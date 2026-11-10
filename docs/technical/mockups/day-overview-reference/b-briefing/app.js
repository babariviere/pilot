// Concept B: Briefing. Time-first; one thing at a time; missions read as short stories. Mock state only.
(function () {
	"use strict";
	const P = window.Proto, esc = P.esc, ic = P.icon;
	const S = { w: null, picks: {}, open: {}, notes: [], checking: {}, sent: {}, day: "today", snoozed: [] };
	const top = document.getElementById("top"), main = document.getElementById("main");
	const skyWrap = document.querySelector(".sky");
	P.dither(document.getElementById("sky"), {
		cell: 4,
		light: [["#b7d5f2", 0], ["#d6e8f8", 0.4], ["#eef5fc", 0.75], ["#ffffff", 1]],
		dark: [["#1b2433", 0], ["#24344a", 0.45], ["#28303d", 0.78], ["#23262c", 1]],
	});

	function reset() { S.w = window.MockWorld(P.scenario); S.picks = {}; S.notes = []; S.checking = {}; S.sent = {}; S.snoozed = []; S.day = "today"; }
	const M = (id) => S.w.missions.find((m) => m.id === id);
	const route = () => (location.hash.replace(/^#\/?/, "") || "").split("/");
	const queue = () => {
		const reviews = S.w.reviews.filter((r) => r.state === "waiting").map((r) => ({ id: r.id, kind: "review", mission: r.mission, title: "Review: " + r.title, effort: "About 2 min", r }));
		const a = S.w.attention.concat(reviews);
		return a.filter((x) => !S.snoozed.includes(x.id)).concat(a.filter((x) => S.snoozed.includes(x.id)));
	};

	function navTop() {
		const r = route()[0];
		top.innerHTML = '<a class="brand" href="#/">' + '<span class="logo" aria-hidden="true"></span>Pilot</a>' +
			(r === "" ? '<div class="days" role="group" aria-label="Briefing day">' + [["today", "Today"], ["yesterday", "Yesterday"], ["week", "This week"]].map(([k, l]) => '<button data-day="' + k + '" aria-pressed="' + (S.day === k) + '">' + l + "</button>").join("") + "</div>" : '<span style="margin:auto"></span>') +
			'<div class="right"><button class="link-btn" style="border:0;background:none;cursor:pointer" data-act="palette" aria-label="Search (Command K)">' + ic("search") + '<span class="lbl">Search</span></button>' +
			'<a class="link-btn" href="#/missions">' + ic("compass") + '<span class="lbl">Missions</span></a>' +
			'<button class="icon-btn" data-act="more" aria-label="More places" title="Library, conversations, projects and settings">' + ic("more") + "</button></div>";
	}

	// ----- decision focus card
	function focusCard(a, idx, count) {
		const m = M(a.mission);
		if (a.kind === "review") {
			const r = a.r;
			return '<article class="focus" aria-labelledby="fh-' + a.id + '"><h3 id="fh-' + a.id + '">' + esc(a.title) + '</h3><div class="meta"><i class="mark ready"></i><span class="state ready" style="gap:0">Ready for review</span><span>· <a href="#/m/' + m.id + '" style="color:inherit">' + esc(m.title) + "</a> · " + esc(a.effort) + "</span>" + (count > 1 ? '<span class="step">' + (idx + 1) + " of " + count + "</span>" : "") + "</div>" +
				'<p class="ctx">' + esc(r.summary) + '</p><p class="why">' + ic("checks", "s") + "<span>" + esc(r.checks) + " · " + r.files.length + " files changed</span></p>" +
				'<div class="acts" style="margin-top:16px"><button class="btn primary" data-act="approve" data-id="' + r.id + '" data-fk="f-' + a.id + '">Approve</button><button class="btn quiet" data-act="mock" data-what="Open diff">Open diff</button>' + (count > 1 ? '<button class="btn quiet" data-act="snooze" data-id="' + a.id + '">Later</button>' : "") + '<span class="mock-tag">mock</span></div>' +
				'<div class="chips" style="margin-top:16px">' + r.evidence.map(P.chip).join("") + "</div></article>";
		}
		const pick = S.picks[a.id] || (a.options.find((o) => o.recommended) || a.options[0]).id;
		const mk = { decision: "needs", approval: "needs", failure: "failed", unknown: "unknown" }[a.kind];
		let body;
		if (a.kind === "unknown") {
			body = '<div class="acts" style="margin-top:18px"><button class="btn primary" data-act="check" data-id="' + a.id + '" data-fk="f-' + a.id + '"' + (S.checking[a.id] ? " disabled" : "") + ">" + ic("refresh", "s") + (S.checking[a.id] ? "Checking…" : "Check again") + '</button><button class="btn quiet" data-act="toggle" data-key="det-' + a.id + '" aria-expanded="' + !!S.open["det-" + a.id] + '">What was pushed</button>' + (count > 1 ? '<button class="btn quiet" data-act="snooze" data-id="' + a.id + '">Later</button>' : "") + '<span class="mock-tag">mock</span></div>' +
				(S.open["det-" + a.id] ? '<p class="t-meta" style="margin-top:10px">Commit e93b1a0, 6 files, "Image zoom and pan".</p>' : "");
		} else {
			body = '<div class="choices" role="radiogroup" aria-label="Choices">' + a.options.map((o) => '<label class="choice"><input type="radio" name="c-' + a.id + '" value="' + o.id + '" data-pick="' + a.id + '"' + (o.id === pick ? " checked" : "") + '><span><span class="l">' + esc(o.label) + (o.recommended ? '<span class="rec">Recommended</span>' : "") + '</span><br><span class="d">' + esc(o.detail) + "</span></span></label>").join("") + "</div>" +
				'<div class="acts"><button class="btn primary" data-act="decide" data-id="' + a.id + '" data-fk="f-' + a.id + '">' + (a.kind === "approval" ? "Confirm" : "Decide") + "</button>" + (count > 1 ? '<button class="btn quiet" data-act="snooze" data-id="' + a.id + '">Later</button>' : "") + '<a class="btn quiet" href="#/m/' + m.id + '/talk">Ask first</a><span class="mock-tag">mock</span></div>';
		}
		return '<article class="focus" aria-labelledby="fh-' + a.id + '"><h3 id="fh-' + a.id + '">' + esc(a.title) + '</h3><div class="meta"><i class="mark ' + mk + '"></i><span class="state ' + mk + '" style="gap:0">' + esc(a.reason) + '</span><span>· <a href="#/m/' + m.id + '" style="color:inherit">' + esc(m.title) + "</a> · " + esc(a.effort || "") + "</span>" + (count > 1 ? '<span class="step">' + (idx + 1) + " of " + count + "</span>" : "") + "</div>" +
			'<p class="ctx">' + esc(a.context) + "</p>" +
			(a.tried ? '<ul class="tried" aria-label="What Pilot tried">' + a.tried.map((t) => "<li>" + esc(t) + "</li>").join("") + "</ul>" : "") +
			'<div class="why">' + ic("shield", "s") + "<span>" + esc(a.boundary) + "</span></div>" + body +
			'<div class="chips" style="margin-top:16px">' + a.evidence.map(P.chip).join("") + "</div></article>";
	}

	// ----- Home: the briefing
	function home() {
		skyWrap.style.display = "";
		const w = S.w;
		if (S.day !== "today") return pastDay();
		const q = queue();
		const working = w.missions.filter((m) => m.state === "working" || m.state === "background" || m.state === "paused" || m.state === "planned");
		const link = (id) => '<a href="#/m/' + id + '">' + esc(M(id).title) + "</a>";
		const sum = esc(w.summary).replace(/(Tidy shell setup|Quieter notifications|Faster search|the native app|The native app)/, (s) => {
			const map = { "Tidy shell setup": "dotfiles", "Quieter notifications": "notify", "Faster search": "search", "the native app": "native", "The native app": "native" };
			return '<a href="#/m/' + map[s] + '">' + s + "</a>";
		});
		let forYou = "";
		forYou = S.notes.map((n) => '<div class="done-note">' + ic("check", "s") + esc(n) + "</div>").join("");
		if (q.length) {
			forYou += focusCard(q[0], 0, q.length);
			if (q.length > 1) forYou += '<ul class="queue" aria-label="Up next">' + q.slice(1).map((a) => '<li><i class="mark ' + (a.kind === "failure" ? "failed" : a.kind === "unknown" ? "unknown" : a.kind === "review" ? "ready" : "needs") + '"></i><span>Up next: <span class="t">' + esc(a.title) + '</span></span><span class="w">' + esc(a.effort || "") + "</span></li>").join("") + "</ul>";
		} else {
			forYou += '<p class="calm">' + ic("checks") + "Nothing needs you. Pilot keeps going on its own.</p>";
		}
		const away = w.digest;
		const awayOpen = S.open.away;
		main.innerHTML = '<div class="col">' +
			'<div class="hello"><h1 class="t-display">' + esc(!S.notes.length ? w.headline : !q.length ? "That was everything. Pilot is back on it." : q.length === 1 ? "One thing left." : q.length + " things left.") + '</h1><p class="sum">' + sum + '</p><p class="when-line">' + esc(w.date) + ", " + esc(w.time) + "</p>" +
			(w.leftOff && !q.length ? '<p class="resume">' + ic("back", "s") + '<a href="#/m/' + w.leftOff.mission + '">' + esc(w.leftOff.text) + "</a></p>" : "") + "</div>" +
			'<section class="part"><h2>For you' + (q.length ? ' <span class="n">' + q.length + "</span>" : "") + "</h2>" + forYou + "</section>" +
			'<section class="part"><h2>Since you looked <span class="n">' + esc(w.lastLooked) + "</span></h2>" +
			away.slice(0, awayOpen ? 99 : 3).map((d) => {
				const bad = d.evidence.some((e) => e.bad), warn = d.evidence.some((e) => e.warn);
				return '<div class="entry"><span class="dot' + (bad ? " bad" : warn ? " warn" : "") + '"></span><div><p class="txt">' + esc(d.text) + '</p><div class="chips">' + d.evidence.map(P.chip).join("") + '<span class="src">' + link(d.mission) + "</span></div></div></div>";
			}).join("") + "</section>" +
			'<section class="part"><h2>Underway</h2>' + (working.length ? working.map((m) => '<div class="under"><i class="mark ' + P.markClass[m.state] + '"></i><div><span class="t"><a href="#/m/' + m.id + '">' + esc(m.title) + '</a></span> <span class="s" data-live="now-' + m.id + '">' + esc(m.now) + '</span></div><span class="w">' + (m.helpers.length ? m.helpers.length + " helper" + (m.helpers.length > 1 ? "s" : "") : P.stateWord[m.state]) + "</span></div>").join("") : '<p class="muted">Nothing running.</p>') + "</section>" +
			'<section class="part"><h2>Later</h2>' + w.scheduled.map((s) => '<div class="later">' + ic("clock", "s") + "<span>" + esc(s.text) + '</span><span class="w">' + esc(s.when) + "</span></div>").join("") + "</section>" +
			'<p class="signoff">That is everything for now. Pilot will tell you if something needs you.</p></div>';
	}
	function pastDay() {
		const y = S.day === "yesterday";
		main.innerHTML = '<div class="col"><div class="hello"><h1 class="t-display">' + (y ? "A quiet day. Two missions moved forward." : "Five results this week. One mission finished.") + '</h1><p class="sum">' +
			(y ? "Faster search measured the slow path and started the index. Quieter notifications finished its audit." : "Native desktop app finished Shell and chat. Tidy shell setup finished. You made 4 decisions.") + "</p></div>" +
			'<section class="part"><h2>Results</h2>' + S.w.missions.flatMap((m) => m.delivered.map((d) => ({ m, d }))).slice(0, y ? 3 : 5).map(({ m, d }) => '<div class="entry"><span class="dot"></span><div><p class="txt">' + esc(d.title) + '</p><div class="chips">' + d.evidence.map(P.chip).join("") + '<span class="src"><a href="#/m/' + m.id + '">' + esc(m.title) + "</a></span></div></div></div>").join("") + "</section>" +
			'<p class="signoff">Past briefings are rebuilt from mission activity. <span class="mock-tag gap-tag">derived, not stored</span></p></div>';
	}

	// ----- Mission story
	function story(id, sub) {
		skyWrap.style.display = "none";
		const m = M(id); if (!m) { main.innerHTML = "<p>Not found.</p>"; return; }
		const aa = S.w.attention.filter((a) => a.mission === id);
		const t = m.tasks, tot = t.done + t.review + t.active + t.blocked + t.todo;
		const idx = m.phases.findIndex((p) => p.state === "active" || p.state === "failed");
		const stageLine = idx >= 0 ? "Stage " + (idx + 1) + " of " + m.phases.length + ", " + m.phases[idx].name + "." : "All " + m.phases.length + " stages done.";
		const b = m.scope.budget, pct = b ? Math.min(100, (b.used / b.cap) * 100) : 0;
		const entries = m.delivered.map((d) => ({ when: d.when, html: '<p class="txt"><b style="font-weight:600">' + esc(d.title) + "</b>. " + esc(d.summary) + '</p><div class="chips">' + d.evidence.map(P.chip).join("") + "</div>" }))
			.concat(m.activity.slice(0, S.open["act-" + id] ? 99 : 3).map((a) => ({ when: a.when, html: '<p class="txt muted" style="font-size:13px">' + esc(a.text) + "</p>" })));
		const dayOf = (w) => (/^Yesterday|^Friday|^Thursday/.test(w) ? w.split(" ")[0] : "Today");
		const key = (w) => { const t = /(\d\d):(\d\d)/.exec(w); const mins = t ? +t[1] * 60 + +t[2] : 0; return (dayOf(w) === "Today" ? 20000 : dayOf(w) === "Yesterday" ? 10000 : 0) + mins; };
		entries.sort((a, b) => key(b.when) - key(a.when));
		let lastDay = null;
		const journal = entries.map((e) => { const d = dayOf(e.when); const h = d !== lastDay ? '<div class="day">' + d + "</div>" : ""; lastDay = d; return h + '<div class="entry timed"><span class="when">' + esc(e.when.replace(/^Yesterday ?/, "") || "") + "</span><div>" + e.html + "</div></div>"; }).join("");
		const convoOpen = S.open["convo-" + id] || sub === "talk";
		const sent = S.sent[id] || [];
		main.innerHTML = '<div class="story-grid"><div>' +
			'<a class="back" href="#/">' + ic("left", "s") + "Briefing</a>" +
			'<div class="story-head"><div style="display:flex;gap:12px;align-items:flex-start"><h1>' + esc(m.title) + '</h1><span style="margin-left:auto;margin-top:22px;display:flex;gap:4px">' + P.state(m.state, aa[0] ? aa[0].reason : null) + '<button class="icon-btn" data-act="mmenu" data-id="' + id + '" aria-label="Mission actions">' + ic("more") + '</button></span></div><p class="goal">' + esc(m.goal) + "</p></div>" +
			'<div class="stand"><p><b style="font-weight:600">Where it stands.</b> ' + t.done + " of " + tot + " tasks done. " + esc(stageLine) + ' <span data-live="now-' + m.id + '">' + esc(m.now) + "</span></p>" + P.bar(t) + "</div>" +
			(m.next.who !== "none" ? '<p class="next-line">' + ic("flag", "s") + "<span>Next" + (m.next.who === "you" ? " for you" : "") + ": <b>" + esc(m.next.text) + "</b></span></p>" : "") +
			(aa.length ? '<section class="part" style="margin-top:32px">' + aa.map((a, i) => focusCard(a, i, aa.length)).join('<div style="height:12px"></div>') + "</section>" : "") +
			'<section class="part"><h2>Story so far</h2>' + journal +
			(m.activity.length > 3 ? '<button class="more" data-act="toggle" data-key="act-' + id + '" aria-expanded="' + !!S.open["act-" + id] + '">' + ic("right", "s") + (S.open["act-" + id] ? "Less" : "Everything that happened") + "</button>" : "") + "</section>" +
			'<section class="talk" id="talk"><h2 class="t-meta" style="font-weight:600;margin:0 0 8px">Talk to the coordinator</h2>' +
			'<button class="more" data-act="toggle" data-key="convo-' + id + '" aria-expanded="' + !!convoOpen + '">' + ic("right", "s") + (convoOpen ? "Hide conversation" : "Show conversation (" + (m.convo.length + sent.length) + ")") + "</button>" +
			(convoOpen ? '<div class="convo">' + m.convo.concat(sent).map((x) => x.who === "event" ? '<div class="msg event">' + ic("commit", "s") + esc(x.text) + "</div>" : '<div class="msg ' + x.who + '">' + (x.who === "agent" ? '<div class="who">Coordinator · ' + esc(x.when) + "</div>" : "") + esc(x.text) + (x.mock ? '<div class="t-small">Mock, not sent</div>' : "") + "</div>").join("") + "</div>" : '<div style="height:10px"></div>') +
			'<form class="composer" data-compose="' + id + '"><textarea aria-label="Message the coordinator" placeholder="Redirect, ask or add context" data-fk="compose-' + id + '"></textarea><div class="row"><span class="t-small">Return to send · mock</span><button class="btn primary small" aria-label="Send">' + ic("send", "s") + "</button></div></form></section>" +
			"</div>" +
			'<aside class="margin" aria-label="Mission details"><div class="blk"><h3>Stages</h3><ol class="stages">' + m.phases.map((p) => '<li class="' + p.state + '">' + P.pie(p.state === "done" ? "done" : p.state === "active" ? "active" : p.state === "failed" ? "blocked" : "todo") + esc(p.name) + "</li>").join("") + "</ol>" +
			'<button class="more" data-act="mock" data-what="Open all tasks">' + ic("list", "s") + "All " + tot + " tasks</button></div>" +
			'<div class="blk"><h3>Does on its own</h3><ul class="plain">' + m.scope.may.map((x) => "<li>" + esc(x) + "</li>").join("") + '</ul><h3 style="margin-top:14px">Asks you first</h3><ul class="plain">' + m.scope.asks.map((x) => "<li>" + esc(x) + "</li>").join("") + "</ul></div>" +
			(b ? '<div class="blk"><h3>Spending today <span class="mock-tag gap-tag">gap</span></h3><div style="font-size:13px">$' + b.used.toFixed(2) + ' <span class="faint">of $' + b.cap + '</span></div><div class="meter' + (pct > 90 ? " hot" : "") + '"><i style="width:' + pct.toFixed(1) + '%"></i></div></div>' : "") +
			(m.helpers.length ? '<div class="blk"><h3>Helpers</h3>' + m.helpers.map((h) => '<div style="font-size:12.5px;padding:3px 0"><span>' + esc(h.title) + '</span><br><span class="faint">' + esc(h.step) + " · " + esc(h.since) + "</span></div>").join("") + "</div>" : "") +
			"</aside></div>";
		if (sub === "talk") { const ta = main.querySelector("textarea"); ta && ta.focus(); document.getElementById("talk").scrollIntoView({ block: "center" }); }
	}

	function missions() {
		skyWrap.style.display = "none";
		const w = S.w;
		const row = (m) => '<a class="list-row" href="#/m/' + m.id + '"><span class="t">' + esc(m.title) + '</span><span class="s">' + esc(m.now) + '</span><span class="w">' + P.state(m.state) + "</span></a>";
		main.innerHTML = '<div class="col"><a class="back" href="#/">' + ic("left", "s") + 'Briefing</a><h1 class="t-title" style="margin:14px 0 18px">Missions</h1>' + w.missions.filter((m) => m.state !== "done").map(row).join("") +
			'<h2 class="t-meta" style="margin:28px 0 6px;font-weight:600">Finished</h2>' + w.missions.filter((m) => m.state === "done").map(row).join("") +
			'<div style="margin-top:20px"><button class="btn" data-act="mock" data-what="New mission">' + ic("plus", "s") + "New mission</button></div></div>";
	}
	function simple(title, rows) {
		skyWrap.style.display = "none";
		main.innerHTML = '<div class="col"><a class="back" href="#/">' + ic("left", "s") + 'Briefing</a><h1 class="t-title" style="margin:14px 0 18px">' + esc(title) + "</h1>" + rows + "</div>";
	}

	function render(keep) {
		navTop();
		const [r, id, sub] = route();
		const sy = window.scrollY, fk = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.fk : null;
		if (r === "m") story(id, sub);
		else if (r === "missions") missions();
		else if (r === "library") simple("Library", S.w.artifacts.map((a) => '<button class="list-row" style="width:100%;border-left:0;border-right:0;border-bottom:0;background:none;text-align:left;cursor:pointer" data-act="mock" data-what="Open artifact"><span class="t">' + esc(a.title) + '</span><span class="s">' + esc(M(a.mission).title) + '</span><span class="w faint">' + esc(a.when) + "</span></button>").join(""));
		else if (r === "conversations") simple("Conversations", S.w.chats.map((c) => '<a class="list-row" href="' + (c.mission ? "#/m/" + c.mission + "/talk" : "#/conversations") + '" ' + (c.mission ? "" : 'data-act="mock" data-what="Open chat"') + '><span class="t">' + esc(c.title) + '</span><span class="s">' + esc(c.project) + '</span><span class="w faint">' + esc(c.when) + "</span></a>").join("") + '<div style="margin-top:16px"><button class="btn" data-act="mock" data-what="New chat">' + ic("plus", "s") + "New chat</button></div>");
		else if (r === "settings") simple("Settings", window.MockSettings.concat(["Projects"]).map((s) => '<button class="list-row" style="width:100%;border-left:0;border-right:0;border-bottom:0;background:none;text-align:left;cursor:pointer" data-act="mock" data-what="Open ' + esc(s) + '"><span class="t">' + esc(s) + '</span><span class="w">' + ic("right", "s") + "</span></button>").join(""));
		else if (r === "projects") simple("Projects", S.w.projects.map((p) => '<div class="list-row"><span class="t">' + esc(p.name) + '</span><span class="s">' + esc(p.folder) + '</span><span class="w"><button class="btn small quiet" data-act="mock" data-what="Project settings">Settings</button></span></div>').join(""));
		else home();
		if (keep) { window.scrollTo(0, sy); if (fk) { const el = main.querySelector('[data-fk="' + fk + '"]'); el && el.focus({ preventScroll: true }); } }
	}

	function resolve(a, note, apply) {
		S.w.attention = S.w.attention.filter((x) => x !== a);
		const m = M(a.mission); apply(m);
		S.notes.unshift(note);
		if (S.notes.length > 2) S.notes.pop();
		render(true);
		const next = main.querySelector(".focus .btn.primary"); next && next.focus({ preventScroll: true });
	}

	document.addEventListener("click", (e) => {
		const b = e.target.closest("[data-act],[data-day]");
		if (!b) { const c = e.target.closest(".chip"); if (c) P.mock("open " + c.textContent.trim()); return; }
		if (b.dataset.day) { S.day = b.dataset.day; render(false); return; }
		const act = b.dataset.act;
		if (act === "palette") P.openPalette(paletteItems());
		else if (act === "decide") {
			const a = S.w.attention.find((x) => x.id === b.dataset.id); if (!a) return;
			const pick = S.picks[a.id] || (a.options.find((o) => o.recommended) || a.options[0]).id, opt = a.options.find((o) => o.id === pick);
			resolve(a, "Decided for " + M(a.mission).title + ": " + opt.label + ". Mock only.", (m) => { m.state = (a.kind === "failure" && pick === "c")  ? "paused" : "working"; m.now = m.state === "paused" ? "Paused." : "Applying your choice."; m.next = { who: "pilot", text: "Continues within the agreed scope." }; });
			P.mock("decision recorded locally");
		} else if (act === "check") {
			S.checking[b.dataset.id] = true; render(true);
			setTimeout(() => { const a = S.w.attention.find((x) => x.id === b.dataset.id); if (a) resolve(a, "Confirmed: e93b1a0 is on main. Mock result.", (m) => { m.state = "working"; m.now = "Push confirmed. Continuing."; }); }, 1200);
		} else if (act === "snooze") { S.snoozed = S.snoozed.filter((x) => x !== b.dataset.id).concat(b.dataset.id); render(true); const n = main.querySelector(".focus .btn.primary"); n && n.focus({ preventScroll: true }); P.toast("Moved to the end. It still blocks that mission."); }
		else if (act === "toggle") { S.open[b.dataset.key] = !S.open[b.dataset.key]; render(true); }
		else if (act === "approve") {
			const r = S.w.reviews.find((x) => x.id === b.dataset.id); if (!r) return;
			r.state = "done"; S.notes.unshift("Approved " + r.title + ". Mock only."); if (S.notes.length > 2) S.notes.pop();
			P.mock("approved"); render(true); const n = main.querySelector(".focus .btn.primary"); n && n.focus({ preventScroll: true });
		}
		else if (act === "more") P.openMenu(b, [{ label: "Library", icon: "grid", run: () => (location.hash = "#/library") }, { label: "Conversations", icon: "chat", run: () => (location.hash = "#/conversations") }, { label: "Projects", icon: "folder", run: () => (location.hash = "#/projects") }, "-", { label: "Settings", icon: "settings", hint: "⌘,", run: () => (location.hash = "#/settings") }]);
		else if (act === "mmenu") P.openMenu(b, [{ label: "Pause mission", icon: "pause", hint: "needs contract", run: () => P.mock("pause mission") }, { label: "Brief and decisions", icon: "file", run: () => P.mock("open brief") }, { label: "All tasks", icon: "list", run: () => P.mock("open tasks") }, { label: "Artifacts", icon: "grid", run: () => (location.hash = "#/library") }, "-", { label: "Archive mission", icon: "folder", run: () => P.mock("archive needs confirmation") }]);
		else if (act === "mock") P.mock(b.dataset.what || "action");
	});
	document.addEventListener("change", (e) => { const r = e.target.closest("[data-pick]"); if (r) S.picks[r.dataset.pick] = r.value; });
	document.addEventListener("submit", (e) => {
		const f = e.target.closest("[data-compose]"); if (!f) return; e.preventDefault();
		const ta = f.querySelector("textarea"), text = ta.value.trim(); if (!text) return;
		(S.sent[f.dataset.compose] = S.sent[f.dataset.compose] || []).push({ who: "user", text, mock: true });
		S.open["convo-" + f.dataset.compose] = true; ta.value = ""; render(true);
		const t2 = main.querySelector("textarea"); t2 && t2.focus({ preventScroll: true });
	});
	document.addEventListener("keydown", (e) => {
		if (e.key === "Enter" && !e.shiftKey && e.target.matches(".composer textarea") && !e.isComposing) { e.preventDefault(); e.target.form.requestSubmit(); }
		if ((e.metaKey || e.ctrlKey) && e.key === ",") { e.preventDefault(); location.hash = "#/settings"; }
	});
	window.addEventListener("scroll", () => document.getElementById("topbar").classList.toggle("scrolled", window.scrollY > 8), { passive: true });

	function paletteItems() {
		const go = (h) => () => (location.hash = h);
		return [["Briefing", "#/", "target"], ["Missions", "#/missions", "compass"], ["Library", "#/library", "grid"], ["Conversations", "#/conversations", "chat"], ["Projects", "#/projects", "folder"], ["Settings", "#/settings", "settings"]].map(([l, h, i]) => ({ group: "Places", label: l, icon: i, run: go(h) }))
			.concat(S.w.missions.map((m) => ({ group: "Missions", label: m.title, icon: "compass", hint: m.project, run: go("#/m/" + m.id) })))
			.concat(S.w.missions.map((m) => ({ group: "Talk", label: "Talk to " + m.title + " coordinator", icon: "chat", run: go("#/m/" + m.id + "/talk") })))
			.concat([{ group: "Actions", label: "New mission", icon: "plus", run: () => P.mock("new mission") }, { group: "Actions", label: "New chat", icon: "plus", run: () => P.mock("new chat") }]);
	}

	let tick = 0;
	setInterval(() => {
		if (S.w.scenario !== "underway") return; tick++;
		S.w.missions.forEach((m) => { if (m.state !== "working") return; m.now = m.steps[tick % m.steps.length]; document.querySelectorAll('[data-live="now-' + m.id + '"]').forEach((el) => P.swapText(el, m.now)); });
	}, 5000);

	window.addEventListener("hashchange", () => { render(false); main.focus({ preventScroll: true }); });
	window.addEventListener("proto:scenario", () => { reset(); render(true); });
	P.palette(paletteItems);
	reset(); render(false);
	P.mountPanel("B · Briefing");
})();
