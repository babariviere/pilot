// Synthetic world for the prototypes. Every name, number and event here is invented.
(function () {
	"use strict";
	const clone = (o) => JSON.parse(JSON.stringify(o));

	const projects = [
		{ id: "pilot", name: "pilot", folder: "Personal" },
		{ id: "harbor", name: "harbor", folder: "Work" },
		{ id: "dotfiles", name: "dotfiles", folder: "Personal" },
	];

	const base = {
		date: "Monday 9 November",
		time: "09:12",
		lastLooked: "yesterday at 19:05",
		leftOff: { mission: "native", text: "You were reading the history slice in Native desktop app." },
		projects,
		missions: [
			{
				id: "native", title: "Native desktop app", project: "pilot",
				goal: "Move the desktop app to Native Shell, keeping how it looks and behaves.",
				state: "background", updated: "4 min ago",
				phases: [
					{ name: "Shell and chat", state: "done" },
					{ name: "History and images", state: "active" },
					{ name: "Missions and Review", state: "todo" },
					{ name: "Settings", state: "todo" },
					{ name: "Qualify on macOS", state: "todo" },
				],
				tasks: { done: 14, review: 1, active: 2, blocked: 0, todo: 6 },
				taskList: [
					{ n: 563, title: "First chat on Native Shell", state: "done", phase: "Shell and chat", outcome: "Sidebar, selection, send and Stop work on real chats." },
					{ n: 564, title: "Chat controls and drafts", state: "done", phase: "Shell and chat", outcome: "Drafts survive restarts; IME checks pass." },
					{ n: 565, title: "Load older messages while streaming", state: "review", phase: "History and images", outcome: "Reading position holds while older pages load." },
					{ n: 566, title: "Image zoom and pan", state: "active", phase: "History and images", outcome: "" },
					{ n: 581, title: "Fold long user messages", state: "active", phase: "History and images", outcome: "" },
					{ n: 567, title: "Review on Native Shell", state: "todo", phase: "Missions and Review", outcome: "" },
					{ n: 568, title: "Missions on Native Shell", state: "todo", phase: "Missions and Review", outcome: "" },
					{ n: 570, title: "Settings and projects", state: "todo", phase: "Settings", outcome: "" },
					{ n: 162, title: "Input, motion and large-history checks", state: "todo", phase: "Qualify on macOS", outcome: "" },
				],
				now: "Checking image zoom on a 4K capture.",
				steps: ["Checking image zoom on a 4K capture.", "Running 38 focused tests.", "Comparing light and dark captures.", "Reviewing the history slice."],
				next: { who: "you", text: "Review the history slice once its checks pass." },
				helpers: [
					{ title: "Image zoom and pan", step: "Testing pinch zoom", since: "31 min" },
					{ title: "Fold long user messages", step: "Writing tests", since: "12 min" },
				],
				delivered: [
					{ id: "d1", title: "Older messages load while a reply streams", when: "06:40", summary: "Scrolling up fetches older pages. Your reading position stays put.", evidence: [{ kind: "commit", label: "a41c9e2" }, { kind: "checks", label: "38 tests passed" }, { kind: "image", label: "Capture, light and dark" }] },
					{ id: "d2", title: "Drafts survive a restart", when: "Yesterday", summary: "Unsent text and attachments come back after quitting.", evidence: [{ kind: "commit", label: "9f02b7d" }, { kind: "checks", label: "IME and undo checks" }] },
				],
				scope: {
					may: ["Change desktop app code in pilot", "Run local tests and captures", "Push finished work to main after checks"],
					asks: ["Daemon, storage or protocol changes", "Installs, releases or restarting your app"],
					budget: null,
				},
				activity: [
					{ when: "09:08", text: "Started checking image zoom on a 4K capture." },
					{ when: "08:51", text: "Assigned \"Fold long user messages\" to a helper." },
					{ when: "06:40", text: "Pushed a41c9e2: older messages load while streaming." },
					{ when: "06:12", text: "Checks passed for the history slice." },
					{ when: "Yesterday 22:30", text: "Split images into its own task." },
				],
				convo: [
					{ who: "user", text: "Keep the reading position stable when older pages load. That matters more than speed.", when: "Yesterday 18:20" },
					{ who: "agent", text: "Understood. I added it to the acceptance checks for the history slice and will show you a capture before calling it done.", when: "Yesterday 18:21" },
					{ who: "event", text: "Pushed a41c9e2 · 38 tests passed", when: "06:40" },
					{ who: "agent", text: "History paging is in. Reading position held in all 12 capture runs. Images are next.", when: "06:41" },
				],
			},
			{
				id: "notify", title: "Quieter notifications", project: "pilot",
				goal: "Notify only when something needs you, and say why.",
				state: "planned", updated: "yesterday",
				phases: [{ name: "Audit", state: "done" }, { name: "Rules", state: "todo" }, { name: "Build", state: "todo" }, { name: "Verify", state: "todo" }],
				tasks: { done: 3, review: 0, active: 0, blocked: 0, todo: 5 },
				taskList: [
					{ n: 601, title: "Count last week's notifications", state: "done", phase: "Audit", outcome: "41 sent, 6 needed you." },
					{ n: 602, title: "Draft notification rules", state: "todo", phase: "Rules", outcome: "" },
					{ n: 603, title: "Daily summary", state: "todo", phase: "Build", outcome: "" },
					{ n: 604, title: "Verify with a synthetic week", state: "todo", phase: "Verify", outcome: "" },
				],
				now: "Waiting to start Rules after the audit.",
				steps: ["Drafting notification rules.", "Grouping last week's notifications by reason.", "Writing the rule table."],
				next: { who: "pilot", text: "Starts Rules this afternoon." },
				helpers: [],
				delivered: [
					{ id: "d3", title: "Audit of last week's notifications", when: "Yesterday", summary: "41 notifications were sent. 6 needed you. Most others were finished work.", evidence: [{ kind: "visual", label: "Notification chart" }, { kind: "file", label: "Audit notes" }] },
				],
				scope: {
					may: ["Change notification code in pilot", "Run local tests"],
					asks: ["Changing which events notify by default"],
					budget: null,
				},
				activity: [
					{ when: "Yesterday 17:02", text: "Finished the notification audit." },
					{ when: "Yesterday 15:40", text: "Mission started from your brief." },
				],
				convo: [
					{ who: "user", text: "I get too many pings. Figure out which ones matter.", when: "Yesterday 15:38" },
					{ who: "agent", text: "I'll audit last week first, then propose rules. I won't change defaults without asking you.", when: "Yesterday 15:40" },
				],
			},
			{
				id: "search", title: "Faster search", project: "harbor",
				goal: "Show search results in under 200 ms for large workspaces.",
				state: "background", updated: "18 min ago",
				phases: [{ name: "Measure", state: "done" }, { name: "Index", state: "done" }, { name: "Verify", state: "active" }, { name: "Ship", state: "todo" }],
				tasks: { done: 7, review: 0, active: 1, blocked: 0, todo: 2 },
				taskList: [
					{ n: 701, title: "Measure current search time", state: "done", phase: "Measure", outcome: "Median 640 ms on the large fixture." },
					{ n: 702, title: "Incremental index", state: "done", phase: "Index", outcome: "Index rebuild 4x faster." },
					{ n: 703, title: "Run integration tests on Linux and macOS", state: "active", phase: "Verify", outcome: "" },
					{ n: 704, title: "Open the release PR", state: "todo", phase: "Ship", outcome: "" },
				],
				now: "Running integration tests on Linux.",
				steps: ["Running integration tests on Linux.", "Running integration tests on macOS.", "Benchmarking the large fixture."],
				next: { who: "you", text: "Review the release PR when it opens." },
				helpers: [{ title: "Integration tests", step: "Linux runner, 112 of 148", since: "18 min" }],
				delivered: [
					{ id: "d4", title: "Index rebuild is 4x faster", when: "02:15", summary: "Median search fell from 640 ms to 150 ms on the large fixture.", evidence: [{ kind: "commit", label: "7c1e04a" }, { kind: "bench", label: "Benchmark chart" }, { kind: "checks", label: "Unit tests passed" }] },
				],
				scope: {
					may: ["Change search and index code in harbor", "Run tests and benchmarks", "Open a pull request"],
					asks: ["Changing the public search API", "Merging"],
					budget: null,
				},
				activity: [
					{ when: "08:54", text: "Started integration tests on Linux." },
					{ when: "02:15", text: "Pushed 7c1e04a to search-index: incremental index." },
					{ when: "Yesterday 23:10", text: "Measured median search at 640 ms." },
				],
				convo: [
					{ who: "user", text: "Search feels slow in big workspaces. Under 200 ms if you can.", when: "Yesterday 21:00" },
					{ who: "agent", text: "Measured 640 ms median. The index rebuild is the main cost. I'll make it incremental and keep the API unchanged.", when: "Yesterday 23:12" },
				],
			},
			{
				id: "dotfiles", title: "Tidy shell setup", project: "dotfiles",
				goal: "Remove unused tools and start a shell in under 100 ms.",
				state: "done", updated: "05:30",
				phases: [{ name: "Inventory", state: "done" }, { name: "Remove", state: "done" }, { name: "Measure", state: "done" }],
				tasks: { done: 5, review: 0, active: 0, blocked: 0, todo: 0 },
				taskList: [
					{ n: 801, title: "List unused tools", state: "done", phase: "Inventory", outcome: "11 tools unused for 90 days." },
					{ n: 802, title: "Remove them", state: "done", phase: "Remove", outcome: "Removed 9; kept 2 you use monthly." },
					{ n: 803, title: "Measure shell start", state: "done", phase: "Measure", outcome: "84 ms, was 310 ms." },
				],
				now: "Finished.",
				steps: ["Finished."],
				next: { who: "none", text: "Nothing left to do." },
				helpers: [],
				delivered: [
					{ id: "d5", title: "Shell starts in 84 ms", when: "05:30", summary: "Was 310 ms. Removed 9 unused tools and kept 2 you use monthly.", evidence: [{ kind: "commit", label: "3 commits" }, { kind: "bench", label: "Startup timing" }, { kind: "checks", label: "Checks passed" }] },
				],
				scope: { may: ["Change files in dotfiles", "Run shell timing"], asks: ["Removing tools you used this quarter"], budget: null },
				activity: [{ when: "05:30", text: "Mission finished. Shell starts in 84 ms." }, { when: "03:02", text: "Removed 9 unused tools." }],
				convo: [{ who: "agent", text: "Done. Shell starts in 84 ms. I kept two tools you used this month.", when: "05:30" }],
			},
		],
		attention: [],
		reviews: [
			{ id: "r1", mission: "native", title: "History slice", state: "done", summary: "Older messages load while streaming. Reading position holds.", checks: "38 tests passed", files: ["transcript/history.rs", "transcript/anchor.rs", "tests/history_paging.rs", "docs/history.md"], evidence: [{ kind: "image", label: "Capture, light and dark" }] },
		],
		chats: [
			{ id: "c1", title: "Fix flaky upload test", project: "harbor", state: "done", when: "Yesterday" },
			{ id: "c2", title: "Explain the release workflow", project: "pilot", state: "done", when: "Friday" },
			{ id: "c3", title: "Draft changelog for 0.9", project: "pilot", state: "quiet", when: "Thursday" },
			{ id: "m-native", title: "Coordinator: Native desktop app", project: "pilot", state: "background", when: "4 min ago", mission: "native" },
			{ id: "m-search", title: "Coordinator: Faster search", project: "harbor", state: "background", when: "18 min ago", mission: "search" },
		],
		artifacts: [
			{ id: "a1", title: "History paging, light and dark", kind: "image", mission: "native", when: "06:40" },
			{ id: "a2", title: "Notification chart", kind: "chart", mission: "notify", when: "Yesterday" },
			{ id: "a3", title: "Search benchmark", kind: "chart", mission: "search", when: "02:15" },
			{ id: "a4", title: "Startup timing", kind: "chart", mission: "dotfiles", when: "05:30" },
			{ id: "a5", title: "Mission flow", kind: "diagram", mission: "native", when: "Friday" },
		],
		scheduled: [
			{ when: "18:00", text: "Daily summary from all coordinators", by: "you" },
			{ when: "Nightly 02:00", text: "Re-run the search benchmark", by: "pilot", mission: "search", why: "Catches slowdowns from other changes." },
			{ when: "Tomorrow 09:00", text: "Weekly Insights report for pilot", by: "you" },
		],
		digest: [
			{ mission: "dotfiles", text: "Tidy shell setup finished. Shell starts in 84 ms, was 310 ms.", evidence: [{ kind: "commit", label: "3 commits" }, { kind: "bench", label: "Startup timing" }] },
			{ mission: "native", text: "Older messages now load while a reply streams.", evidence: [{ kind: "commit", label: "a41c9e2" }, { kind: "checks", label: "38 tests passed" }] },
			{ mission: "search", text: "Search index rebuilds 4x faster. Median search is 150 ms.", evidence: [{ kind: "bench", label: "Benchmark chart" }] },
		],
		headline: "Nothing needs you today.",
		summary: "Overnight, Tidy shell setup finished and the native app moved on to images. Faster search is running its last checks.",
	};

	function apply(scn) {
		const w = clone(base);
		const m = (id) => w.missions.find((x) => x.id === id);
		w.scenario = scn;
		if (scn === "quiet") return w;

		if (scn === "underway") {
			w.time = "14:36"; w.lastLooked = "at 12:10";
			m("native").state = "working"; m("native").updated = "just now";
			m("native").tasks = { done: 15, review: 0, active: 3, blocked: 0, todo: 5 };
			m("native").helpers = [
				{ title: "Image zoom and pan", step: "Testing pinch zoom", since: "31 min" },
				{ title: "Fold long user messages", step: "Writing tests", since: "12 min" },
				{ title: "Copy exact message text", step: "Comparing clipboard output", since: "4 min" },
			];
			m("native").taskList[2].state = "done";
			m("native").taskList.push({ n: 583, title: "Copy exact message text", state: "active", phase: "History and images", outcome: "" });
			m("notify").state = "working"; m("notify").updated = "2 min ago"; m("notify").now = "Drafting notification rules.";
			m("notify").phases[1].state = "active"; m("notify").tasks = { done: 3, review: 0, active: 1, blocked: 0, todo: 4 };
			m("notify").taskList[1].state = "active";
			m("notify").helpers = [{ title: "Draft notification rules", step: "Grouping by reason", since: "9 min" }];
			m("notify").next = { who: "you", text: "Choose how finished work should reach you." };
			m("search").state = "working"; m("search").updated = "1 min ago";
			w.reviews[0].state = "done";
			w.reviews.push({ id: "r2", mission: "search", title: "Incremental index", state: "waiting", summary: "Index rebuild 4x faster. API unchanged.", checks: "Unit tests passed, integration running", files: ["index/build.go", "index/incremental.go", "index/incremental_test.go"], evidence: [{ kind: "bench", label: "Benchmark chart" }] });
			w.chats[2].state = "working"; w.chats[2].when = "now";
			w.headline = "Three missions are moving. One result is ready to review.";
			w.summary = "The native app has three helpers on images and history. Notification rules are being drafted. Search is in its last checks.";
			w.digest = [
				{ mission: "native", text: "History slice reviewed and done. Images started.", evidence: [{ kind: "checks", label: "38 tests passed" }] },
				{ mission: "notify", text: "Started drafting notification rules.", evidence: [] },
			];
			return w;
		}

		if (scn === "decision") {
			w.time = "11:02"; w.lastLooked = "at 09:15";
			w.reviews[0].state = "waiting";
			m("notify").state = "needs"; m("notify").updated = "12 min ago";
			m("notify").phases[1].state = "active"; m("notify").tasks = { done: 4, review: 0, active: 0, blocked: 1, todo: 3 };
			m("notify").taskList[1].state = "blocked"; m("notify").now = "Waiting for your choice on notification rules.";
			m("notify").next = { who: "you", text: "Choose how finished work should reach you." };
			m("notify").attentionIds = ["q1"];
			m("native").state = "needs"; m("native").updated = "6 min ago";
			m("native").now = "Paused before the macOS checks: waiting for your OK to open a test copy of Pilot.";
			m("native").next = { who: "you", text: "Allow a test copy of Pilot for the macOS checks, or skip them." };
			m("native").attentionIds = ["q2"];
			m("native").helpers = [];
			m("search").state = "working";
			w.attention = [
				{
					id: "q1", kind: "decision", mission: "notify", asked: "12 min ago",
					effort: "About 1 min",
					title: "How should finished work reach you?",
					reason: "Asks: notification rule",
					context: "Last week Pilot sent 41 notifications. 6 needed you. The rest were finished work you looked at later.",
					boundary: "Changing which events notify you is outside the agreed scope, so the coordinator stopped to ask.",
					options: [
						{ id: "a", label: "One summary at 18:00", detail: "Fewer interruptions. Failures and questions still notify right away.", recommended: true },
						{ id: "b", label: "Each finished task", detail: "Same as today." },
						{ id: "c", label: "Only failures and questions", detail: "Finished work waits in Pilot until you look." },
					],
					evidence: [{ kind: "visual", label: "Notification chart" }, { kind: "file", label: "Audit notes" }],
				},
				{
					id: "q2", kind: "approval", mission: "native", asked: "6 min ago",
					effort: "Under a minute",
					title: "Open a test copy of Pilot on your Mac?",
					reason: "Approval: open an app",
					context: "The image zoom checks need a real window. Pilot would open a separate test copy with its own data, then close it.",
					boundary: "Opening apps on your Mac needs your approval.",
					options: [
						{ id: "a", label: "Allow for this check", detail: "Opens once, with test data only. Your Pilot keeps running.", recommended: true },
						{ id: "b", label: "Skip it", detail: "Uses synthetic checks only. How zoom feels stays unchecked." },
					],
					evidence: [{ kind: "checks", label: "Check plan" }],
				},
			];
			w.headline = "Three short things need you.";
			w.summary = "Quieter notifications needs a rule choice. The native app wants to open a test copy of Pilot. Search is still testing.";
			return w;
		}

		if (scn === "trouble") {
			w.time = "16:48"; w.lastLooked = "at 13:30";
			w.reviews[0].state = "waiting";
			const s = m("search");
			s.state = "failed"; s.updated = "22 min ago";
			s.phases[2].state = "failed"; s.tasks = { done: 7, review: 0, active: 0, blocked: 1, todo: 2 };
			s.taskList[2].state = "blocked"; s.now = "Stopped: 2 integration tests fail on Linux.";
			s.helpers = []; s.next = { who: "you", text: "Choose how to handle the failing tests." };
			s.attentionIds = ["f1"];
			s.activity.unshift({ when: "16:26", text: "Stopped: a fix would change the public search API." }, { when: "16:10", text: "Re-ran Linux tests. Same 2 failures." }, { when: "15:58", text: "2 of 148 integration tests failed on Linux." });
			const n = m("native");
			n.state = "unknown"; n.updated = "9 min ago";
			n.now = "Waiting to confirm a push before continuing.";
			n.next = { who: "you", text: "Check whether the image zoom push landed." };
			n.attentionIds = ["u1"]; n.helpers = [{ title: "Fold long user messages", step: "Writing tests", since: "40 min" }];
			n.activity.unshift({ when: "16:39", text: "Push of \"Image zoom and pan\" not confirmed. The remote did not answer." });
			const q = m("notify");
			q.state = "paused"; q.updated = "1 h ago"; q.now = "Paused: usage limit reached. Resumes at 18:00.";
			q.phases[1].state = "active"; q.tasks = { done: 3, review: 0, active: 1, blocked: 0, todo: 4 };
			q.next = { who: "pilot", text: "Resumes at 18:00 when the limit resets." };
			w.attention = [
				{
					id: "f1", kind: "failure", mission: "search", asked: "22 min ago",
					effort: "About 2 min",
					title: "2 integration tests fail on Linux",
					reason: "Failed: 2 of 148 tests",
					context: "Both failures started with the incremental index (7c1e04a). macOS passes.",
					tried: ["Re-ran the Linux tests once. Same 2 failures.", "Found the cause: results are ordered differently on Linux.", "A fix would change the public search API, so it stopped."],
					boundary: "Changing the public search API is outside the agreed scope.",
					options: [
						{ id: "a", label: "Allow the API change for this fix", detail: "Adds a stable sort option. Callers keep working.", recommended: true },
						{ id: "b", label: "Keep the API; sort inside the index", detail: "About 20 ms slower. No API change." },
						{ id: "c", label: "Pause the mission", detail: "Nothing changes until you resume it." },
					],
					evidence: [{ kind: "fail", label: "2 failing tests", bad: true }, { kind: "commit", label: "7c1e04a" }, { kind: "file", label: "Linux test output" }],
				},
				{
					id: "u1", kind: "unknown", mission: "native", asked: "9 min ago",
					effort: "Under a minute",
					title: "Push not confirmed",
					reason: "Unconfirmed: push of image zoom",
					context: "The remote did not answer after pushing \"Image zoom and pan\". Pilot does not know if it landed.",
					tried: ["Waited 35 seconds for an answer.", "Will not push again until it can confirm."],
					boundary: "Pushing twice could duplicate work, so Pilot waits.",
					options: [
						{ id: "check", label: "Check again", detail: "Reads the remote branch. Changes nothing.", recommended: true },
						{ id: "details", label: "Show what was pushed", detail: "Commit e93b1a0, 6 files." },
					],
					evidence: [{ kind: "commit", label: "e93b1a0", warn: true }],
				},
			];
			w.scheduled.unshift({ when: "17:30", text: "Check again whether the image zoom push landed", by: "pilot", mission: "native", why: "The remote did not answer. Checking only reads." });
			w.chats.push({ id: "m-notify", title: "Coordinator: Quieter notifications", project: "pilot", state: "paused", when: "1 h ago", mission: "notify" });
			w.headline = "One check failed. One push is unconfirmed.";
			w.summary = "Faster search stopped on 2 Linux test failures and needs a choice. The native app is waiting to confirm a push. Notifications paused until 18:00.";
			w.digest = [
				{ mission: "search", text: "Linux tests failed after the index change. macOS passed.", evidence: [{ kind: "fail", label: "2 failing tests", bad: true }] },
				{ mission: "native", text: "Image zoom and pan finished. Its push is not confirmed yet.", evidence: [{ kind: "commit", label: "e93b1a0", warn: true }] },
				{ mission: "notify", text: "Paused at the usage limit. Resumes at 18:00.", evidence: [] },
			];
			return w;
		}
		return w;
	}

	window.MockWorld = apply;
	window.MockSettings = ["Appearance", "Chats", "Models", "MCP connections", "Usage", "Automations", "Updates", "Diagnostics"];
})();
