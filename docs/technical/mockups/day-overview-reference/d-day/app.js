// Concept D: Day. B's daily briefing, plus a clear "In progress" split, standup notes and an interview to start missions. Mock state only.
(function () {
	"use strict";
	const P = window.Proto, esc = P.esc, ic = P.icon;
	const S = { seen: {}, again: {}, chFilter: "all", rv: {}, autoOff: {}, extraAuto: [], help: {}, tri: null, startStep: 1, closed: false, w: null, picks: {}, open: {}, notes: [], checking: {}, sent: {}, day: "today", snoozed: [], front: null, iv: null, extra: [] };
	const top = document.getElementById("top"), main = document.getElementById("main");
	const skyWrap = document.querySelector(".sky");
	P.dither(document.getElementById("sky"), {
		cell: 4,
		light: [["#b7d5f2", 0], ["#d6e8f8", 0.4], ["#eef5fc", 0.75], ["#ffffff", 1]],
		dark: [["#1b2433", 0], ["#24344a", 0.45], ["#28303d", 0.78], ["#23262c", 1]],
	});

	// What each mission agreed to at its start, plus decisions added later. In production this is the brief and decisions.
	const AGREED = {
		native: [["Done when", "The desktop app runs on Native Shell and looks and behaves the same."], ["Won't change", "Daemon, storage and protocol."], ["Proof", "Focused tests, light and dark captures, IME checks."], ["Lands by", "Push to main after checks."], ["Stops to ask", "Installs, releases, opening apps on your Mac."], ["Added later", "Reading position matters more than speed.", "You, yesterday"]],
		notify: [["Done when", "Pilot notifies only when something needs you, and says why."], ["Won't change", "Which events notify by default, without asking you."], ["Proof", "A week of notification counts, before and after."], ["Lands by", "Push to main after checks."], ["Stops to ask", "Changes to notification rules."]],
		search: [["Done when", "Search results in under 200 ms for large workspaces."], ["Won't change", "The public search API."], ["Proof", "Benchmark before and after. All tests pass on macOS and Linux."], ["Lands by", "A pull request for your review."], ["Stops to ask", "API changes and merging."]],
		dotfiles: [["Done when", "A shell starts in under 100 ms."], ["Won't change", "Tools you used this quarter."], ["Proof", "Shell timing, before and after."], ["Lands by", "Commit to dotfiles."], ["Stops to ask", "Removing tools you used this quarter."]],
	};
	const PAST = {
		yesterday: {
			head: "A quiet day. Two missions moved forward.", sum: "Nothing broke. You made one decision.",
			done: [["search", "Found the slow path: rebuilding the index is 70% of search time."], ["notify", "Finished the notification audit. 41 sent, 6 needed you."]],
			moved: [["native", "History slice reached its checks."], ["dotfiles", "Shell start down to 120 ms."]],
			decided: [["native", "Reading position matters more than speed."]],
			open: [["notify", "Rules start today."], ["native", "History slice needs your review."]],
		},
		week: {
			head: "Five results this week. One mission finished.", sum: "Tidy shell setup is done. You made 4 decisions.",
			done: [["dotfiles", "Shell starts in 84 ms, was 310 ms."], ["native", "Shell and chat stage finished."], ["native", "Drafts survive a restart."], ["search", "Index rebuilds 4x faster."], ["notify", "Notification audit finished."]],
			moved: [["native", "Images and history started."], ["search", "Integration tests on Linux."]],
			decided: [["native", "Reading position over speed."], ["search", "Keep the public API stable."], ["dotfiles", "Keep tools used this quarter."], ["notify", "Audit before changing rules."]],
			open: [["notify", "Notification rules."], ["search", "Release PR review."]],
		},
	};

	// Interview questions. Mock: written for the CSV example, whatever goal you type.
	const QS = [
		{ key: "done", label: "Done when", title: "What does done look like?", ctx: "harbor has 6 report types. Two already export as PDF.", options: [{ id: "a", label: "All 6 reports export as CSV", detail: "One Export button per report.", rec: true }, { id: "b", label: "The 2 most used reports first", detail: "Faster. Pilot asks before doing the rest." }, { id: "c", label: "CSV and Excel", detail: "Adds a library for Excel files." }] },
		{ key: "keep", label: "Won't change", title: "What must not change?", ctx: "The billing service also reads report data.", options: [{ id: "a", label: "The report data format", detail: "Pilot asks before changing it.", rec: true }, { id: "b", label: "Nothing, if billing keeps working", detail: "Pilot may change the format and update billing." }] },
		{ key: "proof", label: "Proof", title: "How should Pilot show it works?", ctx: "harbor has sample data and 148 integration tests.", options: [{ id: "a", label: "Export every report from sample data; all tests pass", detail: "Files attached to the result.", rec: true }, { id: "b", label: "Same, and open the files in Numbers", detail: "Opens an app on your Mac, so it asks you first." }] },
		{ key: "land", label: "Lands by", title: "How should finished work land?", ctx: "harbor's main branch is protected. Pull requests need one review.", options: [{ id: "a", label: "A pull request for your review", detail: "Matches the project's rules.", rec: true }, { id: "b", label: "Keep it local until you look", detail: "Nothing leaves your Mac." }] },
		{ key: "ask", label: "Stops to ask", title: "When should Pilot stop and ask you?", ctx: "For everything else, Pilot decides and writes down why.", options: [{ id: "a", label: "Only for things outside this agreement", detail: "Fewest interruptions.", rec: true }, { id: "b", label: "Also before each pull request", detail: "One more check-in per result." }, { id: "c", label: "Also when the plan changes", detail: "More check-ins, more control." }] },
	];
	const EXAMPLE = "Let people export harbor reports as CSV.";
	const SMALL = "Fix the broken link in harbor's README.";
	const isSmall = (g) => g === SMALL || (g.length < 70 && /\b(fix|typo|rename|bump|update|explain|why)\b/i.test(g) && !/\band\b/i.test(g));

	function reset() { S.nowAdd = 0; S.sel = null; S.startStep = 1; S.closed = false; S.w = window.MockWorld(P.scenario); S.w.missions.push(...S.extra.map((m) => JSON.parse(JSON.stringify(m)))); S.picks = {}; S.notes = []; S.checking = {}; S.sent = {}; S.snoozed = []; S.front = null; }
	const M = (id) => S.w.missions.find((m) => m.id === id);
	const route = () => (location.hash.replace(/^#\/?/, "") || "").split("/");
	const queue = () => {
		const reviews = S.w.reviews.filter((r) => r.state === "waiting").map((r) => ({ id: r.id, kind: "review", mission: r.mission, title: "Review: " + r.title, effort: "About 2 min", r }));
		let a = S.w.attention.concat(reviews);
		a = a.filter((x) => !S.snoozed.includes(x.id)).concat(a.filter((x) => S.snoozed.includes(x.id)));
		if (S.front) { const f = a.find((x) => x.id === S.front); if (f) a = [f].concat(a.filter((x) => x !== f)); }
		return a;
	};
	const moving = (m) => m.state === "working" || m.state === "background";
	const blockerFor = (m) => queue().find((a) => a.mission === m.id);

	function navTop() {
		const r = route()[0];
		top.innerHTML = '<a class="brand" href="#/"><span class="logo" aria-hidden="true"></span>Pilot</a>' +
			(r === "" ? '<div class="days" role="group" aria-label="Day">' + [["today", "Today"], ["yesterday", "Yesterday"], ["week", "This week"]].map(([k, l]) => '<button data-day="' + k + '" aria-pressed="' + (S.day === k) + '">' + l + "</button>").join("") + "</div>" : '<span style="margin:auto"></span>') +
			'<div class="right"><button class="link-btn" style="border:0;background:none;cursor:pointer" data-act="palette" aria-label="Search (Command K)">' + ic("search") + '<span class="lbl">Search</span></button>' +
			'<a class="btn new" href="#/new" title="New (⌘N)">' + ic("plus", "s") + '<span class="lbl">New</span></a>' +
			'<button class="icon-btn" data-act="more" aria-label="More places" title="Missions, library, projects and settings">' + ic("more") + "</button></div>";
	}

	// ----- decision card (same as B)
	function focusCard(a, idx, count) {
		const m = M(a.mission);
		const stepTag = count > 1 ? '<span class="step">' + (idx + 1) + " of " + count + "</span>" : "";
		if (a.kind === "review") {
			const r = a.r;
			return '<article class="focus" id="dec-' + a.id + '" aria-labelledby="fh-' + a.id + '"><h3 id="fh-' + a.id + '">' + esc(a.title) + '</h3><div class="meta"><i class="mark ready"></i><span class="state ready" style="gap:0">Ready for review</span><span>· <a href="#/m/' + m.id + '" style="color:inherit">' + esc(m.title) + "</a> · " + esc(a.effort) + "</span>" + stepTag + "</div>" +
				ctxHtml(a) + helpHtml(a) + '<p class="why">' + ic("checks", "s") + "<span>" + esc(r.checks) + " · " + r.files.length + " files changed</span></p>" +
				'<div class="acts" style="margin-top:16px"><button class="btn primary" data-act="approve" data-id="' + r.id + '" data-fk="f-' + a.id + '">Approve</button><a class="btn quiet" href="#/review/' + r.id + '">Open review</a>' + (count > 1 ? '<button class="btn quiet" data-act="snooze" data-id="' + a.id + '">Later</button>' : "") + '<span class="mock-tag">mock</span></div>' +
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
				'<div class="acts"><button class="btn primary" data-act="decide" data-id="' + a.id + '" data-fk="f-' + a.id + '">' + (a.kind === "approval" ? "Confirm" : "Decide") + "</button>" + (count > 1 ? '<button class="btn quiet" data-act="snooze" data-id="' + a.id + '">Later</button>' : "") + '<span class="mock-tag">mock</span></div>';
		}
		return '<article class="focus" id="dec-' + a.id + '" aria-labelledby="fh-' + a.id + '"><h3 id="fh-' + a.id + '">' + esc(a.title) + '</h3><div class="meta"><i class="mark ' + mk + '"></i><span class="state ' + mk + '" style="gap:0">' + esc(a.reason) + '</span><span>· <a href="#/m/' + m.id + '" style="color:inherit">' + esc(m.title) + "</a> · " + esc(a.effort || "") + "</span>" + stepTag + "</div>" +
			ctxHtml(a) + helpHtml(a) +
			(a.tried ? '<ul class="tried" aria-label="What Pilot tried">' + a.tried.map((t) => "<li>" + esc(t) + "</li>").join("") + "</ul>" : "") +
			'<div class="why">' + ic("shield", "s") + "<span>" + esc(a.boundary) + "</span></div>" + body +
			'<div class="chips" style="margin-top:16px">' + a.evidence.map(P.chip).join("") + "</div></article>";
	}

	// ----- one mission row: moving or waiting, said in words
	function track(m) {
		const t = m.tasks, tot = t.done + t.review + t.active + t.blocked + t.todo;
		const idx = m.phases.findIndex((p) => p.state === "active" || p.state === "failed");
		const stage = m.quick ? "Quick task" : idx >= 0 ? "Stage " + (idx + 1) + " of " + m.phases.length + " · " + m.phases[idx].name : "All stages done";
		return '<div class="track">' + P.bar(t) + "<span>" + esc(stage) + '</span><span style="margin-left:auto">' + t.done + " of " + tot + " done</span></div>";
	}
	function missionRow(m) {
		const b = blockerFor(m);
		let word, line;
		if (moving(m)) {
			word = P.state("working", "Moving");
			line = '<span class="line" data-live="now-' + m.id + '">' + esc(m.now) + "</span>";
		} else if (b) {
			const who = b.kind === "failure" ? "Stuck" : b.kind === "unknown" ? "Unconfirmed" : "Waiting for you";
			word = P.state(b.kind === "failure" ? "failed" : b.kind === "unknown" ? "unknown" : "needs", who);
			line = '<span class="line">' + esc(m.now) + ' <button class="go" data-act="focus-dec" data-id="' + b.id + '">' + (b.kind === "review" ? "Review it" : b.kind === "unknown" ? "Check it" : "Decide") + "</button></span>";
		} else if (m.state === "paused") {
			word = P.state("paused", "Paused");
			line = '<span class="line">' + esc(m.now) + "</span>";
		} else {
			word = P.state("paused", m.state === "planned" ? "Starts later" : P.stateWord[m.state]);
			line = '<span class="line">' + esc(m.next && m.next.text ? m.next.text : m.now) + "</span>";
		}
		return '<a class="mrow' + (moving(m) ? " moving" : "") + '" href="#/m/' + m.id + '"><span class="t">' + esc(m.title) + "</span>" + word + line + track(m) + "</a>";
	}

	// ----- Now line (concept C): the day as a timeline. Left of the line is done, right is planned.
	const MODE = window.PILOT_MODE || "day";
	const hm = (x) => { const r = /(\d\d):(\d\d)/.exec(x || ""); return r ? +r[1] * 60 + +r[2] : null; };
	const ago = (x) => { const r = /(\d+)\s*(min|h)/.exec(x || ""); return r ? +r[1] * (r[2] === "h" ? 60 : 1) : 0; };
	const fmt = (v) => String(Math.floor(v / 60)).padStart(2, "0") + ":" + String(v % 60).padStart(2, "0");
	const short = (x, n) => (x.length > n ? x.slice(0, n - 1).replace(/\s+\S*$/, "") + "…" : x);
	const isToday = (w) => w && !/^(Yesterday|Mon|Tue|Wed|Thu|Fri|Sat|Sun|Tomorrow)/.test(w);
	function nowLine() {
		const w = S.w, now = hm(w.time) + (S.nowAdd || 0), q = queue();
		const t0 = 6 * 60, t1 = Math.max(20 * 60, now + 120);
		const X = (v) => (((Math.min(Math.max(v, t0), t1) - t0) / (t1 - t0)) * 100).toFixed(2) + "%";
		const pinRight = (now - t0) / (t1 - t0) > 0.68;
		let ticks = "";
		for (let h = 6; h * 60 <= t1; h += 2) if (Math.abs(h * 60 - now) > 40) ticks += '<span style="left:' + X(h * 60) + '">' + fmt(h * 60) + "</span>";
		const nowMark = '<i class="nowseg" style="left:' + X(now) + '"></i>';
		const rows = w.missions.slice().sort((a, b) => (a.state === "done") - (b.state === "done")).map((m) => {
			const mine = q.filter((a) => a.mission === m.id), b = mine[0];
			const pinHtml = (kind) => '<button class="pin ' + kind + '" style="left:' + X(now) + '" data-act="pin" data-id="' + b.id + '" aria-pressed="' + ((S.sel || (q[0] && q[0].id)) === b.id) + '" aria-label="' + esc(b.title) + '"></button>' +
				'<span class="pinlbl ' + kind + (pinRight ? " left" : "") + '" style="' + (pinRight ? "right:calc(100% - " + X(now) + " + 12px)" : "left:calc(" + X(now) + " + 12px)") + '">' + esc(short(b.title, 34)) + " · " + esc((b.effort || "").replace(/^About /, "").replace(/^Under a minute$/, "<1 min")) + (mine.length > 1 ? " · +" + (mine.length - 1) + " more" : "") + "</span>";
			const times = m.activity.filter((a) => isToday(a.when)).map((a) => hm(a.when)).filter((v) => v != null);
			const start = times.length ? Math.min(...times) : now - 90;
			let parts = "", word;
			const res = m.delivered.filter((d) => isToday(d.when) && hm(d.when) != null);
			if (m.state === "done") {
				word = '<span class="state">Finished ' + esc(m.updated) + "</span>";
				if (!res.length) parts += '<i class="dot" style="left:' + X(hm(m.updated) || t0) + '" title="Finished at ' + esc(m.updated) + '"></i><span class="lbl" style="left:' + X(hm(m.updated) || t0) + '">Finished</span>';
			} else if (moving(m)) {
				word = P.state("working", "Moving");
				parts += '<i class="work" style="left:' + X(start) + ";width:calc(" + X(now) + " - " + X(start) + ')"></i><i class="tail" style="left:' + X(now) + '"></i>';
				const nx = now + 150;
				parts += '<i class="dot plan" style="left:' + X(nx) + '" title="Next: ' + esc(m.next.text) + '"></i><span class="lbl" style="left:' + X(nx) + '">' + esc(short(m.next.text, 26)) + "</span>";
				if (b) parts += pinHtml(b.kind === "review" ? "review" : "needs");
			} else if (b) {
				const at = now - ago(b.asked || "10 min ago") || now - 10;
				const kind = b.kind === "failure" ? "failed" : b.kind === "unknown" ? "unknown" : b.kind === "review" ? "review" : "needs";
				word = P.state(kind === "review" ? "ready" : kind, kind === "failed" ? "Stuck" : kind === "unknown" ? "Unconfirmed" : kind === "review" ? "Ready for review" : "Waiting for you");
				parts += '<i class="work" style="left:' + X(start) + ";width:calc(" + X(at) + " - " + X(start) + ')"></i><i class="wait ' + kind + '" style="left:' + X(at) + ";width:calc(" + X(now) + " - " + X(at) + ')" title="Stopped at ' + fmt(at) + '"></i>' +
					pinHtml(kind);
			} else if (m.state === "paused") {
				const at = now - ago(m.updated), until = hm(m.now);
				word = P.state("paused", "Paused");
				parts += '<i class="work" style="left:' + X(start) + ";width:calc(" + X(at) + " - " + X(start) + ')"></i><i class="wait paused" style="left:' + X(at) + ";width:calc(" + X(until || now) + " - " + X(at) + ')"></i>' + (until ? '<i class="dot plan" style="left:' + X(until) + '"></i><span class="lbl" style="left:' + X(until) + '">Resumes ' + fmt(until) + "</span>" : "");
			} else {
				const nx = /afternoon/.test(m.next.text) ? 14 * 60 : now + 180;
				word = P.state("paused", "Starts later");
				parts += '<i class="dot plan" style="left:' + X(nx) + '" title="' + esc(m.next.text) + '"></i><span class="lbl" style="left:' + X(nx) + '">' + esc(short(m.next.text.replace(/^Starts /, ""), 22)) + "</span>";
			}
			res.forEach((d) => { parts += '<i class="dot" style="left:' + X(hm(d.when)) + '" title="' + esc(d.when + " · " + d.title) + '"></i><span class="lbl" style="left:' + X(hm(d.when)) + '">' + esc(short(d.title, 22)) + "</span>"; });
			return '<div class="nl-row"><div class="who"><a href="#/m/' + m.id + '">' + esc(m.title) + "</a>" + word + '</div><div class="track"><i class="base"></i>' + nowMark + parts + "</div></div>";
		}).join("");
		const sched = w.scheduled.filter((x) => hm(x.when) != null && isToday(x.when));
		const schedRow = sched.length ? '<div class="nl-row sched"><div class="who"><span class="faint">Scheduled</span></div><div class="track"><i class="base"></i>' + nowMark + sched.map((x) => '<i class="dot plan" style="left:' + X(hm(x.when)) + '"></i><span class="lbl" style="left:' + X(hm(x.when)) + '">' + esc(short(x.text, 22)) + "</span>").join("") + "</div></div>" : "";
		return '<div class="nl-axis"><div></div><div class="ticks">' + ticks + '<span class="nowt" style="left:' + X(now) + '">Now ' + fmt(now) + "</span></div></div>" + rows + schedRow +
			'<div class="nl-key" aria-hidden="true"><span><i class="k-dot"></i>Result</span><span><i class="k-work"></i>Working</span><span><i class="k-wait"></i>Waiting since</span><span><i class="k-plan"></i>Planned</span></div>';
	}
	function nowHome() {
		const w = S.w, q = queue();
		const sel = q.find((a) => a.id === S.sel) || q[0];
		const head = !S.notes.length ? w.headline : !q.length ? "That was everything. Pilot is back on it." : q.length === 1 ? "One thing left." : q.length + " things left.";
		const results = w.missions.flatMap((m) => m.delivered.filter((d) => isToday(d.when)).map((d) => ({ m, d }))).sort((a, b) => hm(b.d.when) - hm(a.d.when));
		main.innerHTML = '<div class="col wide">' +
			'<div class="hello"><h1 class="t-display">' + esc(head) + '</h1><p class="sum">' + esc(w.summary) + "</p>" +
			'<p class="when-line"><span>' + esc(w.date) + "</span>" + dayBtn() + '<button class="btn quiet small" data-act="standup">' + ic("calendar", "s") + "Standup notes</button></p></div>" +
			'<section class="nl" id="nl" aria-label="Today as a timeline">' + nowLine() + "</section>" +
			'<div class="col">' + S.notes.map((n) => '<div class="done-note">' + ic("check", "s") + esc(n) + "</div>").join("") +
			(sel ? '<section class="part" style="margin-top:36px" aria-label="Selected decision"><h2>Decisions <span class="n">' + q.length + "</span>" + triBtn(q) + "</h2>" + focusCard(sel, q.indexOf(sel), q.length) + "</section>" : '<p class="calm" style="margin-top:36px">' + ic("checks") + "No decisions waiting. Pilot keeps going on its own.</p>") +
			'<section class="part"><h2>Results today</h2>' + (results.length ? results.map(({ m, d }) => '<div class="entry timed"><span class="when">' + esc(d.when) + '</span><div><p class="txt">' + esc(d.title) + '</p><div class="chips">' + d.evidence.map(P.chip).join("") + '<span class="src"><a href="#/m/' + m.id + '">' + esc(m.title) + "</a></span></div></div></div>").join("") : '<p class="muted">None yet today.</p>') + "</section>" + comingUp() + "</div></div>";
	}

	// ----- Help me decide: simpler wording, more context, a visual made for the decision, inline questions. Mock answers.
	const bars = (rows, unit) => { const max = Math.max(...rows.map((r) => r[1])); return '<div class="hbars">' + rows.map(([l, v, hot]) => '<div class="hb"><span class="hl">' + esc(l) + '</span><span class="ht"><i class="' + (hot ? "hot" : "") + '" style="width:' + ((v / max) * 100).toFixed(1) + '%"></i></span><span class="hv">' + v + (unit || "") + "</span></div>").join("") + "</div>"; };
	const table = (head, rows) => '<table class="htab"><thead><tr>' + head.map((h) => "<th>" + esc(h) + "</th>").join("") + "</tr></thead><tbody>" + rows.map((r) => "<tr>" + r.map((c, i) => "<td" + (i ? "" : ' class="k"') + ">" + esc(c) + "</td>").join("") + "</tr>").join("") + "</tbody></table>";
	const HELP = {
		q1: { simple: "Pilot sends too many notifications. Choose when it should tell you about finished work.", more: ["35 of the 41 notifications were finished work. You opened most of them hours later.", "Questions and failures still notify you right away with every option.", "You can change this later in Settings, under Notifications."], visual: { title: "Notifications last week", html: bars([["Finished work", 35], ["Questions", 4, true], ["Failures", 2, true]]) + '<p class="hcap">Highlighted: the 6 that needed you.</p>' }, answer: "Anything that finishes after 18:00 waits for the next day's summary. Questions and failures still reach you right away." },
		q2: { simple: "To test image zoom for real, Pilot needs to open a second Pilot window with fake data. Is that OK?", more: ["The test copy has its own data folder. It cannot see your chats or missions.", "It runs for about 4 minutes, then Pilot closes it.", "If you skip it, only synthetic tests check zoom, so how it feels stays unchecked."], visual: { title: "Check plan", html: table(["Step", "What happens", "Time"], [["1", "Open a test copy with sample data", "20 s"], ["2", "Pinch zoom on a 4K capture", "2 min"], ["3", "Compare light and dark captures", "1 min"], ["4", "Close the test copy", "5 s"]]) }, answer: "No. The test copy has its own data and never touches your Pilot or its daemon." },
		f1: { simple: "Two Linux tests fail because results come back in a different order. The clean fix adds a sort option to the search API.", more: ["macOS and Linux sort equal scores differently. The tests expect the macOS order.", "Option 1 adds an optional sort setting. Callers that do not use it see no change.", "Option 2 keeps the API but sorts every search inside the index, about 20 ms slower."], visual: { title: "Same query, different order", html: table(["Rank", "macOS", "Linux"], [["1", "harbor/index.go", "harbor/index.go"], ["2", "harbor/query.go", "harbor/score.go"], ["3", "harbor/score.go", "harbor/query.go"]]) + '<p class="hcap">Rows 2 and 3 have equal scores.</p>' }, answer: "Callers that do not pass the new option get exactly the same results as today." },
		u1: { simple: "Pilot pushed code, but GitHub did not reply. Pilot wants to check that it arrived before doing anything else.", more: ["Pushing again without checking could create a duplicate.", "Check again only reads the branch. It changes nothing.", "If the push did not land, Pilot pushes once more and tells you."], visual: { title: "What was pushed: e93b1a0", html: table(["File", "Added", "Removed"], [["image/zoom.rs", "+142", "−8"], ["image/pan.rs", "+61", "−2"], ["image/viewer.rs", "+18", "−11"], ["tests/zoom.rs", "+96", "−0"], ["docs/images.md", "+12", "−1"], ["Cargo.lock", "+2", "−2"]]) }, answer: "If it did not land, Pilot pushes once more, then tells you. It never pushes twice without checking." },
		r1: { simple: "Scrolling up now loads older messages without jumping. Pilot wants your OK to call it done.", more: ["38 tests passed, including 12 capture runs.", "You asked yesterday that the reading position stays put. All 12 runs kept it."], visual: { title: "Reading position across 12 runs", html: bars([["Kept position", 12], ["Jumped", 0, true]]) }, answer: "Yes. Light and dark captures are attached to the result." },
		r2: { simple: "Rebuilding the search index is now 4 times faster. The API did not change.", more: ["Unit tests passed. Integration tests are still running.", "The benchmark used the large test workspace."], visual: { title: "Index rebuild time", html: bars([["Before", 48, false], ["After", 12, true]], " s") }, answer: "Yes. Results are the same; only rebuild time changed." },
	};
	const helpOf = (a) => HELP[a.id] || { simple: a.title, more: ["Pilot has no more context yet. Ask a question."], visual: { title: "No visual yet", html: '<p class="hcap">Ask Pilot to make one.</p>' }, answer: "Pilot will answer from the mission's history." };
	const hstate = (id) => (S.help[id] = S.help[id] || { ask: [] });
	function ctxHtml(a) {
		const h = S.help[a.id], base = a.kind === "review" ? a.r.summary : a.context;
		return h && h.simple === true ? '<p class="ctx"><span class="simpler">Simpler</span>' + esc(helpOf(a).simple) + "</p>" : '<p class="ctx">' + esc(base) + "</p>";
	}
	function helpHtml(a) {
		const H = helpOf(a), h = S.help[a.id] || { ask: [] }, tri = !!S.tri;
		const chip = (k, label, key) => '<button class="hchip" data-act="help" data-kind="' + k + '" data-id="' + a.id + '" data-fk="h-' + k + "-" + a.id + '" aria-pressed="' + (h[k] === true) + '">' + label + (tri ? " <kbd>" + key + "</kbd>" : "") + "</button>";
		let html = '<div class="help" role="group" aria-label="Help me decide">' + chip("simple", h.simple === "loading" ? "Rewriting…" : h.simple === true ? "Original wording" : "Say it simpler", "S") + chip("more", h.more === "loading" ? "Finding context…" : "More context", "M") + chip("show", h.show === "loading" ? "Making a visual…" : "Show me", "V") + chip("asking", "Ask a question", "?") + "</div>";
		if (h.more === true) html += '<div class="hpanel"><h4>More context</h4>' + H.more.map((p) => "<p>" + esc(p) + "</p>").join("") + "</div>";
		if (h.show === true) html += '<figure class="hpanel"><figcaption><b>' + esc(H.visual.title) + '</b><span>Made by Pilot for this decision</span><button class="btn quiet small" data-act="mock" data-what="Open the visual in the Library">Open</button></figcaption>' + H.visual.html + "</figure>";
		if (h.asking || h.ask.length) html += '<div class="hpanel ask">' + h.ask.map((x) => '<p class="q">' + esc(x.q) + "</p>" + (x.a ? '<p class="a"><b>Pilot</b> ' + esc(x.a) + "</p>" : '<p class="a muted">Pilot is answering…</p>')).join("") +
			'<form class="ask-row" data-askform="' + a.id + '"><input data-askin="' + a.id + '" data-fk="ask-' + a.id + '" placeholder="What do you want to know?" aria-label="Ask about this decision" autocomplete="off"><button class="btn small">Ask</button></form></div>';
		return html;
	}
	const redrawHelp = () => (S.tri ? drawTri() : render(true));
	function helpToggle(id, kind) {
		const h = hstate(id);
		if (kind === "asking") { h.asking = true; redrawHelp(); const i = document.querySelector('[data-askin="' + id + '"]'); i && i.focus(); return; }
		if (h[kind] === "loading") return;
		if (h[kind] === true) { h[kind] = false; redrawHelp(); return; }
		h[kind] = "loading"; redrawHelp();
		setTimeout(() => { h[kind] = true; redrawHelp(); }, kind === "show" ? 900 : 650);
	}
	function askSubmit(id, input) {
		const q = input.value.trim(); if (!q) return;
		const h = hstate(id), a = queue().find((x) => x.id === id), item = { q };
		h.ask.push(item); input.value = ""; redrawHelp();
		const i1 = document.querySelector('[data-askin="' + id + '"]'); i1 && i1.focus();
		setTimeout(() => { item.a = a ? helpOf(a).answer : "Answered."; redrawHelp(); const i2 = document.querySelector('[data-askin="' + id + '"]'); i2 && i2.focus(); }, 800);
	}

	// ----- Review: reached from the decision card, Reviews list (More, ⌘K). Pilot reviews first; you approve.
	const PILOT_RV = {
		r1: { verdict: "Pilot reviewed it first: no problems found.", notes: [["transcript/anchor.rs", 3, "The anchor test runs only on macOS. Linux runs it in the next stage."]] },
		r2: { verdict: "Pilot reviewed it first: one thing to check.", notes: [["index/incremental.go", 2, "Integration tests are still running. Approve now or wait for them."]] },
	};
	// Changes Pilot landed on its own (inside the agreement) and live work in progress. You can look at any of them, any time.
	const LANDED = [
		{ id: "c1", mission: "native", title: "Drafts survive a restart", when: "Yesterday", commit: "9f02b7d", summary: "Unsent text and attachments come back after quitting.", checks: "IME and undo checks passed", files: ["composer/draft.rs", "composer/store.rs", "tests/draft_restart.rs"], why: "Small change inside the agreement. Pilot reviewed it and pushed it." },
		{ id: "c2", mission: "dotfiles", title: "Remove 9 unused tools", when: "05:30", commit: "3 commits", summary: "Shell starts in 84 ms, was 310 ms.", checks: "Shell timing before and after", files: ["Brewfile", "dot_zshrc", "dot_config/mise/config.toml"], why: "Inside the agreement: none were used this quarter." },
		{ id: "c3", mission: "notify", title: "Notification audit script", when: "Yesterday", commit: "5be21c0", summary: "Counts last week's notifications by reason.", checks: "4 tests passed", files: ["scripts/notify-audit.ts", "scripts/notify-audit.test.ts"], why: "A read-only script. Pilot reviewed it and pushed it." },
	];
	const wipFiles = (t) => (/zoom/i.test(t) ? ["image/zoom.rs", "image/pan.rs"] : /fold/i.test(t) ? ["transcript/fold.rs", "tests/fold.rs"] : /copy/i.test(t) ? ["transcript/copy.rs"] : /rules/i.test(t) ? ["notify/rules.ts"] : ["src/lib.rs"]);
	function allChanges() {
		const rv = S.w.reviews.map((r) => Object.assign({}, r, { kind: r.state === "waiting" ? "review" : r.state === "changes" ? "changes" : "approved", when: r.when || "Today" }));
		const landed = LANDED.map((c) => Object.assign({ kind: "landed" }, c));
		const wip = S.w.missions.flatMap((m) => m.helpers.map((h, i) => ({ id: "w-" + m.id + "-" + i, mission: m.id, title: h.title, summary: h.step + ", " + h.since + " so far.", checks: "Not checked yet", files: wipFiles(h.title), kind: "wip" })));
		return { rv, landed, wip };
	}
	const DIG_CH = { dotfiles: "c2", native: "r1" };
	const getChange = (id) => { const c = allChanges(); return c.rv.concat(c.landed, c.wip).find((x) => x.id === id); };
	const unseen = () => LANDED.filter((c) => !S.seen[c.id]).length;
	function diffLines(file, k) {
		if (/\.ts$/.test(file)) return [[" ", "export function audit(events: Event[]) {"], ["+", "  const byReason = groupBy(events, (e) => e.reason);"], ["+", "  return summarize(byReason);"], [" ", "}"]];
		if (/Brewfile|zshrc|toml$/.test(file)) return [[" ", 'brew "jj"'], ["-", 'brew "fasd"'], ["-", 'brew "thefuck"'], ["-", 'brew "nvm"'], [" ", 'brew "mise"']];
		const rs = /\.rs$/.test(file), go = /\.go$/.test(file), md = /\.md$/.test(file);
		if (md) return [[" ", "## Loading older messages"], ["+", "Scrolling up loads older pages while a reply streams."], ["+", "Your reading position stays where it was."], [" ", ""]];
		if (rs) return [[" ", "fn load_older(&mut self, page: Page) {"], ["-", "    self.scroll_to_bottom();"], ["+", "    let anchor = self.anchor();"], ["+", "    self.prepend(page);"], ["+", "    self.restore(anchor);"], [" ", "}"]].map((l, i) => (k && i === 0 ? [" ", "fn anchor_test_" + k + "() {"] : l));
		if (go) return [[" ", "func (ix *Index) Rebuild(docs []Doc) error {"], ["-", "\tix.reset()"], ["-", "\treturn ix.addAll(docs)"], ["+", "\tchanged := ix.diff(docs)"], ["+", "\treturn ix.apply(changed)"], [" ", "}"]];
		return [[" ", "..."], ["+", "updated"]];
	}
	function reviewPage(id) {
		skyWrap.style.display = "none";
		const r = getChange(id); if (!r) { main.innerHTML = '<div class="col"><a class="back" href="#/">' + ic("left", "s") + "Today</a><p>Not found.</p></div>"; return; }
		const m = M(r.mission), st = (S.rv[id] = S.rv[id] || { file: 0, comments: {}, open: null, changes: false }), pr = PILOT_RV[id] || { verdict: r.kind === "landed" ? r.why : r.kind === "wip" ? "Pilot is still working on this. Live and read-only." : "Pilot reviewed it first.", notes: [] };
		if (r.kind === "landed" && !S.seen[id]) S.seen[id] = true;
		const stateHtml = { review: P.state("ready", "Ready for review"), approved: P.state("done", "Approved by you"), changes: '<span class="state">Changes requested</span>', landed: P.state("ready", "Landed " + r.when + " · " + r.commit), wip: P.state("working", "In progress") }[r.kind];
		const again = S.again[id] ? '<p class="again-note">' + ic("clock", "s") + 'On your list to look at again. <button class="example" data-act="rv-again" data-id="' + id + '">Remove</button></p>' : "";
		const file = r.files[st.file], lines = diffLines(file, st.file);
		const note = pr.notes.find((n) => n[0] === file);
		const rows = lines.map((l, i) => {
			const key = file + ":" + i, cm = st.comments[key] || [];
			return '<div class="dl ' + (l[0] === "+" ? "add" : l[0] === "-" ? "del" : "") + '"><button class="ln" data-act="rv-line" data-key="' + esc(key) + '" aria-label="Comment on line ' + (i + 1) + '">' + (i + 1) + '</button><code>' + esc(l[0] + " " + l[1]) + "</code></div>" +
				(note && note[1] === i ? '<div class="dnote pilot"><b>Pilot</b> ' + esc(note[2]) + "</div>" : "") +
				cm.map((c) => '<div class="dnote"><b>You</b> ' + esc(c) + ' <span class="mock-tag">mock</span></div>').join("") +
				(st.open === key ? '<form class="dnote form" data-rvform="' + esc(key) + '"><input data-fk="rvc" aria-label="Comment" placeholder="Comment on this line"><button class="btn small">Add</button></form>' : "");
		}).join("");
		main.innerHTML = '<div class="rv"><a class="back" href="' + (S.backTo || "#/") + '">' + ic("left", "s") + (S.backTo === "#/changes" ? "Changes" : "Today") + "</a>" + again +
			'<div class="rv-head"><h1>' + esc(r.title) + '</h1><div class="meta">' + stateHtml + '<span>· <a href="#/m/' + m.id + '">' + esc(m.title) + "</a> · " + r.files.length + " files · " + esc(r.checks) + "</span></div>" +
			'<p class="sum">' + esc(r.summary) + '</p><p class="pilot-rv' + (/one thing/.test(pr.verdict) ? " warn" : "") + '">' + ic(/one thing/.test(pr.verdict) ? "alert" : "checks", "s") + "<span>" + esc(pr.verdict) + (pr.notes.length ? " Its note is shown in the diff." : "") + "</span></p></div>" +
			'<div class="rv-grid"><nav class="rv-files" aria-label="Changed files">' + r.files.map((f, i) => '<button data-act="rv-file" data-i="' + i + '" aria-current="' + (i === st.file) + '" data-fk="rvf-' + i + '"><span>' + esc(f.split("/").pop()) + '</span><span class="faint">' + esc(f.split("/").slice(0, -1).join("/")) + "</span>" + (pr.notes.some((n) => n[0] === f) ? '<i class="mark needs" title="Pilot left a note"></i>' : "") + "</button>").join("") +
			'<p class="t-small" style="margin-top:10px">J and K move between files.</p></nav>' +
			'<section class="rv-diff" aria-label="' + esc(file) + '"><div class="fname">' + esc(file) + "</div>" + rows + "</section></div>" +
			(st.changes ? '<form class="rv-changes" data-rvchanges="' + id + '"><label class="t-meta" for="rvch">' + (r.kind === "review" ? "What should change?" : "What is wrong? Pilot fixes it in a new change.") + '</label><textarea id="rvch" data-fk="rvch" placeholder="Pilot will fix it and ask again"></textarea><div class="acts"><button class="btn primary">Send back</button><button type="button" class="btn quiet" data-act="rv-cancel">Cancel</button><span class="mock-tag">mock</span></div></form>' : "") +
			(r.kind === "landed" || r.kind === "approved" || r.kind === "changes" ? '<div class="rv-bar"><button class="btn primary" data-act="rv-seen" data-fk="rv-approve">Looks good</button><button class="btn" data-act="rv-request" data-id="' + id + '">Something is wrong</button><button class="btn quiet" data-act="rv-again" data-id="' + id + '">' + (S.again[id] ? "Off my list" : "Look again later") + '</button><button class="btn quiet" data-act="mock" data-what="Undo this change (Pilot asks first)">Undo…</button><span class="mock-tag">mock</span></div>' : r.kind === "wip" ? '<div class="rv-bar"><a class="btn" href="#/m/' + r.mission + '/talk">Ask about this</a><span class="t-small">Pilot shows it for review when it is done.</span></div>' : '<div class="rv-bar"><button class="btn primary" data-act="rv-approve" data-id="' + id + '" data-fk="rv-approve">Approve</button><button class="btn" data-act="rv-request" data-id="' + id + '">Request changes</button><a class="btn quiet" href="#/">Later</a><span class="mock-tag">mock</span></div>') + "</div>";
	}
	function reviewsPage() {
		skyWrap.style.display = "none"; S.backTo = "#/changes";
		const C = allChanges(), f = S.chFilter, keep = (x) => f === "all" || x.mission === f, all = C.rv.concat(C.landed, C.wip);
		const crow = (x, extra) => '<a class="list-row" href="#/review/' + x.id + '"><span class="t">' + (x.kind === "landed" && !S.seen[x.id] ? '<i class="new-dot" title="New since you looked"></i>' : "") + esc(x.title) + '</span><span class="s">' + esc(M(x.mission).title) + " · " + esc(extra(x)) + "</span></a>";
		const sec = (title, note, list, extra) => (list.length ? '<h2 class="mini2">' + title + ' <span class="faint" style="font-weight:400">' + list.length + "</span></h2>" + (note ? '<p class="t-small" style="margin:0 0 6px">' + note + "</p>" : "") + list.map((x) => crow(x, extra)).join("") : "");
		const ms = [...new Set(all.map((x) => x.mission))];
		main.innerHTML = '<div class="col"><a class="back" href="#/">' + ic("left", "s") + 'Today</a><h1 class="t-title" style="margin:14px 0 6px">Changes</h1><p class="t-meta" style="margin:0 0 14px">Everything Pilot changed, including what you already reviewed. Open any of them again at any time.</p>' +
			'<div class="pills" role="group" aria-label="Mission">' + ["all"].concat(ms).map((k) => '<button data-act="ch-filter" data-k="' + k + '" aria-pressed="' + (f === k) + '">' + esc(k === "all" ? "All" : M(k).title) + "</button>").join("") + "</div>" +
			sec("To look at again", "You saved these for later.", all.filter((x) => S.again[x.id]).filter(keep), (x) => (x.kind === "landed" ? "Landed " + x.when : x.kind === "approved" ? "Approved by you" : x.kind === "changes" ? "Changes requested" : x.checks)) +
			sec("Waiting for you", "", C.rv.filter((x) => x.kind === "review").filter(keep), (x) => x.checks) +
			sec("Landed by Pilot", "Small changes inside the agreement. Pilot reviewed and landed them.", C.landed.filter(keep), (x) => x.when + " · " + x.commit) +
			sec("In progress", "Live and read-only.", C.wip.filter(keep), (x) => x.summary) +
			sec("Reviewed by you", "Open again to re-check, flag a problem or undo.", C.rv.filter((x) => x.kind !== "review").filter(keep), (x) => (x.kind === "changes" ? "Changes requested" : "Approved")) + "</div>";
	}
	function reviewsPageOld() {
		skyWrap.style.display = "none";
		const row = (r) => '<a class="list-row" href="#/review/' + r.id + '"><span class="t">' + esc(r.title) + '</span><span class="s">' + esc(M(r.mission).title) + " · " + esc(r.checks) + '</span><span class="w">' + (r.state === "changes" ? '<span class="state">Changes requested</span>' : P.state(r.state === "done" ? "done" : "ready", r.state === "done" ? "Approved" : "Ready")) + "</span></a>";
		const wait = S.w.reviews.filter((r) => r.state === "waiting"), done = S.w.reviews.filter((r) => r.state !== "waiting");
		main.innerHTML = '<div class="col"><a class="back" href="#/">' + ic("left", "s") + 'Today</a><h1 class="t-title" style="margin:14px 0 6px">Reviews</h1><p class="t-meta" style="margin:0 0 18px">Pilot reviews every change first. You see one when it needs your OK.</p>' +
			(wait.length ? wait.map(row).join("") : '<p class="muted">Nothing waiting for your review.</p>') +
			(done.length ? '<h2 class="t-meta" style="margin:28px 0 6px;font-weight:600">Approved</h2>' + done.map(row).join("") : "") + "</div>";
	}

	// ----- Automations: yours and Pilot's, with on/off. New ones come from the New box ("every Monday...").
	const autoList = () => S.w.scheduled.concat(S.extraAuto);
	const LAST = { "Daily summary from all coordinators": "Yesterday 18:00 · sent", "Re-run the search benchmark": "Last night · 150 ms, no change", "Weekly Insights report for pilot": "Last Tuesday · 3 findings", "Check again whether the image zoom push landed": "Not run yet" };
	function automationsPage() {
		skyWrap.style.display = "none";
		const row = (x) => { const off = !!S.autoOff[x.text]; return '<div class="auto-row' + (off ? " off" : "") + '"><div><div class="t">' + esc(x.text) + '</div><div class="s">' + esc(x.when) + (x.by === "pilot" ? " · set by Pilot" + (x.mission && M(x.mission) ? ' for <a href="#/m/' + x.mission + '">' + esc(M(x.mission).title) + "</a>" : "") : "") + '</div><div class="s faint">' + esc(LAST[x.text] || "Not run yet") + "</div></div>" +
			'<button class="switch" role="switch" aria-checked="' + !off + '" data-act="auto-toggle" data-text="' + esc(x.text) + '" data-fk="sw-' + esc(x.text) + '" aria-label="' + esc(x.text) + '"><i></i></button>' +
			'<button class="icon-btn" data-act="automenu" data-text="' + esc(x.text) + '" aria-label="Automation actions">' + ic("more") + "</button></div>"; };
		const mine = autoList().filter((x) => x.by !== "pilot"), pil = autoList().filter((x) => x.by === "pilot");
		main.innerHTML = '<div class="col"><a class="back" href="#/">' + ic("left", "s") + 'Today</a><div style="display:flex;align-items:baseline;gap:12px;margin:14px 0 6px"><h1 class="t-title" style="margin:0">Automations</h1><a class="btn small" style="margin-left:auto" href="#/new">' + ic("plus", "s") + "New automation</a></div>" +
			'<p class="t-meta" style="margin:0 0 18px">Things that run on a schedule. Results show up in Today.</p>' +
			'<h2 class="mini2">Yours</h2>' + mine.map(row).join("") +
			'<h2 class="mini2">Set by Pilot <span class="mock-tag gap-tag">needs contract</span></h2><p class="t-small" style="margin:0 0 6px">Only for its own mission, inside the agreement. Turn any off.</p>' + (pil.length ? pil.map(row).join("") : '<p class="muted">None right now.</p>') + "</div>";
	}

	// ----- Schedules (some set by Pilot), day rituals, keyboard triage
	function comingUp() {
		const rows = S.w.scheduled.map((x) => '<div class="later sched-row">' + ic("clock", "s") + "<span>" + esc(x.text) +
			(x.by === "pilot" ? '<span class="by-pilot">Set by Pilot' + (x.mission && M(x.mission) ? ' for <a href="#/m/' + x.mission + '">' + esc(M(x.mission).title) + "</a>" : "") + (x.why ? ". " + esc(x.why) : "") + "</span>" : "") +
			'</span><span class="w">' + esc(x.when) + "</span>" + (x.by === "pilot" ? '<button class="icon-btn" data-act="schedmenu" data-text="' + esc(x.text) + '" aria-label="Schedule actions">' + ic("more") + "</button>" : '<span class="icon-sp"></span>') + "</div>").join("");
		return '<section class="part"><h2>Coming up<a class="btn quiet small" style="margin-left:auto" href="#/automations">All automations</a></h2>' + rows + "</section>";
	}
	function dayBtn() {
		const t = hm(S.w.time);
		if (t < 12 * 60 && S.startStep !== "done") return '<button class="btn small" data-act="go" data-href="#/start">' + ic("sun", "s") + "Start the day</button>";
		if (t >= 16 * 60 && !S.closed) return '<button class="btn small" data-act="go" data-href="#/end">' + ic("moon", "s") + "End the day</button>";
		return "";
	}
	const triBtn = (q) => (q.length > 1 ? '<button class="btn quiet small" style="margin-left:auto" data-act="triage" title="Decide all with the keyboard">Decide all <kbd>D</kbd></button>' : "");
	function resultsToday() { return S.w.missions.flatMap((m) => m.delivered.filter((d) => isToday(d.when)).map((d) => ({ m, d }))).concat(S.w.digest.filter((d) => !d.evidence.some((e) => e.bad || e.warn) && !/^Paused/.test(d.text)).map((d) => ({ m: M(d.mission), d: { title: d.text, when: "", evidence: d.evidence } }))).filter((x, i, all) => all.findIndex((y) => y.d.title === x.d.title) === i); }

	function startPage() {
		skyWrap.style.display = "none";
		const w = S.w, q = queue(), st = S.startStep === "done" ? 3 : S.startStep;
		const steps = '<div class="flow-steps">' + ["Overnight", "Decide", "Today"].map((l, i) => '<span class="' + (i + 1 === st ? "on" : i + 1 < st ? "past" : "") + '">' + (i + 1) + " · " + l + "</span>").join("") + "</div>";
		let body;
		if (st === 1) body = "<h1>Good morning.</h1>" + '<p class="lead">Here is what happened since ' + esc(w.lastLooked.replace(/^at /, "")) + ".</p>" +
			w.digest.slice(0, 4).map((d) => '<div class="entry"><span class="dot' + (d.evidence.some((e) => e.bad) ? " bad" : d.evidence.some((e) => e.warn) ? " warn" : "") + '"></span><div><p class="txt">' + esc(d.text) + '</p><div class="chips"><span class="src">' + esc(M(d.mission).title) + "</span></div></div></div>").join("") +
			'<div class="acts" style="margin-top:28px"><button class="btn primary" data-act="start-next" data-fk="start-next">Next</button></div>';
		else if (st === 2) body = "<h1>" + (q.length ? q.length + " decision" + (q.length > 1 ? "s" : "") + ", about " + Math.max(1, q.length) + " min." : "No decisions waiting.") + "</h1>" +
			'<p class="lead">' + (q.length ? "One at a time, with the keyboard. Each has a recommended answer." : "Pilot can keep going on its own.") + "</p>" +
			'<div class="acts" style="margin-top:20px">' + (q.length ? '<button class="btn primary" data-act="triage" data-from="start" data-fk="start-next">Decide now <kbd class="on-accent">D</kbd></button><button class="btn quiet" data-act="start-next">Leave them for later</button>' : '<button class="btn primary" data-act="start-next" data-fk="start-next">Next</button>') + "</div>";
		else {
			const plan = w.missions.filter((m) => m.state !== "done").map((m) => '<div class="later">' + P.state(moving(m) ? "working" : m.state, moving(m) ? "Moving" : null) + "<span><b>" + esc(m.title) + "</b>: " + esc(moving(m) && !/within the agreement/.test(m.next.text) ? m.next.text : m.now) + "</span></div>").join("");
			const sched = w.scheduled.filter((x) => hm(x.when) != null && isToday(x.when) && !/^Nightly/.test(x.when));
			body = "<h1>Today, Pilot will…</h1>" + '<p class="lead">Inside each mission\'s agreement. You do not need to watch.</p>' + plan +
				(sched.length ? '<h3 class="mini">Scheduled</h3>' + sched.map((x) => '<div class="later">' + ic("clock", "s") + "<span>" + esc(x.text) + '</span><span class="w">' + esc(x.when) + "</span></div>").join("") : "") +
				'<div class="acts" style="margin-top:28px"><button class="btn primary" data-act="start-done" data-fk="start-next">Start the day</button><button class="btn quiet" data-act="standup">Standup notes</button></div>';
		}
		main.innerHTML = '<div class="col flow"><a class="back" href="#/">' + ic("left", "s") + "Today</a>" + steps + body + "</div>";
		const f = main.querySelector('[data-fk="start-next"]'); f && f.focus({ preventScroll: true });
	}
	function endPage() {
		skyWrap.style.display = "none";
		const w = S.w, q = queue();
		if (S.closed) {
			main.innerHTML = '<div class="col flow" style="text-align:center;padding-top:12vh">' + ic("moon") + '<h1 style="margin-top:14px">Done for today.</h1><p class="lead" style="margin:0 auto">Pilot keeps working inside the agreements. It only notifies you if something stops everything.</p><div class="acts" style="justify-content:center;margin-top:24px"><a class="btn" href="#/" data-fk="end-back">Back to Today</a></div></div>';
			main.querySelector('[data-fk="end-back"]').focus({ preventScroll: true }); return;
		}
		const res = resultsToday();
		const tonight = w.missions.filter(moving).map((m) => '<div class="later">' + P.state("working", "Moving") + "<span><b>" + esc(m.title) + "</b>: " + esc(m.next.text) + "</span></div>").join("") +
			w.scheduled.filter((x) => (hm(x.when) || 0) >= hm(w.time) || /^Nightly/.test(x.when)).map((x) => '<div class="later">' + ic("clock", "s") + "<span>" + esc(x.text) + (x.by === "pilot" ? ' <span class="faint">· set by Pilot</span>' : "") + '</span><span class="w">' + esc(x.when) + "</span></div>").join("");
		main.innerHTML = '<div class="col flow"><a class="back" href="#/">' + ic("left", "s") + "Today</a><h1>Wrapping up.</h1>" +
			'<p class="lead">' + res.length + " result" + (res.length === 1 ? "" : "s") + " today." + (q.length ? " " + q.length + " decision" + (q.length > 1 ? "s" : "") + " can wait until tomorrow." : " Nothing is waiting for you.") + "</p>" +
			'<h3 class="mini">Done today</h3>' + res.map(({ m, d }) => '<div class="later">' + ic("check", "s") + "<span>" + esc(d.title) + '</span><span class="w">' + esc(m ? m.title : "") + "</span></div>").join("") +
			(q.length ? '<h3 class="mini">Still open</h3><p class="t-meta" style="margin:0 0 6px">Pilot keeps these for tomorrow. Nothing is lost.</p>' + q.map((a) => '<div class="later"><i class="mark ' + (a.kind === "failure" ? "failed" : a.kind === "unknown" ? "unknown" : a.kind === "review" ? "ready" : "needs") + '" style="margin-top:5px"></i><span>' + esc(a.title) + '</span><span class="w">' + esc(a.effort || "") + "</span></div>").join("") + '<button class="btn quiet small" style="margin-top:6px" data-act="triage">Decide them now <kbd>D</kbd></button>' : "") +
			(Object.keys(S.again).filter((k) => S.again[k] && getChange(k)).length ? '<h3 class="mini">To look at again</h3><p class="t-meta" style="margin:0 0 6px">You saved these. Look now, or keep them for tomorrow.</p>' + Object.keys(S.again).filter((k) => S.again[k] && getChange(k)).map((k) => { const c = getChange(k); return '<div class="later">' + ic("clock", "s") + '<span><a href="#/review/' + k + '">' + esc(c.title) + '</a></span><span class="w">' + esc(M(c.mission).title) + "</span></div>"; }).join("") : "") +
			(tonight ? '<h3 class="mini">Tonight</h3>' + tonight : "") +
			'<div class="acts" style="margin-top:30px"><button class="btn primary" data-act="end-close" data-fk="end-close">Close the day</button><button class="btn quiet" data-act="standup">Standup notes for tomorrow</button></div></div>';
		main.querySelector('[data-fk="end-close"]').focus({ preventScroll: true });
	}

	// Keyboard triage: one decision at a time. 1-3 choose, Enter confirm, L later, ? ask, Esc leave.
	function triOpts(a) {
		if (a.kind === "review") return [{ id: "approve", label: "Approve", detail: a.r.checks + " · " + a.r.files.length + " files changed", rec: true }, { id: "diff", label: "Open the diff first", detail: "Nothing is approved yet." }];
		if (a.kind === "unknown") return [{ id: "check", label: "Check again", detail: "Reads the remote branch. Changes nothing.", rec: true }];
		return a.options.map((o) => ({ id: o.id, label: o.label, detail: o.detail, rec: o.recommended }));
	}
	function openTriage(from) {
		const q = queue(); if (!q.length) return;
		S.tri = { ids: q.map((a) => a.id), i: 0, done: [], later: [], pick: null, from: from || "home", t0: Date.now() };
		drawTri();
	}
	function triCurrent() { const id = S.tri.ids[S.tri.i]; return queue().find((a) => a.id === id); }
	function drawTri() {
		let el = document.getElementById("tri");
		if (!el) { el = document.createElement("div"); el.id = "tri"; el.className = "tri"; el.setAttribute("role", "dialog"); el.setAttribute("aria-modal", "true"); el.setAttribute("aria-label", "Decide with the keyboard"); document.body.appendChild(el); S.tri.prev = document.activeElement; }
		const T = S.tri, a = T.i < T.ids.length ? triCurrent() : null;
		const top = '<div class="tri-top"><span>Decisions</span><span class="steps" aria-hidden="true">' + T.ids.map((_, k) => '<i class="' + (k < T.i ? "done" : k === T.i ? "on" : "") + '"></i>').join("") + "</span>" + (a ? "<span>" + (T.i + 1) + " of " + T.ids.length + "</span>" : "") + '<button class="btn quiet small" style="margin-left:auto" data-tri="esc">Leave <kbd>Esc</kbd></button></div>';
		if (!a) {
			const secs = Math.max(20, Math.round((Date.now() - T.t0) / 1000));
			el.innerHTML = top + '<div class="tri-card"><h1>' + (T.later.length ? "Done. " + T.later.length + " left for later." : "All clear.") + '</h1><p class="lead">' + T.done.length + " decided in " + (secs < 60 ? "under a minute" : Math.round(secs / 60) + " min") + ". Pilot is back on it.</p>" +
				T.done.map((d) => '<div class="later">' + ic("check", "s") + "<span><b>" + esc(d.mission) + "</b>: " + esc(d.choice) + "</span></div>").join("") +
				'<div class="acts" style="margin-top:26px"><button class="btn primary" data-tri="finish">' + (T.from === "start" ? "Continue" : "Back to Today") + ' <kbd class="on-accent">↵</kbd></button><span class="mock-tag">mock</span></div></div>';
			el.querySelector("[data-tri=finish]").focus(); return;
		}
		const m = M(a.mission), opts = triOpts(a), pick = T.pick || (opts.find((o) => o.rec) || opts[0]).id;
		const mk = a.kind === "review" ? "ready" : { decision: "needs", approval: "needs", failure: "failed", unknown: "unknown" }[a.kind];
		el.innerHTML = top + '<div class="tri-card"><div class="meta"><span class="state ' + mk + '"><i class="mark ' + mk + '"></i>' + esc(a.kind === "review" ? "Ready for review" : a.reason) + "</span><span>· " + esc(m.title) + " · " + esc(a.effort || "") + "</span></div>" +
			"<h1>" + esc(a.title) + "</h1>" + ctxHtml(a) + helpHtml(a) + (a.boundary ? '<div class="why">' + ic("shield", "s") + "<span>" + esc(a.boundary) + "</span></div>" : "") +
			'<div role="radiogroup" aria-label="Choices" style="margin-top:18px">' + opts.map((o, k) => '<button class="tri-opt" role="radio" aria-checked="' + (o.id === pick) + '" data-tri="pick" data-id="' + o.id + '"><kbd>' + (k + 1) + '</kbd><span><span class="l">' + esc(o.label) + (o.rec ? '<span class="rec">Recommended</span>' : "") + '</span><span class="d">' + esc(o.detail) + "</span></span></button>").join("") + "</div>" +
			'<div class="acts" style="margin-top:18px"><button class="btn primary" data-tri="ok">' + (a.kind === "review" && pick === "approve" ? "Approve" : a.kind === "unknown" ? "Check again" : "Confirm") + ' <kbd class="on-accent">↵</kbd></button><button class="btn quiet" data-tri="later">Later <kbd>L</kbd></button><span class="mock-tag">mock</span></div>' +
			'<p class="tri-keys">1–' + opts.length + " choose · Enter confirm · L later · S simpler · M more · V show · ? ask · Esc leave</p></div>";
		const cur = el.querySelector('.tri-opt[aria-checked="true"]'); cur && cur.focus();
	}
	function triAct(what, id) {
		const T = S.tri; if (!T) return;
		const a = T.i < T.ids.length ? triCurrent() : null;
		if (what === "esc" || (what === "finish" && T.from !== "start")) { closeTri(); return; }
		if (what === "finish") { S.startStep = 3; closeTri(true); location.hash = "#/start"; render(false); return; }
		if (!a) return;
		const opts = triOpts(a);
		if (what === "pick") { T.pick = id; drawTri(); return; }
		if (what === "num") { if (opts[id]) { T.pick = opts[id].id; drawTri(); } return; }
		if (what === "later") { T.later.push(a.id); S.snoozed = S.snoozed.filter((x) => x !== a.id).concat(a.id); T.i++; T.pick = null; drawTri(); return; }
		if (what === "ask") { closeTri(); location.hash = "#/m/" + a.mission + "/talk"; return; }
		if (what === "ok") {
			const pick = T.pick || (opts.find((o) => o.rec) || opts[0]).id, m = M(a.mission);
			if (pick === "diff") { closeTri(true); location.hash = "#/review/" + a.r.id; return; }
			if (a.kind === "review") { a.r.state = "done"; T.done.push({ mission: m.title, choice: "Approved " + a.r.title }); }
			else if (a.kind === "unknown") { S.w.attention = S.w.attention.filter((x) => x !== a); m.state = "working"; m.now = "Push confirmed. Continuing."; T.done.push({ mission: m.title, choice: "Push confirmed (mock check)" }); }
			else {
				const opt = a.options.find((o) => o.id === pick);
				S.w.attention = S.w.attention.filter((x) => x !== a);
				m.state = a.kind === "failure" && pick === "c" ? "paused" : "working"; m.now = m.state === "paused" ? "Paused." : "Applying your choice."; m.next = { who: "pilot", text: "Continues within the agreement." };
				(m.agreed = (m.agreed || AGREED[m.id] || []).slice()).push(["Added later", opt.label + ".", "You, just now"]);
				T.done.push({ mission: m.title, choice: opt.label });
			}
			T.i++; T.pick = null; drawTri();
		}
	}
	function closeTri(silent) {
		const el = document.getElementById("tri"), prev = S.tri && S.tri.prev, n = S.tri ? S.tri.done.length : 0;
		el && el.remove(); S.tri = null; S.sel = null; S.front = null;
		if (n) { S.notes.unshift(n + " decided with the keyboard. Mock only."); if (S.notes.length > 2) S.notes.pop(); }
		if (!silent) { render(true); if (n) P.toast(n + " decided. Mock only."); prev && prev.focus && document.contains(prev) && prev.focus(); }
	}
	document.addEventListener("click", (e) => { const b = e.target.closest("[data-tri]"); if (!b || !S.tri) return; e.stopPropagation(); triAct(b.dataset.tri, b.dataset.id); }, true);
	document.addEventListener("keydown", (e) => {
		const typing = e.target.matches && e.target.matches("input, textarea, [contenteditable]");
		if (!S.tri) {
			if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === "d" && !document.querySelector(".scrim, .pal-scrim") && queue().length && ["", "start", "end"].includes(route()[0])) { e.preventDefault(); openTriage(route()[0] === "start" ? "start" : "home"); }
			return;
		}
		const k = e.key;
		if (e.target.matches && e.target.matches("#tri input")) {
			if (k === "Escape") { e.preventDefault(); e.stopPropagation(); e.target.blur(); const c = document.querySelector('.tri-opt[aria-checked="true"]'); c && c.focus(); }
			return;
		}
		const cur = S.tri.i < S.tri.ids.length ? triCurrent() : null;
		if (cur && /^[smvSMV?]$/.test(k)) { e.preventDefault(); e.stopPropagation(); helpToggle(cur.id, { s: "simple", m: "more", v: "show", "?": "asking" }[k.toLowerCase()]); return; }
		if (k === "Escape") triAct("esc");
		else if (k === "Enter") { const f = document.activeElement; if (f && f.dataset && (f.dataset.tri === "later" || f.dataset.tri === "ask" || f.dataset.tri === "esc")) return; triAct(document.querySelector("[data-tri=finish]") ? "finish" : "ok"); }
		else if (/^[1-9]$/.test(k)) triAct("num", +k - 1);
		else if (k === "l" || k === "L") triAct("later");
		else if (k === "Tab") { const f = [...document.querySelectorAll("#tri button")]; const i = f.indexOf(document.activeElement); e.preventDefault(); f[(i + (e.shiftKey ? f.length - 1 : 1)) % f.length].focus(); return; }
		else return;
		e.preventDefault(); e.stopPropagation();
	}, true);

	// ----- Today
	function home() {
		skyWrap.style.display = ""; S.backTo = "#/";
		if (S.day !== "today") return pastDay();
		if (MODE === "now") return nowHome();
		const w = S.w, q = queue();
		const open = w.missions.filter((m) => m.state !== "done");
		const mov = open.filter(moving), still = open.filter((m) => !moving(m));
		const finished = w.missions.filter((m) => m.state === "done");
		let forYou = S.notes.map((n) => '<div class="done-note">' + ic("check", "s") + esc(n) + "</div>").join("");
		if (q.length) {
			forYou += focusCard(q[0], 0, q.length);
			if (q.length > 1) forYou += '<ul class="queue" aria-label="Up next">' + q.slice(1).map((a) => '<li><i class="mark ' + (a.kind === "failure" ? "failed" : a.kind === "unknown" ? "unknown" : a.kind === "review" ? "ready" : "needs") + '"></i><span>Up next: <span class="t">' + esc(a.title) + '</span></span><span class="w">' + esc(a.effort || "") + "</span></li>").join("") + "</ul>";
		} else forYou += '<p class="calm">' + ic("checks") + "No decisions waiting. Pilot keeps going on its own.</p>";
		const head = !S.notes.length ? w.headline : !q.length ? "That was everything. Pilot is back on it." : q.length === 1 ? "One thing left." : q.length + " things left.";
		main.innerHTML = '<div class="col">' +
			'<div class="hello"><h1 class="t-display">' + esc(head) + '</h1><p class="sum">' + esc(w.summary) + "</p>" +
			'<p class="when-line"><span>' + esc(w.date) + ", " + esc(w.time) + "</span>" + dayBtn() + '<button class="btn quiet small" data-act="standup">' + ic("calendar", "s") + "Standup notes</button></p>" +
			(w.leftOff && !q.length ? '<p class="resume">' + ic("back", "s") + '<a href="#/m/' + w.leftOff.mission + '">' + esc(w.leftOff.text) + "</a></p>" : "") + "</div>" +
			'<section class="part" id="decisions"><h2>Decisions' + (q.length ? ' <span class="n">' + q.length + "</span>" : "") + triBtn(q) + "</h2>" + forYou + "</section>" +
			'<section class="part"><h2>Missions <span class="n">' + open.length + "</span></h2>" +
			(mov.length ? '<div class="sub">Moving <span>' + mov.length + "</span></div>" + mov.map(missionRow).join("") : "") +
			(still.length ? '<div class="sub">Not moving <span>' + still.length + "</span></div>" + still.map(missionRow).join("") : "") +
			"</section>" +
			'<section class="part"><h2>Done since you looked <span class="n">' + esc(w.lastLooked) + "</span></h2>" +
			w.digest.map((d) => '<div class="entry"><span class="dot' + (d.evidence.some((e) => e.bad) ? " bad" : d.evidence.some((e) => e.warn) ? " warn" : "") + '"></span><div><p class="txt">' + esc(d.text) + '</p><div class="chips">' + d.evidence.map(P.chip).join("") + '<span class="src"><a href="#/m/' + d.mission + '">' + esc(M(d.mission).title) + "</a>" + (DIG_CH[d.mission] && getChange(DIG_CH[d.mission]) ? ' · <a href="#/review/' + DIG_CH[d.mission] + '">See the change</a>' : "") + "</span></div></div></div>").join("") +
			(finished.length ? '<p class="t-meta" style="margin-top:10px">Finished: ' + finished.map((m) => '<a href="#/m/' + m.id + '">' + esc(m.title) + "</a>").join(", ") + "</p>" : "") + "</section>" +
			comingUp() +
			'<p class="signoff">That is everything for now. Pilot will tell you if something needs you.</p></div>';
	}
	function pastDay() {
		const d = PAST[S.day], T = (id) => esc(M(id) ? M(id).title : id);
		const list = (h, rows) => rows.length ? "<h3>" + h + "</h3><ul>" + rows.map(([id, t]) => "<li><span>" + esc(t) + '</span><span class="src"><a href="#/m/' + id + '" style="color:inherit">' + T(id) + "</a></span></li>").join("") + "</ul>" : "";
		main.innerHTML = '<div class="col"><div class="hello"><h1 class="t-display">' + esc(d.head) + '</h1><p class="sum">' + esc(d.sum) + '</p><p class="when-line"><span>' + (S.day === "yesterday" ? "Sunday 8 November" : "2 to 8 November") + '</span><button class="btn quiet small" data-act="standup">' + ic("calendar", "s") + "Standup notes</button></p></div>" +
			'<div class="recap part">' + list("Done", d.done) + list("Moved forward", d.moved) + list("You decided", d.decided) + list("Still open", d.open) + "</div>" +
			'<p class="signoff">Built from mission activity. <span class="mock-tag gap-tag">derived, not stored</span></p></div>';
	}

	// ----- Standup notes: Yesterday, Today, Blocked. Plain text you can paste.
	function standupParts() {
		if (S.day !== "today") {
			const d = PAST[S.day];
			return [["Done", d.done.map((x) => x[1])], ["Next", d.open.map((x) => x[1])], ["Blocked", []]];
		}
		const w = S.w, q = queue();
		const done = PAST.yesterday.done.map((x) => x[1]).concat(w.digest.map((d) => d.text));
		const today = w.missions.filter((m) => m.state !== "done").map((m) => m.title + ": " + (moving(m) ? m.now : m.next.text));
		const blocked = q.map((a) => M(a.mission).title + ": " + a.title.replace(/^Review: /, "review ") + (a.kind === "review" ? "" : " (needs me)"));
		return [["Yesterday", done], ["Today", today], ["Blocked", blocked]];
	}
	function standup() {
		const parts = standupParts();
		const text = parts.map(([h, rows]) => h + "\n" + (rows.length ? rows.map((r) => "- " + r).join("\n") : "- Nothing")).join("\n\n");
		const prev = document.activeElement;
		const s = document.createElement("div"); s.className = "scrim";
		s.innerHTML = '<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="su-h"><h2 id="su-h">Standup notes</h2><p class="lead">Written from mission activity. Copy and paste, or read it out.</p>' +
			parts.map(([h, rows]) => "<h3>" + h + "</h3><ul>" + (rows.length ? rows.map((r) => "<li>" + esc(r) + "</li>").join("") : '<li class="muted">Nothing</li>') + "</ul>").join("") +
			'<div class="acts"><button class="btn quiet" data-close>Close</button><button class="btn primary" data-copy>' + ic("check", "s") + "Copy as text</button></div></div>";
		document.body.appendChild(s);
		const close = () => { s.remove(); prev && prev.focus && prev.focus(); };
		s.addEventListener("click", (e) => {
			if (e.target === s || e.target.closest("[data-close]")) close();
			if (e.target.closest("[data-copy]")) {
				const done = () => { P.toast("Copied standup notes"); close(); };
				try { navigator.clipboard.writeText(text).then(done, () => P.toast("Copy is blocked here. Select the text instead.")); } catch (err) { P.toast("Copy is blocked here. Select the text instead."); }
			}
		});
		s.addEventListener("keydown", (e) => {
			if (e.key === "Escape") { e.stopPropagation(); close(); }
			if (e.key === "Tab") { const f = [...s.querySelectorAll("button")]; const i = f.indexOf(document.activeElement); if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); } else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); } }
		});
		s.querySelector("[data-copy]").focus();
	}

	// ----- Mission page
	function missionPage(id, sub) {
		skyWrap.style.display = "none";
		const m = M(id); if (!m) { main.innerHTML = '<div class="col"><a class="back" href="#/">' + ic("left", "s") + "Today</a><p>Not found.</p></div>"; return; }
		const aa = queue().filter((a) => a.mission === id);
		const t = m.tasks, tot = t.done + t.review + t.active + t.blocked + t.todo;
		const idx = m.phases.findIndex((p) => p.state === "active" || p.state === "failed");
		const stageLine = idx >= 0 ? "Stage " + (idx + 1) + " of " + m.phases.length + ": " + m.phases[idx].name + "." : "All " + m.phases.length + " stages done.";
		const status = moving(m) ? P.state("working", "Moving") : aa[0] ? P.state(aa[0].kind === "failure" ? "failed" : aa[0].kind === "unknown" ? "unknown" : aa[0].kind === "review" ? "ready" : "needs", aa[0].kind === "failure" ? "Stuck" : aa[0].kind === "unknown" ? "Unconfirmed" : aa[0].kind === "review" ? "Ready for review" : "Waiting for you") : P.state(m.state);
		const entries = m.delivered.map((d) => ({ when: d.when, html: '<p class="txt"><b style="font-weight:600">' + esc(d.title) + "</b>. " + esc(d.summary) + '</p><div class="chips">' + d.evidence.map(P.chip).join("") + "</div>" }))
			.concat(m.activity.slice(0, S.open["act-" + id] ? 99 : 3).map((a) => ({ when: a.when, html: '<p class="txt muted" style="font-size:13px">' + esc(a.text) + "</p>" })));
		const dayOf = (w) => (/^Yesterday|^Friday|^Thursday/.test(w) ? w.split(" ")[0] : "Today");
		const key = (w) => { const tm = /(\d\d):(\d\d)/.exec(w); const mins = tm ? +tm[1] * 60 + +tm[2] : 24 * 60; return (dayOf(w) === "Today" ? 20000 : dayOf(w) === "Yesterday" ? 10000 : 0) + mins; };
		entries.sort((a, b) => key(b.when) - key(a.when));
		let lastDay = null;
		const journal = entries.map((e) => { const d = dayOf(e.when); const h = d !== lastDay ? '<div class="day">' + d + "</div>" : ""; lastDay = d; return h + '<div class="entry timed"><span class="when">' + esc(e.when.replace(/^Yesterday ?/, "") || "") + "</span><div>" + e.html + "</div></div>"; }).join("");
		const agreed = m.agreed || AGREED[id] || [];
		const convoOpen = S.open["convo-" + id];
		const sent = S.sent[id] || [];
		const arts = S.w.artifacts.filter((a) => a.mission === id);
		main.innerHTML = '<div class="story-grid"><div>' +
			'<a class="back" href="#/">' + ic("left", "s") + "Today</a>" +
			'<div class="story-head"><div style="display:flex;gap:12px;align-items:flex-start"><h1>' + esc(m.title) + '</h1><span style="margin-left:auto;margin-top:22px;display:flex;gap:4px;align-items:center">' + status + '<button class="icon-btn" data-act="mmenu" data-id="' + id + '" aria-label="Mission actions">' + ic("more") + '</button></span></div><p class="goal">' + esc(m.goal) + "</p></div>" +
			'<div class="stand"><p>' + esc(stageLine) + " " + t.done + " of " + tot + ' tasks done.<br><b style="font-weight:600">Now:</b> <span data-live="now-' + m.id + '">' + esc(m.now) + "</span></p>" + P.bar(t) + "</div>" +
			(m.next.who !== "none" ? '<p class="next-line">' + ic("flag", "s") + "<span>Next" + (m.next.who === "you" ? " for you" : "") + ": <b>" + esc(m.next.text) + "</b></span></p>" : "") +
			(aa.length ? '<section class="part" style="margin-top:32px"><h2>Decisions</h2>' + aa.map((a, i) => focusCard(a, i, aa.length)).join('<div style="height:12px"></div>') + "</section>" : "") +
			'<section class="part"><h2>Agreed</h2><dl class="agreed">' + agreed.map(([k, v, by]) => "<dt>" + esc(k) + "</dt><dd>" + esc(v) + (by ? ' <span class="by">· ' + esc(by) + "</span>" : "") + "</dd>").join("") + "</dl>" +
			'<button class="more" style="margin-top:10px" data-act="mock" data-what="Change the agreement through a new question">' + ic("right", "s") + "Change the agreement</button></section>" +
			'<section class="part"><h2>Story so far</h2>' + journal +
			(m.activity.length > 3 ? '<button class="more" data-act="toggle" data-key="act-' + id + '" aria-expanded="' + !!S.open["act-" + id] + '">' + ic("right", "s") + (S.open["act-" + id] ? "Less" : "Everything that happened") + "</button>" : "") + "</section>" +
			'<section class="talk" id="talk"><h2 class="t-meta" style="font-weight:600;margin:0 0 8px">Ask or redirect</h2>' +
			'<form class="composer" data-compose="' + id + '"><textarea aria-label="Message about this mission" placeholder="Ask a question or add context" data-fk="compose-' + id + '"></textarea><div class="row"><span class="t-small">Return to send · mock</span><button class="btn primary small" aria-label="Send">' + ic("send", "s") + "</button></div></form>" +
			(m.convo.length + sent.length ? '<button class="more" style="margin-top:10px" data-act="toggle" data-key="convo-' + id + '" aria-expanded="' + !!convoOpen + '">' + ic("right", "s") + (convoOpen ? "Hide earlier messages" : "Earlier messages (" + (m.convo.length + sent.length) + ")") + "</button>" : "") +
			(convoOpen ? '<div class="convo">' + m.convo.concat(sent).map((x) => x.who === "event" ? '<div class="msg event">' + ic("commit", "s") + esc(x.text) + "</div>" : '<div class="msg ' + x.who + '">' + (x.who === "agent" ? '<div class="who">Pilot · ' + esc(x.when) + "</div>" : "") + esc(x.text) + (x.mock ? '<div class="t-small">Mock, not sent</div>' : "") + "</div>").join("") + "</div>" : "") +
			"</section></div>" +
			'<aside class="margin" aria-label="Mission details"><div class="blk"><h3>Stages</h3><ol class="stages">' + m.phases.map((p) => '<li class="' + p.state + '">' + P.pie(p.state === "done" ? "done" : p.state === "active" ? "active" : p.state === "failed" ? "blocked" : "todo") + esc(p.name) + "</li>").join("") + "</ol>" +
			(tot ? '<button class="more" data-act="mock" data-what="Open all tasks">' + ic("list", "s") + "All " + tot + " tasks</button>" : "") + "</div>" +
			(m.helpers.length ? '<div class="blk"><h3>Pilot has ' + m.helpers.length + " helper" + (m.helpers.length > 1 ? "s" : "") + " on this</h3>" + m.helpers.map((h) => '<div style="font-size:12.5px;padding:3px 0"><span>' + esc(h.title) + '</span><br><span class="faint">' + esc(h.step) + "</span></div>").join("") + "</div>" : "") +
			(S.w.scheduled.some((x) => x.mission === id) ? '<div class="blk"><h3>Scheduled by Pilot</h3>' + S.w.scheduled.filter((x) => x.mission === id).map((x) => '<div style="font-size:12.5px;padding:3px 0">' + esc(x.text) + '<br><span class="faint">' + esc(x.when) + "</span></div>").join("") + "</div>" : "") +
			(arts.length ? '<div class="blk"><h3>Library</h3>' + arts.map((a) => '<button class="more" style="display:flex" data-act="mock" data-what="Open artifact">' + ic(a.kind === "image" ? "image" : "activity", "s") + esc(a.title) + "</button>").join("") + "</div>" : "") +
			"</aside></div>";
		if (sub === "talk") { const ta = main.querySelector("textarea"); ta && ta.focus(); document.getElementById("talk").scrollIntoView({ block: "center" }); }
	}

	// ----- New mission: an interview made of decisions
	function newIv() { return { step: 0, goal: "", project: "harbor", ans: {}, picks: {}, other: {} }; }
	function agreeRows(iv, editable) {
		const rows = [["Goal", iv.goal || ""], ["Project", iv.project]].concat(QS.map((q) => [q.label, iv.ans[q.key] || "", q.key]));
		return '<dl class="agreed">' + rows.map(([k, v, key]) => "<dt>" + esc(k) + "</dt>" + (v ? "<dd>" + esc(v) + (editable && key ? '<button class="btn quiet small" data-act="iv-edit" data-key="' + key + '">Change</button>' : "") + "</dd>" : '<dd class="empty">Not decided yet</dd>')).join("") + "</dl>";
	}
	function interview() {
		skyWrap.style.display = "none";
		const iv = S.iv || (S.iv = newIv());
		let card;
		if (iv.step === 0) {
			card = '<h1>New</h1><p class="lead">Say what you want done, big or small. Small things start right away. Bigger ones get a few short questions, each with a recommended answer.</p>' +
				'<label class="field-l" for="goal" style="margin-top:0">What should Pilot get done?</label><textarea id="goal" class="goal-in" placeholder="' + esc(EXAMPLE) + '" data-fk="goal">' + esc(iv.goal) + "</textarea>" +
				'<span style="display:flex;gap:16px"><button class="example" data-act="iv-example">Bigger example</button><button class="example" data-act="iv-small">Small example</button><button class="example" data-act="iv-autoex">Repeating example</button></span>' +
				'<span class="field-l">Project</span><div class="pills" role="group" aria-label="Project">' + S.w.projects.map((p) => '<button data-act="iv-project" data-id="' + p.id + '" aria-pressed="' + (iv.project === p.id) + '">' + esc(p.name) + "</button>").join("") + "</div>" +
				'<div class="acts" style="margin-top:28px"><button class="btn primary" data-act="iv-start" data-fk="iv-start">Continue</button><a class="btn quiet" href="#/">Cancel</a></div>';
		} else if (iv.step === "reading") {
			card = '<h1>Reading ' + esc(iv.project) + "…</h1><p class=\"lead\">So the questions fit your project.</p><ul class=\"reading\" aria-live=\"polite\">" +
				["Read the README and the report code", "Found 6 report types, 2 with PDF export", "5 short questions ready"].slice(0, iv.readN || 0).map((x) => "<li>" + ic("check", "s") + esc(x) + "</li>").join("") + "</ul>";
		} else if (iv.step === "auto") {
			const pk = iv.autoPick || "a";
			card = "<h1>" + esc(iv.goal) + '</h1><p class="lead" style="margin-bottom:20px">' + esc(iv.project) + "</p>" +
				'<article class="focus"><h3>This repeats. Make it an automation?</h3><p class="ctx" style="margin-top:8px;color:var(--muted)">Pilot runs it on a schedule. Results show up in Today.</p>' +
				'<div class="choices" role="radiogroup" aria-label="When">' + [["a", "Every Monday at 09:00", "From what you wrote.", true], ["b", "Every weekday at 09:00", ""], ["c", "Every day at 18:00", "With the daily summary."]].map(([v, l, d, rec]) => '<label class="choice"><input type="radio" name="iv-auto" value="' + v + '" data-ivauto' + (v === pk ? " checked" : "") + '><span><span class="l">' + l + (rec ? '<span class="rec">Recommended</span>' : "") + "</span>" + (d ? '<br><span class="d">' + d + "</span>" : "") + "</span></label>").join("") + "</div>" +
				'<div class="acts"><button class="btn primary" data-act="iv-mkauto" data-fk="iv-auto">Create automation</button><button class="btn quiet" data-act="iv-back">Back</button><span class="mock-tag">mock</span></div></article>';
		} else if (iv.step === "small") {
			card = "<h1>" + esc(iv.goal) + '</h1><p class="lead" style="margin-bottom:20px">' + esc(iv.project) + "</p>" +
				'<article class="focus"><h3>This looks small. Pilot can just do it.</h3><p class="ctx" style="margin-top:8px;color:var(--muted)">One change, no questions needed. Pilot uses the project\'s usual rules:</p>' +
				'<dl class="agreed" style="margin-top:14px"><dt>Lands by</dt><dd>A pull request for your review <span class="by">· project default</span></dd><dt>Stops to ask</dt><dd>Anything outside this task</dd></dl>' +
				'<div class="acts" style="margin-top:22px"><button class="btn primary" data-act="iv-quick" data-fk="iv-quick">Do it</button><button class="btn quiet" data-act="iv-full">Ask me questions first</button><button class="btn quiet" data-act="iv-back">Back</button><span class="mock-tag">mock</span></div></article>';
		} else if (iv.step === "review") {
			card = '<h1>Here is the agreement</h1><p class="lead">Pilot plans and works inside this. It stops to ask only for what is outside it.</p>' +
				'<article class="focus review-card">' + agreeRows(iv, true) +
				'<button class="more" style="margin-top:16px" data-act="toggle" data-key="iv-more" aria-expanded="' + !!S.open["iv-more"] + '">' + ic("right", "s") + "More options (optional)</button>" +
				(S.open["iv-more"] ? '<div style="margin-top:8px"><div class="opt-row"><span>Spending limit</span><span class="v">None</span><button class="btn quiet small" data-act="mock" data-what="Set a spending limit">Set</button></div><div class="opt-row"><span>Deadline</span><span class="v">None</span><button class="btn quiet small" data-act="mock" data-what="Set a deadline">Set</button></div><div class="opt-row"><span>Pilot asks later</span><span class="v">Column order, after reading real reports</span></div></div>' : "") +
				'<div class="acts" style="margin-top:22px"><button class="btn primary" data-act="iv-go" data-fk="iv-go">Start mission</button><button class="btn quiet" data-act="iv-back">Back</button><span class="mock-tag">mock</span></div>' +
				'<p class="t-small" style="margin-top:12px">Starting approves this agreement. <span class="mock-tag gap-tag">approval action proposed, not built</span></p></article>';
		} else {
			const i = iv.step - 1, q = QS[i];
			const pick = iv.picks[q.key] || q.options.find((o) => o.rec).id;
			card = '<h1>' + esc(iv.goal) + '</h1><p class="lead" style="margin-bottom:20px">' + esc(iv.project) + "</p>" +
				'<article class="focus" aria-labelledby="q-h"><div class="meta" style="margin-top:0"><span>Question ' + (i + 1) + " of " + QS.length + '</span><span class="steps" aria-hidden="true">' + QS.map((_, k) => '<i class="' + (k < i ? "done" : k === i ? "on" : "") + '"></i>').join("") + "</span></div>" +
				'<h3 id="q-h">' + esc(q.title) + '</h3><p class="ctx" style="margin-top:8px;color:var(--muted)">' + esc(q.ctx) + "</p>" +
				'<div class="choices" role="radiogroup" aria-label="Answers">' + q.options.map((o) => '<label class="choice"><input type="radio" name="q-' + q.key + '" value="' + o.id + '" data-ivpick="' + q.key + '"' + (o.id === pick ? " checked" : "") + '><span><span class="l">' + esc(o.label) + (o.rec ? '<span class="rec">Recommended</span>' : "") + '</span><br><span class="d">' + esc(o.detail) + "</span></span></label>").join("") +
				'<label class="choice"><input type="radio" name="q-' + q.key + '" value="other" data-ivpick="' + q.key + '"' + (pick === "other" ? " checked" : "") + '><span style="flex:1"><span class="l">Something else</span>' + (pick === "other" ? '<input class="other-in" data-ivother="' + q.key + '" data-fk="other-' + q.key + '" aria-label="Your answer" placeholder="Your answer" value="' + esc(iv.other[q.key] || "") + '">' : "") + "</span></label></div>" +
				'<div class="acts"><button class="btn primary" data-act="iv-next" data-fk="iv-next">' + (iv.returnTo ? "Save" : i === QS.length - 1 ? "Done" : "Next") + '</button><button class="btn quiet" data-act="iv-back">Back</button><button class="btn quiet" data-act="iv-pilot">Let Pilot decide</button></div></article>' +
				(i < QS.length - 1 ? '<button class="skip-rest" data-act="iv-rest">Use the recommended answers for the rest</button>' : "");
		}
		main.innerHTML = '<div class="iv"><div><a class="back" href="#/">' + ic("left", "s") + "Today</a>" + card + "</div>" +
			(iv.step === "review" ? "<div></div>" : '<aside class="side-agree" aria-label="Agreement so far"><h2>Agreement so far</h2>' + agreeRows(iv, false) + "</aside>") + "</div>";
		if (iv.step === 0) { const g = main.querySelector("#goal"); g && !g.value && g.focus({ preventScroll: true }); }
	}
	function ivAnswer(q, how) {
		const iv = S.iv;
		if (how === "pilot") { iv.ans[q.key] = "Pilot decides and writes down why"; return; }
		const pick = iv.picks[q.key] || q.options.find((o) => o.rec).id;
		iv.ans[q.key] = pick === "other" ? (iv.other[q.key] || "").trim() || "Pilot decides and writes down why" : q.options.find((o) => o.id === pick).label;
	}
	function ivAdvance() { const iv = S.iv; iv.step = iv.returnTo || iv.step >= QS.length ? "review" : iv.step + 1; iv.returnTo = null; render(false); const b = main.querySelector('[data-fk="iv-next"],[data-fk="iv-go"]'); b && b.focus({ preventScroll: true }); window.scrollTo(0, 0); }

	function missionsPage() {
		skyWrap.style.display = "none";
		const row = (m) => '<a class="list-row" href="#/m/' + m.id + '"><span class="t">' + esc(m.title) + '</span><span class="s">' + esc(m.project) + '</span><span class="w">' + P.state(moving(m) ? "working" : m.state, moving(m) ? "Moving" : null) + "</span></a>";
		main.innerHTML = '<div class="col"><a class="back" href="#/">' + ic("left", "s") + 'Today</a><h1 class="t-title" style="margin:14px 0 18px">Missions</h1>' + S.w.missions.filter((m) => m.state !== "done").map(row).join("") +
			'<h2 class="t-meta" style="margin:28px 0 6px;font-weight:600">Finished</h2>' + S.w.missions.filter((m) => m.state === "done").map(row).join("") +
			'<div style="margin-top:20px"><a class="btn" href="#/new">' + ic("plus", "s") + "New mission</a></div></div>";
	}
	function simple(title, rows) {
		skyWrap.style.display = "none";
		main.innerHTML = '<div class="col"><a class="back" href="#/">' + ic("left", "s") + 'Today</a><h1 class="t-title" style="margin:14px 0 18px">' + esc(title) + "</h1>" + rows + "</div>";
	}
	const rowBtn = (t, s, w, what) => '<button class="list-row" style="width:100%;border-left:0;border-right:0;border-bottom:0;background:none;text-align:left;cursor:pointer" data-act="mock" data-what="' + esc(what) + '"><span class="t">' + esc(t) + '</span><span class="s">' + esc(s) + '</span><span class="w faint">' + (w || ic("right", "s")) + "</span></button>";

	function render(keep) {
		navTop();
		const [r, id, sub] = route();
		const sy = window.scrollY, fk = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.fk : null;
		if (r === "m") missionPage(id, sub);
		else if (r === "new") interview();
		else if (r === "start") startPage();
		else if (r === "review") reviewPage(id);
		else if (r === "reviews" || r === "changes") reviewsPage();
		else if (r === "automations") automationsPage();
		else if (r === "end") endPage();
		else if (r === "missions") missionsPage();
		else if (r === "library") simple("Library", S.w.artifacts.map((a) => rowBtn(a.title, M(a.mission).title, esc(a.when), "Open artifact")).join(""));
		else if (r === "settings") simple("Settings", window.MockSettings.map((s) => rowBtn(s, "", "", "Open " + s)).join(""));
		else if (r === "projects") simple("Projects", S.w.projects.map((p) => rowBtn(p.name, p.folder, "", "Project settings")).join(""));
		else home();
		if (keep) { window.scrollTo(0, sy); if (fk) { const el = main.querySelector('[data-fk="' + fk + '"]'); el && el.focus({ preventScroll: true }); } }
	}

	function resolve(a, note, apply) {
		S.w.attention = S.w.attention.filter((x) => x !== a);
		apply(M(a.mission)); S.front = null; S.sel = null;
		S.notes.unshift(note); if (S.notes.length > 2) S.notes.pop();
		render(true);
		const next = main.querySelector(".focus .btn.primary"); next && next.focus({ preventScroll: true });
	}

	document.addEventListener("click", (e) => {
		const b = e.target.closest("[data-act],[data-day]");
		if (!b) { const c = e.target.closest(".chip"); if (c) P.mock("open " + c.textContent.trim()); return; }
		if (b.dataset.day) { S.day = b.dataset.day; render(false); return; }
		const act = b.dataset.act;
		if (act && act.startsWith("iv-")) { e.preventDefault(); return ivClick(act, b); }
		if (act === "palette") P.openPalette(paletteItems());
		else if (act === "standup") standup();
		else if (act === "help") helpToggle(b.dataset.id, b.dataset.kind);
		else if (act === "rv-file") { S.rv[route()[1]].file = +b.dataset.i; S.rv[route()[1]].open = null; render(true); }
		else if (act === "rv-line") { const st = S.rv[route()[1]]; st.open = st.open === b.dataset.key ? null : b.dataset.key; render(true); const i = main.querySelector('[data-fk="rvc"]'); i && i.focus({ preventScroll: true }); }
		else if (act === "rv-seen") { location.hash = S.backTo || "#/"; P.toast("Marked as seen."); }
		else if (act === "rv-again") { S.again[b.dataset.id] = !S.again[b.dataset.id]; render(true); P.toast(S.again[b.dataset.id] ? "Saved to look at again. It shows at the top of Changes." : "Removed from your list."); }
		else if (act === "ch-filter") { S.chFilter = b.dataset.k; render(true); }
		else if (act === "rv-request") { S.rv[b.dataset.id].changes = true; render(true); main.querySelector("#rvch").focus(); }
		else if (act === "rv-cancel") { S.rv[route()[1]].changes = false; render(true); }
		else if (act === "rv-approve") { const r = S.w.reviews.find((x) => x.id === b.dataset.id); r.state = "done"; S.notes.unshift("Approved " + r.title + ". Mock only."); if (S.notes.length > 2) S.notes.pop(); location.hash = "#/"; }
		else if (act === "auto-toggle") { S.autoOff[b.dataset.text] = !S.autoOff[b.dataset.text]; render(true); P.toast((S.autoOff[b.dataset.text] ? "Turned off: " : "Turned on: ") + b.dataset.text + ". Mock only."); }
		else if (act === "automenu") P.openMenu(b, [{ label: "Run now", icon: "play", run: () => P.mock("run now") }, { label: "Edit schedule", icon: "clock", run: () => P.mock("edit schedule") }, "-", { label: "Remove", icon: "x", run: () => { S.w.scheduled = S.w.scheduled.filter((x) => x.text !== b.dataset.text); S.extraAuto = S.extraAuto.filter((x) => x.text !== b.dataset.text); render(true); P.mock("automation removed"); } }]);
		else if (act === "triage") openTriage(b.dataset.from || (route()[0] === "start" ? "start" : "home"));
		else if (act === "go") location.hash = b.dataset.href;
		else if (act === "start-next") { S.startStep = (S.startStep === "done" ? 3 : S.startStep) + 1; render(false); }
		else if (act === "start-done") { S.startStep = "done"; location.hash = "#/"; P.toast("Good start. Pilot is on it."); }
		else if (act === "end-close") { S.closed = true; render(false); }
		else if (act === "schedmenu") P.openMenu(b, [{ label: "Skip the next run", icon: "clock", run: () => P.mock("skip next run") }, { label: "Remove", icon: "x", run: () => { S.w.scheduled = S.w.scheduled.filter((x) => x.text !== b.dataset.text); render(true); P.mock("schedule removed"); } }]);
		else if (act === "pin") { S.sel = b.dataset.id; render(true); const c = document.getElementById("dec-" + b.dataset.id); if (c) { c.scrollIntoView({ block: "nearest", behavior: "smooth" }); const p = c.querySelector(".btn.primary"); p && p.focus({ preventScroll: true }); } }
		else if (act === "focus-dec") {
			e.preventDefault(); S.front = b.dataset.id; S.sel = b.dataset.id;
			if (route()[0] !== "") location.hash = "#/"; else render(false);
			setTimeout(() => { const c = document.getElementById("dec-" + b.dataset.id); if (c) { c.scrollIntoView({ block: "center" }); const p = c.querySelector(".btn.primary"); p && p.focus({ preventScroll: true }); } }, 30);
		} else if (act === "decide") {
			const a = S.w.attention.find((x) => x.id === b.dataset.id); if (!a) return;
			const pick = S.picks[a.id] || (a.options.find((o) => o.recommended) || a.options[0]).id, opt = a.options.find((o) => o.id === pick);
			resolve(a, "Decided for " + M(a.mission).title + ": " + opt.label + ". Added to its agreement.", (m) => { m.state = a.kind === "failure" && pick === "c" ? "paused" : "working"; m.now = m.state === "paused" ? "Paused." : "Applying your choice."; m.next = { who: "pilot", text: "Continues within the agreement." }; (m.agreed = (m.agreed || AGREED[m.id] || []).slice()).push(["Added later", opt.label + ".", "You, just now"]); });
			P.mock("decision recorded locally");
		} else if (act === "check") {
			S.checking[b.dataset.id] = true; render(true);
			setTimeout(() => { const a = S.w.attention.find((x) => x.id === b.dataset.id); if (a) resolve(a, "Confirmed: e93b1a0 is on main. Mock result.", (m) => { m.state = "working"; m.now = "Push confirmed. Continuing."; }); }, 1200);
		} else if (act === "snooze") { S.snoozed = S.snoozed.filter((x) => x !== b.dataset.id).concat(b.dataset.id); S.front = null; render(true); const n = main.querySelector(".focus .btn.primary"); n && n.focus({ preventScroll: true }); P.toast("Moved to the end. That mission still waits for it."); }
		else if (act === "toggle") { S.open[b.dataset.key] = !S.open[b.dataset.key]; render(true); }
		else if (act === "approve") {
			const r = S.w.reviews.find((x) => x.id === b.dataset.id); if (!r) return;
			r.state = "done"; S.notes.unshift("Approved " + r.title + ". Mock only."); if (S.notes.length > 2) S.notes.pop();
			P.mock("approved"); render(true); const n = main.querySelector(".focus .btn.primary"); n && n.focus({ preventScroll: true });
		}
		else if (act === "more") P.openMenu(b, [{ label: "All missions", icon: "compass", run: () => (location.hash = "#/missions") }, { label: "Changes", icon: "pr", hint: unseen() ? unseen() + " new" : "", run: () => (location.hash = "#/changes") }, { label: "Automations", icon: "clock", run: () => (location.hash = "#/automations") }, { label: "Library", icon: "grid", run: () => (location.hash = "#/library") }, { label: "Projects", icon: "folder", run: () => (location.hash = "#/projects") }, "-", { label: "Settings", icon: "settings", hint: "⌘,", run: () => (location.hash = "#/settings") }]);
		else if (act === "mmenu") P.openMenu(b, [{ label: "Ask or redirect", icon: "chat", run: () => (location.hash = "#/m/" + b.dataset.id + "/talk") }, { label: "All tasks", icon: "list", run: () => P.mock("open tasks") }, { label: "Pause mission", icon: "pause", hint: "needs contract", run: () => P.mock("pause mission") }, "-", { label: "Archive mission", icon: "folder", run: () => P.mock("archive needs confirmation") }]);
		else if (act === "mock") P.mock(b.dataset.what || "action");
	});
	function ivClick(act, b) {
		const iv = S.iv; if (!iv) return;
		if (act === "iv-example") { iv.goal = EXAMPLE; iv.project = "harbor"; render(false); main.querySelector('[data-fk="iv-start"]').focus(); }
		else if (act === "iv-project") { iv.project = b.dataset.id; render(true); }
		else if (act === "iv-start") {
			const g = main.querySelector("#goal"); iv.goal = (g && g.value.trim()) || EXAMPLE;
			if (/\b(every|each|daily|weekly|nightly)\b/i.test(iv.goal)) { iv.step = "auto"; render(false); const q = main.querySelector('[data-fk="iv-auto"]'); q && q.focus({ preventScroll: true }); return; }
			if (isSmall(iv.goal)) { iv.step = "small"; render(false); const q = main.querySelector('[data-fk="iv-quick"]'); q && q.focus({ preventScroll: true }); return; }
			iv.step = "reading"; iv.readN = 0; render(false);
			const tick = () => { if (!S.iv || S.iv.step !== "reading") return; iv.readN++; if (iv.readN > 3) { iv.step = 1; render(false); const n = main.querySelector('[data-fk="iv-next"]'); n && n.focus({ preventScroll: true }); return; } render(false); setTimeout(tick, 450); };
			setTimeout(tick, 350);
		}
		else if (act === "iv-next") { ivAnswer(QS[iv.step - 1]); ivAdvance(); }
		else if (act === "iv-pilot") { ivAnswer(QS[iv.step - 1], "pilot"); ivAdvance(); }
		else if (act === "iv-rest") { for (let k = iv.step - 1; k < QS.length; k++) { if (k === iv.step - 1) ivAnswer(QS[k]); else if (!iv.ans[QS[k].key]) iv.ans[QS[k].key] = QS[k].options.find((o) => o.rec).label; } iv.step = "review"; render(false); main.querySelector('[data-fk="iv-go"]').focus(); }
		else if (act === "iv-autoex") { iv.goal = "Every Monday, summarize open pull requests in harbor."; iv.project = "harbor"; render(false); main.querySelector('[data-fk="iv-start"]').focus(); }
		else if (act === "iv-mkauto") {
			const when = { a: "Mon 09:00", b: "Weekdays 09:00", c: "Daily 18:00" }[iv.autoPick || "a"];
			S.extraAuto.push({ when, text: iv.goal.replace(/^every (monday|day|weekday)s?( at \d+)?,?\s*/i, "").replace(/^./, (c) => c.toUpperCase()).replace(/[.]$/, ""), by: "you" });
			S.iv = null; location.hash = "#/automations"; P.toast("Automation created. Mock only.");
		}
		else if (act === "iv-small") { iv.goal = SMALL; iv.project = "harbor"; render(false); main.querySelector('[data-fk="iv-start"]').focus(); }
		else if (act === "iv-full") { iv.step = "reading"; iv.readN = 0; render(false); setTimeout(function t2() { if (!S.iv || S.iv.step !== "reading") return; iv.readN++; if (iv.readN > 3) { iv.step = 1; render(false); return; } render(false); setTimeout(t2, 450); }, 350); }
		else if (act === "iv-quick") {
			const id = "new" + (S.extra.length + 1);
			const m = { id, title: iv.goal.replace(/[.!]$/, "").slice(0, 48), project: iv.project, goal: iv.goal, state: "working", updated: "just now", quick: true, phases: [{ name: "Quick task", state: "active" }], tasks: { done: 0, review: 0, active: 1, blocked: 0, todo: 0 }, taskList: [], now: "Working on it.", steps: ["Working on it.", "Checking the change."], next: { who: "pilot", text: "Opens a pull request when done." }, helpers: [], delivered: [], scope: { may: [], asks: [], budget: null }, activity: [{ when: "now", text: "Started from your request." }], convo: [], agreed: [["Lands by", "A pull request for your review", "project default"], ["Stops to ask", "Anything outside this task"]] };
			S.extra.push(m); S.w.missions.push(JSON.parse(JSON.stringify(m))); S.iv = null; S.day = "today";
			location.hash = "#/"; P.toast("Started. It shows under Missions, then in Done. Mock only.");
		}
		else if (act === "iv-back") { if (iv.returnTo) { iv.returnTo = null; iv.step = "review"; render(false); return; } iv.step = iv.step === "review" ? QS.length : iv.step === "small" || iv.step === "auto" ? 0 : iv.step > 1 ? iv.step - 1 : 0; render(false); }
		else if (act === "iv-edit") { iv.returnTo = "review"; iv.step = QS.findIndex((q) => q.key === b.dataset.key) + 1; render(false); const n = main.querySelector('[data-fk="iv-next"]'); n && n.focus({ preventScroll: true }); }
		else if (act === "iv-go") {
			const id = "new" + (S.extra.length + 1);
			const title = iv.goal === EXAMPLE ? "CSV export" : iv.goal.replace(/[.!]$/, "").slice(0, 40);
			const m = { id, title, project: iv.project, goal: iv.goal, state: "working", updated: "just now", phases: [{ name: "Plan", state: "active" }, { name: "Build", state: "todo" }, { name: "Prove", state: "todo" }, { name: "Land", state: "todo" }], tasks: { done: 0, review: 0, active: 1, blocked: 0, todo: 0 }, taskList: [], now: "Planning the first steps.", steps: ["Planning the first steps.", "Reading the 6 report types.", "Splitting the work."], next: { who: "pilot", text: "Shares the plan in Story so far." }, helpers: [], delivered: [], scope: { may: [], asks: [], budget: null }, activity: [{ when: "now", text: "Started from your answers. Planning the first steps." }], convo: [], agreed: QS.map((q) => [q.label, iv.ans[q.key]]) };
			S.extra.push(m); S.w.missions.push(JSON.parse(JSON.stringify(m))); S.iv = null;
			location.hash = "#/m/" + id; P.mock("mission started");
		}
	}
	document.addEventListener("change", (e) => {
		const r = e.target.closest("[data-pick]"); if (r) S.picks[r.dataset.pick] = r.value;
		const au = e.target.closest("[data-ivauto]"); if (au && S.iv) S.iv.autoPick = au.value;
		const q = e.target.closest("[data-ivpick]"); if (q && S.iv) { S.iv.picks[q.dataset.ivpick] = q.value; if (q.value === "other" || main.querySelector(".other-in")) { render(true); const o = main.querySelector(".other-in"); if (q.value === "other" && o) o.focus(); } }
	});
	document.addEventListener("input", (e) => {
		const o = e.target.closest("[data-ivother]"); if (o && S.iv) S.iv.other[o.dataset.ivother] = o.value;
		const g = e.target.closest("#goal"); if (g && S.iv) S.iv.goal = g.value;
	});
	document.addEventListener("submit", (e) => {
		const rf = e.target.closest("[data-rvform]"); if (rf) { e.preventDefault(); const v = rf.querySelector("input").value.trim(); if (v) { const st = S.rv[route()[1]]; (st.comments[rf.dataset.rvform] = st.comments[rf.dataset.rvform] || []).push(v); st.open = null; render(true); } return; }
		const rc = e.target.closest("[data-rvchanges]"); if (rc) { e.preventDefault(); const r = S.w.reviews.find((x) => x.id === rc.dataset.rvchanges && x.state === "waiting"); if (!r) { const c = getChange(rc.dataset.rvchanges); S.notes.unshift("Pilot will fix " + c.title + " in a new change. Mock only."); P.toast("Pilot will fix " + c.title + " in a new change. Mock only."); if (S.notes.length > 2) S.notes.pop(); location.hash = S.backTo || "#/"; return; } r.state = "changes"; S.notes.unshift("Sent " + r.title + " back with your notes. Pilot will ask again. Mock only."); if (S.notes.length > 2) S.notes.pop(); location.hash = "#/"; return; }
		const af = e.target.closest("[data-askform]"); if (af) { e.preventDefault(); askSubmit(af.dataset.askform, af.querySelector("input")); return; }
		const f = e.target.closest("[data-compose]"); if (!f) return; e.preventDefault();
		const ta = f.querySelector("textarea"), text = ta.value.trim(); if (!text) return;
		(S.sent[f.dataset.compose] = S.sent[f.dataset.compose] || []).push({ who: "user", text, mock: true });
		S.open["convo-" + f.dataset.compose] = true; ta.value = ""; render(true);
		const t2 = main.querySelector("textarea"); t2 && t2.focus({ preventScroll: true });
	});
	document.addEventListener("keydown", (e) => {
		if (e.key === "Enter" && !e.shiftKey && e.target.matches(".composer textarea") && !e.isComposing) { e.preventDefault(); e.target.form.requestSubmit(); }
		if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.target.matches("#goal")) { e.preventDefault(); ivClick("iv-start"); }
		if (e.key === "Enter" && !e.isComposing && e.target.matches(".other-in")) { e.preventDefault(); ivClick("iv-next"); }
		if (route()[0] === "review" && !e.metaKey && !e.ctrlKey && !e.target.matches("input, textarea") && (e.key === "j" || e.key === "k")) { const st = S.rv[route()[1]], r = S.w.reviews.find((x) => x.id === route()[1]); if (st && r) { st.file = Math.max(0, Math.min(r.files.length - 1, st.file + (e.key === "j" ? 1 : -1))); st.open = null; render(true); } }
		if ((e.metaKey || e.ctrlKey) && e.key === ",") { e.preventDefault(); location.hash = "#/settings"; }
		if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") { e.preventDefault(); location.hash = "#/new"; }
	});
	window.addEventListener("scroll", () => document.getElementById("topbar").classList.toggle("scrolled", window.scrollY > 8), { passive: true });

	function paletteItems() {
		const go = (h) => () => (location.hash = h);
		return [["Today", "#/", "target"], ["All missions", "#/missions", "compass"], ["Changes", "#/changes", "pr"], ["Automations", "#/automations", "clock"], ["Library", "#/library", "grid"], ["Projects", "#/projects", "folder"], ["Settings", "#/settings", "settings"]].map(([l, h, i]) => ({ group: "Places", label: l, icon: i, run: go(h) }))
			.concat(S.w.missions.map((m) => ({ group: "Missions", label: m.title, icon: "compass", hint: m.project, run: go("#/m/" + m.id) })))
			.concat(S.w.missions.filter((m) => m.state !== "done").map((m) => ({ group: "Ask", label: "Ask about " + m.title, icon: "chat", run: go("#/m/" + m.id + "/talk") })))
			.concat([{ group: "Actions", label: "New mission", icon: "plus", hint: "⌘N", run: go("#/new") }, { group: "Actions", label: "Standup notes", icon: "calendar", run: standup }, { group: "Actions", label: "Start the day", icon: "sun", run: go("#/start") }, { group: "Actions", label: "End the day", icon: "moon", run: go("#/end") }, { group: "Actions", label: "Decide all", icon: "check", hint: "D", run: () => openTriage() }, { group: "Archive", label: "Search old chats", icon: "search", hint: "read-only", run: () => P.mock("search old chats") }]);
	}

	let tick = 0;
	setInterval(() => {
		if (S.w.scenario !== "underway") return; tick++;
		if (MODE === "now" && route()[0] === "" && S.day === "today") { S.nowAdd = (S.nowAdd || 0) + 1; const nl = document.getElementById("nl"); if (nl) nl.innerHTML = nowLine(); }
		S.w.missions.forEach((m) => { if (m.state !== "working") return; m.now = m.steps[tick % m.steps.length]; document.querySelectorAll('[data-live="now-' + m.id + '"]').forEach((el) => P.swapText(el, m.now)); });
	}, 5000);

	window.addEventListener("hashchange", () => { if (route()[0] === "new" && !S.iv) S.iv = newIv(); render(false); main.focus({ preventScroll: true }); });
	window.addEventListener("proto:scenario", () => { reset(); render(true); });
	P.palette(paletteItems);
	reset(); render(false);
	P.mountPanel(MODE === "now" ? "C · Now line" : "D · Day");
})();

