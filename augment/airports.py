#!/usr/bin/env python3
"""
Nearby-airport context for tar1090-project (display only, nothing is fed back out).

- Live METAR (aviationweather.gov, free, no key) fetched in a background thread
- Likely runway in use, derived from the wind
- Per-airport traffic buckets from live aircraft: on the ground, local/circuit,
  inbound (descending towards the field) and departing (climbing away)
"""

import json
import math
import threading
import time
import urllib.request
from typing import Any, Dict, List, Optional

# icao, name, lat, lon, runway axis (deg true, approx.), has_metar
AIRPORTS = [
    ("EGSS", "London Stansted", 51.8850, 0.2350, 40),
    ("EGMC", "Southend", 51.5714, 0.6956, 50),
    ("EGGW", "London Luton", 51.8747, -0.3683, 80),
    ("EGSC", "Cambridge", 52.2050, 0.1750, 50),
    ("EGLC", "London City", 51.5053, 0.0553, 90),
    ("EGWU", "RAF Northolt", 51.5530, -0.4182, 70),
    ("EGUL", "RAF Lakenheath", 52.4093, 0.5610, 60),
    ("EGUN", "RAF Mildenhall", 52.3619, 0.4864, 110),
    ("EGUW", "RAF Wattisham", 52.1273, 0.9568, 50),
    ("EGSX", "North Weald", 51.7217, 0.1546, 20),
    ("EGSR", "Earls Colne", 51.9100, 0.6970, 60),
    ("EGSL", "Andrewsfield", 51.8947, 0.4408, 90),
    ("EGSU", "Duxford", 52.0908, 0.1319, 60),
]

METAR_URL = "https://aviationweather.gov/api/data/metar?format=json&ids=" + ",".join(a[0] for a in AIRPORTS)
METAR_REFRESH_S = 300
METAR_RETRY_S = 60

_lock = threading.Lock()
_metars: Dict[str, Dict[str, Any]] = {}
_last_attempt = 0.0
_last_ok = 0.0
_running = False


def _fetch_metars() -> None:
    global _last_ok, _running
    try:
        req = urllib.request.Request(METAR_URL, headers={"User-Agent": "tar1090-project-augment/1.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8", errors="ignore"))
        out: Dict[str, Dict[str, Any]] = {}
        for m in data:
            icao = m.get("icaoId")
            if not icao:
                continue
            clouds = m.get("clouds") or []
            ceiling = None
            for c in clouds:
                if c.get("cover") in ("BKN", "OVC", "OVX") and c.get("base") is not None:
                    ceiling = c["base"] if ceiling is None else min(ceiling, c["base"])
            out[icao] = {
                "raw": m.get("rawOb", ""),
                "wdir": m.get("wdir"),
                "wspd": m.get("wspd"),
                "wgst": m.get("wgst"),
                "vis_sm": m.get("visib"),
                "temp": m.get("temp"),
                "dewp": m.get("dewp"),
                "qnh": m.get("altim"),
                "cat": m.get("fltCat") or "",
                "wx": m.get("wxString") or "",
                "ceiling_ft": ceiling,
                "clouds": " ".join(f"{c.get('cover')}{int(c['base'] // 100):03d}" for c in clouds
                                   if c.get("base") is not None) or "CLR",
                "obs_time": m.get("obsTime"),
            }
        if out:
            with _lock:
                _metars.clear()
                _metars.update(out)
                _last_ok = time.time()
    except Exception:
        pass
    finally:
        _running = False


def refresh_async() -> None:
    """Kick off a background METAR refresh when due (never blocks the main loop)."""
    global _last_attempt, _running
    now = time.time()
    interval = METAR_REFRESH_S if _last_ok and (now - _last_ok) < METAR_REFRESH_S * 2 else METAR_RETRY_S
    if _running or (now - _last_attempt) < interval:
        return
    _last_attempt = now
    _running = True
    threading.Thread(target=_fetch_metars, daemon=True).start()


def _dist_bearing(lat1: float, lon1: float, lat2: float, lon2: float):
    r = 3440.065  # nm
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    d = 2 * r * math.atan2(math.sqrt(a), math.sqrt(max(0.0, 1 - a)))
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return d, (math.degrees(math.atan2(y, x)) + 360) % 360


def _adiff(a: float, b: float) -> float:
    return abs((a - b + 180) % 360 - 180)


def _designator(hdg: float) -> str:
    n = int(round(hdg / 10.0)) % 36
    return f"{36 if n == 0 else n:02d}"


def _active_runway(axis: float, wdir: Any, wspd: Any) -> Optional[str]:
    if not isinstance(wdir, (int, float)) or not isinstance(wspd, (int, float)) or wspd < 3:
        return None
    best, best_hw = None, -999.0
    for h in (axis, (axis + 180) % 360):
        hw = wspd * math.cos(math.radians(wdir - h))
        if hw > best_hw:
            best, best_hw = h, hw
    return _designator(best) if best is not None else None


def build_status(site_lat: float, site_lon: float, aircraft: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """aircraft: dicts with hex, lat, lon, alt_baro, baro_rate/geom_rate, track, gs, flight, r."""
    refresh_async()
    with _lock:
        metars = dict(_metars)

    buckets: Dict[str, Dict[str, List[Dict[str, Any]]]] = {
        a[0]: {"ground": [], "local": [], "inbound": [], "departing": []} for a in AIRPORTS
    }

    for ac in aircraft:
        lat, lon = ac.get("lat"), ac.get("lon")
        if lat is None or lon is None:
            continue
        alt = ac.get("alt_baro")
        on_ground = alt == "ground"
        if not on_ground and not isinstance(alt, (int, float)):
            continue
        rate = ac.get("baro_rate", ac.get("geom_rate"))
        rate = rate if isinstance(rate, (int, float)) else 0
        trk = ac.get("track")
        gs = ac.get("gs") if isinstance(ac.get("gs"), (int, float)) else 0

        best = None  # (dist, icao, bucket)
        for icao, _n, alat, alon, _ax in AIRPORTS:
            d, b_to = _dist_bearing(lat, lon, alat, alon)  # bearing aircraft -> airport
            bucket = None
            if on_ground and d <= 2.5:
                bucket = "ground"
            elif not on_ground and d <= 4 and alt <= 2000:
                bucket = "local"
            elif not on_ground and d <= 30 and alt <= 6000 and trk is not None and gs > 60:
                if rate < -200 and _adiff(trk, b_to) <= 45:
                    bucket = "inbound"
                elif rate > 300 and d <= 15 and _adiff(trk, (b_to + 180) % 360) <= 50:
                    bucket = "departing"
            if bucket and (best is None or d < best[0]):
                best = (d, icao, bucket)
        if best:
            d, icao, bucket = best
            buckets[icao][bucket].append({
                "hex": str(ac.get("hex", "")).lower(),
                "flight": str(ac.get("flight", "")).strip() or str(ac.get("r", "")).strip() or str(ac.get("hex", "")).upper(),
                "type": ac.get("t", ""),
                "alt": alt,
                "dst_nm": round(d, 1),
                "lat": lat,
                "lon": lon,
            })

    now = time.time()
    out = []
    for icao, name, alat, alon, axis in AIRPORTS:
        m = metars.get(icao)
        d_site, brg_site = _dist_bearing(site_lat, site_lon, alat, alon)
        for k in buckets[icao]:
            buckets[icao][k].sort(key=lambda x: x["dst_nm"])
        entry: Dict[str, Any] = {
            "icao": icao,
            "name": name,
            "lat": alat,
            "lon": alon,
            "axis": axis,
            "rwy_pair": f"{_designator(axis)}/{_designator((axis + 180) % 360)}",
            "dist_nm": round(d_site, 1),
            "dir_deg": round(brg_site),
            "metar": m,
            "metar_age_min": round((now - m["obs_time"]) / 60) if m and m.get("obs_time") else None,
            "active_rwy": _active_runway(axis, m.get("wdir"), m.get("wspd")) if m else None,
            "ground": buckets[icao]["ground"],
            "local": buckets[icao]["local"],
            "inbound": buckets[icao]["inbound"],
            "departing": buckets[icao]["departing"],
        }
        out.append(entry)
    out.sort(key=lambda e: e["dist_nm"])
    return out
