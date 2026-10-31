// -*- mode: javascript; indent-tabs-mode: nil; c-basic-offset: 4 -*-
"use strict";

/**
 * Extensible Tactical Classification, Open-Data Augmentation, ATC Radar Scope,
 * Modernized Avionics Left Panel, Side-by-Side HD Map Comparator & Benchmark HUD.
 */
(function () {
    const TacticalEngine = {
        categories: [],
        activeFilter: "ALL", // ALL, MIL, NPAS, HEMS_SAR, LOCAL_ONLY
        augmentEnabled: true,
        deadReckoningEnabled: true,
        radarScopeEnabled: true,
        polarOpen: false,
        hudCollapsed: false,
        splitCompare: false,
        splitRatio: 0.5,
        splitLeftMap: "osm",
        splitRightMap: "carto_dark_all",
        latestAugment: null,
        classifications: {},
        furthestHex: null,
        furthestNm: 0,
        sweepAngleDeg: 0,

        registerCategory: function (cat) {
            this.categories.push(cat);
        },

        classify: function (plane) {
            if (!plane || !plane.icao) return null;
            const hx = String(plane.icao).toLowerCase();
            const srv = this.classifications[hx];

            // Enrich from server open-data metadata if local DB lacked it, and trigger shape lookup
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

            // Ensure server-supplied type / reg / desc / ownOp from readsb --db-file-lt or augmented.json
            // immediately populate the PlaneObject so true airframe shapes render on first frame
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

            // Make sure typeDescription & wtc are resolved from g.type_cache as soon as g.type_cache is ready
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
                if (this.tacticalBadge) {
                    prefix = "[" + this.tacticalBadge + "] ";
                } else if (this.coastedModeS) {
                    prefix = "[COAST] ";
                }
                if (TacticalEngine.furthestHex && this.icao === TacticalEngine.furthestHex && !this.uat) {
                    prefix = "🏆 " + prefix;
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

    // 3. Real-Time ATC Radar Scope Overlay (Phosphor Sweep, Compass Rose, Range Rings & Target Locks)
    let radarCanvas = null;
    let radarCtx = null;

    function initRadarScopeOverlay() {
        const mapEl = document.getElementById("map_canvas");
        if (!mapEl || document.getElementById("tar1090-radar-overlay")) return;

        radarCanvas = document.createElement("canvas");
        radarCanvas.id = "tar1090-radar-overlay";
        mapEl.appendChild(radarCanvas);
        radarCtx = radarCanvas.getContext("2d");

        function resizeRadarCanvas() {
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

        window.addEventListener("resize", resizeRadarCanvas);
        resizeRadarCanvas();

        let lastFrameTs = performance.now();
        function animateRadarLoop(nowTs) {
            const dt = Math.min(0.1, (nowTs - lastFrameTs) / 1000.0);
            lastFrameTs = nowTs;
            if (TacticalEngine.radarScopeEnabled) {
                // 36 degrees per second = 10s full 360° radar sweep (6 RPM ATC Terminal Radar)
                TacticalEngine.sweepAngleDeg = (TacticalEngine.sweepAngleDeg + dt * 36.0) % 360.0;
                drawRadarScope(resizeRadarCanvas);
            } else if (radarCtx && radarCanvas) {
                radarCtx.clearRect(0, 0, radarCanvas.width, radarCanvas.height);
            }
            requestAnimationFrame(animateRadarLoop);
        }
        requestAnimationFrame(animateRadarLoop);
    }

    function drawRadarScope(resizeFn) {
        if (!radarCanvas || !radarCtx || typeof OLMap === "undefined" || typeof ol === "undefined") return;
        resizeFn();
        const dpr = window.devicePixelRatio || 1;
        const w = radarCanvas.width;
        const h = radarCanvas.height;
        const ctx = radarCtx;
        ctx.clearRect(0, 0, w, h);

        if (!TacticalEngine.radarScopeEnabled) return;

        const sLat = (typeof SiteLat === "number") ? SiteLat : 51.9202;
        const sLon = (typeof SiteLon === "number") ? SiteLon : 0.8978;
        const centerCoord = ol.proj.fromLonLat([sLon, sLat]);
        const centerPx = OLMap.getPixelFromCoordinate(centerCoord);
        if (!centerPx) return;

        const cx = centerPx[0] * dpr;
        const cy = centerPx[1] * dpr;

        // Calculate pixel radius for a given Nautical Miles distance at SiteLat
        function nmToPixels(nm) {
            const dLat = nm / 60.0;
            const edgeCoord = ol.proj.fromLonLat([sLon, sLat + dLat]);
            const edgePx = OLMap.getPixelFromCoordinate(edgeCoord);
            if (!edgePx) return nm * 2;
            const dx = (edgePx[0] - centerPx[0]) * dpr;
            const dy = (edgePx[1] - centerPx[1]) * dpr;
            return Math.sqrt(dx * dx + dy * dy);
        }

        const r25 = nmToPixels(25);
        const r50 = nmToPixels(50);
        const r100 = nmToPixels(100);
        const r150 = nmToPixels(150);
        const sweepRadius = r150;

        ctx.save();

        // 1. Subtle CRT Radar Scope Vignette & Crosshairs
        ctx.strokeStyle = "rgba(16, 185, 129, 0.16)";
        ctx.lineWidth = 1 * dpr;
        ctx.setLineDash([6 * dpr, 6 * dpr]);
        ctx.beginPath();
        ctx.moveTo(cx - sweepRadius, cy);
        ctx.lineTo(cx + sweepRadius, cy);
        ctx.moveTo(cx, cy - sweepRadius);
        ctx.lineTo(cx, cy + sweepRadius);
        ctx.stroke();
        ctx.setLineDash([]);

        // 2. Range Rings (25, 50, 100, 150 NM) with Glowing Phosphor Labels
        const rings = [
            { nm: 25, r: r25 },
            { nm: 50, r: r50 },
            { nm: 100, r: r100 },
            { nm: 150, r: r150 }
        ];
        ctx.font = `600 ${Math.round(10 * dpr)}px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`;
        for (let i = 0; i < rings.length; i++) {
            const rg = rings[i];
            if (rg.r < 18 * dpr) continue;
            ctx.beginPath();
            ctx.arc(cx, cy, rg.r, 0, Math.PI * 2);
            ctx.strokeStyle = (rg.nm === 100 || rg.nm === 150)
                ? "rgba(16, 185, 129, 0.34)"
                : "rgba(56, 189, 248, 0.22)";
            ctx.lineWidth = (rg.nm === 150 ? 1.5 : 1.0) * dpr;
            ctx.stroke();

            // Label at 015° bearing on each ring
            const lblAngle = (-75 * Math.PI) / 180.0;
            const lx = cx + rg.r * Math.cos(lblAngle);
            const ly = cy + rg.r * Math.sin(lblAngle);
            ctx.fillStyle = "rgba(11, 17, 32, 0.78)";
            ctx.fillRect(lx - 18 * dpr, ly - 7 * dpr, 38 * dpr, 13 * dpr);
            ctx.fillStyle = "rgba(52, 211, 153, 0.92)";
            ctx.fillText(`${rg.nm}NM`, lx - 14 * dpr, ly + 3 * dpr);
        }

        // 3. Outer 360° Azimuth Compass Rose on the 100 NM (or 150 NM) ring
        const roseR = r100 > 90 * dpr && r100 < Math.min(w, h) * 0.46 ? r100 : r150;
        if (roseR > 45 * dpr) {
            for (let deg = 0; deg < 360; deg += 5) {
                const rad = ((deg - 90) * Math.PI) / 180.0;
                const isMajor = (deg % 30 === 0);
                const isMed = (deg % 10 === 0);
                const tickLen = (isMajor ? 9 : (isMed ? 5 : 2.5)) * dpr;
                const x1 = cx + (roseR - tickLen) * Math.cos(rad);
                const y1 = cy + (roseR - tickLen) * Math.sin(rad);
                const x2 = cx + roseR * Math.cos(rad);
                const y2 = cy + roseR * Math.sin(rad);

                ctx.beginPath();
                ctx.moveTo(x1, y1);
                ctx.lineTo(x2, y2);
                ctx.strokeStyle = isMajor ? "rgba(52, 211, 153, 0.55)" : "rgba(56, 189, 248, 0.25)";
                ctx.lineWidth = (isMajor ? 1.4 : 0.9) * dpr;
                ctx.stroke();

                if (isMajor) {
                    const tx = cx + (roseR + 13 * dpr) * Math.cos(rad);
                    const ty = cy + (roseR + 13 * dpr) * Math.sin(rad);
                    ctx.fillStyle = (deg % 90 === 0) ? "#34d399" : "rgba(148, 163, 184, 0.78)";
                    ctx.textAlign = "center";
                    ctx.textBaseline = "middle";
                    const cardinal = deg === 0 ? "000° N" : (deg === 90 ? "090° E" : (deg === 180 ? "180° S" : (deg === 270 ? "270° W" : String(deg).padStart(3, "0") + "°")));
                    ctx.fillText(cardinal, tx, ty);
                }
            }
        }

        // 4. Rotating Radar Phosphor Sweep Cone
        const headRad = ((TacticalEngine.sweepAngleDeg - 90) * Math.PI) / 180.0;
        const trailSpanRad = (34 * Math.PI) / 180.0;
        const slices = 22;
        for (let s = 0; s < slices; s++) {
            const frac0 = s / slices;
            const frac1 = (s + 1) / slices;
            const a0 = headRad - trailSpanRad * (1 - frac0);
            const a1 = headRad - trailSpanRad * (1 - frac1);
            const alpha = Math.pow(frac1, 2.2) * 0.16;
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.arc(cx, cy, sweepRadius, a0, a1);
            ctx.closePath();
            ctx.fillStyle = `rgba(16, 185, 129, ${alpha.toFixed(4)})`;
            ctx.fill();
        }

        // Bright Leading Radar Beam Line
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + sweepRadius * Math.cos(headRad), cy + sweepRadius * Math.sin(headRad));
        ctx.strokeStyle = "rgba(52, 211, 153, 0.78)";
        ctx.lineWidth = 1.8 * dpr;
        ctx.stroke();

        // 5. Tactical Target Lock Brackets on Active NPAS / HEMS / SAR / MIL & Selected Aircraft
        if (typeof g !== "undefined" && Array.isArray(g.planesOrdered)) {
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
                const box = (p.selected ? 17 : 14) * dpr;
                const corner = 5 * dpr;

                ctx.strokeStyle = col;
                ctx.lineWidth = 1.6 * dpr;
                ctx.beginPath();
                // Top-left bracket
                ctx.moveTo(tx - box, ty - box + corner);
                ctx.lineTo(tx - box, ty - box);
                ctx.lineTo(tx - box + corner, ty - box);
                // Top-right bracket
                ctx.moveTo(tx + box - corner, ty - box);
                ctx.lineTo(tx + box, ty - box);
                ctx.lineTo(tx + box, ty - box + corner);
                // Bottom-right bracket
                ctx.moveTo(tx + box, ty + box - corner);
                ctx.lineTo(tx + box, ty + box);
                ctx.lineTo(tx + box - corner, ty + box);
                // Bottom-left bracket
                ctx.moveTo(tx - box + corner, ty + box);
                ctx.lineTo(tx - box, ty + box);
                ctx.lineTo(tx - box, ty + box - corner);
                ctx.stroke();

                // Velocity leader vector line (30s projected track)
                if (p.rotation != null && p.gs > 30) {
                    const trkRad = ((p.rotation - 90) * Math.PI) / 180.0;
                    const vecLen = Math.min(42, Math.max(16, p.gs / 10)) * dpr;
                    ctx.beginPath();
                    ctx.moveTo(tx + (box * 0.8) * Math.cos(trkRad), ty + (box * 0.8) * Math.sin(trkRad));
                    ctx.lineTo(tx + (box + vecLen) * Math.cos(trkRad), ty + (box + vecLen) * Math.sin(trkRad));
                    ctx.strokeStyle = col;
                    ctx.lineWidth = 1.2 * dpr;
                    ctx.stroke();
                }
            }
        }

        ctx.restore();
    }

    // 4. Modernize the Left Aircraft Telemetry Panel (#selected_infoblock) & Dark Avionics Theme
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
        }

        const p = SelectedPlane;
        const cat = p.tacticalCategory || (p.uat ? "AUGMENTED" : "LOCAL RF");
        const col = p.tacticalColor || (p.uat ? "#a855f7" : "#10b981");
        const badgeText = p.tacticalLabel || (p.uat ? "Open-Data Augmented" : "Local Antenna RF");
        const modelText = p.typeLong || p.icaoType || "Aircraft";
        const typeCode = p.icaoType ? `ICAO: ${p.icaoType}` : "";
        const regText = p.registration ? `REG: ${p.registration}` : `HEX: ${String(p.icao).toUpperCase()}`;
        const opText = p.ownOp || (p.getAirline && p.getAirline()) || "";

        banner.innerHTML = `
            <div class="avionics-badge-row">
                <span class="avionics-pill" style="background:${col}22;border-color:${col};color:${col};">${cat}</span>
                <span class="avionics-sub">${badgeText}</span>
            </div>
            <div class="avionics-model">${modelText}</div>
            <div class="avionics-meta">${regText} ${typeCode ? "· " + typeCode : ""}</div>
            ${opText ? `<div class="avionics-op">${opText}</div>` : ""}
        `;
    }

    // 5. Side-by-Side Split-Screen & Single Base Map Switcher
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

    // 6. Inject Modern Avionics CSS for Left Panel (#selected_infoblock), Radar Canvas & HUD
    function injectStyles() {
        const style = document.createElement("style");
        style.textContent = `
            /* Radar Scope Canvas */
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
                top: 102px !important;
                bottom: 12px !important;
                height: auto !important;
                max-height: calc(100vh - 116px) !important;
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

            /* Top Tactical HUD */
            #tar1090-tactical-hud {
                position: fixed;
                top: 6px;
                left: 44px;
                z-index: 950;
                background: rgba(11, 17, 32, 0.90);
                backdrop-filter: blur(10px);
                border: 1px solid rgba(52, 211, 153, 0.4);
                border-radius: 8px;
                padding: 5px 8px;
                color: #f8fafc;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                font-size: 11px;
                max-width: calc(100vw - 190px);
                box-shadow: 0 4px 16px rgba(0, 0, 0, 0.65);
                user-select: none;
            }
            .thud-row {
                display: flex;
                align-items: center;
                flex-wrap: wrap;
                gap: 4px;
                margin-bottom: 4px;
            }
            .thud-row:last-child {
                margin-bottom: 0;
            }
            .thud-stat {
                background: rgba(30, 41, 59, 0.9);
                border: 1px solid rgba(148, 163, 184, 0.25);
                border-radius: 5px;
                padding: 2px 6px;
                font-weight: 600;
                white-space: nowrap;
            }
            .thud-stat b {
                color: #34d399;
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
            .thud-btn.radar-active {
                background: rgba(16, 185, 129, 0.25);
                color: #6ee7b7;
                border-color: #10b981;
            }
            .thud-btn.split-left-active {
                background: #7c3aed;
                color: #ffffff;
                border-color: #c084fc;
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
            .thud-polar-box {
                margin-top: 5px;
                padding-top: 5px;
                border-top: 1px solid rgba(148, 163, 184, 0.25);
                display: grid;
                grid-template-columns: repeat(4, 1fr);
                gap: 4px;
            }
            .thud-sector {
                background: rgba(15, 23, 42, 0.85);
                border: 1px solid rgba(148, 163, 184, 0.2);
                border-radius: 4px;
                padding: 2px 5px;
                text-align: center;
                font-size: 10px;
            }
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
        const fl = bench.furthest_live;

        let milCount = 0, npasCount = 0, hemsSarCount = 0;
        for (let i = 0; i < tacList.length; i++) {
            const c = tacList[i].category;
            if (c === "MIL") milCount++;
            else if (c === "NPAS") npasCount++;
            else if (c === "HEMS" || c === "SAR") hemsSarCount++;
        }

        if (TacticalEngine.hudCollapsed) {
            container.innerHTML = `
                <div class="thud-row">
                    <button class="thud-btn radar-active" id="thud-expand">🟢 RADAR HUD (${bench.max_range_nm || "--"} NM | Tac: ${tacList.length}) ▾</button>
                </div>
            `;
            document.getElementById("thud-expand").onclick = function () {
                TacticalEngine.hudCollapsed = false;
                renderHud();
            };
            return;
        }

        const mapPresets = window.HudMapPresets || [
            { id: "carto_dark_all", label: "Dark HD", bg: "#0e131a" },
            { id: "OpenFreeMapFiord", label: "Radar Vec", bg: "#1c2636" },
            { id: "OpenFreeMapDark", label: "Dark Vec", bg: "#1a1a1a" },
            { id: "carto_rastertiles/voyager", label: "Voyager HD", bg: "#f5f3f0" },
            { id: "esri", label: "Satellite", bg: "#0b151e" },
            { id: "opentopo", label: "Terrain", bg: "#e8e4d8" },
            { id: "osm", label: "OSM (Old)", bg: "#aad3df" }
        ];

        let mapRowsHtml = "";
        if (!TacticalEngine.splitCompare) {
            let mapButtonsHtml = "";
            for (let i = 0; i < mapPresets.length; i++) {
                const mp = mapPresets[i];
                const isAct = (typeof MapType_tar1090 !== "undefined" && MapType_tar1090 === mp.id) ? "active" : "";
                mapButtonsHtml += `<button class="thud-btn ${isAct}" data-map="${mp.id}">${mp.label}</button>`;
            }
            mapRowsHtml = `
                <div class="thud-row">
                    <span style="color:#94a3b8;font-weight:600;">🗺️ Map:</span>
                    ${mapButtonsHtml}
                    <button class="thud-btn" id="thud-split-btn" title="Compare two maps side-by-side">⚖️ Split Compare</button>
                </div>
            `;
        } else {
            let leftBtns = "", rightBtns = "";
            for (let i = 0; i < mapPresets.length; i++) {
                const mp = mapPresets[i];
                const lAct = (TacticalEngine.splitLeftMap === mp.id) ? "split-left-active" : "";
                const rAct = (TacticalEngine.splitRightMap === mp.id) ? "active" : "";
                leftBtns += `<button class="thud-btn ${lAct}" data-split-left="${mp.id}">${mp.label}</button>`;
                rightBtns += `<button class="thud-btn ${rAct}" data-split-right="${mp.id}">${mp.label}</button>`;
            }
            mapRowsHtml = `
                <div class="thud-row">
                    <span style="color:#c084fc;font-weight:700;">◀ Left:</span>
                    ${leftBtns}
                    <button class="thud-btn active" id="thud-split-btn">✖ Exit Split</button>
                </div>
                <div class="thud-row">
                    <span style="color:#38bdf8;font-weight:700;">Right ▶:</span>
                    ${rightBtns}
                </div>
            `;
        }

        let furthestHtml = "";
        if (fl && fl.hex) {
            furthestHtml = `<button class="thud-btn" id="thud-furthest" title="Click to jump to furthest local aircraft">🏆 ${fl.flight} (${fl.dst_nm} NM)</button>`;
        }

        let tacTickerHtml = "";
        if (tacList.length > 0) {
            const topTac = tacList.slice(0, 4);
            let pills = "";
            for (let i = 0; i < topTac.length; i++) {
                const t = topTac[i];
                const altTxt = t.alt != null ? `${t.alt}ft` : "";
                pills += `<button class="thud-btn tactical-pill ${t.category}" data-fhex="${t.hex}" data-flat="${t.lat || ""}" data-flon="${t.lon || ""}">[${t.badge}] ${t.flight} ${t.type ? "(" + t.type + ")" : ""} ${altTxt} · ${Math.round(t.dst_nm || 0)}NM</button>`;
            }
            tacTickerHtml = `<div class="thud-row"><span style="color:#94a3b8;font-weight:600;">Active Tactical:</span>${pills}</div>`;
        }

        let polarHtml = "";
        if (TacticalEngine.polarOpen && Array.isArray(bench.sectors)) {
            let cells = "";
            for (let i = 0; i < bench.sectors.length; i++) {
                const s = bench.sectors[i];
                const col = s.max_nm >= 100 ? "#4ade80" : (s.max_nm < 50 ? "#f87171" : "#38bdf8");
                cells += `<div class="thud-sector"><b>${s.name}</b>: <span style="color:${col}">${s.max_nm} NM</span></div>`;
            }
            polarHtml = `<div class="thud-polar-box">${cells}</div>`;
        }

        const f = TacticalEngine.activeFilter;
        container.innerHTML = `
            <div class="thud-row">
                <button class="thud-btn" id="thud-home-btn" title="Center on Local Receiver Site">🎯 Home</button>
                <button class="thud-btn ${TacticalEngine.radarScopeEnabled ? "radar-active" : ""}" id="thud-radar-btn" title="Toggle Rotating ATC Radar Sweep & Compass Rose">🟢 Radar Scope: ${TacticalEngine.radarScopeEnabled ? "ON" : "OFF"}</button>
                <span class="thud-stat">📡 Max: <b>${bench.max_range_nm || "--"} NM</b></span>
                <span class="thud-stat">⚡ <b>${bench.msg_rate || "--"}</b> msg/s</span>
                <span class="thud-stat">SNR: <b>${bench.snr_db || "--"} dB</b></span>
                ${furthestHtml}
                <button class="thud-btn ${TacticalEngine.polarOpen ? "active" : ""}" id="thud-polar-btn">📊 Polar</button>
                <button class="thud-btn" id="thud-collapse" title="Minimize HUD">▴</button>
            </div>
            <div class="thud-row">
                <button class="thud-btn ${f === "ALL" ? "active" : ""}" data-filter="ALL">ALL</button>
                <button class="thud-btn ${f === "MIL" ? "active" : ""}" data-filter="MIL">⚔️ MIL (${milCount})</button>
                <button class="thud-btn ${f === "NPAS" ? "active" : ""}" data-filter="NPAS">🚓 NPAS (${npasCount})</button>
                <button class="thud-btn ${f === "HEMS_SAR" ? "active" : ""}" data-filter="HEMS_SAR">🚁 HEMS/SAR (${hemsSarCount})</button>
                <button class="thud-btn ${f === "LOCAL_ONLY" ? "active" : ""}" data-filter="LOCAL_ONLY">📡 LOCAL ONLY</button>
                <button class="thud-btn ${TacticalEngine.augmentEnabled ? "active" : ""}" id="thud-aug-toggle">🌐 Augment: ${TacticalEngine.augmentEnabled ? "ON" : "OFF"}</button>
            </div>
            ${mapRowsHtml}
            ${tacTickerHtml}
            ${polarHtml}
        `;

        // Wire event listeners
        const homeBtn = document.getElementById("thud-home-btn");
        if (homeBtn) {
            homeBtn.onclick = function () {
                recenterToSite(true);
            };
        }
        const radarBtn = document.getElementById("thud-radar-btn");
        if (radarBtn) {
            radarBtn.onclick = function () {
                TacticalEngine.radarScopeEnabled = !TacticalEngine.radarScopeEnabled;
                renderHud();
            };
        }
        const colBtn = document.getElementById("thud-collapse");
        if (colBtn) {
            colBtn.onclick = function () {
                TacticalEngine.hudCollapsed = true;
                renderHud();
            };
        }
        const polBtn = document.getElementById("thud-polar-btn");
        if (polBtn) {
            polBtn.onclick = function () {
                TacticalEngine.polarOpen = !TacticalEngine.polarOpen;
                renderHud();
            };
        }
        const furBtn = document.getElementById("thud-furthest");
        if (furBtn && fl) {
            furBtn.onclick = function () {
                focusAircraft(fl.hex);
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

        const mapBtns = container.querySelectorAll("[data-map]");
        for (let i = 0; i < mapBtns.length; i++) {
            mapBtns[i].onclick = function () {
                switchBaseMap(this.getAttribute("data-map"));
            };
        }

        const leftSplitBtns = container.querySelectorAll("[data-split-left]");
        for (let i = 0; i < leftSplitBtns.length; i++) {
            leftSplitBtns[i].onclick = function () {
                TacticalEngine.splitLeftMap = this.getAttribute("data-split-left");
                applyMapVisibility();
                renderHud();
            };
        }

        const rightSplitBtns = container.querySelectorAll("[data-split-right]");
        for (let i = 0; i < rightSplitBtns.length; i++) {
            rightSplitBtns[i].onclick = function () {
                TacticalEngine.splitRightMap = this.getAttribute("data-split-right");
                MapType_tar1090 = loStore["MapType_tar1090"] = TacticalEngine.splitRightMap;
                applyMapVisibility();
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

    // 7. Poll data/augmented.json and refresh airframe shapes + left panel header
    function pollAugmentedData() {
        updateLeftAircraftPanelBadge();

        fetch("data/augmented.json", { cache: "no-store" })
            .then(function (r) {
                if (!r.ok) throw new Error("HTTP " + r.status);
                return r.json();
            })
            .then(function (data) {
                if (!data) return;
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
        if (typeof drawSiteCircle === "function") drawSiteCircle();
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
            initRadarScopeOverlay();
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
