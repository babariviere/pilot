// Concept C: Board. Columns show who holds the ball; cards are outcomes, not chats. Focus mode shows one item. Mock state only.
(function () {
	"use strict";
	const P = window.Proto, esc = P.esc, ic = P.icon;
	const S = { w: null, picks: {}, open: {}, notes: [], checking: {}, sent: {}, project: "all", lane: "yours", skipped: [] };
	const top = document.getElementById("top"), main = document.getElementById("main");
	function reset() { S.w = window.MockWorld(P.scenario); S.picks = {}; S.notes = []; S.checking = {}; S.sent = {}; S.skipped = []; }
	const M = (id) => S.w.missions.find((m) => m.id === id);
	const route = () => (location.hash.replace(/^#\/?/, "") || "").split("/");
	const inScope = (mid) => S.project === "all" || M(mid).project === S.project;
	const kindOrder = { failure: 0, unknown: 1, decision: 2, approval: 2, review: 3 };

	function yourTurn() {
		const a = S.w.attention.filter((x) => inScope(x.mission)).map((x) => ({ type: "att", id: x.id, kind: x.kind, mission: x.mission, x }));
		const r = S.w.reviews.filter((x) => x.state === "waiting" && inScope(x.mission)).map((x) => ({ type: "review", id: x.id, kind: "review", mission: x.mission, x }));
		const all = a.concat(r).sort((p, q) => kindOrder[p.kind] - kindOrder[q.kind]);
		return all.filter((i) => !S.skipped.includes(i.id)).concat(all.filter((i) => S.skipped.includes(i.id)));
	}

	function navTop() {
		const [r] = route();
		const view = r === "focus" ? "focus" : r === "" || r === "m" ? "board" : "";
		const proj = S.project === "all" ? "All projects" : S.project;
		top.innerHTML = '<a class="brand" href="#/"><span class="logo" aria-hidden="true"></span>Pilot</a>' +
			'<div class="views" role="group" aria-label="View"><button data-view="board" aria-pressed="' + (view === "board") + '">' + ic("board", "s") + '<span class="lbl">Board</span></button><button data-view="focus" aria-pressed="' + (view === "focus") + '">' + ic("target", "s") + '<span class="lbl">Focus</span></button></div>' +
			'<button class="filter" data-act="project" aria-label="Project filter: ' + esc(proj) + '">' + ic("folder", "s") + '<span class="lbl">' + esc(proj) + "</span>" + ic("down", "s") + "</button>" +
			'<div class="right"><button class="icon-btn" data-act="palette" aria-label="Search (Command K)" title="Search ⌘K">' + ic("search") + "</button>" +
			'<button class="icon-btn" data-act="new" aria-label="New mission or chat" title="New">' + ic("plus") + "</button>" +
			'<button class="icon-btn" data-act="more" aria-label="Conversations, library, projects and settings" title="More">' + ic("more") + "</button></div>";
	}

	// ----- Cards
	function turnCard(i) {
		const m = M(i.mission);
		if (i.type === "review") return '<button class="card" data-open="' + m.id + '" data-tab="overview"><div class="t">Review ' + esc(i.x.title.toLowerCase()) + '</div><div class="k"><i class="mark ready"></i>Ready for review<span class="r">2 min</span></div><div class="d">' + esc(m.title) + "</div></button>";
		const a = i.x, cls = { failure: "failed", unknown: "unknown" }[a.kind] || "needs";
		return '<button class="card" data-open="' + m.id + '" data-tab="overview" data-fk="card-' + a.id + '"><div class="t">' + esc(a.title) + '</div><div class="k"><i class="mark ' + cls + '"></i><span class="state ' + cls + '" style="gap:0">' + esc(a.reason) + '</span><span class="r">' + esc(a.effort || "") + '</span></div><div class="d">' + esc(m.title) + " · " + esc(a.asked) + "</div></button>";
	}
	function pilotCard(m) {
		const waiting = S.w.attention.find((a) => a.mission === m.id);
		const nx = waiting ? '<div class="stop you">' + ic("flag", "s") + "Waiting on you for one thing. " + m.helpers.length + " helper" + (m.helpers.length > 1 ? "s" : "") + " still working.</div>"
			: m.next.who === "you" ? '<div class="stop you">' + ic("flag", "s") + "Stops for you: " + esc(m.next.text) + "</div>" : m.next.who === "pilot" ? '<div class="stop">' + ic("clock", "s") + esc(m.next.text) + "</div>" : "";
		const now = waiting ? m.helpers.map((h) => h.title + ": " + h.step).join(". ") : m.now;
		return '<button class="card" data-open="' + m.id + '" data-tab="overview" data-fk="card-' + m.id + '"><div class="t">' + esc(m.title) + '</div><div class="k">' + P.state(waiting ? "working" : m.state) + '<span class="r">' + esc(m.project) + '</span></div><div class="d" style="margin-top:6px"' + (waiting ? "" : ' data-live="now-' + m.id + '"') + ">" + esc(now) + "</div>" + P.bar(m.tasks) + nx + "</button>";
	}
	function doneCards() {
		const out = [];
		S.w.missions.filter((m) => inScope(m.id)).forEach((m) => m.delivered.forEach((d) => out.push({ m, d })));
		out.sort((a, b) => (a.d.when === "Yesterday") - (b.d.when === "Yesterday"));
		return out;
	}

	function board() {
		const w = S.w;
		const yt = yourTurn();
		const busy = w.missions.filter((m) => m.state !== "done" && inScope(m.id) && (!w.attention.some((a) => a.mission === m.id) || m.helpers.length));
		const done = doneCards();
		const showDone = S.open.done ? done : done.slice(0, 4);
		const lanes = [["yours", "Your turn", yt.length], ["pilot", "Pilot is on it", busy.length], ["done", "Done", done.length]];
		const working = busy.filter((m) => m.state === "working" || m.state === "background" || m.helpers.length).length;
		main.innerHTML = '<div class="board-head"><h1>' + (yt.length ? yt.length + (yt.length === 1 ? " thing is" : " things are") + " your turn" : "Your turn is empty") + '</h1><span class="s">' + (working ? "Pilot is working on " + working + (working === 1 ? " mission" : " missions") : "Pilot is idle") + '</span><span class="s faint" style="margin-left:auto">' + esc(w.date) + ", " + esc(w.time) + "</span></div>" +
			'<div class="lane-tabs seg" role="tablist" aria-label="Columns">' + lanes.map(([k, l, n]) => '<button role="tab" data-lane="' + k + '" aria-pressed="' + (S.lane === k) + '">' + l + " " + n + "</button>").join("") + "</div>" +
			'<div class="board">' +
			'<section class="lane yours' + (S.lane === "yours" ? " shown" : "") + '" aria-label="Your turn"><header><h2>Your turn</h2><span class="n">' + yt.length + '</span><span class="hint">Only you can move these</span></header>' +
			(S.notes.length ? S.notes.map((n) => '<div class="resolved">' + ic("check", "s") + esc(n) + "</div>").join("") : "") +
			(yt.length ? '<div class="cards">' + yt.map(turnCard).join("") + "</div>" : '<div class="lane-empty">Nothing waits on you. You can close Pilot.</div>') + "</section>" +
			'<section class="lane pilot' + (S.lane === "pilot" ? " shown" : "") + '" aria-label="Pilot is on it"><header><h2>Pilot is on it</h2><span class="n">' + busy.length + '</span><span class="hint">Within agreed scope</span></header>' +
			(busy.length ? '<div class="cards">' + busy.map(pilotCard).join("") + "</div>" : '<div class="lane-empty">Nothing running.</div>') + "</section>" +
			'<section class="lane done' + (S.lane === "done" ? " shown" : "") + '" aria-label="Done"><header><h2>Done</h2><span class="n">' + done.length + '</span><span class="hint">This week</span></header><div class="done-list">' +
			showDone.map(({ m, d }) => '<button class="done-row" data-open="' + m.id + '" data-tab="overview"><div class="t">' + esc(d.title) + '</div><div class="m"><span>' + esc(m.title) + '</span><span>· ' + d.evidence.length + ' proof' + (d.evidence.length === 1 ? "" : "s") + '</span><span class="w">' + esc(d.when) + "</span></div></button>").join("") + "</div>" +
			(done.length > 4 ? '<button class="fold" data-act="toggle" data-key="done" aria-expanded="' + !!S.open.done + '">' + ic(S.open.done ? "down" : "right", "s") + (S.open.done ? "Show fewer" : done.length - 4 + " more") + "</button>" : "") + "</section></div>";
	}

	// ----- Decision body (shared by sheet and focus)
	function decisionBody(a) {
		if (a.kind === "unknown") {
			return '<div class="acts" style="margin-top:16px"><button class="btn primary" data-act="check" data-id="' + a.id + '" data-fk="d-' + a.id + '"' + (S.checking[a.id] ? " disabled" : "") + ">" + ic("refresh", "s") + (S.checking[a.id] ? "Checking…" : "Check again") + '</button><button class="btn quiet" data-act="mock" data-what="Show pushed commit e93b1a0">What was pushed</button><span class="mock-tag">mock</span></div>';
		}
		const pick = S.picks[a.id] || (a.options.find((o) => o.recommended) || a.options[0]).id;
		return '<div class="opts" role="radiogroup" aria-label="Options">' + a.options.map((o) => '<label class="opt"><input type="radio" name="p-' + a.id + '" value="' + o.id + '" data-pick="' + a.id + '"' + (o.id === pick ? " checked" : "") + '><span><span class="l">' + esc(o.label) + (o.recommended ? '<span class="rec">Recommended</span>' : "") + '</span><br><span class="dd">' + esc(o.detail) + "</span></span></label>").join("") + "</div>" +
			'<div class="acts"><button class="btn primary" data-act="decide" data-id="' + a.id + '" data-fk="d-' + a.id + '">' + (a.kind === "approval" ? "Confirm" : "Decide") + '</button><span class="mock-tag">mock</span></div>';
	}
	function decisionBlock(a, big) {
		const cls = { failure: "failed", unknown: "unknown" }[a.kind] || "needs";
		const meta = '<div class="t-meta" style="display:flex;gap:6px;align-items:center;margin-bottom:10px"><i class="mark ' + cls + '"></i><span class="state ' + cls + '" style="gap:0">' + esc(a.reason) + "</span>" + (big ? "<span>· " + esc(M(a.mission).title) + "</span>" : "") + '<span style="margin-left:auto" class="faint">' + esc(a.effort || "") + "</span></div>";
		return '<div class="' + (big ? "big" : "sec") + '">' +
			(big ? '<h3 style="margin-top:0">' : '<h3 style="font:600 17px/1.3 var(--display);color:var(--text);margin:0 0 6px">') + esc(a.title) + "</h3>" + meta + "<p>" + esc(a.context) + "</p>" +
			(a.tried ? '<ul class="tried">' + a.tried.map((t) => "<li>" + esc(t) + "</li>").join("") + "</ul>" : "") +
			'<div class="why">' + ic("shield", "s") + "<span>" + esc(a.boundary) + "</span></div>" + decisionBody(a) +
			'<div class="chips" style="margin-top:14px">' + a.evidence.map(P.chip).join("") + "</div></div>";
	}

	// ----- Focus mode
	function focus() {
		const yt = yourTurn();
		const busy = S.w.missions.filter((m) => m.state !== "done" && inScope(m.id) && (!S.w.attention.some((a) => a.mission === m.id) || m.helpers.length));
		let html = '<div class="focus-wrap">' + S.notes.map((n) => '<div class="resolved">' + ic("check", "s") + esc(n) + "</div>").join("");
		if (yt.length) {
			const i = yt[0];
			html += '<div class="count"><span>' + (yt.length === 1 ? "Last one" : "1 of " + yt.length) + "</span>" + (yt.length > 1 ? '<button class="btn quiet small" data-act="skip" data-id="' + i.id + '">Skip for now</button>' : "") + "</div>";
			html += '<div class="stack">' + (yt.length > 1 ? '<div class="behind"></div>' : "");
			if (i.type === "att") html += decisionBlock(i.x, true);
			else html += '<div class="big"><h3 style="margin-top:0">Review ' + esc(i.x.title.toLowerCase()) + '</h3><div class="t-meta" style="display:flex;gap:6px;align-items:center;margin-bottom:10px"><i class="mark ready"></i>Ready for review · ' + esc(M(i.mission).title) + "</div><p>" + esc(i.x.summary) + '</p><p class="t-meta" style="margin-top:6px">' + ic("checks", "s") + " " + esc(i.x.checks) + '</p><div class="chips" style="margin:12px 0 16px">' + i.x.evidence.map(P.chip).join("") + '</div><div class="acts"><button class="btn primary" data-act="approve" data-id="' + i.id + '" data-fk="d-' + i.id + '">Approve</button><button class="btn quiet" data-act="mock" data-what="Request changes">Request changes</button><button class="btn quiet" data-open="' + i.mission + '" data-tab="overview">Open</button><span class="mock-tag">mock</span></div></div>';
			html += "</div>";
		} else {
			html += '<div class="clear">' + ic("checks") + "<h3>Your turn is empty</h3><p>Nothing needs you. You can close Pilot.</p></div>";
		}
		html += '<div class="pilot-on"><h2>Meanwhile, Pilot is on</h2>' + (busy.length ? busy.map((m) => '<div class="row"><i class="mark ' + P.markClass[m.state] + '"></i><b style="font-weight:500">' + esc(m.title) + '</b><span class="s" data-live="now-' + m.id + '">' + esc(m.now) + "</span></div>").join("") : '<p class="t-meta">Nothing.</p>') + "</div></div>";
		main.innerHTML = html;
	}

	// ----- Sheet
	function openSheet(mid, tab) {
		closeSheet(true);
		const m = M(mid); if (!m) return;
		S.sheet = { mid, tab: tab || "overview", prev: S.sheet && S.sheet.prev || document.activeElement };
		const scrim = document.createElement("div"); scrim.className = "scrim"; scrim.dataset.sheet = "1";
		const el = document.createElement("aside"); el.className = "sheet"; el.dataset.sheet = "1"; el.setAttribute("role", "dialog"); el.setAttribute("aria-label", m.title);
		document.body.append(scrim, el);
		scrim.addEventListener("mousedown", () => (location.hash = route()[0] === "m" ? "#/" : location.hash));
		drawSheet(true);
	}
	function drawSheet(first) {
		const el = document.querySelector(".sheet"); if (!el || !S.sheet) return;
		const m = M(S.sheet.mid), tab = S.sheet.tab;
		const aa = S.w.attention.filter((a) => a.mission === m.id);
		const rv = S.w.reviews.filter((r) => r.mission === m.id && r.state === "waiting");
		const t = m.tasks, tot = t.done + t.review + t.active + t.blocked + t.todo;
		let body = "";
		if (tab === "overview") {
			body = S.notes.filter((n) => n.indexOf(m.title) >= 0).map((n) => '<div class="resolved">' + ic("check", "s") + esc(n) + "</div>").join("") +
				aa.map((a) => decisionBlock(a, false)).join("") +
				rv.map((r) => '<div class="sec"><h3>Waiting for your review</h3><p><b style="font-weight:600">' + esc(r.title) + ".</b> " + esc(r.summary) + '</p><p class="t-meta" style="margin:4px 0 8px">' + esc(r.checks) + " · " + r.files.length + ' files</p><div class="acts"><button class="btn small' + (aa.length ? "" : " primary") + '" data-act="approve" data-id="' + r.id + '">Approve</button><button class="btn quiet small" data-act="mock" data-what="Open diff">Open diff</button><span class="mock-tag">mock</span></div></div>').join("") +
				'<div class="sec"><h3>Now</h3><p data-live="now-' + m.id + '">' + esc(m.now) + "</p>" +
				(m.helpers.length ? '<ul class="list" style="margin-top:8px">' + m.helpers.map((h) => '<li><i class="mark working" style="margin-top:6px"></i><span>' + esc(h.title) + '<br><span class="o">' + esc(h.step) + '</span></span><span class="w">' + esc(h.since) + "</span></li>").join("") + "</ul>" : "") + "</div>" +
				(m.next.who !== "none" ? '<div class="sec"><h3>Next stop</h3><p>' + (m.next.who === "you" ? "For you: " : "") + esc(m.next.text) + "</p></div>" : "") +
				'<div class="sec"><h3>Stages · ' + t.done + " of " + tot + ' tasks</h3><div class="stations" aria-label="Stages">' + m.phases.map((p) => '<span class="' + p.state + '" title="' + esc(p.name) + '"></span>').join("") + '</div><p class="t-meta" style="margin-top:6px">' + esc((m.phases.find((p) => p.state === "active" || p.state === "failed") || { name: "All stages done" }).name) + "</p></div>" +
				'<div class="sec"><h3>Results</h3><ul class="list">' + m.delivered.map((d) => "<li>" + P.pie("done") + '<span>' + esc(d.title) + '<br><span class="o">' + esc(d.summary) + '</span><span class="chips" style="margin-top:6px">' + d.evidence.map(P.chip).join("") + '</span></span><span class="w">' + esc(d.when) + "</span></li>").join("") + "</ul></div>";
		} else if (tab === "plan") {
			let last = null;
			body = '<div class="sec">' + P.bar(t) + '<div style="margin-top:8px">' + P.legend(t) + '</div></div><ul class="list">' + m.taskList.map((k) => { const h = k.phase !== last ? '<li style="border:0;padding:12px 0 2px"><span class="t-meta">' + esc(k.phase) + "</span></li>" : ""; last = k.phase; return h + "<li>" + P.pie(k.state) + "<span>" + esc(k.title) + (k.outcome ? '<br><span class="o">' + esc(k.outcome) + "</span>" : "") + '</span><span class="w">' + P.taskWord[k.state] + "</span></li>"; }).join("") + "</ul>";
		} else if (tab === "scope") {
			const b = m.scope.budget, pct = b ? Math.min(100, (b.used / b.cap) * 100) : 0;
			body = '<div class="sec"><h3>Does on its own</h3><ul class="plain">' + m.scope.may.map((x) => "<li>" + esc(x) + "</li>").join("") + '</ul></div><div class="sec"><h3>Asks you first</h3><ul class="plain">' + m.scope.asks.map((x) => "<li>" + esc(x) + "</li>").join("") + "</ul></div>" +
				(b ? '<div class="sec"><h3>Spending today <span class="mock-tag gap-tag">gap</span></h3><p style="margin-bottom:6px">$' + b.used.toFixed(2) + ' <span class="faint">of $' + b.cap + '</span></p><div class="meter' + (pct > 90 ? " hot" : "") + '"><i style="width:' + pct + '%"></i></div></div>' : "") +
				'<div class="sec"><h3>Brief and decisions</h3><p class="muted">' + esc(m.goal) + '</p><div class="acts" style="margin-top:10px"><button class="btn small" data-act="mock" data-what="Edit brief">Edit brief</button><button class="btn quiet small" data-act="mock" data-what="Open decisions">Decisions</button></div></div>';
		} else {
			const sent = S.sent[m.id] || [];
			body = '<div class="convo">' + m.convo.concat(sent).map((x) => x.who === "event" ? '<div class="msg event">' + ic("commit", "s") + esc(x.text) + "</div>" : '<div class="msg ' + x.who + '">' + (x.who === "agent" ? '<div class="who">Coordinator · ' + esc(x.when) + "</div>" : "") + esc(x.text) + (x.mock ? '<div class="t-small">Mock, not sent</div>' : "") + "</div>").join("") + "</div>";
		}
		const foot = tab === "talk" ? '<div class="foot"><form class="composer" data-compose="' + m.id + '"><textarea aria-label="Message the coordinator" placeholder="Redirect, ask or add context" data-fk="compose"></textarea><div class="row"><span class="t-small">Return to send · mock</span><button class="btn primary small" aria-label="Send">' + ic("send", "s") + "</button></div></form></div>" : "";
		const tabs = [["overview", "Overview"], ["plan", "Plan"], ["scope", "Scope"], ["talk", "Conversation"]];
		el.innerHTML = "<header><div class=\"hrow\"><div><h2>" + esc(m.title) + "</h2><div class=\"t-meta\" style=\"display:flex;gap:8px;align-items:center;margin-top:4px\">" + P.state(m.state, aa[0] ? aa[0].reason : null) + "<span>" + esc(m.project) + '</span></div><p class="goal" style="margin-top:8px">' + esc(m.goal) + '</p></div><div class="acts">' +
			(m.state !== "done" ? '<button class="btn quiet small" data-act="pause" data-id="' + m.id + '" title="Mock. Mission pause needs a contract">' + ic(m.state === "paused" ? "play" : "pause", "s") + (m.state === "paused" ? "Resume" : "Pause") + "</button>" : "") +
			'<button class="icon-btn" data-act="mmenu" aria-label="Mission actions">' + ic("more") + '</button><button class="icon-btn" data-act="close" aria-label="Close" title="Close (Esc)">' + ic("x") + "</button></div></div>" +
			'<div class="tabs" role="tablist">' + tabs.map(([k, l]) => '<button role="tab" data-tab-sel="' + k + '" aria-selected="' + (tab === k) + '" tabindex="' + (tab === k ? 0 : -1) + '">' + l + "</button>").join("") + '</div></header><div class="body">' + body + "</div>" + foot;
		if (tab === "talk") { const b = el.querySelector(".body"); b.scrollTop = b.scrollHeight; }
		if (first) { const f = el.querySelector(".btn.primary") || el.querySelector('[aria-selected="true"]'); f && f.focus(); }
	}
	function closeSheet(silent) {
		document.querySelectorAll("[data-sheet]").forEach((x) => x.remove());
		if (!silent && S.sheet) {
			const back = (S.sheet.prev && document.contains(S.sheet.prev) && S.sheet.prev) || main.querySelector('[data-open="' + S.sheet.mid + '"]');
			back && back.focus({ preventScroll: true });
		}
		if (!silent) S.sheet = null;
	}

	function page(title, rows) { main.innerHTML = '<div class="page"><a href="#/" class="t-meta" style="display:inline-flex;gap:4px;align-items:center">' + ic("left", "s") + "Board</a><h1 style=\"margin-top:10px\">" + esc(title) + "</h1>" + rows + "</div>"; }

	function render(keep) {
		navTop();
		const [r, id, tab] = route();
		const sy = window.scrollY, fk = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.fk : null;
		if (r === "focus") focus();
		else if (r === "conversations") page("Conversations", S.w.chats.map((c) => '<div class="row"><b style="font-weight:500">' + esc(c.title) + '</b><span class="s">' + esc(c.project) + '</span><span class="w">' + esc(c.when) + ' <button class="btn quiet small" ' + (c.mission ? 'data-open="' + c.mission + '" data-tab="talk"' : 'data-act="mock" data-what="Open chat"') + ">Open</button></span></div>").join("") + '<div style="margin-top:14px"><button class="btn" data-act="mock" data-what="New chat">' + ic("plus", "s") + "New chat</button></div>");
		else if (r === "library") page("Library", S.w.artifacts.map((a) => '<div class="row"><b style="font-weight:500">' + esc(a.title) + '</b><span class="s">' + esc(M(a.mission).title) + '</span><span class="w">' + esc(a.when) + ' <button class="btn quiet small" data-act="mock" data-what="Open artifact">Open</button></span></div>').join(""));
		else if (r === "settings") page("Settings", window.MockSettings.concat(["Projects"]).map((s) => '<div class="row"><b style="font-weight:500">' + esc(s) + '</b><span class="w"><button class="btn quiet small" data-act="mock" data-what="Open ' + esc(s) + '">Open</button></span></div>').join(""));
		else if (r === "projects") page("Projects", S.w.projects.map((p) => '<div class="row"><b style="font-weight:500">' + esc(p.name) + '</b><span class="s">' + esc(p.folder) + '</span><span class="w"><button class="btn quiet small" data-act="mock" data-what="Project settings">Settings</button></span></div>').join(""));
		else board();
		if (keep) { window.scrollTo(0, sy); if (fk) { const el = main.querySelector('[data-fk="' + fk + '"]'); el && el.focus({ preventScroll: true }); } }
		if (r === "m") { if (!S.sheet || S.sheet.mid !== id) openSheet(id, tab); else { S.sheet.tab = tab || S.sheet.tab; drawSheet(false); } }
		else if (S.sheet) closeSheet(false);
	}

	function note(text) { S.notes.unshift(text); if (S.notes.length > 2) S.notes.pop(); }
	document.addEventListener("click", (e) => {
		const o = e.target.closest("[data-open]");
		if (o) { location.hash = "#/m/" + o.dataset.open + "/" + (o.dataset.tab || "overview"); return; }
		const v = e.target.closest("[data-view]"); if (v) { location.hash = v.dataset.view === "focus" ? "#/focus" : "#/"; return; }
		const ln = e.target.closest("[data-lane]"); if (ln) { S.lane = ln.dataset.lane; render(true); return; }
		const ts = e.target.closest("[data-tab-sel]"); if (ts) { location.hash = "#/m/" + S.sheet.mid + "/" + ts.dataset.tabSel; return; }
		const b = e.target.closest("[data-act]");
		if (!b) { const c = e.target.closest(".chip"); if (c && !c.closest(".card")) P.mock("open " + c.textContent.trim()); return; }
		const act = b.dataset.act;
		if (act === "palette") P.openPalette(paletteItems());
		else if (act === "close") location.hash = "#/";
		else if (act === "toggle") { S.open[b.dataset.key] = !S.open[b.dataset.key]; render(true); }
		else if (act === "skip") { S.skipped = S.skipped.filter((x) => x !== b.dataset.id).concat(b.dataset.id); render(false); const n = main.querySelector(".btn.primary"); n && n.focus(); }
		else if (act === "decide") {
			const a = S.w.attention.find((x) => x.id === b.dataset.id); if (!a) return;
			const pick = S.picks[a.id] || (a.options.find((x) => x.recommended) || a.options[0]).id, opt = a.options.find((x) => x.id === pick);
			S.w.attention = S.w.attention.filter((x) => x !== a);
			const m = M(a.mission); const pause = a.kind === "failure" && pick === "c";
			m.state = pause ? "paused" : "working"; m.now = pause ? "Paused." : "Applying your choice: " + opt.label.toLowerCase() + "."; m.next = { who: "pilot", text: "Continues within the agreed scope." };
			note(m.title + ": " + opt.label + ". Mock only.");
			P.mock("decision recorded locally");
			const inFocus = route()[0] === "focus";
			render(true); if (S.sheet) drawSheet(false);
			if (inFocus) { const n = main.querySelector(".btn.primary"); n && n.focus(); }
		} else if (act === "check") {
			S.checking[b.dataset.id] = true; render(true); if (S.sheet) drawSheet(false);
			setTimeout(() => { const a = S.w.attention.find((x) => x.id === b.dataset.id); if (!a) return; S.w.attention = S.w.attention.filter((x) => x !== a); const m = M(a.mission); m.state = "working"; m.now = "Push confirmed. Continuing."; note(m.title + ": e93b1a0 confirmed on main. Mock result."); render(true); if (S.sheet) drawSheet(false); }, 1200);
		} else if (act === "approve") { const r = S.w.reviews.find((x) => x.id === b.dataset.id); r.state = "done"; note("Approved " + r.title + " in " + M(r.mission).title + ". Mock only."); P.mock("approved"); render(true); if (S.sheet) drawSheet(false); }
		else if (act === "pause") { const m = M(b.dataset.id); m.state = m.state === "paused" ? "working" : "paused"; m.now = m.state === "paused" ? "Paused by you. Helpers stop after their current step." : "Resumed."; P.mock(m.state === "paused" ? "mission paused" : "mission resumed"); render(true); drawSheet(false); }
		else if (act === "project") P.openMenu(b, [{ label: "All projects", run: () => { S.project = "all"; render(false); } }].concat(S.w.projects.map((p) => ({ label: p.name, icon: "folder", run: () => { S.project = p.id; render(false); } }))).concat(["-", { label: "Projects…", run: () => (location.hash = "#/projects") }]));
		else if (act === "new") P.openMenu(b, [{ label: "New mission…", icon: "target", run: () => P.mock("new mission") }, { label: "New chat", icon: "chat", run: () => P.mock("new chat") }]);
		else if (act === "more") P.openMenu(b, [{ label: "Conversations", icon: "chat", run: () => (location.hash = "#/conversations") }, { label: "Library", icon: "grid", run: () => (location.hash = "#/library") }, { label: "Projects", icon: "folder", run: () => (location.hash = "#/projects") }, "-", { label: "Settings", icon: "settings", hint: "⌘,", run: () => (location.hash = "#/settings") }]);
		else if (act === "mmenu") P.openMenu(b, [{ label: "Edit brief", icon: "file", run: () => P.mock("edit brief") }, { label: "Artifacts", icon: "grid", run: () => (location.hash = "#/library") }, "-", { label: "Mark done", icon: "check", run: () => P.mock("mark done needs confirmation") }, { label: "Archive mission", icon: "folder", run: () => P.mock("archive needs confirmation") }]);
		else if (act === "mock") P.mock(b.dataset.what || "action");
	});
	document.addEventListener("change", (e) => { const r = e.target.closest("[data-pick]"); if (r) S.picks[r.dataset.pick] = r.value; });
	document.addEventListener("submit", (e) => {
		const f = e.target.closest("[data-compose]"); if (!f) return; e.preventDefault();
		const ta = f.querySelector("textarea"), text = ta.value.trim(); if (!text) return;
		(S.sent[f.dataset.compose] = S.sent[f.dataset.compose] || []).push({ who: "user", text, mock: true });
		drawSheet(false); const t2 = document.querySelector(".sheet textarea"); t2 && t2.focus();
	});
	document.addEventListener("keydown", (e) => {
		if (e.key === "Escape" && S.sheet && !document.querySelector(".menu,.pal-scrim")) { e.preventDefault(); location.hash = "#/"; }
		if (e.key === "Enter" && !e.shiftKey && e.target.matches(".composer textarea") && !e.isComposing) { e.preventDefault(); e.target.form.requestSubmit(); }
		if ((e.metaKey || e.ctrlKey) && e.key === ",") { e.preventDefault(); location.hash = "#/settings"; }
		const tab = e.target.closest && e.target.closest("[data-tab-sel]");
		if (tab && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
			const all = [...document.querySelectorAll("[data-tab-sel]")]; const i = all.indexOf(tab);
			const n = all[(i + (e.key === "ArrowRight" ? 1 : all.length - 1)) % all.length];
			location.hash = "#/m/" + S.sheet.mid + "/" + n.dataset.tabSel; setTimeout(() => { const t = document.querySelector('[data-tab-sel="' + n.dataset.tabSel + '"]'); t && t.focus(); }, 0);
		}
		// Arrow keys move between cards inside a column
		const card = e.target.closest && e.target.closest(".card");
		if (card && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
			const list = [...card.parentElement.querySelectorAll(".card")]; const i = list.indexOf(card);
			const n = list[i + (e.key === "ArrowDown" ? 1 : -1)]; if (n) { e.preventDefault(); n.focus(); }
		}
	});

	function paletteItems() {
		const go = (h) => () => (location.hash = h);
		return [["Board", "#/", "board"], ["Focus", "#/focus", "target"], ["Conversations", "#/conversations", "chat"], ["Library", "#/library", "grid"], ["Projects", "#/projects", "folder"], ["Settings", "#/settings", "settings"]].map(([l, h, i]) => ({ group: "Places", label: l, icon: i, run: go(h) }))
			.concat(S.w.missions.map((m) => ({ group: "Missions", label: m.title, icon: "compass", hint: m.project, run: go("#/m/" + m.id + "/overview") })))
			.concat(S.w.missions.map((m) => ({ group: "Talk", label: "Talk to " + m.title + " coordinator", icon: "chat", run: go("#/m/" + m.id + "/talk") })))
			.concat([{ group: "Actions", label: "New mission", icon: "plus", run: () => P.mock("new mission") }, { group: "Actions", label: "New chat", icon: "plus", run: () => P.mock("new chat") }]);
	}

	let tick = 0;
	setInterval(() => {
		if (S.w.scenario !== "underway") return; tick++;
		S.w.missions.forEach((m) => { if (m.state !== "working") return; m.now = m.steps[tick % m.steps.length]; document.querySelectorAll('[data-live="now-' + m.id + '"]').forEach((el) => P.swapText(el, m.now)); });
	}, 5000);

	window.addEventListener("hashchange", () => { const had = !!S.sheet; render(had); if (!had && !S.sheet) main.focus({ preventScroll: true }); });
	window.addEventListener("proto:scenario", () => { reset(); render(true); });
	P.palette(paletteItems);
	reset(); render(false);
	P.mountPanel("C · Board");
})();
