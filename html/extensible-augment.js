// -*- mode: javascript; indent-tabs-mode: nil; c-basic-offset: 4 -*-
"use strict";

/**
 * Extensible Tactical Classification, Open-Data Augmentation,
 * Interactive Airport FIDS/METAR Board, Modernized Avionics Left Panel,
 * Side-by-Side HD Map Comparator & Compact Single-Line Top Bar.
 */
(function () {
    const TacticalEngine = {
        categories: [],
        activeFilter: "ALL", // ALL, MIL, NPAS, HEMS_SAR, LOCAL_ONLY
        augmentEnabled: true,
        deadReckoningEnabled: true,
        airportsOverlay: true,
        airportsPanelOpen: false,
        selectedAirportIcao: "EGSS",
        rfPopoverOpen: false,
        tacPopoverOpen: false,
        rangeOutlineVisible: false,
        uiVersion: null,
        splitCompare: false,
        splitRatio: 0.5,
        splitLeftMap: "osm",
        splitRightMap: "carto_dark_all",
        latestAugment: null,
        classifications: {},
        furthestHex: null,
        furthestNm: 0,
        airportScreenHitboxes: [],

        registerCategory: function (cat) {
            this.categories.push(cat);
        },

        classify: function (plane) {
            if (!plane || !plane.icao) return null;
            const hx = String(plane.icao).toLowerCase();
            const srv = this.classifications[hx];

            if (srv) {
                if (!plane.registration && srv.reg) {
                    plane.registration = srv.reg;
                }
                if (!plane.icaoType && srv.type) {
                    plane.icaoType = srv.type;
                    if (typeof plane.setTypeData === "function") {
                        plane.setTypeData();
                    }
                }
                if (!plane.typeLong && srv.desc) {
                    plane.typeLong = srv.desc;
                }
                if (!plane.ownOp && srv.ownOp) {
                    plane.ownOp = srv.ownOp;
                }
                if (srv.route && !plane.augRoute) {
                    plane.augRoute = srv.route;
                    plane.augRouteVerbose = srv.route_verbose || "";
                }
            }

            const reg = String(plane.registration || (srv && srv.reg) || "").toUpperCase();
            const fl = String(plane.flight || plane.name || "").trim().toUpperCase();
            const sqk = String(plane.squawk || "").trim();
            const tp = String(plane.icaoType || (srv && srv.type) || "").toUpperCase();
            const op = String(plane.ownOp || (srv && srv.ownOp) || "").toUpperCase();

            for (let i = 0; i < this.categories.length; i++) {
                const c = this.categories[i];
                if (c.match({ hex: hx, reg: reg, flight: fl, squawk: sqk, type: tp, ownOp: op, plane: plane, srv: srv })) {
                    return {
                        category: c.id,
                        badge: c.badge,
                        label: c.label || c.badge,
                        color: c.color,
                        source: (srv && srv.source) || (plane.uat ? "OPEN_TACTICAL" : "LOCAL")
                    };
                }
            }

            if (srv && (srv.category === "HYBRID" || srv.category === "BLINDSPOT")) {
                return {
                    category: srv.category,
                    badge: srv.badge || srv.category,
                    label: srv.label || srv.badge,
                    color: srv.color || "#a855f7",
                    source: srv.source || "HYBRID_MLAT"
                };
            }
            return null;
        }
    };

    // 1. Pre-register UK / NATO Tactical Categories
    TacticalEngine.registerCategory({
        id: "NPAS",
        badge: "NPAS",
        label: "NPAS Police Air Service",
        color: "#38bdf8",
        match: function (ctx) {
            if (ctx.srv && ctx.srv.category === "NPAS") return true;
            return (
                ctx.reg.startsWith("G-POL") ||
                ctx.reg.startsWith("G-NPA") ||
                ctx.reg.startsWith("G-MPS") ||
                ctx.flight.startsWith("UKP") ||
                ctx.flight.startsWith("NPAS") ||
                ctx.flight.startsWith("POLICE") ||
                ctx.squawk === "0032" ||
                ctx.squawk === "7004" ||
                ctx.ownOp.indexOf("POLICE") !== -1
            );
        }
    });

    TacticalEngine.registerCategory({
        id: "HEMS",
        badge: "HEMS",
        label: "Air Ambulance (HEMS)",
        color: "#ef4444",
        match: function (ctx) {
            if (ctx.srv && ctx.srv.category === "HEMS") return true;
            const hemsRegs = [
                "G-EHM", "G-EHE", "G-ANG", "G-RESU", "G-LAA", "G-LNDN", "G-KSS",
                "G-GWA", "G-NWE", "G-NWA", "G-YAA", "G-YOR", "G-MAA", "G-DAA",
                "G-LIN", "G-HIW", "G-WAA", "G-WENU", "G-SCG", "G-SAS", "G-TVA", "G-CNW"
            ];
            for (let i = 0; i < hemsRegs.length; i++) {
                if (ctx.reg.startsWith(hemsRegs[i])) return true;
            }
            return (
                ctx.flight.startsWith("HLE") ||
                ctx.flight.startsWith("EHA") ||
                ctx.flight.startsWith("ANG") ||
                ctx.flight.startsWith("HELIMED") ||
                ctx.flight.startsWith("AIRAMB") ||
                ctx.flight.startsWith("LIFELN") ||
                ctx.squawk === "0020" ||
                ctx.ownOp.indexOf("AIR AMBULANCE") !== -1
            );
        }
    });

    TacticalEngine.registerCategory({
        id: "SAR",
        badge: "SAR",
        label: "HM Coastguard / SAR",
        color: "#f97316",
        match: function (ctx) {
            if (ctx.srv && ctx.srv.category === "SAR") return true;
            return (
                ctx.reg.startsWith("G-MCG") ||
                ctx.reg.startsWith("G-SAR") ||
                ctx.reg.startsWith("G-CG") ||
                ctx.reg.startsWith("G-WKTS") ||
                ctx.reg.startsWith("G-DLAA") ||
                ctx.flight.startsWith("SRG") ||
                ctx.flight.startsWith("RESCUE") ||
                ctx.flight.startsWith("COAST") ||
                ctx.squawk === "0023" ||
                ctx.squawk === "0036" ||
                ctx.ownOp.indexOf("COASTGUARD") !== -1 ||
                ctx.ownOp.indexOf("SEARCH AND RESCUE") !== -1
            );
        }
    });

    TacticalEngine.registerCategory({
        id: "MIL",
        badge: "MIL",
        label: "Military (RAF / USAF / NATO)",
        color: "#f59e0b",
        match: function (ctx) {
            if (ctx.srv && ctx.srv.category === "MIL") return true;
            if (ctx.plane && ctx.plane.military) return true;
            if (ctx.hex.startsWith("43c") || ctx.hex.startsWith("ae") || ctx.hex.startsWith("af")) return true;
            const milCalls = [
                "RRR", "AAC", "RFR", "VYT", "SHF", "BKH", "SYS", "TARTN", "LOSSIE",
                "TYPHOON", "COBRA", "VIPER", "LION", "NATO", "MMF", "RCH", "KNIFE",
                "JOLLY", "ASCOT", "TARTAN", "RAF", "NAVY", "ARMY", "GAF", "FAF", "BAF",
                "GONZO", "TALON", "REAPER", "FOCUS", "QUID", "HOBO", "BOLAR"
            ];
            for (let i = 0; i < milCalls.length; i++) {
                if (ctx.flight.startsWith(milCalls[i])) return true;
            }
            if (
                ctx.ownOp.indexOf("AIR FORCE") !== -1 ||
                ctx.ownOp.indexOf("ROYAL NAVY") !== -1 ||
                ctx.ownOp.indexOf("ARMY AIR") !== -1 ||
                ctx.ownOp.indexOf("MINISTRY OF DEFENCE") !== -1 ||
                ctx.ownOp.indexOf("QINETIQ") !== -1
            ) {
                return true;
            }
            return false;
        }
    });

    window.TacticalEngine = TacticalEngine;

    // 2. Hook PlaneObject methods for Airframe Shapes, Tactical Fidelity & Mode-S Dead-Reckoning
    function installPlaneHooks() {
        if (typeof PlaneObject === "undefined") return;

        const origUpdateData = PlaneObject.prototype.updateData;
        PlaneObject.prototype.updateData = function (now, last, data, init) {
            if (data && data.aug_source) {
                this.augSource = data.aug_source;
            } else if (!this.uat) {
                this.augSource = "LOCAL";
            }

            if (data) {
                if (data.r && !this.registration) this.registration = String(data.r);
                if (data.desc && !this.typeLong) this.typeLong = String(data.desc);
                if (data.ownOp && !this.ownOp) this.ownOp = String(data.ownOp);
                if (data.t && data.t !== this.icaoType) {
                    this.icaoType = String(data.t);
                    if (typeof this.setTypeData === "function") {
                        this.setTypeData();
                    }
                }
            }

            origUpdateData.call(this, now, last, data, init);

            if (this.icaoType && !this.typeDescription && typeof g !== "undefined" && g.type_cache) {
                this.icaoTypeCache = null;
                if (typeof this.setTypeData === "function") {
                    this.setTypeData();
                }
            }

            // Save last real GPS fix for Mode-S Dead-Reckoning
            if (this.position && this.seen_pos != null && this.seen_pos < 10) {
                this.lastRealPos = [this.position[0], this.position[1]];
                this.lastRealPosTime = now - this.seen_pos;
            } else if (
                TacticalEngine.deadReckoningEnabled &&
                this.lastRealPos &&
                this.seen < 15 &&
                this.seen_pos > 30 &&
                this.seen_pos < 180 &&
                this.gs > 40 &&
                this.rotation != null
            ) {
                const dtHours = Math.max(0, (now - this.lastRealPosTime)) / 3600.0;
                const distNm = this.gs * dtHours;
                if (distNm > 0.05 && distNm < 20.0) {
                    const brngRad = (this.rotation * Math.PI) / 180.0;
                    const lat1 = this.lastRealPos[1];
                    const lon1 = this.lastRealPos[0];
                    const dLat = (distNm / 60.0) * Math.cos(brngRad);
                    const dLon = (distNm / (60.0 * Math.cos((lat1 * Math.PI) / 180.0))) * Math.sin(brngRad);
                    this.position = [lon1 + dLon, lat1 + dLat];
                    this.position_time = now - 5;
                    this.coastedModeS = true;
                }
            } else {
                this.coastedModeS = false;
            }

            const cls = TacticalEngine.classify(this);
            if (cls) {
                this.tacticalCategory = cls.category;
                this.tacticalBadge = cls.badge;
                this.tacticalLabel = cls.label;
                this.tacticalColor = cls.color;
                this.tacticalSource = cls.source;
                if (cls.category === "NPAS" || cls.category === "HEMS" || cls.category === "SAR" || cls.category === "MIL") {
                    this.military = true;
                    this.interesting = true;
                }
            } else {
                this.tacticalCategory = null;
                this.tacticalBadge = null;
                this.tacticalLabel = null;
            }
        };

        const origIsFiltered = PlaneObject.prototype.isFiltered;
        PlaneObject.prototype.isFiltered = function () {
            if (origIsFiltered.call(this)) return true;

            const isAug = this.uat || (this.augSource && this.augSource !== "LOCAL");
            if (isAug && (!TacticalEngine.augmentEnabled || TacticalEngine.activeFilter === "LOCAL_ONLY")) {
                return true;
            }

            const f = TacticalEngine.activeFilter;
            if (f === "MIL") {
                return this.tacticalCategory !== "MIL" && !this.military;
            }
            if (f === "NPAS") {
                return this.tacticalCategory !== "NPAS";
            }
            if (f === "HEMS_SAR") {
                return this.tacticalCategory !== "HEMS" && this.tacticalCategory !== "SAR";
            }
            return false;
        };

        const origUpdateIcon = PlaneObject.prototype.updateIcon;
        PlaneObject.prototype.updateIcon = function () {
            const savedFlight = this.flight;
            try {
                let prefix = "";
                if (
                    this.tacticalBadge &&
                    (this.tacticalCategory === "MIL" ||
                        this.tacticalCategory === "NPAS" ||
                        this.tacticalCategory === "HEMS" ||
                        this.tacticalCategory === "SAR")
                ) {
                    prefix = "[" + this.tacticalBadge + "] ";
                }
                if (prefix) {
                    const baseName = (this.flight && this.flight.trim()) || this.registration || this.icao.toUpperCase();
                    if (!baseName.startsWith(prefix.trim())) {
                        this.flight = prefix + baseName;
                    }
                }
                origUpdateIcon.call(this);
            } finally {
                this.flight = savedFlight;
            }
        };
    }

    // 3. Clean Map Overlay: Event-Driven Interactive Airport Pins + Tactical Target Lock Brackets
    let radarCanvas = null;
    let radarCtx = null;
    let overlayRafPending = false;
    let lastHudHtml = "";
    let lastAirportsHtml = "";
    let lastBannerHtml = "";

    function resizeRadarCanvas() {
        const mapEl = document.getElementById("map_canvas");
        if (!radarCanvas || !mapEl) return;
        const dpr = window.devicePixelRatio || 1;
        const w = mapEl.clientWidth || window.innerWidth;
        const h = mapEl.clientHeight || window.innerHeight;
        if (radarCanvas.width !== Math.round(w * dpr) || radarCanvas.height !== Math.round(h * dpr)) {
            radarCanvas.width = Math.round(w * dpr);
            radarCanvas.height = Math.round(h * dpr);
            radarCanvas.style.width = w + "px";
            radarCanvas.style.height = h + "px";
        }
    }

    function scheduleOverlayDraw() {
        if (overlayRafPending) return;
        overlayRafPending = true;
        requestAnimationFrame(function () {
            overlayRafPending = false;
            drawCleanOverlay(resizeRadarCanvas);
        });
    }

    const FLT_CAT_COLORS = { VFR: "#22c55e", MVFR: "#38bdf8", IFR: "#ef4444", LIFR: "#d946ef" };

    function fmtWind(m) {
        if (!m) return "No METAR";
        if (m.wspd === 0 || m.wspd == null) return "Calm";
        const dir = (typeof m.wdir === "number") ? String(Math.round(m.wdir)).padStart(3, "0") : "VRB";
        return `${dir}°/${m.wspd}${m.wgst ? "G" + m.wgst : ""}kt`;
    }

    function fmtVis(m) {
        if (!m || m.vis_sm == null) return "--";
        const v = Number(m.vis_sm);
        if (isNaN(v)) return String(m.vis_sm);
        return v >= 6.2 ? "10km+" : (v * 1.609).toFixed(v < 1 ? 1 : 0) + "km";
    }

    function disableConcentricRangeCircles() {
        try {
            window.SiteCircles = false;
            if (typeof loStore !== "undefined") {
                loStore["SiteCircles"] = "false";
                if (!loStore["clean_map_v3_init"]) {
                    loStore["clean_map_v3_init"] = "1";
                    loStore["actual_range_outline"] = "false";
                    if (typeof deselectAllTracks === "function") {
                        deselectAllTracks();
                    }
                }
            }
            if (typeof layers_group !== "undefined" && typeof ol !== "undefined") {
                ol.control.LayerSwitcher.forEachRecursive(layers_group, function (lyr) {
                    const nm = lyr.get("name");
                    if (nm === "site_circles" || nm === "upintheair") {
                        lyr.setVisible(false);
                    } else if (nm === "actual_range_outline") {
                        lyr.setVisible(Boolean(TacticalEngine.rangeOutlineVisible));
                    }
                });
            }
        } catch (e) {}
    }

    function initMapCanvasOverlay() {
        const mapEl = document.getElementById("map_canvas");
        if (!mapEl || document.getElementById("tar1090-radar-overlay")) return;

        radarCanvas = document.createElement("canvas");
        radarCanvas.id = "tar1090-radar-overlay";
        mapEl.appendChild(radarCanvas);
        radarCtx = radarCanvas.getContext("2d");

        window.addEventListener("resize", function () {
            resizeRadarCanvas();
            scheduleOverlayDraw();
        });
        resizeRadarCanvas();

        // Allow clicking an airport pin on the map to open its FIDS / METAR card
        mapEl.addEventListener("click", function (evt) {
            scheduleOverlayDraw();
            if (!TacticalEngine.airportsOverlay || !TacticalEngine.airportScreenHitboxes.length) return;
            const rect = mapEl.getBoundingClientRect();
            const cx = evt.clientX - rect.left;
            const cy = evt.clientY - rect.top;
            for (let i = 0; i < TacticalEngine.airportScreenHitboxes.length; i++) {
                const hb = TacticalEngine.airportScreenHitboxes[i];
                if (cx >= hb.x1 && cx <= hb.x2 && cy >= hb.y1 && cy <= hb.y2) {
                    TacticalEngine.selectedAirportIcao = hb.icao;
                    TacticalEngine.airportsPanelOpen = true;
                    renderAirportsPanel();
                    renderHud();
                    scheduleOverlayDraw();
                    evt.stopPropagation();
                    return;
                }
            }
        });

        // Redraw overlay only when OpenLayers renders/pans or data updates (eliminates idle 60 FPS spin)
        if (typeof OLMap !== "undefined" && OLMap.on) {
            OLMap.on("postrender", scheduleOverlayDraw);
            OLMap.on("moveend", scheduleOverlayDraw);
        }
        scheduleOverlayDraw();
    }

    function drawAirportMarkers(ctx, dpr, w, h) {
        const aug = TacticalEngine.latestAugment;
        TacticalEngine.airportScreenHitboxes = [];
        if (!TacticalEngine.airportsOverlay || !aug || !Array.isArray(aug.airports)) return;
        const zoom = OLMap.getView().getZoom() || 9;
        ctx.save();
        ctx.textBaseline = "middle";

        for (let i = 0; i < aug.airports.length; i++) {
            const a = aug.airports[i];
            const px = OLMap.getPixelFromCoordinate(ol.proj.fromLonLat([a.lon, a.lat]));
            if (!px) continue;
            const x = px[0] * dpr, y = px[1] * dpr;
            if (x < -50 || y < -50 || x > w + 50 || y > h + 50) continue;

            const m = a.metar;
            const col = (m && FLT_CAT_COLORS[m.cat]) || "#64748b";
            const isSel = TacticalEngine.airportsPanelOpen && TacticalEngine.selectedAirportIcao === a.icao;
            const totalMoves = (a.inbound ? a.inbound.length : 0) + (a.departing ? a.departing.length : 0) + (a.local ? a.local.length : 0);

            // Runway centerline segment scaled cleanly to zoom
            const res = OLMap.getView().getResolution() || 1;
            const nmPx = 1852 / (res * Math.cos(a.lat * Math.PI / 180));
            const half = Math.max(6 * dpr, Math.min(36 * dpr, 0.65 * nmPx * dpr));
            const rad = ((a.axis - 90) * Math.PI) / 180.0;

            ctx.strokeStyle = isSel ? "#38bdf8" : col;
            ctx.lineWidth = (isSel ? 3.0 : 2.0) * dpr;
            ctx.beginPath();
            ctx.moveTo(x - half * Math.cos(rad), y - half * Math.sin(rad));
            ctx.lineTo(x + half * Math.cos(rad), y + half * Math.sin(rad));
            ctx.stroke();

            // Center dot
            ctx.beginPath();
            ctx.arc(x, y, (isSel ? 4.2 : 3.0) * dpr, 0, Math.PI * 2);
            ctx.fillStyle = isSel ? "#38bdf8" : col;
            ctx.fill();

            // Compact, non-distracting pill tag (only ICAO + active runway / traffic count)
            if (zoom < 8.0 && !totalMoves && !isSel) {
                TacticalEngine.airportScreenHitboxes.push({
                    icao: a.icao,
                    x1: px[0] - 10,
                    y1: px[1] - 10,
                    x2: px[0] + 10,
                    y2: px[1] + 10
                });
                continue;
            }

            let tag = a.icao;
            if (a.active_rwy && zoom >= 8.8) {
                tag += "·" + a.active_rwy;
            }
            if (totalMoves > 0) {
                tag += ` (${totalMoves})`;
            }

            ctx.font = `700 ${Math.round(9.5 * dpr)}px ui-monospace, Menlo, Consolas, monospace`;
            const tw = ctx.measureText(tag).width;
            const bw = tw + 9 * dpr;
            const bh = 15 * dpr;
            const bx = x + 7 * dpr;
            const by = y - bh / 2;

            ctx.fillStyle = isSel ? "rgba(2, 132, 199, 0.92)" : "rgba(11, 17, 32, 0.80)";
            ctx.fillRect(bx, by, bw, bh);
            ctx.fillStyle = col;
            ctx.fillRect(bx, by, 2.5 * dpr, bh);

            ctx.fillStyle = isSel ? "#ffffff" : "#e2e8f0";
            ctx.textAlign = "left";
            ctx.fillText(tag, bx + 5 * dpr, by + bh / 2 + 0.5 * dpr);

            TacticalEngine.airportScreenHitboxes.push({
                icao: a.icao,
                x1: px[0] - 8,
                y1: (by / dpr) - 3,
                x2: ((bx + bw) / dpr) + 4,
                y2: ((by + bh) / dpr) + 3
            });
        }
        ctx.restore();
    }

    function drawCleanOverlay(resizeFn) {
        if (!radarCanvas || !radarCtx || typeof OLMap === "undefined" || typeof ol === "undefined") return;
        resizeFn();
        const dpr = window.devicePixelRatio || 1;
        const w = radarCanvas.width;
        const h = radarCanvas.height;
        const ctx = radarCtx;
        ctx.clearRect(0, 0, w, h);

        drawAirportMarkers(ctx, dpr, w, h);

        // Tactical Target Lock Brackets on Active NPAS / HEMS / SAR / MIL & Selected Aircraft
        if (typeof g !== "undefined" && Array.isArray(g.planesOrdered)) {
            ctx.save();
            for (let i = 0; i < g.planesOrdered.length; i++) {
                const p = g.planesOrdered[i];
                if (!p || !p.visible || !p.position) continue;
                const isTac = p.tacticalCategory === "NPAS" || p.tacticalCategory === "HEMS" || p.tacticalCategory === "SAR" || p.tacticalCategory === "MIL";
                if (!isTac && !p.selected) continue;

                const coord = ol.proj.fromLonLat(p.position);
                const px = OLMap.getPixelFromCoordinate(coord);
                if (!px) continue;

                const tx = px[0] * dpr;
                const ty = px[1] * dpr;
                if (tx < 0 || ty < 0 || tx > w || ty > h) continue;

                const col = p.tacticalColor || (p.selected ? "#38bdf8" : "#34d399");
                const box = (p.selected ? 16 : 13) * dpr;
                const corner = 4.5 * dpr;

                ctx.strokeStyle = col;
                ctx.lineWidth = 1.5 * dpr;
                ctx.beginPath();
                ctx.moveTo(tx - box, ty - box + corner);
                ctx.lineTo(tx - box, ty - box);
                ctx.lineTo(tx - box + corner, ty - box);
                ctx.moveTo(tx + box - corner, ty - box);
                ctx.lineTo(tx + box, ty - box);
                ctx.lineTo(tx + box, ty - box + corner);
                ctx.moveTo(tx + box, ty + box - corner);
                ctx.lineTo(tx + box, ty + box);
                ctx.lineTo(tx + box - corner, ty + box);
                ctx.moveTo(tx - box + corner, ty + box);
                ctx.lineTo(tx - box, ty + box);
                ctx.lineTo(tx - box, ty + box - corner);
                ctx.stroke();
            }
            ctx.restore();
        }
    }

    // 4. Redesigned Interactive Airport FIDS / ATIS Drawer
    function renderFlightRow(ac, badgeSymbol, badgeColor, dirMode) {
        const altTxt = ac.alt === "ground" ? "GND" : (ac.alt != null ? `${Number(ac.alt).toLocaleString()}ft` : "--");
        const vr = ac.vr || 0;
        const vrArrow = vr < -200 ? "↓" : (vr > 200 ? "↑" : "");
        const gsTxt = ac.gs ? `${ac.gs}kt` : "";
        let tagTxt = ac.type || "";
        if (ac.peer) {
            const pfx = dirMode === "in" ? "←" : (dirMode === "out" ? "→" : "");
            tagTxt = `${pfx}${ac.peer}${ac.type ? "·" + ac.type : ""}`;
        } else if (ac.route) {
            tagTxt = ac.route;
        }
        const routeTitle = ac.route ? `${ac.route}${ac.peer_loc ? " (" + ac.peer_loc + ")" : ""}` : (ac.desc || "");
        return `
            <div class="fids-flight-row" data-fhex="${ac.hex}" data-flat="${ac.lat || ""}" data-flon="${ac.lon || ""}" title="${routeTitle}">
                <span class="fids-fl-sym" style="color:${badgeColor}">${badgeSymbol}</span>
                <b class="fids-fl-call">${ac.flight}</b>
                <span class="fids-fl-type">${tagTxt}</span>
                <span class="fids-fl-alt">${altTxt}${vrArrow}</span>
                <span class="fids-fl-gs">${gsTxt}</span>
                <span class="fids-fl-dst">${ac.dst_nm}NM</span>
            </div>
        `;
    }

    function renderAirportsPanel() {
        let el = document.getElementById("tar1090-airports-panel");
        const aug = TacticalEngine.latestAugment;
        if (!aug || !Array.isArray(aug.airports) || !aug.airports.length) return;
        if (!el) {
            el = document.createElement("div");
            el.id = "tar1090-airports-panel";
            document.body.appendChild(el);
        }

        if (!TacticalEngine.airportsPanelOpen) {
            el.style.display = "none";
            return;
        }
        el.style.display = "block";

        // Pick selected airport (or default to first airport with METAR/traffic)
        let selApt = null;
        for (let i = 0; i < aug.airports.length; i++) {
            if (aug.airports[i].icao === TacticalEngine.selectedAirportIcao) {
                selApt = aug.airports[i];
                break;
            }
        }
        if (!selApt) {
            selApt = aug.airports[0];
            TacticalEngine.selectedAirportIcao = selApt.icao;
        }

        // Build top airport selector tabs (prioritize airports with METAR or active traffic)
        let tabsHtml = "";
        for (let i = 0; i < aug.airports.length; i++) {
            const a = aug.airports[i];
            const m = a.metar;
            const col = (m && FLT_CAT_COLORS[m.cat]) || "#64748b";
            const cnt = a.inbound.length + a.departing.length + a.local.length + a.ground.length;
            const isAct = (a.icao === selApt.icao) ? "active" : "";
            tabsHtml += `
                <button class="fids-tab ${isAct}" data-apt-icao="${a.icao}" title="${a.name} (${a.dist_nm} NM)">
                    <span class="apt-dot" style="background:${col}"></span>
                    <span>${a.icao}</span>
                    ${cnt > 0 ? `<span class="fids-tab-cnt">${cnt}</span>` : ""}
                </button>
            `;
        }

        const m = selApt.metar;
        const cat = (m && m.cat) || "N/A";
        const catCol = (m && FLT_CAT_COLORS[m.cat]) || "#64748b";
        const rwyLabel = selApt.active_rwy ? `RWY ${selApt.active_rwy} ACTIVE` : `RWY ${selApt.rwy_pair}`;
        const qnhTxt = (m && m.qnh) ? `${Math.round(m.qnh)} hPa` : "--";
        const tempTxt = (m && m.temp != null) ? `${Math.round(m.temp)}°C / ${m.dewp != null ? Math.round(m.dewp) + "°C" : "--"}` : "--";

        // Arrivals column (Inbound)
        let inRows = "";
        if (selApt.inbound.length > 0) {
            for (let i = 0; i < selApt.inbound.length; i++) {
                inRows += renderFlightRow(selApt.inbound[i], "▼", "#38bdf8", "in");
            }
        } else {
            inRows = `<div class="fids-empty">No aircraft currently on approach</div>`;
        }

        // Departures & Local/Ground column
        let outRows = "";
        for (let i = 0; i < selApt.departing.length; i++) {
            outRows += renderFlightRow(selApt.departing[i], "▲", "#34d399", "out");
        }
        for (let i = 0; i < selApt.local.length; i++) {
            outRows += renderFlightRow(selApt.local[i], "⟳", "#fbbf24", "loc");
        }
        for (let i = 0; i < selApt.ground.length; i++) {
            outRows += renderFlightRow(selApt.ground[i], "⏚", "#94a3b8", "gnd");
        }
        if (!outRows) {
            outRows = `<div class="fids-empty">No departures or surface traffic</div>`;
        }

        const nextHtml = `
            <div class="fids-header">
                <div class="fids-title-wrap">
                    <span class="fids-cat-pill" style="background:${catCol}25;border-color:${catCol};color:${catCol}">${cat}</span>
                    <b class="fids-apt-title">${selApt.icao} · ${selApt.name}</b>
                    <span class="fids-rwy-pill">${rwyLabel}</span>
                    <span class="fids-apt-dist">${selApt.dist_nm} NM</span>
                </div>
                <div class="fids-actions">
                    <button class="thud-btn" id="fids-center-apt" title="Center map on ${selApt.name}">◉ Map</button>
                    <button class="thud-btn ${TacticalEngine.airportsOverlay ? "active" : ""}" id="fids-toggle-pins" title="Toggle airport pins on map">Pins: ${TacticalEngine.airportsOverlay ? "ON" : "OFF"}</button>
                    <button class="thud-btn" id="fids-close" title="Close Airport Board">✕</button>
                </div>
            </div>
            <div class="fids-tabs-bar">${tabsHtml}</div>
            <div class="fids-wx-strip">
                <div><span>WIND</span> <b>${fmtWind(m)}</b></div>
                <div><span>VIS</span> <b>${fmtVis(m)}</b></div>
                <div><span>CLOUDS</span> <b>${m ? m.clouds : "--"}</b></div>
                <div><span>TEMP/DP</span> <b>${tempTxt}</b></div>
                <div><span>QNH</span> <b>${qnhTxt}</b></div>
            </div>
            ${m && m.raw ? `<div class="fids-metar-raw" title="${m.raw}"><b>METAR:</b> ${m.raw}</div>` : ""}
            ${selApt.taf ? `<div class="fids-metar-raw" title="${selApt.taf}"><b>TAF:</b> ${selApt.taf}</div>` : ""}
            <div class="fids-board-grid">
                <div class="fids-col">
                    <div class="fids-col-head"><span>▼ ARRIVALS / APPROACH</span> <b>${selApt.inbound.length}</b></div>
                    <div class="fids-col-list">${inRows}</div>
                </div>
                <div class="fids-col">
                    <div class="fids-col-head"><span>▲ DEPARTURES / CIRCUIT / GND</span> <b>${selApt.departing.length + selApt.local.length + selApt.ground.length}</b></div>
                    <div class="fids-col-list">${outRows}</div>
                </div>
            </div>
        `;
        if (nextHtml === lastAirportsHtml) return;
        lastAirportsHtml = nextHtml;
        el.innerHTML = nextHtml;

        // Wire events
        document.getElementById("fids-close").onclick = function () {
            TacticalEngine.airportsPanelOpen = false;
            renderAirportsPanel();
            renderHud();
            scheduleOverlayDraw();
        };
        document.getElementById("fids-toggle-pins").onclick = function () {
            TacticalEngine.airportsOverlay = !TacticalEngine.airportsOverlay;
            renderAirportsPanel();
            scheduleOverlayDraw();
        };
        document.getElementById("fids-center-apt").onclick = function () {
            OLMap.getView().animate({
                center: ol.proj.fromLonLat([selApt.lon, selApt.lat]),
                zoom: Math.max(OLMap.getView().getZoom() || 9, 11.2),
                duration: 350
            });
        };

        const tabBtns = el.querySelectorAll("[data-apt-icao]");
        for (let i = 0; i < tabBtns.length; i++) {
            tabBtns[i].onclick = function () {
                TacticalEngine.selectedAirportIcao = this.getAttribute("data-apt-icao");
                renderAirportsPanel();
                scheduleOverlayDraw();
            };
        }

        const flRows = el.querySelectorAll(".fids-flight-row");
        for (let i = 0; i < flRows.length; i++) {
            flRows[i].onclick = function () {
                const hx = this.getAttribute("data-fhex");
                const lt = this.getAttribute("data-flat");
                const ln = this.getAttribute("data-flon");
                focusAircraft(hx, lt ? Number(lt) : null, ln ? Number(ln) : null);
            };
        }
    }

    // 5. Modernize the Left Aircraft Telemetry Panel (#selected_infoblock) & Dark Avionics Theme
    function applyDarkAvionicsTheme() {
        const root = document.documentElement;
        root.style.setProperty("--BGCOLOR1", "#0b1120");
        root.style.setProperty("--BGCOLOR2", "#111827");
        root.style.setProperty("--TXTCOLOR1", "#94a3b8");
        root.style.setProperty("--TXTCOLOR2", "#f1f5f9");
        root.style.setProperty("--TXTCOLOR3", "#38bdf8");
        if (typeof tableColorsDark !== "undefined") {
            window.tableColors = tableColorsDark;
        }
        if (typeof jQuery !== "undefined") {
            jQuery(".infoblockCloseBox, .settingsCloseBox").css("filter", "invert(100%)");
        }
        disableConcentricRangeCircles();
    }

    function updateLeftAircraftPanelBadge() {
        const infoBlock = document.getElementById("selected_infoblock");
        if (!infoBlock || infoBlock.style.display === "none" || typeof SelectedPlane === "undefined" || !SelectedPlane) {
            return;
        }
        let banner = document.getElementById("tar1090-avionics-card-header");
        const container = document.getElementById("infoblock-container");
        if (!container) return;

        if (!banner) {
            banner = document.createElement("div");
            banner.id = "tar1090-avionics-card-header";
            container.insertBefore(banner, container.firstChild);
            lastBannerHtml = "";
        }

        const p = SelectedPlane;
        const cat = p.tacticalCategory || (p.uat ? "AUGMENTED" : "LOCAL RF");
        const col = p.tacticalColor || (p.uat ? "#a855f7" : "#10b981");
        const badgeText = p.tacticalLabel || (p.uat ? "Open-Data Augmented" : "Local Antenna RF");
        const modelText = p.typeLong || p.icaoType || "Aircraft";
        const typeCode = p.icaoType ? `ICAO: ${p.icaoType}` : "";
        const regText = p.registration ? `REG: ${p.registration}` : `HEX: ${String(p.icao).toUpperCase()}`;
        const opObj = p.getAirline && p.getAirline();
        const opText = p.ownOp || (opObj && typeof opObj === "object" ? opObj.n : opObj) || "";
        const routeCode = p.augRoute || p.routeString || "";
        const routeVerb = p.augRouteVerbose || p.routeVerbose || "";

        const nextBannerHtml = `
            <div class="avionics-badge-row">
                <span class="avionics-pill" style="background:${col}22;border-color:${col};color:${col};">${cat}</span>
                <span class="avionics-sub">${badgeText}</span>
            </div>
            <div class="avionics-model">${modelText}</div>
            <div class="avionics-meta">${regText} ${typeCode ? "· " + typeCode : ""}</div>
            ${routeCode ? `<div class="avionics-meta" style="color:#34d399;margin-top:2px;">✈ ${routeCode}${routeVerb ? " · " + routeVerb : ""}</div>` : ""}
            ${opText ? `<div class="avionics-op">${opText}</div>` : ""}
        `;
        if (nextBannerHtml !== lastBannerHtml) {
            lastBannerHtml = nextBannerHtml;
            banner.innerHTML = nextBannerHtml;
        }
    }

    // 6. Side-by-Side Split-Screen & Single Base Map Switcher
    function getPresetInfo(mapId) {
        const list = window.HudMapPresets || [];
        for (let i = 0; i < list.length; i++) {
            if (list[i].id === mapId) return list[i];
        }
        return { id: mapId, label: mapId, bg: "#0e131a" };
    }

    let splitClipInstalled = false;
    function installSplitClipHooks() {
        if (splitClipInstalled || typeof layers_group === "undefined" || typeof ol === "undefined") return;
        splitClipInstalled = true;

        ol.control.LayerSwitcher.forEachRecursive(layers_group, function (lyr) {
            if (!lyr.get("name") || lyr.get("type") !== "base") return;

            lyr.on("prerender", function (evt) {
                if (!TacticalEngine.splitCompare || !evt.context) return;
                const name = lyr.get("name");
                const isLeft = name === TacticalEngine.splitLeftMap;
                const isRight = name === TacticalEngine.splitRightMap;
                if (!isLeft && !isRight) return;

                const ctx = evt.context;
                const w = ctx.canvas.width;
                const h = ctx.canvas.height;
                const mapEl = document.getElementById("map_canvas");
                const mapWidthCss = (mapEl && mapEl.clientWidth) || window.innerWidth;
                const scaleX = w / Math.max(1, mapWidthCss);
                const splitX = Math.round(mapWidthCss * TacticalEngine.splitRatio * scaleX);

                ctx.save();
                ctx.beginPath();
                if (isLeft && !isRight) {
                    ctx.rect(0, 0, splitX, h);
                } else if (isRight && !isLeft) {
                    ctx.rect(splitX, 0, w - splitX, h);
                } else {
                    ctx.rect(0, 0, w, h);
                }
                ctx.clip();

                const info = getPresetInfo(name);
                if (info && info.bg) {
                    ctx.fillStyle = info.bg;
                    if (isLeft && !isRight) {
                        ctx.fillRect(0, 0, splitX, h);
                    } else if (isRight && !isLeft) {
                        ctx.fillRect(splitX, 0, w - splitX, h);
                    }
                }
            });

            lyr.on("postrender", function (evt) {
                if (!TacticalEngine.splitCompare || !evt.context) return;
                const name = lyr.get("name");
                if (name === TacticalEngine.splitLeftMap || name === TacticalEngine.splitRightMap) {
                    evt.context.restore();
                }
            });
        });
    }

    function applyMapVisibility() {
        if (typeof layers_group === "undefined" || typeof ol === "undefined") return;
        installSplitClipHooks();
        disableConcentricRangeCircles();

        if (!TacticalEngine.splitCompare) {
            ol.control.LayerSwitcher.forEachRecursive(layers_group, function (lyr) {
                if (lyr.get("name") && lyr.get("type") === "base") {
                    lyr.setVisible(lyr.get("name") === MapType_tar1090);
                }
            });
        } else {
            ol.control.LayerSwitcher.forEachRecursive(layers_group, function (lyr) {
                if (lyr.get("name") && lyr.get("type") === "base") {
                    const nm = lyr.get("name");
                    const vis = (nm === TacticalEngine.splitLeftMap || nm === TacticalEngine.splitRightMap);
                    lyr.setVisible(vis);
                    if (vis) {
                        const onVisible = lyr.get("onVisible");
                        if (onVisible) onVisible(lyr);
                    }
                }
            });
        }
        updateSplitDividerDom();
        if (typeof OLMap !== "undefined") {
            OLMap.render();
        }
    }

    function switchBaseMap(targetName) {
        MapType_tar1090 = loStore["MapType_tar1090"] = targetName;
        loStore["extensible_hd_map_init"] = "1";
        if (TacticalEngine.splitCompare) {
            TacticalEngine.splitRightMap = targetName;
        }
        applyMapVisibility();
        renderHud();
    }

    function toggleSplitCompare(forceState) {
        TacticalEngine.splitCompare = (typeof forceState === "boolean") ? forceState : !TacticalEngine.splitCompare;
        if (TacticalEngine.splitCompare) {
            if (MapType_tar1090 === "osm") {
                TacticalEngine.splitLeftMap = "osm";
                TacticalEngine.splitRightMap = "carto_dark_all";
            } else {
                TacticalEngine.splitLeftMap = "osm";
                TacticalEngine.splitRightMap = MapType_tar1090 || "carto_dark_all";
            }
        }
        applyMapVisibility();
        renderHud();
    }

    function updateSplitDividerDom() {
        let div = document.getElementById("tar1090-split-divider");
        const mapEl = document.getElementById("map_canvas");
        if (!TacticalEngine.splitCompare || !mapEl) {
            if (div) div.style.display = "none";
            return;
        }
        if (!div) {
            div = document.createElement("div");
            div.id = "tar1090-split-divider";
            div.innerHTML = `
                <div class="split-handle">
                    <span class="split-tag split-tag-left" id="split-label-left">LEFT</span>
                    <span class="split-grip">⇔</span>
                    <span class="split-tag split-tag-right" id="split-label-right">RIGHT</span>
                </div>
            `;
            mapEl.appendChild(div);

            let dragging = false;
            const onMove = function (clientX) {
                if (!dragging) return;
                const rect = mapEl.getBoundingClientRect();
                const ratio = Math.min(0.92, Math.max(0.08, (clientX - rect.left) / Math.max(1, rect.width)));
                TacticalEngine.splitRatio = ratio;
                div.style.left = (ratio * 100).toFixed(1) + "%";
                if (typeof OLMap !== "undefined") OLMap.render();
            };

            div.addEventListener("mousedown", function (e) {
                dragging = true;
                e.preventDefault();
            });
            window.addEventListener("mousemove", function (e) {
                onMove(e.clientX);
            });
            window.addEventListener("mouseup", function () {
                dragging = false;
            });

            div.addEventListener("touchstart", function (e) {
                dragging = true;
                e.stopPropagation();
            }, { passive: true });
            window.addEventListener("touchmove", function (e) {
                if (dragging && e.touches && e.touches[0]) {
                    onMove(e.touches[0].clientX);
                }
            }, { passive: true });
            window.addEventListener("touchend", function () {
                dragging = false;
            });
        }

        div.style.display = "block";
        div.style.left = (TacticalEngine.splitRatio * 100).toFixed(1) + "%";
        const lInfo = getPresetInfo(TacticalEngine.splitLeftMap);
        const rInfo = getPresetInfo(TacticalEngine.splitRightMap);
        const lEl = document.getElementById("split-label-left");
        const rEl = document.getElementById("split-label-right");
        if (lEl) lEl.textContent = "◀ " + lInfo.label;
        if (rEl) rEl.textContent = rInfo.label + " ▶";
    }

    function focusAircraft(hex, lat, lon) {
        if (!hex) return;
        const h = String(hex).toLowerCase();
        if (typeof selectPlaneByHex === "function") {
            selectPlaneByHex(h, { follow: true });
        }
        if (lat != null && lon != null && typeof OLMap !== "undefined" && typeof ol !== "undefined") {
            OLMap.getView().animate({
                center: ol.proj.fromLonLat([Number(lon), Number(lat)]),
                zoom: Math.max(OLMap.getView().getZoom() || 9, 10.2),
                duration: 350
            });
        }
    }

    // 7. Inject Clean Avionics CSS for Single-Line Top Bar, Interactive Airport Board & Left Panel
    function injectStyles() {
        const style = document.createElement("style");
        style.textContent = `
            /* Map Overlay Canvas */
            #tar1090-radar-overlay {
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                pointer-events: none;
                z-index: 400;
            }

            /* Modernized Left Aircraft Panel (#selected_infoblock) & Hover Card (#highlighted_infoblock) */
            #selected_infoblock {
                position: absolute !important;
                left: 10px !important;
                top: 46px !important;
                bottom: 12px !important;
                height: auto !important;
                max-height: calc(100vh - 60px) !important;
                width: 248px !important;
                z-index: 900 !important;
                background: rgba(11, 17, 32, 0.92) !important;
                backdrop-filter: blur(12px) !important;
                border: 1px solid rgba(56, 189, 248, 0.35) !important;
                border-radius: 12px !important;
                box-shadow: 0 10px 30px rgba(0, 0, 0, 0.72) !important;
                color: #f1f5f9 !important;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
                padding: 8px 10px !important;
            }
            #selected_infoblock::-webkit-scrollbar,
            #infoblock-container::-webkit-scrollbar {
                width: 5px;
            }
            #selected_infoblock::-webkit-scrollbar-thumb,
            #infoblock-container::-webkit-scrollbar-thumb {
                background: rgba(56, 189, 248, 0.35);
                border-radius: 4px;
            }
            #highlighted_infoblock {
                background: rgba(11, 17, 32, 0.94) !important;
                backdrop-filter: blur(10px) !important;
                border: 1px solid rgba(52, 211, 153, 0.45) !important;
                border-radius: 10px !important;
                box-shadow: 0 8px 24px rgba(0, 0, 0, 0.65) !important;
                color: #f8fafc !important;
                padding: 8px 10px !important;
            }
            #tar1090-avionics-card-header {
                background: linear-gradient(135deg, rgba(30, 41, 59, 0.92), rgba(15, 23, 42, 0.95));
                border: 1px solid rgba(56, 189, 248, 0.28);
                border-radius: 8px;
                padding: 7px 9px;
                margin-bottom: 8px;
            }
            .avionics-badge-row {
                display: flex;
                align-items: center;
                gap: 6px;
                margin-bottom: 4px;
            }
            .avionics-pill {
                font-size: 9.5px;
                font-weight: 800;
                letter-spacing: 0.5px;
                padding: 1px 6px;
                border-radius: 4px;
                border: 1px solid;
                text-transform: uppercase;
            }
            .avionics-sub {
                font-size: 10px;
                color: #94a3b8;
                font-weight: 600;
            }
            .avionics-model {
                font-size: 12.5px;
                font-weight: 700;
                color: #f8fafc;
                line-height: 1.25;
                margin-bottom: 2px;
            }
            .avionics-meta {
                font-size: 10.5px;
                font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
                color: #38bdf8;
                font-weight: 600;
            }
            .avionics-op {
                font-size: 10px;
                color: #cbd5e1;
                margin-top: 2px;
                font-style: italic;
            }
            #selected_infoblock .highlightedTitle {
                border-bottom: 1px solid rgba(148, 163, 184, 0.18) !important;
                padding-bottom: 4px !important;
                margin-bottom: 6px !important;
            }
            #selected_callsign {
                color: #34d399 !important;
                font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace !important;
                font-weight: 800 !important;
                letter-spacing: 0.4px !important;
            }
            #selected_icao {
                color: #94a3b8 !important;
                font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace !important;
            }
            #selected_infoblock .sectionTitle {
                background: rgba(30, 41, 59, 0.85) !important;
                border-left: 3px solid #38bdf8 !important;
                border-radius: 4px !important;
                padding: 3px 7px !important;
                margin: 6px 0 4px 0 !important;
                color: #38bdf8 !important;
                font-weight: 700 !important;
                text-transform: uppercase !important;
                letter-spacing: 0.5px !important;
                font-size: 10px !important;
            }
            #selected_infoblock .infoBlockSection {
                background: rgba(15, 23, 42, 0.55) !important;
                border: 1px solid rgba(148, 163, 184, 0.12) !important;
                border-radius: 6px !important;
                padding: 4px 6px !important;
                margin-bottom: 5px !important;
            }
            #selected_infoblock .infoHeading {
                color: #94a3b8 !important;
                font-weight: 500 !important;
                font-size: 11px !important;
            }
            #selected_infoblock .infoData {
                color: #f8fafc !important;
                font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace !important;
                font-weight: 600 !important;
                font-size: 11.5px !important;
            }
            #selected_infoblock button {
                width: 100%;
                margin-top: 4px;
                background: rgba(30, 41, 59, 0.9) !important;
                color: #e2e8f0 !important;
                border: 1px solid rgba(56, 189, 248, 0.35) !important;
                border-radius: 5px !important;
                padding: 4px 8px !important;
                font-size: 10.5px !important;
                font-weight: 600 !important;
                cursor: pointer;
            }
            #selected_infoblock button:hover {
                background: #0284c7 !important;
                color: #fff !important;
            }

            /* Sidebar Aircraft Table Polish */
            #sidebar_container {
                background: #0b1120 !important;
                border-left: 1px solid rgba(56, 189, 248, 0.25) !important;
            }
            #planesTable {
                font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace !important;
            }

            /*Redesigned Interactive Airport FIDS / ATIS Drawer */
            #tar1090-airports-panel {
                position: fixed;
                left: 12px;
                bottom: 34px;
                z-index: 945;
                width: min(560px, calc(100vw - 26px));
                background: rgba(11, 17, 32, 0.95);
                backdrop-filter: blur(14px);
                border: 1px solid rgba(56, 189, 248, 0.42);
                border-radius: 12px;
                box-shadow: 0 12px 34px rgba(0, 0, 0, 0.78);
                color: #f1f5f9;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                font-size: 11px;
                padding: 8px 10px;
            }
            .fids-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                gap: 6px;
                margin-bottom: 6px;
            }
            .fids-title-wrap {
                display: flex;
                align-items: center;
                gap: 6px;
                flex-wrap: wrap;
            }
            .fids-cat-pill {
                font-size: 9.5px;
                font-weight: 800;
                padding: 1px 6px;
                border-radius: 4px;
                border: 1px solid;
                font-family: ui-monospace, Menlo, Consolas, monospace;
            }
            .fids-apt-title {
                font-size: 12.5px;
                color: #f8fafc;
            }
            .fids-rwy-pill {
                background: rgba(251, 191, 36, 0.16);
                border: 1px solid rgba(251, 191, 36, 0.55);
                color: #fde68a;
                font-size: 9.5px;
                font-weight: 700;
                padding: 1px 6px;
                border-radius: 4px;
                font-family: ui-monospace, Menlo, Consolas, monospace;
            }
            .fids-apt-dist {
                color: #94a3b8;
                font-size: 10px;
                font-family: ui-monospace, Menlo, Consolas, monospace;
            }
            .fids-actions {
                display: flex;
                gap: 4px;
            }
            .fids-tabs-bar {
                display: flex;
                gap: 4px;
                overflow-x: auto;
                padding-bottom: 5px;
                margin-bottom: 6px;
                border-bottom: 1px solid rgba(148, 163, 184, 0.18);
            }
            .fids-tabs-bar::-webkit-scrollbar {
                height: 3px;
            }
            .fids-tabs-bar::-webkit-scrollbar-thumb {
                background: rgba(56, 189, 248, 0.35);
                border-radius: 3px;
            }
            .fids-tab {
                display: inline-flex;
                align-items: center;
                gap: 4px;
                background: rgba(30, 41, 59, 0.78);
                border: 1px solid rgba(148, 163, 184, 0.25);
                border-radius: 6px;
                padding: 2px 7px;
                color: #cbd5e1;
                font-size: 10px;
                font-weight: 700;
                font-family: ui-monospace, Menlo, Consolas, monospace;
                cursor: pointer;
                white-space: nowrap;
            }
            .fids-tab:hover {
                background: rgba(51, 65, 85, 0.9);
                color: #fff;
            }
            .fids-tab.active {
                background: rgba(2, 132, 199, 0.35);
                border-color: #38bdf8;
                color: #fff;
            }
            .fids-tab-cnt {
                background: rgba(56, 189, 248, 0.25);
                color: #7dd3fc;
                border-radius: 8px;
                padding: 0 4px;
                font-size: 9px;
            }
            .apt-dot {
                width: 7px;
                height: 7px;
                border-radius: 50%;
                display: inline-block;
            }
            .fids-wx-strip {
                display: grid;
                grid-template-columns: repeat(5, 1fr);
                gap: 4px;
                background: rgba(15, 23, 42, 0.85);
                border: 1px solid rgba(148, 163, 184, 0.16);
                border-radius: 6px;
                padding: 4px 7px;
                margin-bottom: 4px;
                font-family: ui-monospace, Menlo, Consolas, monospace;
                font-size: 10px;
            }
            .fids-wx-strip span {
                display: block;
                font-size: 8.5px;
                color: #64748b;
                font-weight: 700;
            }
            .fids-wx-strip b {
                color: #e2e8f0;
            }
            .fids-metar-raw {
                font-family: ui-monospace, Menlo, Consolas, monospace;
                font-size: 9.5px;
                color: #94a3b8;
                background: rgba(15, 23, 42, 0.5);
                padding: 3px 6px;
                border-radius: 4px;
                margin-bottom: 6px;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            .fids-board-grid {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 6px;
            }
            .fids-col {
                background: rgba(15, 23, 42, 0.65);
                border: 1px solid rgba(148, 163, 184, 0.16);
                border-radius: 6px;
                padding: 4px 6px;
            }
            .fids-col-head {
                display: flex;
                justify-content: space-between;
                font-size: 9.5px;
                font-weight: 800;
                color: #94a3b8;
                border-bottom: 1px solid rgba(148, 163, 184, 0.15);
                padding-bottom: 3px;
                margin-bottom: 4px;
            }
            .fids-col-list {
                max-height: 120px;
                overflow-y: auto;
            }
            .fids-flight-row {
                display: grid;
                grid-template-columns: 12px 54px 62px 1fr 36px 38px;
                gap: 4px;
                align-items: center;
                font-family: ui-monospace, Menlo, Consolas, monospace;
                font-size: 10px;
                padding: 2px 3px;
                border-radius: 4px;
                cursor: pointer;
            }
            .fids-flight-row:hover {
                background: rgba(56, 189, 248, 0.2);
            }
            .fids-fl-call {
                color: #f8fafc;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            .fids-fl-type {
                color: #38bdf8;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .fids-fl-alt {
                color: #cbd5e1;
                text-align: right;
            }
            .fids-fl-gs {
                color: #94a3b8;
                text-align: right;
            }
            .fids-fl-dst {
                color: #64748b;
                text-align: right;
            }
            .fids-empty {
                color: #64748b;
                font-size: 10px;
                font-style: italic;
                padding: 6px 2px;
                text-align: center;
            }

            /* Move OpenLayers layer-switcher button below top HUD bar so they never overlap */
            .ol-layerswitcher, .layer-switcher {
                top: 44px !important;
            }

            /* Compact Single-Line Top Bar (#tar1090-tactical-hud) */
            #tar1090-tactical-hud {
                position: fixed;
                top: 6px;
                left: 8px;
                z-index: 950;
                background: rgba(11, 17, 32, 0.92);
                backdrop-filter: blur(10px);
                border: 1px solid rgba(56, 189, 248, 0.35);
                border-radius: 8px;
                padding: 4px 7px;
                color: #f8fafc;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                font-size: 11px;
                max-width: calc(100vw - 210px);
                box-shadow: 0 4px 16px rgba(0, 0, 0, 0.65);
                user-select: none;
            }
            .thud-bar {
                display: flex;
                align-items: center;
                flex-wrap: nowrap;
                gap: 4px;
                overflow-x: auto;
                scrollbar-width: none;
            }
            .thud-bar::-webkit-scrollbar {
                display: none;
            }
            .thud-sep {
                width: 1px;
                height: 15px;
                background: rgba(148, 163, 184, 0.28);
                margin: 0 2px;
                flex-shrink: 0;
            }
            .thud-btn {
                background: rgba(30, 41, 59, 0.9);
                color: #cbd5e1;
                border: 1px solid rgba(148, 163, 184, 0.3);
                border-radius: 5px;
                padding: 2px 7px;
                font-size: 10.5px;
                font-weight: 600;
                cursor: pointer;
                white-space: nowrap;
                flex-shrink: 0;
                transition: all 0.12s ease;
            }
            .thud-btn:hover {
                background: rgba(51, 65, 85, 0.95);
                color: #fff;
            }
            .thud-btn.active {
                background: #0284c7;
                color: #ffffff;
                border-color: #38bdf8;
            }
            .thud-btn.rf-pill b {
                color: #34d399;
            }
            .thud-select {
                background: rgba(30, 41, 59, 0.92);
                color: #f8fafc;
                border: 1px solid rgba(56, 189, 248, 0.4);
                border-radius: 5px;
                padding: 2px 5px;
                font-size: 10.5px;
                font-weight: 600;
                cursor: pointer;
                flex-shrink: 0;
            }
            .thud-popover {
                margin-top: 5px;
                padding-top: 5px;
                border-top: 1px solid rgba(148, 163, 184, 0.22);
                display: flex;
                flex-wrap: wrap;
                align-items: center;
                gap: 5px;
            }
            .thud-stat {
                background: rgba(30, 41, 59, 0.9);
                border: 1px solid rgba(148, 163, 184, 0.25);
                border-radius: 5px;
                padding: 2px 6px;
                font-size: 10px;
                font-weight: 600;
                white-space: nowrap;
            }
            .thud-stat b {
                color: #34d399;
            }
            .thud-polar-box {
                width: 100%;
                display: grid;
                grid-template-columns: repeat(8, 1fr);
                gap: 3px;
                margin-top: 2px;
            }
            .thud-sector {
                background: rgba(15, 23, 42, 0.85);
                border: 1px solid rgba(148, 163, 184, 0.2);
                border-radius: 4px;
                padding: 2px 4px;
                text-align: center;
                font-size: 9.5px;
            }
            .thud-btn.tactical-pill {
                background: rgba(245, 158, 11, 0.18);
                border-color: rgba(245, 158, 11, 0.65);
                color: #fde68a;
            }
            .thud-btn.tactical-pill.NPAS {
                background: rgba(56, 189, 248, 0.2);
                border-color: #38bdf8;
                color: #bae6fd;
            }
            .thud-btn.tactical-pill.HEMS, .thud-btn.tactical-pill.SAR {
                background: rgba(239, 68, 68, 0.22);
                border-color: #f87171;
                color: #fecaca;
            }

            /* Split Map Divider */
            #tar1090-split-divider {
                position: absolute;
                top: 0;
                bottom: 0;
                left: 50%;
                width: 3px;
                background: #38bdf8;
                box-shadow: 0 0 10px rgba(56, 189, 248, 0.9);
                z-index: 850;
                cursor: ew-resize;
                touch-action: none;
            }
            #tar1090-split-divider .split-handle {
                position: absolute;
                bottom: 42px;
                left: 50%;
                transform: translateX(-50%);
                display: flex;
                align-items: center;
                gap: 4px;
                background: rgba(15, 23, 42, 0.92);
                border: 1.5px solid #38bdf8;
                border-radius: 20px;
                padding: 4px 10px;
                color: #fff;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                font-size: 11px;
                font-weight: 700;
                white-space: nowrap;
                box-shadow: 0 4px 14px rgba(0, 0, 0, 0.65);
            }
            #tar1090-split-divider .split-tag-left {
                color: #c084fc;
            }
            #tar1090-split-divider .split-tag-right {
                color: #38bdf8;
            }
            #tar1090-split-divider .split-grip {
                background: #0284c7;
                color: #fff;
                border-radius: 50%;
                width: 22px;
                height: 22px;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                font-size: 13px;
            }
        `;
        document.head.appendChild(style);
    }

    function renderHud() {
        let container = document.getElementById("tar1090-tactical-hud");
        if (!container) {
            container = document.createElement("div");
            container.id = "tar1090-tactical-hud";
            document.body.appendChild(container);
        }

        const aug = TacticalEngine.latestAugment;
        const bench = (aug && aug.benchmark) || {};
        const tacList = (aug && aug.tactical_active) || [];
        const apts = (aug && aug.airports) || [];
        const fl = bench.furthest_live;

        let milCount = 0, npasCount = 0, hemsSarCount = 0;
        for (let i = 0; i < tacList.length; i++) {
            const c = tacList[i].category;
            if (c === "MIL") milCount++;
            else if (c === "NPAS") npasCount++;
            else if (c === "HEMS" || c === "SAR") hemsSarCount++;
        }

        let totalAirportMovements = 0;
        for (let i = 0; i < apts.length; i++) {
            totalAirportMovements += (apts[i].inbound ? apts[i].inbound.length : 0) + (apts[i].departing ? apts[i].departing.length : 0);
        }

        const mapPresets = window.HudMapPresets || [
            { id: "carto_dark_all", label: "Dark HD", bg: "#0e131a" },
            { id: "OpenFreeMapFiord", label: "Radar Vec", bg: "#1c2636" },
            { id: "OpenFreeMapDark", label: "Dark Vec", bg: "#1a1a1a" },
            { id: "carto_rastertiles/voyager", label: "Voyager HD", bg: "#f5f3f0" },
            { id: "esri", label: "Satellite", bg: "#0b151e" },
            { id: "opentopo", label: "Terrain", bg: "#e8e4d8" },
            { id: "osm", label: "OSM", bg: "#aad3df" }
        ];

        let mapOpts = "";
        for (let i = 0; i < mapPresets.length; i++) {
            const mp = mapPresets[i];
            const sel = (typeof MapType_tar1090 !== "undefined" && MapType_tar1090 === mp.id) ? "selected" : "";
            mapOpts += `<option value="${mp.id}" ${sel}>▤ ${mp.label}</option>`;
        }

        // Optional expandable RF Diagnostics & Polar Range Popover
        let rfPopoverHtml = "";
        if (TacticalEngine.rfPopoverOpen) {
            let cells = "";
            if (Array.isArray(bench.sectors)) {
                for (let i = 0; i < bench.sectors.length; i++) {
                    const s = bench.sectors[i];
                    const col = s.max_nm >= 100 ? "#4ade80" : (s.max_nm < 50 ? "#f87171" : "#38bdf8");
                    cells += `<div class="thud-sector"><b>${s.name}</b> <span style="color:${col}">${s.max_nm}NM</span></div>`;
                }
            }
            const furBtn = (fl && fl.hex)
                ? `<button class="thud-btn" id="thud-furthest">★ Furthest: ${fl.flight} (${fl.dst_nm} NM)</button>`
                : "";
            const feedNames = Array.isArray(bench.feed_sources) && bench.feed_sources.length
                ? bench.feed_sources.join("+")
                : "adsb.fi+adsb.lol";
            rfPopoverHtml = `
                <div class="thud-popover">
                    <span class="thud-stat">SNR: <b>${bench.snr_db || "--"} dB</b></span>
                    <span class="thud-stat">Gain: <b>${bench.gain_db || "--"} dB</b> (${bench.strong_pct != null ? bench.strong_pct : "--"}% strong · ${bench.gain_hint || "auto"})</span>
                    <span class="thud-stat">Feeds: <b>${feedNames}</b> (${bench.open_unique_aircraft || 0})</span>
                    <button class="thud-btn ${TacticalEngine.rangeOutlineVisible ? "active" : ""}" id="thud-range-outline-btn">24h Outline: ${TacticalEngine.rangeOutlineVisible ? "ON" : "OFF"}</button>
                    ${furBtn}
                    ${cells ? `<div class="thud-polar-box">${cells}</div>` : ""}
                </div>
            `;
        }

        // Optional expandable Active Tactical Popover
        let tacPopoverHtml = "";
        if (TacticalEngine.tacPopoverOpen && tacList.length > 0) {
            let pills = "";
            const topTac = tacList.slice(0, 6);
            for (let i = 0; i < topTac.length; i++) {
                const t = topTac[i];
                const altTxt = t.alt != null ? `${t.alt}ft` : "";
                pills += `<button class="thud-btn tactical-pill ${t.category}" data-fhex="${t.hex}" data-flat="${t.lat || ""}" data-flon="${t.lon || ""}">[${t.badge}] ${t.flight} ${t.type ? "(" + t.type + ")" : ""} ${altTxt} · ${Math.round(t.dst_nm || 0)}NM</button>`;
            }
            tacPopoverHtml = `<div class="thud-popover">${pills}</div>`;
        }

        // Avoid clobbering the <select> dropdown while the user has it focused
        const activeEl = document.activeElement;
        if (activeEl && activeEl.id === "thud-map-select") {
            return;
        }

        const f = TacticalEngine.activeFilter;
        const nextHudHtml = `
            <div class="thud-bar">
                <button class="thud-btn" id="thud-home-btn" title="Center on Local Receiver">◉</button>
                <button class="thud-btn rf-pill ${TacticalEngine.rfPopoverOpen ? "active" : ""}" id="thud-rf-btn" title="Click for RF Gain, SNR & 8-Sector Polar Range">
                    RF <b>${bench.max_range_nm || "--"} NM</b> · <b>${bench.msg_rate || "--"}</b>/s ▾
                </button>
                <span class="thud-sep"></span>
                <button class="thud-btn ${f === "ALL" ? "active" : ""}" data-filter="ALL">ALL</button>
                <button class="thud-btn ${f === "MIL" ? "active" : ""}" data-filter="MIL">⚔ MIL ${milCount}</button>
                <button class="thud-btn ${f === "NPAS" ? "active" : ""}" data-filter="NPAS">★ NPAS ${npasCount}</button>
                <button class="thud-btn ${f === "HEMS_SAR" ? "active" : ""}" data-filter="HEMS_SAR">✚ HEMS ${hemsSarCount}</button>
                <button class="thud-btn ${f === "LOCAL_ONLY" ? "active" : ""}" data-filter="LOCAL_ONLY" title="Show only aircraft heard directly by your local antenna">◉ Local</button>
                <button class="thud-btn ${TacticalEngine.augmentEnabled ? "active" : ""}" id="thud-aug-toggle" title="Toggle Hybrid MLAT / Open-Data Augmentation">✦ Aug</button>
                <span class="thud-sep"></span>
                <button class="thud-btn ${TacticalEngine.airportsPanelOpen ? "active" : ""}" id="thud-apt-btn" title="Open Interactive Airport Arrivals/Departures & METAR Board">
                    ✈ Airports${totalAirportMovements > 0 ? " (" + totalAirportMovements + ")" : ""}
                </button>
                ${tacList.length > 0 ? `<button class="thud-btn tactical-pill ${TacticalEngine.tacPopoverOpen ? "active" : ""}" id="thud-tac-btn">⚡ Tactical (${tacList.length}) ▾</button>` : ""}
                <span class="thud-sep"></span>
                <select class="thud-select" id="thud-map-select" title="Switch Base Map">${mapOpts}</select>
                <button class="thud-btn ${TacticalEngine.splitCompare ? "active" : ""}" id="thud-split-btn" title="Compare Two Maps Side-by-Side">◫</button>
            </div>
            ${rfPopoverHtml}
            ${tacPopoverHtml}
        `;
        if (nextHudHtml === lastHudHtml) return;
        lastHudHtml = nextHudHtml;
        container.innerHTML = nextHudHtml;

        // Wire event listeners
        const homeBtn = document.getElementById("thud-home-btn");
        if (homeBtn) {
            homeBtn.onclick = function () {
                recenterToSite(true);
            };
        }
        const rfBtn = document.getElementById("thud-rf-btn");
        if (rfBtn) {
            rfBtn.onclick = function () {
                TacticalEngine.rfPopoverOpen = !TacticalEngine.rfPopoverOpen;
                if (TacticalEngine.rfPopoverOpen) TacticalEngine.tacPopoverOpen = false;
                renderHud();
            };
        }
        const tacBtn = document.getElementById("thud-tac-btn");
        if (tacBtn) {
            tacBtn.onclick = function () {
                TacticalEngine.tacPopoverOpen = !TacticalEngine.tacPopoverOpen;
                if (TacticalEngine.tacPopoverOpen) TacticalEngine.rfPopoverOpen = false;
                renderHud();
            };
        }
        const aptBtn = document.getElementById("thud-apt-btn");
        if (aptBtn) {
            aptBtn.onclick = function () {
                TacticalEngine.airportsPanelOpen = !TacticalEngine.airportsPanelOpen;
                renderAirportsPanel();
                renderHud();
            };
        }
        const furBtn = document.getElementById("thud-furthest");
        if (furBtn && fl) {
            furBtn.onclick = function () {
                focusAircraft(fl.hex);
            };
        }
        const roBtn = document.getElementById("thud-range-outline-btn");
        if (roBtn) {
            roBtn.onclick = function () {
                TacticalEngine.rangeOutlineVisible = !TacticalEngine.rangeOutlineVisible;
                disableConcentricRangeCircles();
                renderHud();
            };
        }
        const augBtn = document.getElementById("thud-aug-toggle");
        if (augBtn) {
            augBtn.onclick = function () {
                TacticalEngine.augmentEnabled = !TacticalEngine.augmentEnabled;
                if (typeof refreshFilter === "function") refreshFilter();
                renderHud();
            };
        }
        const mapSel = document.getElementById("thud-map-select");
        if (mapSel) {
            mapSel.onchange = function () {
                switchBaseMap(this.value);
            };
        }
        const splitBtn = document.getElementById("thud-split-btn");
        if (splitBtn) {
            splitBtn.onclick = function () {
                toggleSplitCompare();
            };
        }

        const filterBtns = container.querySelectorAll("[data-filter]");
        for (let i = 0; i < filterBtns.length; i++) {
            filterBtns[i].onclick = function () {
                TacticalEngine.activeFilter = this.getAttribute("data-filter");
                if (typeof refreshFilter === "function") refreshFilter();
                renderHud();
            };
        }

        const tacBtns = container.querySelectorAll("[data-fhex]");
        for (let i = 0; i < tacBtns.length; i++) {
            tacBtns[i].onclick = function () {
                const hx = this.getAttribute("data-fhex");
                const lt = this.getAttribute("data-flat");
                const ln = this.getAttribute("data-flon");
                focusAircraft(hx, lt ? Number(lt) : null, ln ? Number(ln) : null);
            };
        }
    }

    // 8. Poll data/augmented.json and refresh airframe shapes + panels
    function pollAugmentedData() {
        updateLeftAircraftPanelBadge();

        fetch("data/augmented.json", { cache: "no-store" })
            .then(function (r) {
                if (!r.ok) throw new Error("HTTP " + r.status);
                return r.json();
            })
            .then(function (data) {
                if (!data) return;
                if (data.ui_version) {
                    if (TacticalEngine.uiVersion && TacticalEngine.uiVersion !== data.ui_version) {
                        window.location.reload();
                        return;
                    }
                    TacticalEngine.uiVersion = data.ui_version;
                }
                TacticalEngine.latestAugment = data;
                TacticalEngine.classifications = data.classifications || {};
                if (data.benchmark && data.benchmark.furthest_live) {
                    TacticalEngine.furthestHex = data.benchmark.furthest_live.hex;
                    TacticalEngine.furthestNm = data.benchmark.furthest_live.dst_nm;
                }

                if (
                    TacticalEngine.augmentEnabled &&
                    TacticalEngine.activeFilter !== "LOCAL_ONLY" &&
                    Array.isArray(data.aircraft) &&
                    typeof processReceiverUpdate === "function"
                ) {
                    processReceiverUpdate({
                        now: data.now,
                        uat_978: "true",
                        aircraft: data.aircraft
                    });
                }

                if (typeof g !== "undefined" && Array.isArray(g.planesOrdered)) {
                    for (let i = 0; i < g.planesOrdered.length; i++) {
                        const p = g.planesOrdered[i];
                        const cls = TacticalEngine.classify(p);
                        if (cls) {
                            p.tacticalCategory = cls.category;
                            p.tacticalBadge = cls.badge;
                            p.tacticalLabel = cls.label;
                            p.tacticalColor = cls.color;
                            if (cls.category === "NPAS" || cls.category === "HEMS" || cls.category === "SAR" || cls.category === "MIL") {
                                p.military = true;
                                p.interesting = true;
                            }
                        }
                        if (p.icaoType && !p.typeDescription && g.type_cache) {
                            p.icaoTypeCache = null;
                            if (typeof p.setTypeData === "function") {
                                p.setTypeData();
                            }
                        }
                    }
                }
                updateLeftAircraftPanelBadge();
                renderHud();
                renderAirportsPanel();
                scheduleOverlayDraw();
            })
            .catch(function () {});
    }

    function recenterToSite(animate) {
        if (typeof SiteLat !== "number" || typeof SiteLon !== "number") return;
        DefaultCenterLat = CenterLat = SiteLat;
        DefaultCenterLon = CenterLon = SiteLon;
        SitePosition = [SiteLon, SiteLat];
        if (typeof loStore !== "undefined") {
            loStore["CenterLat"] = SiteLat;
            loStore["CenterLon"] = SiteLon;
            loStore["site_receiver_init"] = `${SiteLat.toFixed(4)},${SiteLon.toFixed(4)}`;
        }
        if (typeof lopaStore !== "undefined") {
            lopaStore["CenterLat"] = SiteLat;
            lopaStore["CenterLon"] = SiteLon;
        }
        if (typeof createLocationDot === "function") createLocationDot();
        if (typeof OLMap !== "undefined" && typeof ol !== "undefined") {
            const proj = ol.proj.fromLonLat([SiteLon, SiteLat]);
            if (animate) {
                OLMap.getView().animate({ center: proj, duration: 300 });
            } else {
                OLMap.getView().setCenter(proj);
            }
        }
    }

    window.toggleSplitCompare = toggleSplitCompare;

    window.addEventListener("load", function () {
        injectStyles();
        applyDarkAvionicsTheme();
        installPlaneHooks();

        setTimeout(function () {
            applyDarkAvionicsTheme();
            initMapCanvasOverlay();
            if (typeof SiteLat === "number" && typeof SiteLon === "number") {
                const key = `${SiteLat.toFixed(4)},${SiteLon.toFixed(4)}`;
                if (typeof loStore === "undefined" || loStore["site_receiver_init"] !== key) {
                    recenterToSite(false);
                }
            }
            if (typeof loStore !== "undefined" && !loStore["extensible_hd_map_init"]) {
                switchBaseMap("carto_dark_all");
            } else {
                applyMapVisibility();
                renderHud();
            }
            pollAugmentedData();
            setInterval(pollAugmentedData, 2000);
            setInterval(updateLeftAircraftPanelBadge, 600);
        }, 500);
    });
})();
