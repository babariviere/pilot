// Concept A: Outcomes. Top navigation, outcome list with a route per mission. Mock state only.
(function () {
	"use strict";
	const P = window.Proto, esc = P.esc, ic = P.icon;
	const S = { w: null, picks: {}, open: {}, decided: [], checking: {}, drawer: null, sent: {} };
	const top = document.getElementById("top"), main = document.getElementById("main");

	function reset() { S.w = window.MockWorld(P.scenario); S.picks = {}; S.decided = []; S.checking = {}; S.sent = {}; }
	const M = (id) => S.w.missions.find((m) => m.id === id);
	const att = () => S.w.attention;
	const reviewsWaiting = () => S.w.reviews.filter((r) => r.state === "waiting");
	const route = () => (location.hash.replace(/^#\/?/, "") || "").split("/");

	function navTop() {
		const r = route()[0] || "";
		const tab = (href, label, n, plain) => '<a href="#/' + href + '"' + (r === href || (href === "" && r === "m") ? ' aria-current="page"' : "") + ">" + label + (n ? ' <span class="count' + (plain ? " plain" : "") + '">' + n + "</span>" : "") + "</a>";
		top.innerHTML =
			'<a class="brand" href="#/" aria-label="Pilot, outcomes"><span class="logo" aria-hidden="true"></span>Pilot</a>' +
			'<nav class="tabs" aria-label="Main">' + tab("", "Outcomes") + tab("decisions", "Decisions", att().length) + tab("review", "Review", reviewsWaiting().length, true) + tab("library", "Library") + "</nav>" +
			'<div class="top-right">' +
			'<button class="search-btn" data-act="palette" aria-label="Search (Command K)">' + ic("search") + '<span class="lbl">Search</span><span class="kbd">⌘K</span></button>' +
			
			'<button class="icon-btn" data-act="new" title="New" aria-label="New mission or chat">' + ic("plus") + "</button>" +
			'<button class="icon-btn" data-act="more" title="Projects, automations and settings" aria-label="Projects, automations and settings">' + ic("settings") + "</button></div>";
	}

	// Route: phases as stations
	function routeHtml(m, compact) {
		return '<div class="route' + (compact ? " compact" : "") + '" role="img" aria-label="' + esc(m.phases.map((p) => p.name + " " + p.state).join(", ")) + '"><ol>' +
			m.phases.map((p) => '<li class="' + p.state + '"><span>' + esc(p.name) + "</span></li>").join("") + "</ol></div>";
	}
	const total = (t) => t.done + t.review + t.active + t.blocked + t.todo;
	const attFor = (m) => att().filter((a) => a.mission === m.id);

	// ---------- Outcomes (overview)
	function outcomes() {
		const w = S.w;
		const active = w.missions.filter((m) => m.state !== "done");
		const done = w.missions.filter((m) => m.state === "done");
		const a = att();
		const rw = reviewsWaiting();
		const working = active.filter((m) => m.state === "working" || m.state === "background").length;
		let next;
		if (a.length) {
			const first = a[0];
			next = '<div class="att-row' + (first.kind === "failure" ? " failed" : "") + '"><i class="mark ' + (first.kind === "failure" ? "failed" : first.kind === "unknown" ? "unknown" : "needs") + '"></i><div><div class="t">' + esc(first.title) + '</div><div class="r">' + esc(M(first.mission).title) + " · " + esc(first.effort || "") + "</div></div>" +
				'<a class="btn primary go" href="#/decisions/' + first.id + '" data-fk="next-go">' + (first.kind === "unknown" ? "Check" : "Decide") + "</a></div>" +
				(a.length + rw.length > 1 ? '<p class="t-meta" style="margin:6px 2px 0">Then ' + (a.length + rw.length - 1) + ' more. <a href="#/decisions">Decisions</a>' + (rw.length ? ', <a href="#/review">Review</a>' : "") + "</p>" : "");
		} else if (rw.length) {
			const r = rw[0];
			next = '<div class="att-row" style="background:var(--green-soft)"><i class="mark ready"></i><div><div class="t">Review: ' + esc(r.title) + '</div><div class="r">' + esc(M(r.mission).title) + " · about 2 min</div></div>" +
				'<a class="btn primary go" href="#/review" data-fk="next-go">Review</a></div>';
		} else {
			next = '<p class="lede" style="color:var(--text)">Nothing needs you. You can close Pilot; it keeps working.</p>';
		}
		const leftOff = w.leftOff && !a.length ? '<p class="t-meta" style="margin-top:8px">' + ic("back", "s") + ' <a href="#/m/' + w.leftOff.mission + '">' + esc(w.leftOff.text) + "</a></p>" : "";
		const rows = active.map((m) => {
			const aa = attFor(m);
			const nextLine = m.next.who === "you" ? '<span class="you">' + esc(m.next.text) + "</span>" : esc(m.next.text);
			return '<a class="outcome" href="#/m/' + m.id + '" data-fk="o-' + m.id + '">' +
				'<div class="o-top"><span class="o-title">' + esc(m.title) + '</span><span class="o-proj">' + esc(m.project) + "</span>" + P.state(m.state, aa[0] ? aa[0].reason : null) + "</div>" +
				'<div class="o-goal">' + esc(m.goal) + "</div>" +
				routeHtml(m, true) +
				'<div class="o-lines"><div><span class="k">Now</span><span data-live="now-' + m.id + '">' + esc(m.now) + '</span></div><div><span class="k">Next</span>' + nextLine + "</div></div></a>";
		}).join("");
		const fin = done.map((m) => '<a class="finished-row" href="#/m/' + m.id + '"><span class="t">' + esc(m.title) + '</span><span class="r">' + esc(m.delivered[0].title) + '</span><span class="w">' + esc(m.updated) + "</span></a>").join("");
		const others = w.chats.filter((c) => !c.mission);
		main.innerHTML = '<div class="col">' +
			'<div class="page-head"><h1 class="t-display">' + (a.length || rw.length ? "Your next step" : "All clear") + "</h1>" + '<div style="margin-top:14px">' + next + "</div>" + (rw.length ? "" : leftOff) + "</div>" +
			'<section class="sec"><h2>In progress <span class="n">' + active.length + (working ? " · " + working + " working" : "") + "</span></h2>" + rows + "</section>" +
			(fin ? '<section class="sec"><h2>Finished</h2>' + fin + "</section>" : "") +
			'<section class="sec"><h2>Other work</h2>' +
			'<a class="finished-row" href="#/conversations"><span class="t">' + others.length + ' chats outside missions</span><span class="r">' + others.filter((c) => c.state === "working").length + ' working</span><span class="w">' + ic("right", "s") + "</span></a>" +
			w.scheduled.map((s) => '<div class="plain-row">' + ic("clock", "s") + "<span>" + esc(s.text) + '</span><span class="w">' + esc(s.when) + "</span></div>").join("") +
			"</section></div>";
	}

	// ---------- Decision block (shared by mission page and Decisions)
	function decisionHtml(a, i) {
		const prim = !i ? "btn primary" : "btn";
		const m = M(a.mission);
		const pick = S.picks[a.id] || (a.options.find((o) => o.recommended) || a.options[0]).id;
		const kindWord = { decision: "Asks", approval: "Approval", failure: "Failed", unknown: "Unconfirmed" }[a.kind];
		const mk = { decision: "needs", approval: "needs", failure: "failed", unknown: "unknown" }[a.kind];
		const isUnknown = a.kind === "unknown";
		let opts;
		if (isUnknown) {
			const busy = S.checking[a.id];
			opts = '<div class="d-actions"><button class="' + prim + '" data-act="check" data-id="' + a.id + '" data-fk="chk-' + a.id + '"' + (busy ? " disabled" : "") + ">" + ic("refresh") + (busy ? "Checking…" : "Check again") + '</button><button class="btn quiet" data-act="details" data-id="' + a.id + '" aria-expanded="' + !!S.open["det-" + a.id] + '">Show what was pushed</button><span class="mock-tag">mock</span></div>' +
				(S.open["det-" + a.id] ? '<p class="t-meta" style="margin-top:10px">Commit e93b1a0 · 6 files · "Image zoom and pan". Pilot keeps the exact commit until the remote confirms.</p>' : "");
		} else {
			opts = '<div class="opts" role="radiogroup" aria-label="Options">' + a.options.map((o) =>
				'<label class="opt"><input type="radio" name="o-' + a.id + '" value="' + o.id + '" data-pick="' + a.id + '"' + (o.id === pick ? " checked" : "") + '><span><span class="l">' + esc(o.label) + (o.recommended ? '<span class="rec">Recommended</span>' : "") + '</span><br><span class="d">' + esc(o.detail) + "</span></span></label>").join("") + "</div>" +
				'<div class="d-actions"><button class="' + prim + '" data-act="decide" data-id="' + a.id + '" data-fk="dec-' + a.id + '">' + (a.kind === "approval" ? "Confirm" : "Decide") + '</button><button class="btn quiet" data-act="ask" data-mission="' + m.id + '">' + ic("chat", "s") + 'Ask the coordinator</button><span class="mock-tag">mock</span></div>';
		}
		return '<article class="decision" aria-labelledby="h-' + a.id + '"><h3 id="h-' + a.id + '">' + esc(a.title) + '</h3>' +
			'<div class="dk"><i class="mark ' + mk + '"></i><span class="state ' + mk + '" style="gap:0">' + kindWord + "</span><span>· " + esc(m.title) + " · " + esc(a.asked) + '</span><span style="margin-left:auto" class="faint">' + esc(a.effort || "") + "</span></div>" +
			'<p class="ctx">' + esc(a.context) + "</p>" +
			(a.tried ? '<ul class="tried" aria-label="What Pilot tried">' + a.tried.map((t) => "<li>" + esc(t) + "</li>").join("") + "</ul>" : "") +
			'<div class="boundary">' + ic("shield", "s") + "<span>" + esc(a.boundary) + "</span></div>" +
			opts + '<div class="chips" style="margin-top:14px">' + a.evidence.map(P.chip).join("") + "</div></article>";
	}

	// ---------- Mission page
	function mission(id) {
		const m = M(id);
		if (!m) { main.innerHTML = '<div class="col"><p>Not found. <a href="#/">Back to outcomes</a></p></div>'; return; }
		const aa = attFor(m);
		const t = m.tasks;
		const curPhase = (m.phases.find((p) => p.state === "active" || p.state === "failed") || m.phases[m.phases.length - 1]).name;
		const curTasks = m.taskList.filter((k) => k.phase === curPhase);
		const showAll = S.open["tasks-" + id];
		const tasksShown = showAll ? m.taskList : curTasks;
		let lastPhase = null;
		const tasksHtml = tasksShown.map((k) => {
			const head = showAll && k.phase !== lastPhase ? '<li style="border:0;padding:0"><div class="phase-name">' + esc(k.phase) + "</div></li>" : "";
			lastPhase = k.phase;
			return head + "<li>" + P.pie(k.state) + "<div><div>" + esc(k.title) + "</div>" + (k.outcome ? '<div class="o">' + esc(k.outcome) + "</div>" : "") + '</div><span class="sw">' + P.taskWord[k.state] + "</span></li>";
		}).join("");
		const helpersOpen = S.open["helpers-" + id];
		const b = m.scope.budget;
		const pct = b ? Math.min(100, (b.used / b.cap) * 100) : 0;
		const pausedByYou = m.state === "paused" && S.open["paused-" + id];
		main.innerHTML = '<div class="col" style="max-width:1100px">' +
			'<a class="crumb" href="#/">' + ic("left", "s") + "Outcomes</a>" +
			'<div class="m-head"><div><h1 class="t-display">' + esc(m.title) + '</h1><div class="m-meta"><span>' + ic("folder", "s") + " " + esc(m.project) + "</span>" + P.state(m.state, aa[0] ? aa[0].reason : null) + "<span>Updated " + esc(m.updated) + "</span></div></div>" +
			'<div class="actions"><button class="btn" data-act="ask" data-mission="' + m.id + '" data-fk="talk">' + ic("chat", "s") + "Talk to coordinator</button>" +
			(m.state !== "done" ? '<button class="btn quiet" data-act="pause" data-id="' + m.id + '" title="Mock. Mission-wide pause needs a new contract">' + ic(m.state === "paused" ? "play" : "pause", "s") + (m.state === "paused" ? "Resume" : "Pause") + ' <span class="mock-tag gap-tag">needs contract</span></button>' : "") +
			'<button class="icon-btn" data-act="mmenu" data-id="' + m.id + '" aria-label="More mission actions">' + ic("more") + "</button></div></div>" +
			'<p class="m-goal">' + esc(m.goal) + "</p>" +
			'<div class="m-route">' + routeHtml(m, false) + "</div>" +
			'<div class="m-grid"><div>' +
			(aa.length ? '<section class="sec"><h2>Needs you</h2>' + aa.map(decisionHtml).join("") + "</section>" : "") +
			S.decided.filter((d) => d.mission === m.id).map((d) => '<div class="resolved">' + ic("check", "s") + esc(d.text) + "</div>").join("") +
			'<section class="sec"><h2>Now</h2><p class="now" data-live="now-' + m.id + '">' + esc(m.now) + "</p>" +
			(m.next.who !== "none" ? '<p class="t-meta" style="margin-top:4px">' + ic("flag", "s") + " Next" + (m.next.who === "you" ? " for you" : "") + ": " + esc(m.next.text) + "</p>" : "") +
			(m.helpers.length ? '<button class="disc" data-act="toggle" data-key="helpers-' + id + '" aria-expanded="' + !!helpersOpen + '">' + ic("right", "s") + m.helpers.length + " helper" + (m.helpers.length > 1 ? "s" : "") + " working</button>" +
				(helpersOpen ? '<ul class="helpers">' + m.helpers.map((h, i) => '<li><i class="mark working"></i><span>' + esc(h.title) + '</span><span class="s" data-live="h-' + id + "-" + i + '">' + esc(h.step) + '</span><span class="w">' + esc(h.since) + '</span></li>').join("") + "</ul>" : "") : "") +
			"</section>" +
			'<section class="sec"><h2>Delivered <span class="n">' + m.delivered.length + "</span></h2>" + m.delivered.map((d) => '<div class="result"><div class="t">' + esc(d.title) + '<span class="w">' + esc(d.when) + "</span></div><p>" + esc(d.summary) + '</p><div class="chips">' + d.evidence.map(P.chip).join("") + "</div></div>").join("") + "</section>" +
			'<section class="sec"><h2>Plan <span class="n">' + t.done + " of " + total(t) + " done</span></h2>" + P.bar(t) + '<div style="margin:8px 0 6px">' + P.legend(t) + "</div>" +
			(showAll ? "" : '<div class="phase-name">' + esc(curPhase) + "</div>") + '<ul class="tasks">' + tasksHtml + "</ul>" +
			'<button class="disc" data-act="toggle" data-key="tasks-' + id + '" aria-expanded="' + !!showAll + '">' + ic("right", "s") + (showAll ? "Show current stage only" : "Show all " + total(t) + " tasks") + "</button></section>" +
			'<section class="sec"><h2>Activity</h2><ul class="activity">' + m.activity.slice(0, S.open["act-" + id] ? 99 : 4).map((a) => '<li><span class="w">' + esc(a.when) + "</span><span>" + esc(a.text) + "</span></li>").join("") + "</ul>" +
			(m.activity.length > 4 ? '<button class="disc" data-act="toggle" data-key="act-' + id + '" aria-expanded="' + !!S.open["act-" + id] + '">' + ic("right", "s") + (S.open["act-" + id] ? "Show less" : "Show all activity") + "</button>" : "") + "</section>" +
			"</div>" +
			'<aside class="aside" aria-label="Agreed scope"><div class="blk"><h3>' + ic("shield", "s") + "Agreed scope</h3>" +
			'<div class="sub">Does on its own</div><ul>' + m.scope.may.map((x) => "<li>" + esc(x) + "</li>").join("") + "</ul>" +
			'<div class="sub">Asks you first</div><ul>' + m.scope.asks.map((x) => "<li>" + esc(x) + "</li>").join("") + "</ul>" +
			'<button class="btn small quiet" data-act="mock" data-what="Open decisions and brief">Brief and decisions</button></div>' +
			(b ? '<div class="blk"><h3>' + ic("activity", "s") + 'Spending <span class="mock-tag gap-tag" title="Per-mission limits need a confirmed contract">gap</span></h3><div class="spend"><span>$' + b.used.toFixed(2) + " " + esc(b.period) + '</span><span class="faint">limit $' + b.cap + "</span></div>" +
			'<div class="meter' + (pct > 90 ? " hot" : "") + '"><i style="width:' + pct.toFixed(1) + '%"></i></div></div>' : "") + '</aside></div></div>';
	}

	// ---------- Decisions
	function decisions(focusId) {
		const a = att();
		main.innerHTML = '<div class="col"><div class="page-head"><h1 class="t-display">Decisions</h1><p class="lede">' +
			(a.length ? "Pilot stopped here because each one is outside what you agreed. One at a time." : "Nothing to decide.") + "</p></div>" +
			S.decided.map((d) => '<div class="resolved">' + ic("check", "s") + esc(d.text) + "</div>").join("") +
			(a.length ? a.map(decisionHtml).join("") : '<div class="empty"><div class="t-head">All clear</div>Pilot asks here when something is outside the agreed scope, over a limit, failed, or can\'t be confirmed.</div>') +
			'<section class="sec"><h2>Agreed earlier</h2>' +
			["Push finished features straight to main, no PRs", "Use the native shell, no web views", "Keep the current app until you accept the new one"].map((t, i) => '<div class="plain-row">' + ic("check", "s") + "<span>" + esc(t) + '</span><span class="w">D' + (132 + i) + "</span></div>").join("") + "</section></div>";
		if (focusId) { const el = document.getElementById("h-" + focusId); if (el) { el.closest(".decision").scrollIntoView({ block: "start" }); const btn = el.closest(".decision").querySelector(".btn.primary"); btn && btn.focus({ preventScroll: true }); } }
	}

	// ---------- Review
	function review() {
		const rs = S.w.reviews;
		main.innerHTML = '<div class="col"><div class="page-head"><h1 class="t-display">Review</h1><p class="lede">Finished work with its proof. Approving lets the coordinator continue.</p></div>' +
			(rs.length ? rs.map((r) => {
				const m = M(r.mission);
				return '<details class="rev"' + (r.state === "waiting" && rs.indexOf(r) === rs.findIndex((x) => x.state === "waiting") ? " open" : "") + "><summary>" + P.pie(r.state === "done" ? "done" : "review") + '<span><span class="t">' + esc(r.title) + '</span> <span class="m">' + esc(m.title) + "</span></span>" + P.state(r.state === "done" ? "done" : "ready", r.state === "done" ? "Approved" : "Waiting for you") + "</summary>" +
					'<div class="body"><p>' + esc(r.summary) + '</p><p class="t-meta" style="margin-top:6px">' + ic("checks", "s") + " " + esc(r.checks) + "</p>" +
					'<ul class="files" aria-label="Changed files">' + r.files.map((f) => "<li>" + esc(f) + "</li>").join("") + '</ul><div class="chips">' + r.evidence.map(P.chip).join("") + "</div>" +
					(r.state === "waiting" ? '<div class="d-actions"><button class="btn primary" data-act="approve" data-id="' + r.id + '">Approve</button><button class="btn quiet" data-act="mock" data-what="Request changes">Request changes</button><button class="btn quiet" data-act="mock" data-what="Open full diff">Open diff</button><span class="mock-tag">mock</span></div>' : "") +
					"</div></details>";
			}).join("") : '<div class="empty">Nothing to review.</div>') + "</div>";
	}

	// ---------- Library
	const thumbs = {
		image: '<svg viewBox="0 0 120 80"><rect x="4" y="6" width="34" height="68" rx="4" fill="var(--hair)"/><rect x="44" y="6" width="72" height="8" rx="3" fill="var(--hair-strong)"/><rect x="44" y="20" width="56" height="6" rx="3" fill="var(--hair)"/><rect x="70" y="34" width="46" height="14" rx="6" fill="var(--hair-strong)"/><rect x="44" y="54" width="60" height="6" rx="3" fill="var(--hair)"/></svg>',
		chart: '<svg viewBox="0 0 120 80"><path d="M6 70h108" stroke="var(--hair-strong)"/><rect x="14" y="40" width="12" height="30" rx="2" fill="var(--hair-strong)"/><rect x="34" y="28" width="12" height="42" rx="2" fill="var(--hair-strong)"/><rect x="54" y="48" width="12" height="22" rx="2" fill="var(--accent)" opacity=".6"/><rect x="74" y="20" width="12" height="50" rx="2" fill="var(--hair-strong)"/><rect x="94" y="56" width="12" height="14" rx="2" fill="var(--accent)" opacity=".6"/></svg>',
		diagram: '<svg viewBox="0 0 120 80"><rect x="8" y="10" width="34" height="18" rx="4" fill="none" stroke="var(--faint)"/><rect x="78" y="10" width="34" height="18" rx="4" fill="none" stroke="var(--faint)"/><rect x="43" y="52" width="34" height="18" rx="4" fill="none" stroke="var(--faint)"/><path d="M42 19h36M25 28l30 24M95 28 65 52" stroke="var(--faint)" fill="none"/></svg>',
	};
	function library() {
		const w = S.w;
		main.innerHTML = '<div class="col" style="max-width:1000px"><div class="page-head"><h1 class="t-display">Library</h1><p class="lede">Captures, charts and diagrams from every mission.</p></div>' +
			'<div class="tiles">' + w.artifacts.map((a) => '<button class="tile" data-act="mock" data-what="Open artifact reader"><div class="thumb">' + thumbs[a.kind] + '</div><div class="t">' + esc(a.title) + '</div><div class="m">' + esc(M(a.mission).title) + " · " + esc(a.when) + "</div></button>").join("") + "</div></div>";
	}

	// ---------- Conversations (secondary)
	function conversations() {
		const w = S.w;
		const row = (c) => '<a class="finished-row" href="#/chat/' + c.id + '"><span class="t">' + esc(c.title) + '</span><span class="r">' + esc(c.project) + "</span>" + '<span class="w">' + P.state(c.state === "quiet" ? "done" : c.state, c.state === "quiet" || c.state === "done" ? " " : null) + " " + esc(c.when) + "</span></a>";
		main.innerHTML = '<div class="col"><div class="page-head"><h1 class="t-display">Conversations</h1><p class="lede">Every chat is still here. You rarely need them to follow progress.</p></div>' +
			'<section class="sec"><h2>Coordinators</h2>' + w.chats.filter((c) => c.mission).map(row).join("") + "</section>" +
			'<section class="sec"><h2>Other chats</h2>' + w.chats.filter((c) => !c.mission).map(row).join("") + '<div style="margin-top:12px"><button class="btn" data-act="mock" data-what="New chat">' + ic("plus", "s") + "New chat</button> <button class=\"btn quiet\" data-act=\"mock\" data-what=\"Open archive\">Archived chats</button></div></section></div>";
	}
	function chatPage(id) {
		const c = S.w.chats.find((x) => x.id === id);
		const m = c && c.mission ? M(c.mission) : null;
		const convo = m ? m.convo : [{ who: "agent", text: "This mock chat has no history.", when: "" }];
		main.innerHTML = '<div class="col" style="max-width:760px"><a class="crumb" href="#/conversations">' + ic("left", "s") + 'Conversations</a><h1 class="t-title" style="margin-bottom:20px">' + esc(c ? c.title : "Chat") + "</h1>" + convoHtml(convo, id) + '<div style="height:16px"></div>' + composerHtml(id) + "</div>";
	}
	function convoHtml(list, key) {
		const sent = S.sent[key] || [];
		return '<div class="convo">' + list.concat(sent).map((x) => x.who === "event" ? '<div class="msg event">' + ic("commit", "s") + esc(x.text) + '<span class="faint" style="margin-left:auto">' + esc(x.when) + "</span></div>" :
			'<div class="msg ' + x.who + '">' + (x.who === "agent" ? '<div class="who">Coordinator · ' + esc(x.when) + "</div>" : "") + esc(x.text) + (x.mock ? '<div class="t-small" style="margin-top:4px">Mock, not sent</div>' : "") + "</div>").join("") + "</div>";
	}
	function composerHtml(key) {
		return '<form class="composer" data-compose="' + key + '"><textarea aria-label="Message" placeholder="Message the coordinator" data-fk="compose-' + key + '"></textarea><div class="row"><span class="t-small">Return to send · mock</span><button class="btn primary small" aria-label="Send">' + ic("send", "s") + "</button></div></form>";
	}

	function settings() {
		main.innerHTML = '<div class="col"><div class="page-head"><h1 class="t-display">Settings</h1><p class="lede">Unchanged from the current app. Shown here as a list.</p></div><div class="settings-list">' +
			window.MockSettings.concat(["Projects"]).map((s) => '<button data-act="mock" data-what="Open ' + esc(s) + ' settings">' + esc(s) + ic("right", "s") + "</button>").join("") + "</div></div>";
	}
	function projects() {
		main.innerHTML = '<div class="col"><div class="page-head"><h1 class="t-display">Projects</h1></div>' + S.w.projects.map((p) => {
			const ms = S.w.missions.filter((m) => m.project === p.id);
			return '<div class="finished-row"><span class="t">' + esc(p.name) + '</span><span class="r">' + esc(p.folder) + " · " + ms.length + " mission" + (ms.length === 1 ? "" : "s") + '</span><span class="w"><button class="btn quiet small" data-act="mock" data-what="Open project settings">Settings</button></span></div>';
		}).join("") + '<div style="margin-top:14px"><button class="btn" data-act="mock" data-what="Add project">' + ic("plus", "s") + "Add project</button></div></div>";
	}

	// ---------- Drawer (coordinator conversation)
	function openDrawer(mid) {
		closeDrawer();
		const m = M(mid);
		S.drawer = { mid, prev: document.activeElement };
		const scrim = document.createElement("div"); scrim.className = "scrim"; scrim.dataset.drawer = "1";
		const d = document.createElement("aside"); d.className = "drawer"; d.setAttribute("role", "dialog"); d.setAttribute("aria-label", "Coordinator conversation"); d.dataset.drawer = "1";
		d.innerHTML = '<header>' + ic("compass") + '<div><div class="t">Coordinator</div><div class="s">' + esc(m.title) + '</div></div><a class="btn quiet small" style="margin-left:auto" href="#/chat/m-' + m.id + '">Full chat</a><button class="icon-btn" data-act="close-drawer" aria-label="Close">' + ic("x") + '</button></header><div class="scroll">' + convoHtml(m.convo, "m-" + m.id) + '</div><div class="foot">' + composerHtml("m-" + m.id) + "</div>";
		document.body.append(scrim, d);
		scrim.addEventListener("mousedown", closeDrawer);
		d.querySelector("textarea").focus();
		const sc = d.querySelector(".scroll"); sc.scrollTop = sc.scrollHeight;
	}
	function closeDrawer() {
		document.querySelectorAll("[data-drawer]").forEach((x) => x.remove());
		if (S.drawer && S.drawer.prev && document.contains(S.drawer.prev)) S.drawer.prev.focus();
		S.drawer = null;
	}

	// ---------- Render + actions
	function render(keep) {
		navTop();
		const [r, id] = route();
		document.title = "A · Outcomes, Pilot prototype";
		const html = () => {
			if (r === "m") return mission(id);
			if (r === "decisions") return decisions(id);
			if (r === "review") return review();
			if (r === "library") return library();
			if (r === "conversations") return conversations();
			if (r === "chat") return chatPage(id);
			if (r === "settings") return settings();
			if (r === "projects") return projects();
			return outcomes();
		};
		const sy = window.scrollY, fk = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.fk : null;
		html();
		if (keep) { window.scrollTo(0, sy); if (fk) { const el = main.querySelector('[data-fk="' + fk + '"]'); el && el.focus({ preventScroll: true }); } }
	}

	function decide(id) {
		const a = att().find((x) => x.id === id); if (!a) return;
		const pick = S.picks[id] || (a.options.find((o) => o.recommended) || a.options[0]).id;
		const opt = a.options.find((o) => o.id === pick);
		S.w.attention = att().filter((x) => x !== a);
		const m = M(a.mission);
		if (pick === "c" && a.kind === "failure") { m.state = "paused"; m.now = "Paused by you."; }
		else if (a.kind === "approval" && pick === "b") { m.state = "working"; m.now = "Skipped the test copy. Using synthetic checks."; }
		else { m.state = "working"; m.now = "Applying your choice: " + opt.label.toLowerCase() + "."; }
		m.next = { who: "pilot", text: "Continues within the agreed scope." };
		m.activity.unshift({ when: "now", text: "You chose: " + opt.label + "." });
		S.decided.unshift({ mission: m.id, text: "Decided: " + opt.label + ". Recorded in this mock only." });
		P.mock("decision recorded locally");
		render(true);
		const nextBtn = main.querySelector(".decision .btn.primary") || main.querySelector(".resolved");
		if (nextBtn) { if (!nextBtn.matches("button")) nextBtn.tabIndex = -1; nextBtn.focus({ preventScroll: true }); }
	}

	document.addEventListener("click", (e) => {
		const b = e.target.closest("[data-act]");
		if (!b) return;
		const act = b.dataset.act;
		if (act === "palette") { P.openPalette(paletteItems()); }
		else if (act === "decide") decide(b.dataset.id);
		else if (act === "check") {
			S.checking[b.dataset.id] = true; render(true);
			setTimeout(() => {
				const a = att().find((x) => x.id === b.dataset.id); if (!a) return;
				S.w.attention = att().filter((x) => x !== a);
				const m = M(a.mission); m.state = "working"; m.now = "Push confirmed. Continuing with long messages."; m.next = { who: "you", text: "Review the history slice once its checks pass." };
				m.activity.unshift({ when: "now", text: "Confirmed e93b1a0 is on main." });
				S.decided.unshift({ mission: m.id, text: "Confirmed: e93b1a0 is on main. Mock result." });
				render(true);
			}, 1200);
		}
		else if (act === "details" || act === "toggle") { const k = act === "details" ? "det-" + b.dataset.id : b.dataset.key; S.open[k] = !S.open[k]; render(true); }
		else if (act === "ask") openDrawer(b.dataset.mission);
		else if (act === "close-drawer") closeDrawer();
		else if (act === "approve") { const r = S.w.reviews.find((x) => x.id === b.dataset.id); r.state = "done"; P.mock("approved"); render(true); }
		else if (act === "pause") { const m = M(b.dataset.id); if (m.state === "paused") { m.state = "working"; m.now = "Resumed."; } else { m.state = "paused"; m.now = "Paused by you. Helpers finish their current step, then stop."; S.open["paused-" + m.id] = true; } P.mock(m.state === "paused" ? "mission paused" : "mission resumed"); render(true); }
		else if (act === "mmenu") P.openMenu(b, [{ label: "Edit brief", icon: "file", run: () => P.mock("Open brief editor") }, { label: "All tasks", icon: "list", run: () => { S.open["tasks-" + b.dataset.id] = true; render(true); } }, { label: "Decisions and comments", icon: "help", run: () => P.mock("Open decisions") }, { label: "Links and artifacts", icon: "grid", run: () => (location.hash = "#/library") }, "-", { label: "Mark done", icon: "check", run: () => P.mock("Mark done needs confirmation") }, { label: "Archive mission", icon: "folder", run: () => P.mock("Archive needs confirmation") }]);
		else if (act === "new") P.openMenu(b, [{ label: "New mission…", icon: "target", run: () => P.mock("New mission sheet") }, { label: "New chat", icon: "chat", run: () => P.mock("New chat") }]);
		else if (act === "more") P.openMenu(b, [{ label: "All conversations", icon: "chat", run: () => (location.hash = "#/conversations") }, { label: "Projects", icon: "folder", run: () => (location.hash = "#/projects") }, { label: "Automations", icon: "clock", run: () => P.mock("Open Automations") }, { label: "Usage", icon: "activity", run: () => P.mock("Open Usage") }, "-", { label: "Settings", icon: "settings", hint: "⌘,", run: () => (location.hash = "#/settings") }]);
		else if (act === "mock") P.mock(b.dataset.what || "action");
		else if (b.dataset.evidence !== undefined) P.mock("open evidence");
	});
	document.addEventListener("click", (e) => { const c = e.target.closest(".chip"); if (c) P.mock("open " + c.textContent.trim()); });
	document.addEventListener("change", (e) => { const r = e.target.closest("[data-pick]"); if (r) S.picks[r.dataset.pick] = r.value; });
	document.addEventListener("submit", (e) => {
		const f = e.target.closest("[data-compose]"); if (!f) return; e.preventDefault();
		const ta = f.querySelector("textarea"); const text = ta.value.trim(); if (!text) return;
		const k = f.dataset.compose; (S.sent[k] = S.sent[k] || []).push({ who: "user", text, mock: true });
		ta.value = "";
		if (S.drawer) { const mid = S.drawer.mid; closeDrawer(); openDrawer(mid); } else render(true);
	});
	document.addEventListener("keydown", (e) => {
		if (e.key === "Escape" && S.drawer) { e.preventDefault(); closeDrawer(); }
		if (e.key === "Enter" && !e.shiftKey && e.target.matches(".composer textarea") && !e.isComposing) { e.preventDefault(); e.target.form.requestSubmit(); }
		if ((e.metaKey || e.ctrlKey) && e.key === ",") { e.preventDefault(); location.hash = "#/settings"; }
	});

	function paletteItems() {
		const w = S.w, go = (h) => () => (location.hash = h);
		return [
			{ group: "Places", label: "Outcomes", icon: "target", run: go("#/") },
			{ group: "Places", label: "Decisions", icon: "help", run: go("#/decisions"), hint: att().length ? att().length + " waiting" : "" },
			{ group: "Places", label: "Review", icon: "checks", run: go("#/review") },
			{ group: "Places", label: "Library", icon: "grid", run: go("#/library") },
			{ group: "Places", label: "Conversations", icon: "chat", run: go("#/conversations") },
			{ group: "Places", label: "Projects", icon: "folder", run: go("#/projects") },
			{ group: "Places", label: "Settings", icon: "settings", run: go("#/settings"), hint: "⌘," },
		].concat(w.missions.map((m) => ({ group: "Missions", label: m.title, icon: "compass", hint: m.project, run: go("#/m/" + m.id) })))
			.concat(w.chats.map((c) => ({ group: "Chats", label: c.title, icon: "chat", hint: c.project, run: go("#/chat/" + c.id) })))
			.concat([{ group: "Actions", label: "New mission", icon: "plus", run: () => P.mock("New mission sheet") }, { group: "Actions", label: "New chat", icon: "plus", run: () => P.mock("New chat") }]);
	}

	// Live steps for working missions (in place, no reflow of other content)
	let tick = 0;
	setInterval(() => {
		tick++;
		S.w.missions.forEach((m) => {
			if (m.state !== "working") return;
			if (S.w.scenario !== "underway") return;
			m.now = m.steps[tick % m.steps.length];
			document.querySelectorAll('[data-live="now-' + m.id + '"]').forEach((el) => P.swapText(el, m.now));
		});
	}, 5000);

	window.addEventListener("hashchange", () => { closeDrawer(); render(false); main.focus({ preventScroll: true }); });
	window.addEventListener("proto:scenario", () => { reset(); render(true); });
	P.palette(paletteItems);
	reset();
	render(false);
	P.mountPanel("A · Outcomes");
})();
