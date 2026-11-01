#!/usr/bin/env python3
"""
Nearby-airport context for tar1090-project (display only, nothing is fed back out).

- Live METAR + TAF (aviationweather.gov, free, no key) fetched in a background thread with gzip
- Live batch Callsign -> Origin/Destination Route resolution (adsb.im/api/0/routeset + hexdb.io fallback)
- Likely runway in use, derived from the wind
- Per-airport traffic buckets from live aircraft: on the ground, local/circuit,
  inbound (descending towards the field) and departing (climbing away), enhanced with route matching
"""

import gzip
import json
import math
import threading
import time
import urllib.request
from typing import Any, Dict, List, Optional, Tuple

# icao, name, lat, lon, runway axis (deg true, approx.)
AIRPORTS = [
    ("EGSS", "London Stansted", 51.8850, 0.2350, 40),
    ("EGMC", "London Southend", 51.5714, 0.6956, 50),
    ("EGGW", "London Luton", 51.8747, -0.3683, 80),
    ("EGSC", "Cambridge", 52.2050, 0.1750, 50),
    ("EGLC", "London City", 51.5053, 0.0553, 90),
    ("EGLL", "London Heathrow", 51.4700, -0.4543, 90),
    ("EGKK", "London Gatwick", 51.1481, -0.1903, 80),
    ("EGSH", "Norwich", 52.6758, 1.2828, 90),
    ("EGWU", "RAF Northolt", 51.5530, -0.4182, 70),
    ("EGUL", "RAF Lakenheath", 52.4093, 0.5610, 60),
    ("EGUN", "RAF Mildenhall", 52.3619, 0.4864, 110),
    ("EGUW", "RAF Wattisham", 52.1273, 0.9568, 50),
    ("EGSX", "North Weald", 51.7217, 0.1546, 20),
    ("EGSR", "Earls Colne", 51.9100, 0.6970, 60),
    ("EGSL", "Andrewsfield", 51.8947, 0.4408, 90),
    ("EGSU", "Duxford", 52.0908, 0.1319, 60),
]
AIRPORT_ICAOS = {a[0] for a in AIRPORTS}

IDS_CSV = ",".join(a[0] for a in AIRPORTS)
METAR_URL = f"https://aviationweather.gov/api/data/metar?format=json&ids={IDS_CSV}"
TAF_URL = f"https://aviationweather.gov/api/data/taf?format=json&ids={IDS_CSV}"
ROUTESET_URL = "http://adsb.im/api/0/routeset"
METAR_REFRESH_S = 300
METAR_RETRY_S = 60
ROUTE_CACHE_TTL_S = 6 * 3600
ROUTE_NEG_TTL_S = 900
ROUTE_BATCH_INTERVAL_S = 6.0

_lock = threading.Lock()
_metars: Dict[str, Dict[str, Any]] = {}
_tafs: Dict[str, str] = {}
_routes: Dict[str, Dict[str, Any]] = {}
_last_attempt = 0.0
_last_ok = 0.0
_running = False
_route_running = False
_last_route_attempt = 0.0


def _http_json(url: str, method: str = "GET", body: Optional[bytes] = None, timeout: float = 8.0) -> Any:
    headers = {
        "User-Agent": "tar1090-project-augment/1.0",
        "Accept-Encoding": "gzip",
    }
    if body is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
        if resp.headers.get("Content-Encoding") == "gzip":
            raw = gzip.decompress(raw)
        return json.loads(raw.decode("utf-8", errors="ignore"))


def _fetch_metars_and_tafs() -> None:
    global _last_ok, _running
    try:
        data = _http_json(METAR_URL, timeout=10.0)
        out: Dict[str, Dict[str, Any]] = {}
        for m in data or []:
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

        taf_out: Dict[str, str] = {}
        try:
            taf_data = _http_json(TAF_URL, timeout=10.0)
            for t in taf_data or []:
                icao = t.get("icaoId")
                raw_taf = (t.get("rawTAF") or "").strip()
                if icao and raw_taf:
                    taf_out[icao] = raw_taf
        except Exception:
            pass

        if out:
            with _lock:
                _metars.clear()
                _metars.update(out)
                if taf_out:
                    _tafs.clear()
                    _tafs.update(taf_out)
                _last_ok = time.time()
    except Exception:
        pass
    finally:
        _running = False


def refresh_async() -> None:
    """Kick off a background METAR + TAF refresh when due (never blocks the main loop)."""
    global _last_attempt, _running
    now = time.time()
    interval = METAR_REFRESH_S if _last_ok and (now - _last_ok) < METAR_REFRESH_S * 2 else METAR_RETRY_S
    if _running or (now - _last_attempt) < interval:
        return
    _last_attempt = now
    _running = True
    threading.Thread(target=_fetch_metars_and_tafs, daemon=True).start()


def _fetch_routes_batch(to_query: List[Dict[str, Any]]) -> None:
    global _route_running
    now = time.time()
    try:
        body = json.dumps({"planes": to_query}).encode("utf-8")
        res = _http_json(ROUTESET_URL, method="POST", body=body, timeout=4.5)
        parsed: Dict[str, Dict[str, Any]] = {}
        if isinstance(res, list):
            for entry in res:
                if not isinstance(entry, dict):
                    continue
                cs = str(entry.get("callsign") or "").strip().upper()
                apts = entry.get("_airports") or []
                if not cs or len(apts) < 2:
                    continue
                orig = apts[0]
                dest = apts[-1]
                orig_iata = orig.get("iata") or orig.get("icao") or ""
                dest_iata = dest.get("iata") or dest.get("icao") or ""
                orig_icao = orig.get("icao") or ""
                dest_icao = dest.get("icao") or ""
                orig_loc = orig.get("location") or orig.get("name") or orig_iata
                dest_loc = dest.get("location") or dest.get("name") or dest_iata
                parsed[cs] = {
                    "route_iata": f"{orig_iata}→{dest_iata}" if (orig_iata and dest_iata) else (entry.get("_airport_codes_iata") or ""),
                    "route_icao": f"{orig_icao}-{dest_icao}",
                    "orig_iata": orig_iata,
                    "orig_icao": orig_icao,
                    "orig_loc": orig_loc,
                    "dest_iata": dest_iata,
                    "dest_icao": dest_icao,
                    "dest_loc": dest_loc,
                    "expires": now + ROUTE_CACHE_TTL_S,
                }
        with _lock:
            for q in to_query:
                cs = q["callsign"]
                if cs in parsed:
                    _routes[cs] = parsed[cs]
                else:
                    _routes[cs] = {"route_iata": "", "expires": now + ROUTE_NEG_TTL_S}
    except Exception:
        pass
    finally:
        _route_running = False


def refresh_routes_async(candidates: List[Dict[str, Any]]) -> None:
    """Resolve callsign routes in a background batch request without blocking."""
    global _route_running, _last_route_attempt
    now = time.time()
    if _route_running or (now - _last_route_attempt) < ROUTE_BATCH_INTERVAL_S or not candidates:
        return
    with _lock:
        todo = []
        seen_cs = set()
        for c in candidates:
            cs = c["callsign"]
            if cs in seen_cs:
                continue
            cached = _routes.get(cs)
            if not cached or now > cached.get("expires", 0):
                todo.append(c)
                seen_cs.add(cs)
            if len(todo) >= 25:
                break
    if not todo:
        return
    _last_route_attempt = now
    _route_running = True
    threading.Thread(target=_fetch_routes_batch, args=(todo,), daemon=True).start()


def get_cached_routes() -> Dict[str, Dict[str, Any]]:
    with _lock:
        return {k: v for k, v in _routes.items() if v.get("route_iata")}



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
        tafs = dict(_tafs)
        routes = dict(_routes)

    buckets: Dict[str, Dict[str, List[Dict[str, Any]]]] = {
        a[0]: {"ground": [], "local": [], "inbound": [], "departing": []} for a in AIRPORTS
    }
    route_candidates: List[Dict[str, Any]] = []

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
        fl_raw = str(ac.get("flight", "")).strip().upper()
        reg_raw = str(ac.get("r", "")).strip().upper()
        rt_info = routes.get(fl_raw) if fl_raw else None

        best = None  # (score_dist, dist, icao, bucket)
        for icao, _n, alat, alon, _ax in AIRPORTS:
            d, b_to = _dist_bearing(lat, lon, alat, alon)  # bearing aircraft -> airport
            bucket = None
            if (on_ground and d <= 3.0) or (not on_ground and d <= 2.0 and alt <= 450 and gs < 70):
                bucket = "ground"
            elif not on_ground and d <= 36 and alt <= 10500 and trk is not None and gs > 60:
                to_diff = _adiff(trk, b_to)
                away_diff = _adiff(trk, (b_to + 180) % 360)
                if rt_info and rt_info.get("dest_icao") == icao and d <= 36 and rate <= 150:
                    bucket = "inbound"
                elif rt_info and rt_info.get("orig_icao") == icao and d <= 28 and rate >= 0:
                    bucket = "departing"
                elif (rate <= -150 and to_diff <= 50 and d <= 32 and alt <= 9500) or (d <= 14 and alt <= 4500 and to_diff <= 22 and rate <= 100):
                    bucket = "inbound"
                elif rate >= 250 and d <= 22 and alt <= 9500 and away_diff <= 60:
                    bucket = "departing"
            if not bucket and not on_ground and d <= 5.5 and alt <= 3200:
                bucket = "local"
            if bucket:
                # Prefer closer airport; give strong bonus when confirmed by flight route
                score = d
                if rt_info:
                    if bucket == "inbound" and rt_info.get("dest_icao") == icao:
                        score -= 25.0
                    elif bucket == "departing" and rt_info.get("orig_icao") == icao:
                        score -= 25.0
                    elif bucket == "inbound" and rt_info.get("dest_icao") in AIRPORT_ICAOS and rt_info.get("dest_icao") != icao:
                        score += 20.0
                    elif bucket == "departing" and rt_info.get("orig_icao") in AIRPORT_ICAOS and rt_info.get("orig_icao") != icao:
                        score += 20.0
                if best is None or score < best[0]:
                    best = (score, d, icao, bucket)
        if best:
            _sc, d, icao, bucket = best
            if fl_raw and fl_raw != reg_raw.replace("-", "") and len(fl_raw) >= 4:
                route_candidates.append({"callsign": fl_raw, "lat": float(lat), "lng": float(lon)})

            peer_iata = ""
            peer_loc = ""
            route_iata = ""
            if rt_info and rt_info.get("route_iata"):
                route_iata = rt_info["route_iata"]
                if bucket == "inbound":
                    peer_iata = rt_info.get("orig_iata") or ""
                    peer_loc = rt_info.get("orig_loc") or ""
                elif bucket == "departing":
                    peer_iata = rt_info.get("dest_iata") or ""
                    peer_loc = rt_info.get("dest_loc") or ""

            buckets[icao][bucket].append({
                "hex": str(ac.get("hex", "")).lower(),
                "flight": fl_raw or reg_raw or str(ac.get("hex", "")).upper(),
                "reg": reg_raw,
                "type": str(ac.get("t", "")).strip(),
                "desc": str(ac.get("desc", "")).strip(),
                "route": route_iata,
                "peer": peer_iata,
                "peer_loc": peer_loc,
                "alt": alt,
                "gs": round(gs) if gs else None,
                "vr": round(rate) if rate else 0,
                "trk": round(trk) if isinstance(trk, (int, float)) else None,
                "dst_nm": round(d, 1),
                "lat": lat,
                "lon": lon,
            })

    # Also queue route lookups for any other nearby commercial callsigns
    if len(route_candidates) < 20:
        for ac in aircraft:
            lat, lon = ac.get("lat"), ac.get("lon")
            if lat is None or lon is None:
                continue
            fl_raw = str(ac.get("flight", "")).strip().upper()
            reg_raw = str(ac.get("r", "")).strip().upper()
            if fl_raw and fl_raw != reg_raw.replace("-", "") and len(fl_raw) >= 4 and fl_raw not in routes:
                route_candidates.append({"callsign": fl_raw, "lat": float(lat), "lng": float(lon)})
                if len(route_candidates) >= 25:
                    break

    refresh_routes_async(route_candidates)

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
            "taf": tafs.get(icao, ""),
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
