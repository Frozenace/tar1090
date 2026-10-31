#!/usr/bin/env python3
"""
Extensible Open-Data Augmentation & Antenna Benchmark Engine for tar1090-project.

Combines:
1. Local readsb receiver telemetry (/run/readsb/aircraft.json, stats.json, outline.json)
2. Open uncensored community ADS-B + MLAT feeds (api.adsb.lol / opendata.adsb.fi)
3. High-fidelity UK/NATO Tactical Classifier (NPAS Police, HEMS Air Ambulance, HM Coastguard SAR, Military)
4. Real-time 8-sector polar range benchmark analytics

Outputs /run/readsb/augmented.json (served at /tar1090/data/augmented.json).
"""

import json
import math
import os
import socket
import sys
import time
import urllib.request
from typing import Dict, List, Any, Optional, Tuple

import airports as airports_mod

# Force IPv4 resolution so urllib doesn't hang on dead IPv6 routes
_orig_getaddrinfo = socket.getaddrinfo
def _ipv4_getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
    return _orig_getaddrinfo(host, port, socket.AF_INET, type, proto, flags)
socket.getaddrinfo = _ipv4_getaddrinfo

READSB_DIR = "/run/readsb"
OUTPUT_FILE = "/run/readsb/augmented.json"
STATE_DIR = "/var/lib/tar1090-augment"
BASELINE_FILE = "/var/lib/tar1090-augment/baseline_before_readsb_tuning.json"
FINDINGS_FILE = "/var/lib/tar1090-augment/findings.json"


def load_site_coords() -> Tuple[float, float]:
    """Load receiver coordinates dynamically from /run/readsb/receiver.json (keeps home address out of git)."""
    try:
        with open(os.path.join(READSB_DIR, "receiver.json"), "r") as f:
            rj = json.load(f)
            if "lat" in rj and "lon" in rj:
                return float(rj["lat"]), float(rj["lon"])
    except Exception:
        pass
    return float(os.environ.get("SITE_LAT", "51.5074")), float(os.environ.get("SITE_LON", "-0.1278"))


SITE_LAT, SITE_LON = load_site_coords()

OPEN_ENDPOINTS = [
    ("adsb_fi_regional", f"https://opendata.adsb.fi/api/v2/lat/{SITE_LAT}/lon/{SITE_LON}/dist/200"),
]
FALLBACK_ENDPOINTS = [
    ("adsb_lol_regional", f"https://api.adsb.lol/v2/point/{SITE_LAT}/{SITE_LON}/200"),
]

PLANE_ALERT_CSV = os.environ.get("PLANE_ALERT_CSV", "/usr/local/share/tar1090/plane-alert/plane-alert-db.csv")


def load_plane_alert() -> Dict[str, Dict[str, str]]:
    """Load sdr-enthusiasts/plane-alert-db (hex -> tactical category) if present."""
    import csv
    db: Dict[str, Dict[str, str]] = {}
    try:
        with open(PLANE_ALERT_CSV, "r", encoding="utf-8", errors="ignore", newline="") as f:
            rd = csv.reader(f)
            next(rd, None)
            for r in rd:
                if len(r) < 10:
                    continue
                cmpg, cat = r[5].strip(), r[9].strip()
                tags = " ".join(r[6:9]).lower()
                if cmpg == "Pol":
                    tac = "NPAS"
                elif cat == "Coastguard":
                    tac = "SAR"
                elif cat == "Flying Doctors" or "air ambo" in tags or "medical evac" in tags:
                    tac = "HEMS"
                elif cmpg == "Mil":
                    tac = "MIL"
                else:
                    continue
                db[r[0].strip().lower()] = {"cat": tac, "reg": r[1].strip(), "op": r[2].strip(),
                                            "desc": r[3].strip(), "type": r[4].strip()}
    except Exception:
        pass
    return db


PLANE_ALERT: Dict[str, Dict[str, str]] = load_plane_alert()

# Extensible UK & NATO Tactical Rules
NPAS_REG_PREFIXES = ("G-POL", "G-NPA", "G-MPS", "G-PSN")
NPAS_CALL_PREFIXES = ("UKP", "NPAS", "POLICE", "POL")
NPAS_SQUAWKS = {"0032", "7004"}
NPAS_OP_KEYWORDS = ("NATIONAL POLICE", "POLICE AIR", "NPAS", "METROPOLITAN POLICE", "POLICE SCOTLAND")

HEMS_REG_PREFIXES = (
    "G-EHM", "G-EHE",   # Essex & Herts Air Ambulance (Earls Colne / North Weald)
    "G-ANG", "G-RESU",  # East Anglian Air Ambulance (Norwich / Cambridge)
    "G-LAA", "G-LNDN",  # London's Air Ambulance
    "G-KSS",            # Air Ambulance Charity Kent Surrey Sussex
    "G-GWA",            # Great Western Air Ambulance
    "G-NWE", "G-NWA",   # North West Air Ambulance
    "G-YAA", "G-YOR",   # Yorkshire Air Ambulance
    "G-MAA",            # Midlands Air Ambulance
    "G-DAA",            # Devon Air Ambulance
    "G-LIN",            # Lincs & Notts Air Ambulance
    "G-HIW",            # Hampshire & Isle of Wight Air Ambulance
    "G-WAA", "G-WENU",  # Wales Air Ambulance
    "G-SCG", "G-SAS",   # Scottish Air Ambulance
    "G-TVA",            # Thames Valley Air Ambulance
    "G-CNW",            # Cornwall Air Ambulance
)
HEMS_CALL_PREFIXES = ("HLE", "EHA", "ANG", "HELIMED", "LIFELN", "MEDIC", "AIRAMB", "GMA")
HEMS_SQUAWKS = {"0020"}
HEMS_OP_KEYWORDS = ("AIR AMBULANCE", "HELIMED", "SCOTLAND CHARITY AIR AMBULANCE")

SAR_REG_PREFIXES = ("G-MCG", "G-CG", "G-SAR", "G-HMCG", "2-GGGG", "G-WKTS", "G-DLAA", "G-DSMR")
SAR_CALL_PREFIXES = ("SRG", "RESCUE", "COAST", "CGD", "UKCG", "WDG", "BDR")
SAR_SQUAWKS = {"0023", "0036"}
SAR_OP_KEYWORDS = ("COASTGUARD", "SEARCH AND RESCUE", "MARITIME AND COASTGUARD", "BORDER FORCE")

MIL_HEX_PREFIXES = (
    "43c",  # UK Military (RAF / AAC / RN)
    "ae",   # US DoD / USAF (Lakenheath / Mildenhall)
    "af",   # US DoD
    "3b",   # French Military
    "3f",   # German Military
)
MIL_CALL_PREFIXES = (
    "RRR", "AAC", "RFR", "VYT", "SHF", "BKH", "SYS", "TARTN", "LOSSIE",
    "TYPHOON", "COBRA", "VIPER", "LION", "NATO", "MMF", "RCH", "KNIFE",
    "JOLLY", "ASCOT", "TARTAN", "RAF", "NAVY", "ARMY", "GAF", "FAF", "BAF",
    "KRF", "LCG", "MAD", "NOH", "WAD", "GONZO", "TALON", "REAPER", "FOCUS",
    "QUID", "HOBO", "Bolar", "BOLAR", "CHAOS", "SAVAGE", "KILLER", "TESTER",
)
MIL_REG_PREFIXES = ("ZM", "ZZ", "ZH", "ZK", "ZA", "ZB", "ZE", "ZJ", "XZ", "XW", "XX")
MIL_OP_KEYWORDS = (
    "ROYAL AIR FORCE", "ROYAL NAVY", "ARMY AIR CORPS", "MINISTRY OF DEFENCE",
    "UNITED STATES AIR FORCE", "US AIR FORCE", "US NAVY", "US ARMY",
    "QINETIQ", "DRAKEN", "COBHAM", "NATO", "LUFTWAFFE", "ARMEE DE L'AIR",
)


def dist_bearing(lat1: float, lon1: float, lat2: float, lon2: float) -> Tuple[float, float, float]:
    """Return (distance_km, distance_nm, bearing_deg) from (lat1, lon1) to (lat2, lon2)."""
    r_earth = 6371.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlon / 2) ** 2
    d_km = 2 * r_earth * math.atan2(math.sqrt(a), math.sqrt(max(0.0, 1.0 - a)))
    d_nm = d_km / 1.852
    y = math.sin(dlon) * math.cos(phi2)
    x = math.cos(phi1) * math.sin(phi2) - math.sin(phi1) * math.cos(phi2) * math.cos(dlon)
    brng = (math.degrees(math.atan2(y, x)) + 360.0) % 360.0
    return d_km, d_nm, brng


def classify_aircraft(ac: Dict[str, Any]) -> Optional[Dict[str, str]]:
    """Classify aircraft into NPAS, HEMS, SAR, or MIL with high fidelity & operator awareness."""
    hx = str(ac.get("hex", "")).strip().lower()
    fl = str(ac.get("flight", "")).strip().upper()
    reg = str(ac.get("r", "")).strip().upper()
    sqk = str(ac.get("squawk", "")).strip()
    t = str(ac.get("t", "")).strip().upper()
    desc = str(ac.get("desc", "")).strip()
    own_op = str(ac.get("ownOp", "") or "").strip()
    own_op_up = own_op.upper()
    db_flags = int(ac.get("dbFlags", 0) or 0)

    # 0. Curated plane-alert-db match (authoritative hex lookup)
    pa = PLANE_ALERT.get(hx)
    if pa:
        reg = reg or pa["reg"].upper()
        t = t or pa["type"].upper()
        desc = desc or pa["desc"]
        own_op = own_op or pa["op"]
        meta = {
            "NPAS": ("NPAS Police Air Service", "#38bdf8"),
            "HEMS": ("Air Ambulance (HEMS)", "#ef4444"),
            "SAR": ("HM Coastguard / Search & Rescue", "#f97316"),
            "MIL": ("Military (RAF / USAF / NATO)", "#f59e0b"),
        }[pa["cat"]]
        return {"category": pa["cat"], "badge": pa["cat"], "label": meta[0], "color": meta[1],
                "reg": reg, "type": t, "desc": desc, "ownOp": own_op,
                "match_reason": "plane-alert-db"}

    # 1. NPAS (National Police Air Service)
    npas_reason = None
    if reg.startswith(NPAS_REG_PREFIXES):
        npas_reason = f"reg:{reg}"
    elif fl.startswith(NPAS_CALL_PREFIXES):
        npas_reason = f"callsign:{fl}"
    elif sqk in NPAS_SQUAWKS:
        npas_reason = f"squawk:{sqk}"
    elif own_op_up and any(k in own_op_up for k in NPAS_OP_KEYWORDS):
        npas_reason = f"ownOp:{own_op}"
    if npas_reason:
        return {
            "category": "NPAS",
            "badge": "NPAS",
            "label": "NPAS Police Air Service",
            "color": "#38bdf8",
            "reg": reg,
            "type": t,
            "desc": desc or "Police Helicopter / Fixed-Wing",
            "ownOp": own_op,
            "match_reason": npas_reason,
        }

    # 2. HEMS (Air Ambulance / Helimed)
    hems_reason = None
    if reg.startswith(HEMS_REG_PREFIXES):
        hems_reason = f"reg:{reg}"
    elif fl.startswith(HEMS_CALL_PREFIXES):
        hems_reason = f"callsign:{fl}"
    elif sqk in HEMS_SQUAWKS:
        hems_reason = f"squawk:{sqk}"
    elif own_op_up and any(k in own_op_up for k in HEMS_OP_KEYWORDS):
        hems_reason = f"ownOp:{own_op}"
    if hems_reason:
        return {
            "category": "HEMS",
            "badge": "HEMS",
            "label": "Air Ambulance (HEMS)",
            "color": "#ef4444",
            "reg": reg,
            "type": t,
            "desc": desc or "Air Ambulance Helicopter",
            "ownOp": own_op,
            "match_reason": hems_reason,
        }

    # 3. SAR (HM Coastguard / Search & Rescue / Maritime ISR)
    sar_reason = None
    if reg.startswith(SAR_REG_PREFIXES):
        sar_reason = f"reg:{reg}"
    elif fl.startswith(SAR_CALL_PREFIXES):
        sar_reason = f"callsign:{fl}"
    elif sqk in SAR_SQUAWKS:
        sar_reason = f"squawk:{sqk}"
    elif own_op_up and any(k in own_op_up for k in SAR_OP_KEYWORDS):
        sar_reason = f"ownOp:{own_op}"
    if sar_reason:
        return {
            "category": "SAR",
            "badge": "SAR",
            "label": "HM Coastguard / Search & Rescue",
            "color": "#f97316",
            "reg": reg,
            "type": t,
            "desc": desc or "Search & Rescue Aircraft",
            "ownOp": own_op,
            "match_reason": sar_reason,
        }

    # 4. Military (UK MoD / RAF / AAC / USAF / NATO / Defense Test)
    mil_reason = None
    if (db_flags & 1) != 0:
        mil_reason = "dbFlags:1"
    elif hx.startswith(MIL_HEX_PREFIXES):
        mil_reason = f"hex:{hx[:3]}*"
    elif fl.startswith(MIL_CALL_PREFIXES):
        mil_reason = f"callsign:{fl}"
    elif reg.startswith(MIL_REG_PREFIXES):
        mil_reason = f"reg:{reg}"
    elif own_op_up and any(k in own_op_up for k in MIL_OP_KEYWORDS):
        mil_reason = f"ownOp:{own_op}"
    if mil_reason:
        return {
            "category": "MIL",
            "badge": "MIL",
            "label": "Military (RAF / USAF / NATO)",
            "color": "#f59e0b",
            "reg": reg,
            "type": t,
            "desc": desc or "Military Aircraft",
            "ownOp": own_op,
            "match_reason": mil_reason,
        }

    return None


def fetch_open_feeds() -> Dict[str, Dict[str, Any]]:
    """Fetch open ADS-B & MLAT feeds and index by lowercase hex."""
    merged: Dict[str, Dict[str, Any]] = {}
    success = False

    for endpoint_group in (OPEN_ENDPOINTS, FALLBACK_ENDPOINTS):
        if success:
            break
        for name, url in endpoint_group:
            try:
                req = urllib.request.Request(url, headers={"User-Agent": "tar1090-project-augment/1.0"})
                with urllib.request.urlopen(req, timeout=3.5) as resp:
                    data = json.loads(resp.read().decode("utf-8", errors="ignore"))
                    ac_list = data.get("ac") or data.get("aircraft") or []
                    for ac in ac_list:
                        hx = str(ac.get("hex", "")).strip().lower()
                        if not hx:
                            continue
                        lat = ac.get("lat")
                        lon = ac.get("lon")
                        if lat is not None and lon is not None:
                            _, d_nm, brng = dist_bearing(SITE_LAT, SITE_LON, float(lat), float(lon))
                            if d_nm > 260.0:
                                continue
                            ac["r_dst"] = round(d_nm, 2)
                            ac["r_dir"] = round(brng, 1)
                        merged[hx] = ac
                    success = True
            except Exception:
                pass

    return merged


def compute_benchmark_stats() -> Dict[str, Any]:
    """Compute real-time receiver benchmark and 8-sector polar coverage from local readsb files."""
    bench: Dict[str, Any] = {
        "msg_rate": 0.0,
        "pos_rate": 0.0,
        "max_range_nm": 0.0,
        "max_range_km": 0.0,
        "max_range_brng": 0.0,
        "snr_db": 0.0,
        "signal_dbfs": 0.0,
        "noise_dbfs": 0.0,
        "gain_db": 0.0,
        "strong_pct": 0.0,
        "peak_dbfs": 0.0,
        "gain_hint": "",
        "total_tracks": 0,
        "uptime_min": 0.0,
        "sectors": [],
    }
    try:
        with open(os.path.join(READSB_DIR, "stats.json"), "r") as f:
            st = json.load(f)
        bench["gain_db"] = st.get("gain_db", 0.0)
        l1 = st.get("last1min", {})
        dur1 = max(1.0, l1.get("end", 60.0) - l1.get("start", 0.0))
        bench["msg_rate"] = round(l1.get("messages_valid", 0) / dur1, 1)
        bench["pos_rate"] = round(l1.get("position_count_total", 0) / dur1, 1)

        tot = st.get("total", {})
        durt = max(1.0, tot.get("end", 1.0) - tot.get("start", 0.0))
        bench["uptime_min"] = round(durt / 60.0, 1)
        md_m = tot.get("max_distance", 0)
        bench["max_range_km"] = round(md_m / 1000.0, 1)
        bench["max_range_nm"] = round(md_m / 1852.0, 1)
        bench["total_tracks"] = tot.get("tracks", {}).get("all", 0)

        l1loc = l1.get("local", {})
        acc1 = l1loc.get("accepted", [0, 0])
        good = max(1, (acc1[0] if acc1 else 0) + (acc1[1] if len(acc1) > 1 else 0))
        bench["strong_pct"] = round(100.0 * l1loc.get("strong_signals", 0) / good, 2)
        bench["peak_dbfs"] = l1loc.get("peak_signal", 0.0)
        bench["est_ppm"] = st.get("estimated_ppm")
        # >3% strong signals suggests front-end overload (gain too high); <0.5% suggests headroom
        sp = bench["strong_pct"]
        bench["gain_hint"] = "OVERLOAD: lower gain" if sp > 3.0 else ("headroom: could raise gain" if sp < 0.5 else "optimal")

        loc = tot.get("local", {})
        sig = loc.get("signal", -12.0)
        noi = loc.get("noise", -30.0)
        bench["signal_dbfs"] = sig
        bench["noise_dbfs"] = noi
        bench["snr_db"] = round(sig - noi, 1)
    except Exception:
        pass

    sector_names = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
    sec_max = [0.0] * 8
    sec_pts = [0] * 8
    best_brng = 0.0
    best_nm = 0.0

    try:
        with open(os.path.join(READSB_DIR, "outline.json"), "r") as f:
            outline = json.load(f)
        for pt in outline.get("actualRange", {}).get("last24h", {}).get("points", []):
            _, d_nm, brng = dist_bearing(SITE_LAT, SITE_LON, pt[0], pt[1])
            idx = int(((brng + 22.5) % 360.0) // 45)
            sec_pts[idx] += 1
            if d_nm > sec_max[idx]:
                sec_max[idx] = round(d_nm, 1)
            if d_nm > best_nm:
                best_nm = d_nm
                best_brng = round(brng, 1)
    except Exception:
        pass

    if best_nm > bench["max_range_nm"]:
        bench["max_range_nm"] = round(best_nm, 1)
        bench["max_range_km"] = round(best_nm * 1.852, 1)
    bench["max_range_brng"] = best_brng

    bench["sectors"] = [
        {"name": sector_names[i], "max_nm": sec_max[i], "points": sec_pts[i]}
        for i in range(8)
    ]
    return bench


def run_cycle(cached_open: Dict[str, Dict[str, Any]]) -> None:
    now_ts = time.time()
    local_ac_list: List[Dict[str, Any]] = []
    try:
        with open(os.path.join(READSB_DIR, "aircraft.json"), "r") as f:
            local_data = json.load(f)
            local_ac_list = local_data.get("aircraft", [])
    except Exception:
        pass

    local_by_hex: Dict[str, Dict[str, Any]] = {}
    furthest_local: Optional[Dict[str, Any]] = None
    furthest_dst = 0.0
    local_with_pos = 0
    local_mode_s_only = 0

    classifications: Dict[str, Dict[str, Any]] = {}
    augmented_aircraft: List[Dict[str, Any]] = []
    tactical_list: List[Dict[str, Any]] = []

    # 1. Process all local aircraft
    for ac in local_ac_list:
        hx = str(ac.get("hex", "")).strip().lower()
        if not hx:
            continue
        local_by_hex[hx] = ac
        has_local_pos = ("lat" in ac and "lon" in ac and ac.get("seen_pos", 999) < 60)
        if has_local_pos:
            local_with_pos += 1
            dst = float(ac.get("r_dst", 0.0) or 0.0)
            if dst > furthest_dst:
                furthest_dst = dst
                furthest_local = {
                    "hex": hx,
                    "flight": str(ac.get("flight", "")).strip() or hx.upper(),
                    "dst_nm": round(dst, 1),
                    "dir_deg": round(float(ac.get("r_dir", 0.0) or 0.0), 1),
                    "alt": ac.get("alt_baro"),
                    "rssi": ac.get("rssi"),
                }
        else:
            local_mode_s_only += 1

        # Enrich local aircraft with open feed metadata (reg, type, dbFlags) for classification
        open_ac = cached_open.get(hx, {})
        merged_meta = dict(open_ac)
        merged_meta.update(ac)
        cls = classify_aircraft(merged_meta)

        # Check if this local Mode-S-only plane can get its GPS position from Open MLAT/ADS-B!
        if not has_local_pos and open_ac and "lat" in open_ac and "lon" in open_ac:
            hybrid_ac = dict(open_ac)
            # Preserve local RSSI and message count, but inject triangulated position
            if "rssi" in ac:
                hybrid_ac["rssi"] = ac["rssi"]
            if "messages" in ac:
                hybrid_ac["messages"] = ac["messages"]
            hybrid_ac["seen"] = ac.get("seen", 0.5)
            hybrid_ac["seen_pos"] = min(float(open_ac.get("seen_pos", 1.0) or 1.0), 5.0)
            hybrid_ac["aug_source"] = "HYBRID_MLAT"
            augmented_aircraft.append(hybrid_ac)

            info = cls or {
                "category": "HYBRID",
                "badge": "MLAT+",
                "label": "Local Mode-S + Open MLAT Position",
                "color": "#a855f7",
                "reg": str(open_ac.get("r", "")).strip(),
                "type": str(open_ac.get("t", "")).strip(),
                "desc": str(open_ac.get("desc", "")).strip(),
            }
            info["source"] = "HYBRID_MLAT"
            classifications[hx] = info
            if cls:
                tactical_list.append({
                    "hex": hx,
                    "flight": str(hybrid_ac.get("flight", "")).strip() or info.get("reg") or hx.upper(),
                    "category": cls["category"],
                    "badge": cls["badge"],
                    "reg": info.get("reg", ""),
                    "type": info.get("type", ""),
                    "desc": info.get("desc", ""),
                    "alt": hybrid_ac.get("alt_baro"),
                    "dst_nm": hybrid_ac.get("r_dst", 0.0),
                    "dir_deg": hybrid_ac.get("r_dir", 0.0),
                    "source": "HYBRID_MLAT",
                    "lat": hybrid_ac.get("lat"),
                    "lon": hybrid_ac.get("lon"),
                })
        elif cls:
            cls["source"] = "LOCAL"
            classifications[hx] = cls
            tactical_list.append({
                "hex": hx,
                "flight": str(ac.get("flight", "")).strip() or cls.get("reg") or hx.upper(),
                "category": cls["category"],
                "badge": cls["badge"],
                "reg": cls.get("reg", ""),
                "type": cls.get("type", ""),
                "desc": cls.get("desc", ""),
                "alt": ac.get("alt_baro"),
                "dst_nm": ac.get("r_dst", 0.0),
                "dir_deg": ac.get("r_dir", 0.0),
                "source": "LOCAL",
                "lat": ac.get("lat"),
                "lon": ac.get("lon"),
            })
        elif open_ac:
            # Pass along enriched registration/type for local planes
            classifications[hx] = {
                "category": "LOCAL",
                "badge": "LOCAL",
                "label": "Local Antenna",
                "color": "#22c55e",
                "reg": str(open_ac.get("r", "")).strip(),
                "type": str(open_ac.get("t", "")).strip(),
                "desc": str(open_ac.get("desc", "")).strip(),
                "source": "LOCAL",
            }

    # 2. Scan Open-Data feed for Tactical aircraft (NPAS, HEMS, SAR, MIL) & Blind-Spot augmentation
    for hx, open_ac in cached_open.items():
        if hx in local_by_hex:
            continue
        if "lat" not in open_ac or "lon" not in open_ac:
            continue
        if open_ac.get("alt_baro") == "ground":
            continue

        cls = classify_aircraft(open_ac)
        r_dst = float(open_ac.get("r_dst", 999.0) or 999.0)
        r_dir = float(open_ac.get("r_dir", 0.0) or 0.0)

        # Include all airborne Tactical aircraft (NPAS, HEMS, SAR, MIL) within 180 NM
        if cls and r_dst <= 180.0:
            aug_ac = dict(open_ac)
            aug_ac["seen"] = min(float(open_ac.get("seen", 1.0) or 1.0), 5.0)
            aug_ac["seen_pos"] = min(float(open_ac.get("seen_pos", 1.0) or 1.0), 5.0)
            aug_ac["aug_source"] = "OPEN_TACTICAL"
            augmented_aircraft.append(aug_ac)

            cls["source"] = "OPEN_TACTICAL"
            classifications[hx] = cls
            tactical_list.append({
                "hex": hx,
                "flight": str(open_ac.get("flight", "")).strip() or cls.get("reg") or hx.upper(),
                "category": cls["category"],
                "badge": cls["badge"],
                "reg": cls.get("reg", ""),
                "type": cls.get("type", ""),
                "desc": cls.get("desc", ""),
                "alt": open_ac.get("alt_baro"),
                "dst_nm": r_dst,
                "dir_deg": r_dir,
                "source": "OPEN_TACTICAL",
                "lat": open_ac.get("lat"),
                "lon": open_ac.get("lon"),
            })
        # Also include aircraft inside the NW roof blind-spot (285°-355°) within 65 NM
        elif 285.0 <= r_dir <= 355.0 and r_dst <= 65.0:
            aug_ac = dict(open_ac)
            aug_ac["seen"] = min(float(open_ac.get("seen", 1.0) or 1.0), 5.0)
            aug_ac["seen_pos"] = min(float(open_ac.get("seen_pos", 1.0) or 1.0), 5.0)
            aug_ac["aug_source"] = "OPEN_BLINDSPOT"
            augmented_aircraft.append(aug_ac)
            classifications[hx] = {
                "category": "BLINDSPOT",
                "badge": "NW-AUG",
                "label": "NW Roof-Shadow Augmented",
                "color": "#64748b",
                "reg": str(open_ac.get("r", "")).strip(),
                "type": str(open_ac.get("t", "")).strip(),
                "desc": str(open_ac.get("desc", "")).strip(),
                "source": "OPEN_BLINDSPOT",
            }

    tactical_list.sort(key=lambda x: x.get("dst_nm", 999.0))
    bench = compute_benchmark_stats()
    bench["local_with_pos"] = local_with_pos
    bench["local_mode_s_only"] = local_mode_s_only
    bench["furthest_live"] = furthest_local

    findings_summary = update_findings_log(local_ac_list, cached_open, classifications)

    # Nearby-airport weather + traffic buckets (local RF wins over open-feed duplicates)
    combined: Dict[str, Dict[str, Any]] = {h: a for h, a in cached_open.items()}
    for h, a in local_by_hex.items():
        merged_ac = dict(combined.get(h, {}))
        merged_ac.update({k: v for k, v in a.items() if v is not None})
        combined[h] = merged_ac
    try:
        airport_status = airports_mod.build_status(SITE_LAT, SITE_LON, list(combined.values()))
    except Exception as exc:
        print(f"[augmentd] airports error: {exc}", flush=True)
        airport_status = []

    payload = {
        "now": now_ts,
        "uat_978": "true",
        "benchmark": bench,
        "findings_summary": findings_summary,
        "airports": airport_status,
        "tactical_active": tactical_list,
        "classifications": classifications,
        "aircraft": augmented_aircraft,
    }

    tmp_path = OUTPUT_FILE + ".tmp"
    with open(tmp_path, "w") as f:
        json.dump(payload, f, separators=(",", ":"))
    os.replace(tmp_path, OUTPUT_FILE)


_LAST_FINDINGS_WRITE = 0.0


def update_findings_log(
    local_ac_list: List[Dict[str, Any]],
    cached_open: Dict[str, Dict[str, Any]],
    classifications: Dict[str, Dict[str, Any]],
) -> Dict[str, Any]:
    """Track decoder before/after performance and upstream tar1090-db discrepancies."""
    global _LAST_FINDINGS_WRITE
    now = time.time()

    existing: Dict[str, Any] = {}
    try:
        if os.path.exists(FINDINGS_FILE):
            with open(FINDINGS_FILE, "r") as f:
                existing = json.load(f)
    except Exception:
        existing = {}

    db_discrepancies: Dict[str, Any] = existing.get("db_discrepancies", {})
    local_only_hexes: Dict[str, Any] = existing.get("local_only_hexes", {})

    # 1. Check all combined aircraft for tactical classification vs upstream dbFlags/metadata gaps
    all_seen: Dict[str, Dict[str, Any]] = {}
    for hx, oac in cached_open.items():
        all_seen[hx] = dict(oac)
    for lac in local_ac_list:
        hx = str(lac.get("hex", "")).strip().lower()
        if not hx:
            continue
        merged = dict(all_seen.get(hx, {}))
        merged.update(lac)
        all_seen[hx] = merged

        # Track local-only detections (decoded by tuned local readsb, absent in community snapshot)
        if cached_open and hx not in cached_open and len(local_only_hexes) < 200:
            local_only_hexes[hx] = {
                "hex": hx,
                "r": lac.get("r", ""),
                "t": lac.get("t", ""),
                "desc": lac.get("desc", ""),
                "flight": str(lac.get("flight", "")).strip(),
                "rssi": lac.get("rssi"),
                "dst_nm": lac.get("r_dst"),
                "last_seen": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)),
            }

    for hx, info in classifications.items():
        cat = info.get("category")
        if cat not in ("NPAS", "HEMS", "SAR", "MIL"):
            continue
        ac = all_seen.get(hx, {})
        db_flags = int(ac.get("dbFlags", 0) or 0)
        reg = str(ac.get("r") or info.get("reg") or "").strip().upper()
        ac_type = str(ac.get("t") or info.get("type") or "").strip().upper()
        desc = str(ac.get("desc") or info.get("desc") or "").strip()
        own_op = str(ac.get("ownOp") or info.get("ownOp") or "").strip()
        fl = str(ac.get("flight") or "").strip().upper()

        # Check if upstream tar1090-db is missing military/interesting bitmask or metadata
        expected_flag = 1 if cat == "MIL" else 2
        missing_flag = (db_flags & expected_flag) == 0
        missing_meta = (not reg) or (not ac_type)
        if missing_flag or missing_meta:
            suggested_flags = db_flags | expected_flag
            db_discrepancies[hx] = {
                "hex": hx,
                "category": cat,
                "match_reason": info.get("match_reason", "rule"),
                "flight": fl,
                "r": reg,
                "t": ac_type,
                "desc": desc,
                "ownOp": own_op,
                "current_dbFlags": db_flags,
                "suggested_dbFlags": suggested_flags,
                "issue": (
                    "missing_dbFlags_and_metadata"
                    if (missing_flag and missing_meta)
                    else ("missing_dbFlags" if missing_flag else "missing_metadata")
                ),
                "tar1090_db_csv_suggestion": f"{hx.upper()};{reg};{ac_type};{suggested_flags};{desc};;{own_op or info.get('label', '')};",
                "last_seen": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)),
            }

    # 2. Compute live readsb decoder comparison against pre-tuning baseline
    decoder_eval: Dict[str, Any] = existing.get("decoder_evaluation", {})
    try:
        with open(os.path.join(READSB_DIR, "stats.json"), "r") as f:
            st = json.load(f)
        baseline = {}
        if os.path.exists(BASELINE_FILE):
            with open(BASELINE_FILE, "r") as f:
                baseline = json.load(f)

        # Use last15min if full, otherwise total since restart
        win = st.get("last15min", {})
        if (win.get("end", 0) - win.get("start", 0)) < 300:
            win = st.get("total", {})
        dur_s = max(1.0, float(win.get("end", 1.0) - win.get("start", 0.0)))
        loc = win.get("local", {})
        acc = loc.get("accepted", [0, 0])
        acc_0 = acc[0] if len(acc) > 0 else 0
        acc_1 = acc[1] if len(acc) > 1 else 0
        valid_msgs = max(1, int(win.get("messages_valid", 0) or 1))
        crc_1bit_pct = round((acc_1 / valid_msgs) * 100.0, 2)
        demod_ms = float(win.get("cpu", {}).get("demod", 0.0) or 0.0)
        demod_cpu_pct = round((demod_ms / (dur_s * 1000.0)) * 100.0, 2)

        total_local = len(local_ac_list)
        with_reg = sum(1 for a in local_ac_list if a.get("r"))
        db_enrichment_pct = round((with_reg / max(1, total_local)) * 100.0, 1) if total_local else 100.0

        base_l15 = baseline.get("last15min", {})
        base_acc = base_l15.get("local", {}).get("accepted", [204668, 10245])
        base_valid = max(1, int(base_l15.get("messages_valid", 214913) or 214913))
        base_1bit_pct = round((base_acc[1] / base_valid) * 100.0, 2)
        base_demod_pct = round((float(base_l15.get("cpu", {}).get("demod", 35789)) / 900000.0) * 100.0, 2)

        decoder_eval = {
            "baseline_captured_at": baseline.get("captured_at"),
            "evaluated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)),
            "window_seconds": round(dur_s, 1),
            "before": {
                "preamble_threshold": 42,
                "no_fix_df": True,
                "ppm_configured": 0,
                "estimated_ppm": baseline.get("config", {}).get("estimated_ppm", -2.6),
                "db_enrichment_pct": 0.0,
                "crc_1bit_recovery_pct": base_1bit_pct,
                "demod_cpu_core_pct": base_demod_pct,
            },
            "after": {
                "preamble_threshold": 40,
                "no_fix_df": False,
                "ppm_configured": 0,
                "estimated_ppm": st.get("estimated_ppm"),
                "db_enrichment_pct": db_enrichment_pct,
                "crc_1bit_recovery_pct": crc_1bit_pct,
                "demod_cpu_core_pct": demod_cpu_pct,
                "messages_per_sec": round(valid_msgs / dur_s, 1),
            },
            "deltas": {
                "db_enrichment_pct_delta": round(db_enrichment_pct - 0.0, 1),
                "crc_1bit_recovery_pct_delta": round(crc_1bit_pct - base_1bit_pct, 2),
                "demod_cpu_core_pct_delta": round(demod_cpu_pct - base_demod_pct, 2),
            },
        }
    except Exception:
        pass

    summary = {
        "db_discrepancies_count": len(db_discrepancies),
        "local_only_detections_count": len(local_only_hexes),
        "decoder_evaluation": decoder_eval,
    }

    if now - _LAST_FINDINGS_WRITE >= 15.0 or not os.path.exists(FINDINGS_FILE):
        try:
            os.makedirs(STATE_DIR, exist_ok=True)
            full_report = {
                "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)),
                "summary": summary,
                "decoder_evaluation": decoder_eval,
                "db_discrepancies": db_discrepancies,
                "local_only_hexes": local_only_hexes,
            }
            tmp_f = FINDINGS_FILE + ".tmp"
            with open(tmp_f, "w") as f:
                json.dump(full_report, f, indent=2)
            os.replace(tmp_f, FINDINGS_FILE)
            _LAST_FINDINGS_WRITE = now
        except Exception:
            pass

    return summary


def main() -> None:
    once = "--once" in sys.argv
    cached_open: Dict[str, Dict[str, Any]] = {}
    last_open_fetch = 0.0
    while True:
        now = time.time()
        if now - last_open_fetch >= 10.0:
            new_open = fetch_open_feeds()
            if new_open:
                cached_open = new_open
            last_open_fetch = now
        try:
            run_cycle(cached_open)
        except Exception as exc:
            print(f"[augmentd] cycle error: {exc}", flush=True)
        if once:
            break
        time.sleep(2.0)


if __name__ == "__main__":
    main()
