// Shared prototype runtime. Local mock state only: no network, storage beyond localStorage prefs.
(function () {
	"use strict";
	const P = (window.Proto = {});
	window.__errs = [];
	window.addEventListener("error", (e) => window.__errs.push(String(e.message)));
	const store = {
		get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } },
		set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
	};
	P.esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

	// Icons (simple outline set drawn here; production uses app_icon.rs)
	const I = {
		search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
		chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
		check: '<path d="M20 6 9 17l-5-5"/>',
		x: '<path d="M18 6 6 18M6 6l12 12"/>',
		right: '<path d="m9 18 6-6-6-6"/>',
		down: '<path d="m6 9 6 6 6-6"/>',
		left: '<path d="m15 18-6-6 6-6"/>',
		back: '<path d="m12 19-7-7 7-7M19 12H5"/>',
		compass: '<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5z"/>',
		pause: '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>',
		play: '<path d="M7 4.5v15l12-7.5z"/>',
		stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
		more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
		folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
		grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
		settings: '<path d="M20 7h-8M12 17H4"/><circle cx="8" cy="7" r="3"/><circle cx="16" cy="17" r="3"/>',
		commit: '<circle cx="12" cy="12" r="3"/><path d="M3 12h6M15 12h6"/>',
		checks: '<circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
		image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5L6 20"/>',
		file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
		shield: '<path d="M12 21s7-3.5 7-9.5V6l-7-3-7 3v5.5C5 17.5 12 21 12 21z"/>',
		flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
		clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
		plus: '<path d="M12 5v14M5 12h14"/>',
		pr: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M6 8.5v7M18 15.5V9a2 2 0 0 0-2-2h-4"/><path d="m14 5-2 2 2 2"/>',
		alert: '<path d="M10.3 4 2.6 18a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4M12 17h.01"/>',
		help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 0 1 4.9.6c0 1.6-2.4 2.2-2.4 3.4M12 17h.01"/>',
		send: '<path d="M12 19V5M5 12l7-7 7 7"/>',
		list: '<path d="m4 7 1.5 1.5L8 6M4 17l1.5 1.5L8 16M12 7h8M12 17h8M12 12h8"/>',
		activity: '<path d="M21 12h-4l-3 8-4-16-3 8H3"/>',
		sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
		moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
		board: '<rect x="3" y="4" width="5" height="16" rx="1.5"/><rect x="10" y="4" width="5" height="11" rx="1.5"/><rect x="17" y="4" width="4" height="7" rx="1.5"/>',
		layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
		refresh: '<path d="M20 11a8 8 0 0 0-14.6-4.5L4 8M4 4v4h4M4 13a8 8 0 0 0 14.6 4.5L20 16M20 20v-4h-4"/>',
		target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
		book: '<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 19V5M19 19v2H6"/>',
		inbox: '<path d="M3 13h5l1.5 2.5h5L16 13h5"/><path d="M5.5 5h13L21 13v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5z"/>',
		calendar: '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
	};
	P.icon = (name, cls) => '<svg class="ico ' + (cls || "") + '" viewBox="0 0 24 24" aria-hidden="true">' + (I[name] || "") + "</svg>";

	// Task status pie: todo, active (1/3), review (2/3), done, blocked
	P.pie = (state) => {
		const r = 5.5, c = 7;
		const frac = { todo: 0, active: 1 / 3, review: 2 / 3, done: 1, blocked: 1 / 3, dropped: 0 }[state] || 0;
		const col = { done: "var(--green)", review: "var(--amber)", active: "var(--indigo)", blocked: "var(--red)" }[state] || "var(--faint)";
		let fill = "";
		if (frac >= 1) fill = '<circle cx="7" cy="7" r="' + r + '" fill="' + col + '"/><path d="m4.6 7.1 1.7 1.7 3.2-3.4" stroke="var(--page)" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>';
		else if (frac > 0) {
			const a = frac * 2 * Math.PI - Math.PI / 2;
			const x = c + (r - 1.5) * Math.cos(a), y = c + (r - 1.5) * Math.sin(a);
			fill = '<path d="M7 7 L7 ' + (c - r + 1.5) + " A" + (r - 1.5) + " " + (r - 1.5) + " 0 " + (frac > 0.5 ? 1 : 0) + " 1 " + x.toFixed(2) + " " + y.toFixed(2) + ' Z" fill="' + col + '"/>';
		}
		return '<svg class="pie" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="' + r + '" fill="none" stroke="' + col + '" stroke-width="1.3"' + (state === "dropped" ? ' stroke-dasharray="2 2"' : "") + "/>" + fill + "</svg>";
	};
	P.taskWord = { todo: "To do", active: "In progress", review: "In review", done: "Done", blocked: "Blocked", dropped: "Dropped" };

	P.bar = (t, label) => {
		const total = t.done + t.review + t.active + t.blocked + t.todo || 1;
		const seg = (k) => (t[k] ? '<i class="' + k + '" style="flex-basis:' + ((t[k] / total) * 100).toFixed(2) + '%"></i>' : "");
		return '<div class="bar" role="img" aria-label="' + P.esc(label || t.done + " of " + total + " tasks done") + '">' + seg("done") + seg("review") + seg("active") + seg("blocked") + "</div>";
	};
	P.legend = (t) => {
		const items = [["done", "done", "var(--green)"], ["review", "in review", "var(--amber)"], ["active", "in progress", "var(--indigo)"], ["blocked", "blocked", "var(--red)"], ["todo", "to do", "var(--hair-strong)"]];
		return '<div class="legend">' + items.filter(([k]) => t[k]).map(([k, w, c]) => '<span><i style="background:' + c + '"></i>' + t[k] + " " + w + "</span>").join("") + "</div>";
	};
	P.stateWord = { working: "Working", background: "Working in background", needs: "Needs you", failed: "Failed", unknown: "Unconfirmed", ready: "Ready to merge", paused: "Paused", done: "Done", quiet: "Quiet", planned: "Planned" };
	P.markClass = { working: "working", background: "working", needs: "needs", failed: "failed", unknown: "unknown", ready: "ready", paused: "paused", done: "done", quiet: "quiet", planned: "paused" };
	P.state = (s, word) => '<span class="state ' + (P.markClass[s] || "") + '"><i class="mark ' + (P.markClass[s] || "") + '"></i>' + P.esc(word || P.stateWord[s] || s) + "</span>";

	P.evidenceIcon = { commit: "commit", checks: "checks", image: "image", visual: "activity", pr: "pr", file: "file", fail: "alert", bench: "activity" };
	P.chip = (e) => '<button class="chip' + (e.bad ? " bad" : "") + (e.warn ? " warn" : "") + '" data-evidence="' + P.esc(e.id || e.label) + '" title="Open evidence (mock)">' + P.icon(P.evidenceIcon[e.kind] || "file") + P.esc(e.label) + "</button>";

	// Theme
	P.themePref = store.get("proto.theme", "system");
	const mq = window.matchMedia("(prefers-color-scheme: dark)");
	P.applyTheme = () => {
		const t = P.themePref === "system" ? (mq.matches ? "dark" : "light") : P.themePref;
		document.documentElement.dataset.theme = t;
		window.dispatchEvent(new CustomEvent("proto:theme", { detail: t }));
	};
	mq.addEventListener && mq.addEventListener("change", P.applyTheme);
	P.setTheme = (t) => { P.themePref = t; store.set("proto.theme", t); P.applyTheme(); syncPanel(); };

	// Scenario
	const params = new URLSearchParams(location.search);
	P.scenarios = [["quiet", "Quiet day"], ["underway", "Underway"], ["decision", "Decision"], ["trouble", "Trouble"]];
	P.scenario = params.get("s") || store.get("proto.scenario", "quiet");
	if (!P.scenarios.some(([k]) => k === P.scenario)) P.scenario = "quiet";
	P.setScenario = (s) => {
		P.scenario = s; store.set("proto.scenario", s);
		const u = new URL(location.href); u.searchParams.set("s", s); history.replaceState(history.state, "", u);
		syncPanel();
		window.dispatchEvent(new CustomEvent("proto:scenario", { detail: s }));
	};
	if (params.get("theme")) { P.themePref = params.get("theme"); }
	P.applyTheme();

	// Panel
	let panel;
	function syncPanel() {
		if (!panel) return;
		panel.querySelectorAll("[data-scn]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.scn === P.scenario)));
		panel.querySelectorAll("[data-thm]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.thm === P.themePref)));
	}
	P.mountPanel = (name) => {
		panel = document.createElement("aside");
		panel.className = "proto-panel";
		panel.setAttribute("aria-label", "Prototype controls");
		panel.dataset.collapsed = store.get("proto.panel", "false");
		if (params.get("panel") === "hidden") panel.style.display = "none";
		panel.innerHTML =
			'<div class="pp-head"><span class="pp-title">Prototype: ' + P.esc(name) + ' <span class="mock-tag">mock data</span></span>' +
			'<button class="icon-btn" data-pp-toggle aria-label="Show or hide prototype controls" title="Show or hide prototype controls">' + P.icon("settings") + "</button></div>" +
			'<div class="pp-body"><div class="pp-row"><div class="lbl">Scenario</div><div class="seg" role="group" aria-label="Scenario">' +
			P.scenarios.map(([k, l]) => '<button data-scn="' + k + '">' + l + "</button>").join("") +
			'</div></div><div class="pp-row"><div class="lbl">Appearance</div><div class="seg" role="group" aria-label="Appearance">' +
			[["system", "System"], ["light", "Light"], ["dark", "Dark"]].map(([k, l]) => '<button data-thm="' + k + '">' + l + "</button>").join("") +
			'</div></div><div class="pp-foot"><a href="../index.html">All proposals</a><span>Actions change local mock state only</span></div></div>';
		panel.addEventListener("click", (e) => {
			const b = e.target.closest("button"); if (!b) return;
			if (b.dataset.scn) P.setScenario(b.dataset.scn);
			if (b.dataset.thm) P.setTheme(b.dataset.thm);
			if (b.hasAttribute("data-pp-toggle")) { panel.dataset.collapsed = String(panel.dataset.collapsed !== "true"); store.set("proto.panel", panel.dataset.collapsed); }
		});
		document.body.appendChild(panel);
		syncPanel();
	};

	// Toasts (mock confirmations)
	let host;
	P.toast = (msg) => {
		if (!host) { host = document.createElement("div"); host.className = "toast-host"; host.setAttribute("role", "status"); host.setAttribute("aria-live", "polite"); document.body.appendChild(host); }
		const t = document.createElement("div"); t.className = "toast"; t.textContent = msg; host.appendChild(t);
		setTimeout(() => t.remove(), 2600);
	};
	P.mock = (what) => P.toast("Mock: " + what + ". Nothing was sent.");

	// Menus
	P.openMenu = (anchor, items) => {
		P.closeMenu();
		const m = document.createElement("div"); m.className = "menu"; m.setAttribute("role", "menu");
		m.innerHTML = items.map((it, i) => it === "-" ? "<hr>" : '<button role="menuitem" data-i="' + i + '">' + (it.icon ? P.icon(it.icon) : "") + P.esc(it.label) + (it.hint ? '<span class="hint">' + P.esc(it.hint) + "</span>" : "") + "</button>").join("");
		document.body.appendChild(m);
		const r = anchor.getBoundingClientRect();
		const w = m.offsetWidth;
		m.style.top = window.scrollY + r.bottom + 4 + "px";
		m.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w)) + "px";
		const btns = [...m.querySelectorAll("button")];
		btns[0] && btns[0].focus();
		m.addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; const it = items[+b.dataset.i]; P.closeMenu(); anchor.focus(); it.run && it.run(); });
		m.addEventListener("keydown", (e) => {
			const i = btns.indexOf(document.activeElement);
			if (e.key === "ArrowDown") { e.preventDefault(); btns[(i + 1) % btns.length].focus(); }
			if (e.key === "ArrowUp") { e.preventDefault(); btns[(i - 1 + btns.length) % btns.length].focus(); }
			if (e.key === "Escape" || e.key === "Tab") { e.preventDefault(); P.closeMenu(); anchor.focus(); }
		});
		P._menu = m;
		setTimeout(() => document.addEventListener("mousedown", P._outside = (e) => { if (!m.contains(e.target)) P.closeMenu(); }), 0);
	};
	P.closeMenu = () => { if (P._menu) { P._menu.remove(); P._menu = null; document.removeEventListener("mousedown", P._outside); } };

	// Command palette (Cmd/Ctrl+K)
	P.palette = (getItems) => {
		document.addEventListener("keydown", (e) => {
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); P.openPalette(getItems()); }
		});
	};
	P.openPalette = (items) => {
		if (document.querySelector(".pal-scrim")) return;
		const prev = document.activeElement;
		const s = document.createElement("div"); s.className = "pal-scrim";
		s.innerHTML = '<div class="pal" role="dialog" aria-label="Command palette"><input aria-label="Search places and actions" placeholder="Search places, missions, chats and actions"><ul role="listbox"></ul></div>';
		document.body.appendChild(s);
		const input = s.querySelector("input"), ul = s.querySelector("ul");
		let sel = 0, shown = [];
		const close = () => { s.remove(); prev && prev.focus && prev.focus(); };
		const draw = () => {
			const q = input.value.trim().toLowerCase();
			shown = items.filter((it) => !q || (it.label + " " + (it.group || "")).toLowerCase().includes(q)).slice(0, 40);
			sel = Math.min(sel, Math.max(0, shown.length - 1));
			let last = null;
			ul.innerHTML = shown.map((it, i) => {
				const head = it.group !== last ? '<li class="pal-sec" aria-hidden="true">' + P.esc(it.group || "") + "</li>" : "";
				last = it.group;
				return head + '<li role="option" data-i="' + i + '" aria-selected="' + (i === sel) + '">' + P.icon(it.icon || "right") + "<span>" + P.esc(it.label) + "</span>" + (it.hint ? '<span class="grp">' + P.esc(it.hint) + "</span>" : "") + "</li>";
			}).join("") || '<li class="pal-sec">No matches</li>';
		};
		input.addEventListener("input", () => { sel = 0; draw(); });
		input.addEventListener("keydown", (e) => {
			if (e.key === "ArrowDown") { e.preventDefault(); sel = Math.min(shown.length - 1, sel + 1); draw(); }
			if (e.key === "ArrowUp") { e.preventDefault(); sel = Math.max(0, sel - 1); draw(); }
			if (e.key === "Enter") { e.preventDefault(); const it = shown[sel]; close(); it && it.run(); }
			if (e.key === "Escape") { e.preventDefault(); close(); }
		});
		ul.addEventListener("click", (e) => { const li = e.target.closest("li[data-i]"); if (!li) return; const it = shown[+li.dataset.i]; close(); it.run(); });
		s.addEventListener("mousedown", (e) => { if (e.target === s) close(); });
		draw(); input.focus();
	};

	// Ordered (Bayer) dither sky, painted once per size/theme. Atmosphere only.
	const BAYER = [0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21];
	P.dither = (canvas, opts) => {
		const o = Object.assign({ cell: 3, light: [["#4f8fd6", 0], ["#9cc6ee", 0.45], ["#e6f0fa", 0.8], ["#ffffff", 1]], dark: [["#141922", 0], ["#22344f", 0.45], ["#2c4566", 0.75], ["#23262c", 1]] }, opts || {});
		const draw = () => {
			const dark = document.documentElement.dataset.theme === "dark";
			const stops = (dark ? o.dark : o.light).map(([h, at]) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), at]);
			const W = Math.ceil(canvas.clientWidth / o.cell), H = Math.ceil(canvas.clientHeight / o.cell);
			if (!W || !H) return;
			canvas.width = W; canvas.height = H;
			const ctx = canvas.getContext("2d"), img = ctx.createImageData(W, H);
			const pal = stops;
			for (let y = 0; y < H; y++) {
				for (let x = 0; x < W; x++) {
					// soft cloud bands: gentle low-frequency wave
					let t = y / H + 0.07 * Math.sin(x / W * 6.2 + y / H * 2.1) + 0.04 * Math.sin(x / W * 15 + 1.3);
					t = Math.max(0, Math.min(1, t));
					let k = 0; while (k < pal.length - 2 && t > pal[k + 1][3]) k++;
					const a = pal[k], b = pal[k + 1];
					const f = (t - a[3]) / (b[3] - a[3] || 1);
					const th = (BAYER[(y % 8) * 8 + (x % 8)] + 0.5) / 64;
					const c = f > th ? b : a;
					const i = (y * W + x) * 4;
					img.data[i] = c[0]; img.data[i + 1] = c[1]; img.data[i + 2] = c[2]; img.data[i + 3] = 255;
				}
			}
			ctx.putImageData(img, 0, 0);
		};
		draw();
		window.addEventListener("proto:theme", draw);
		let rt; window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(draw, 120); });
		return draw;
	};

	// Re-render helper that keeps focus and scroll for the same route
	P.rerender = (root, html, keepScroll) => {
		const active = document.activeElement;
		const key = active && active.dataset ? active.dataset.fk : null;
		const sy = window.scrollY;
		root.innerHTML = html;
		if (key) { const el = root.querySelector('[data-fk="' + CSS.escape(key) + '"]'); if (el) el.focus({ preventScroll: true }); }
		if (keepScroll) window.scrollTo(0, sy); else window.scrollTo(0, 0);
	};

	// Gentle live text swaps for the Underway scenario (in place, no reflow of siblings)
	P.swapText = (el, text) => { if (!el || el.textContent === text) return; el.textContent = text; el.classList.remove("live-swap"); void el.offsetWidth; el.classList.add("live-swap"); };
})();
