#!/usr/bin/env python3
"""
Free Multi-Source Aviation Enrichers for tar1090-project (zero API keys required):

1. Open Glider Network (OGN / FLARM / PilotAware / SafeSky / Fanet):
   - Persistent APRS-IS TCP stream (aprs.glidernet.org:14580) filtered around receiver
   - OGN Device Database (ddb.glidernet.org/download/?j=1, 36k+ gliders/GA/tow-planes)
2. OpenSky Network Regional State Vectors:
   - Background poller (opensky-network.org/api/states/all) every 45s
3. HexDB Aircraft Metadata Resolver:
   - Background lookup (hexdb.io/api/v1/aircraft/{hex}) for any hex missing reg/type/owner
"""

import gzip
import json
import math
import os
import re
import socket
import threading
import time
import urllib.request
from typing import Any, Dict, List, Optional, Set, Tuple

STATE_DIR = "/var/lib/tar1090-augment"
OGN_DDB_CACHE = os.path.join(STATE_DIR, "ogn_ddb.json")
HEXDB_CACHE_FILE = os.path.join(STATE_DIR, "hexdb_aircraft_cache.json")

OGN_DDB_URL = "http://ddb.glidernet.org/download/?j=1"
OPENSKY_BBOX_TPL = "https://opensky-network.org/api/states/all?lamin={lamin:.2f}&lomin={lomin:.2f}&lamax={lamax:.2f}&lomax={lomax:.2f}"
HEXDB_AC_URL = "https://hexdb.io/api/v1/aircraft/{hex}"

# OGN APRS regex:
# Example: FLR3E5A12>OGFLR,qAS,EGSR:/202000h5154.60N/00041.80E'143/065/A=003200 !W45! id063E5A12 +420fpm
_APRS_RE = re.compile(
    r"^(?P<call>[A-Z0-9_-]+)>[^:]+:/(?:\d{6}[hz])"
    r"(?P<lat_d>\d{2})(?P<lat_m>\d{2}\.\d{2})(?P<lat_ns>[NS])"
    r"."
    r"(?P<lon_d>\d{3})(?P<lon_m>\d{2}\.\d{2})(?P<lon_ew>[EW])"
    r".(?:(?P<crs>\d{3})/(?P<spd>\d{3}))?"
    r"(?:/A=(?P<alt>\d{6}))?"
    r"(?P<rest>.*)$"
)
_DAO_RE = re.compile(r"!W(?P<dlat>\d)(?P<dlon>\d)!")
_ID_RE = re.compile(r"\bid(?P<fl>[0-9A-Fa-f]{2})(?P<hx>[0-9A-Fa-f]{6})\b")
_FPM_RE = re.compile(r"(?P<fpm>[+-]\d+)fpm\b")
_FL_RE = re.compile(r"\bFL(?P<fl>\d+\.\d+)\b")
_CS_RE = re.compile(r"\bA[0-9]:(?P<cs>[A-Z0-9_-]+)\b")
_SQ_RE = re.compile(r"\bSq(?P<sq>[0-7]{4})\b")

_lock = threading.Lock()
_ogn_ddb: Dict[str, Dict[str, str]] = {}
_ogn_aircraft: Dict[str, Dict[str, Any]] = {}
_opensky_aircraft: Dict[str, Dict[str, Any]] = {}
_hexdb_cache: Dict[str, Dict[str, str]] = {}
_hexdb_todo: Set[str] = set()

_started = False
_opensky_last_ok = 0.0
_ogn_connected = False


def _http_get_json(url: str, timeout: float = 6.0) -> Any:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "tar1090-project-augment/1.0",
            "Accept-Encoding": "gzip",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
        if resp.headers.get("Content-Encoding") == "gzip":
            raw = gzip.decompress(raw)
        return json.loads(raw.decode("utf-8", errors="ignore"))


def _load_ogn_ddb() -> None:
    """Load OGN Device Database from disk cache or download if older than 24h."""
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        if os.path.exists(OGN_DDB_CACHE) and (time.time() - os.stat(OGN_DDB_CACHE).st_mtime) < 86400:
            with open(OGN_DDB_CACHE, "r") as f:
                data = json.load(f)
            with _lock:
                _ogn_ddb.update(data)
            return
    except Exception:
        pass

    try:
        raw_ddb = _http_get_json(OGN_DDB_URL, timeout=8.0)
        parsed: Dict[str, Dict[str, str]] = {}
        for d in raw_ddb.get("devices", []):
            did = str(d.get("device_id") or "").strip().lower()
            if not did or d.get("tracked") == "N":
                continue
            parsed[did] = {
                "reg": str(d.get("registration") or "").strip(),
                "model": str(d.get("aircraft_model") or "").strip(),
                "cn": str(d.get("cn") or "").strip(),
            }
        if parsed:
            with _lock:
                _ogn_ddb.clear()
                _ogn_ddb.update(parsed)
            tmp = OGN_DDB_CACHE + ".tmp"
            with open(tmp, "w") as f:
                json.dump(parsed, f, separators=(",", ":"))
            os.replace(tmp, OGN_DDB_CACHE)
    except Exception:
        pass


def _parse_ogn_aprs_line(line: str, now: float) -> Optional[Tuple[str, Dict[str, Any]]]:
    if not line or line.startswith("#"):
        return None
    m = _APRS_RE.match(line)
    if not m:
        return None

    call = m.group("call")
    # Ignore ground receiver status beacons (only aircraft prefixes: FLR, OGN, ICA, PAW, SKY, FNT, etc.)
    if not call.startswith(("FLR", "OGN", "ICA", "PAW", "SKY", "FNT", "ADL", "TRK")):
        return None

    rest = m.group("rest") or ""
    lat_m = float(m.group("lat_m"))
    lon_m = float(m.group("lon_m"))
    dao = _DAO_RE.search(rest)
    if dao:
        lat_m += int(dao.group("dlat")) * 0.001
        lon_m += int(dao.group("dlon")) * 0.001

    lat = int(m.group("lat_d")) + lat_m / 60.0
    if m.group("lat_ns") == "S":
        lat = -lat
    lon = int(m.group("lon_d")) + lon_m / 60.0
    if m.group("lon_ew") == "W":
        lon = -lon

    idm = _ID_RE.search(rest)
    if idm:
        hx = idm.group("hx").lower()
    elif len(call) >= 9:
        hx = call[-6:].lower()
    else:
        return None

    is_non_icao = not call.startswith("ICA")
    crs = int(m.group("crs")) if m.group("crs") else None
    spd = int(m.group("spd")) if m.group("spd") else None
    alt_ft = int(m.group("alt")) if m.group("alt") else None

    flm = _FL_RE.search(rest)
    if flm and alt_ft is None:
        alt_ft = int(round(float(flm.group("fl")) * 100.0))

    fpm_m = _FPM_RE.search(rest)
    baro_rate = int(fpm_m.group("fpm")) if fpm_m else None

    cs_m = _CS_RE.search(rest)
    flight = cs_m.group("cs") if cs_m else ""

    sq_m = _SQ_RE.search(rest)
    squawk = sq_m.group("sq") if sq_m else None

    with _lock:
        ddb = _ogn_ddb.get(hx, {})

    reg = ddb.get("reg") or ""
    model = ddb.get("model") or ("OGN/FLARM Glider/GA" if is_non_icao else "")
    if not flight:
        flight = reg or call

    ac: Dict[str, Any] = {
        "hex": hx,
        "flight": flight,
        "r": reg,
        "t": "GLID" if (is_non_icao and not ddb.get("model")) else "",
        "desc": model,
        "lat": round(lat, 6),
        "lon": round(lon, 6),
        "alt_baro": alt_ft if alt_ft is not None else 0,
        "gs": spd,
        "track": crs,
        "baro_rate": baro_rate,
        "squawk": squawk,
        "seen": 0.2,
        "seen_pos": 0.2,
        "_ts": now,
        "_ogn_only": is_non_icao,
        "_ogn_prefix": call[:3],
    }
    return hx, ac


def _ogn_stream_worker(site_lat: float, site_lon: float) -> None:
    global _ogn_connected
    _load_ogn_ddb()
    filter_cmd = f"user N0CALL pass -1 vers tar1090-augment 1.0 filter r/{site_lat:.2f}/{site_lon:.2f}/200\r\n".encode("ascii")

    while True:
        sock = None
        try:
            sock = socket.create_connection(("aprs.glidernet.org", 14580), timeout=15.0)
            sock.settimeout(45.0)
            f = sock.makefile("r", encoding="utf-8", errors="ignore")
            f.readline()  # banner
            sock.sendall(filter_cmd)
            _ogn_connected = True

            last_prune = time.time()
            for line in f:
                now = time.time()
                parsed = _parse_ogn_aprs_line(line.strip(), now)
                if parsed:
                    hx, ac = parsed
                    with _lock:
                        _ogn_aircraft[hx] = ac
                if now - last_prune >= 15.0:
                    last_prune = now
                    with _lock:
                        stale = [k for k, v in _ogn_aircraft.items() if (now - v.get("_ts", 0)) > 90.0]
                        for k in stale:
                            del _ogn_aircraft[k]
        except Exception:
            _ogn_connected = False
            time.sleep(5.0)
        finally:
            if sock:
                try:
                    sock.close()
                except Exception:
                    pass


def _opensky_worker(site_lat: float, site_lon: float) -> None:
    global _opensky_last_ok
    url = OPENSKY_BBOX_TPL.format(
        lamin=site_lat - 1.6,
        lomin=site_lon - 2.8,
        lamax=site_lat + 1.6,
        lomax=site_lon + 2.4,
    )
    while True:
        try:
            data = _http_get_json(url, timeout=8.0)
            states = data.get("states") or []
            now = time.time()
            out: Dict[str, Dict[str, Any]] = {}
            for s in states:
                if not s or len(s) < 15:
                    continue
                hx = str(s[0] or "").strip().lower()
                lon, lat = s[5], s[6]
                if not hx or lat is None or lon is None:
                    continue
                cs = str(s[1] or "").strip().upper()
                on_gnd = bool(s[8])
                baro_m = s[7] if s[7] is not None else s[13]
                alt_ft: Any = "ground" if on_gnd else (int(round(float(baro_m) * 3.28084)) if baro_m is not None else None)
                vel_ms = s[9]
                gs_kt = round(float(vel_ms) * 1.94384, 1) if vel_ms is not None else None
                trk = round(float(s[10]), 1) if s[10] is not None else None
                vr_ms = s[11]
                vr_fpm = int(round(float(vr_ms) * 196.85)) if vr_ms is not None else None
                sqk = str(s[14] or "").strip() or None
                pos_age = max(0.5, min(30.0, now - float(s[3] or now)))
                out[hx] = {
                    "hex": hx,
                    "flight": cs,
                    "lat": float(lat),
                    "lon": float(lon),
                    "alt_baro": alt_ft,
                    "gs": gs_kt,
                    "track": trk,
                    "baro_rate": vr_fpm,
                    "squawk": sqk,
                    "seen": pos_age,
                    "seen_pos": pos_age,
                    "_ts": now,
                }
            if out:
                with _lock:
                    _opensky_aircraft.clear()
                    _opensky_aircraft.update(out)
                    _opensky_last_ok = now
        except Exception:
            pass
        time.sleep(45.0)


def _hexdb_worker() -> None:
    """Resolve unknown aircraft hexes via hexdb.io/api/v1/aircraft/{hex} and persist cache."""
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        if os.path.exists(HEXDB_CACHE_FILE):
            with open(HEXDB_CACHE_FILE, "r") as f:
                with _lock:
                    _hexdb_cache.update(json.load(f))
    except Exception:
        pass

    dirty = False
    last_save = time.time()
    while True:
        hx = None
        with _lock:
            if _hexdb_todo:
                hx = _hexdb_todo.pop()
        if not hx:
            if dirty and (time.time() - last_save) >= 15.0:
                try:
                    with _lock:
                        snap = dict(_hexdb_cache)
                    tmp = HEXDB_CACHE_FILE + ".tmp"
                    with open(tmp, "w") as f:
                        json.dump(snap, f, separators=(",", ":"))
                    os.replace(tmp, HEXDB_CACHE_FILE)
                    dirty = False
                    last_save = time.time()
                except Exception:
                    pass
            time.sleep(1.5)
            continue

        try:
            res = _http_get_json(HEXDB_AC_URL.format(hex=hx.upper()), timeout=4.0)
            entry = {
                "r": str(res.get("Registration") or "").strip(),
                "t": str(res.get("ICAOTypeCode") or "").strip(),
                "desc": f"{res.get('Manufacturer', '')} {res.get('Type', '')}".strip(),
                "ownOp": str(res.get("RegisteredOwners") or "").strip(),
            }
        except Exception:
            entry = {"r": "", "t": "", "desc": "", "ownOp": ""}

        with _lock:
            _hexdb_cache[hx] = entry
        dirty = True
        time.sleep(0.35)


def start_background_workers(site_lat: float, site_lon: float) -> None:
    global _started
    if _started:
        return
    _started = True
    threading.Thread(target=_ogn_stream_worker, args=(site_lat, site_lon), daemon=True).start()
    threading.Thread(target=_opensky_worker, args=(site_lat, site_lon), daemon=True).start()
    threading.Thread(target=_hexdb_worker, daemon=True).start()


def get_supplementary_aircraft(now: float) -> Tuple[Dict[str, Dict[str, Any]], Dict[str, Dict[str, Any]], List[str]]:
    """Return (ogn_dict, opensky_dict, active_source_names)."""
    with _lock:
        ogn_snap = {
            k: dict(v)
            for k, v in _ogn_aircraft.items()
            if (now - v.get("_ts", 0)) <= 75.0
        }
        osky_snap = (
            {k: dict(v) for k, v in _opensky_aircraft.items()}
            if (now - _opensky_last_ok) <= 120.0
            else {}
        )
        sources: List[str] = []
        if _ogn_connected:
            sources.append("ogn-flarm")
        if osky_snap:
            sources.append("opensky")
    return ogn_snap, osky_snap, sources


def enrich_from_hexdb(hx: str, ac: Dict[str, Any]) -> None:
    """Fill missing registration/type/desc/ownOp from HexDB cache or queue background lookup."""
    if not hx or len(hx) != 6:
        return
    if ac.get("r") and ac.get("t"):
        return
    with _lock:
        cached = _hexdb_cache.get(hx)
        if cached is None:
            if len(_hexdb_todo) < 80:
                _hexdb_todo.add(hx)
            return
    if cached.get("r") and not ac.get("r"):
        ac["r"] = cached["r"]
    if cached.get("t") and not ac.get("t"):
        ac["t"] = cached["t"]
    if cached.get("desc") and not ac.get("desc"):
        ac["desc"] = cached["desc"]
    if cached.get("ownOp") and not ac.get("ownOp"):
        ac["ownOp"] = cached["ownOp"]
