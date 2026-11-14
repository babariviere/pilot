// biome-ignore lint/correctness/noUnusedVariables: a stored visual function, read as text by its checks.
function visual({ ui, state }) {
	// A desktop release dashboard in a macOS-style window. The toggle switches the
	// window's palette, the slider sets its width (below 720 pt the sidebar collapses
	// to icons), and sidebar items and release rows are pressable. The window keeps its
	// width and scrolls sideways in a narrower reader instead of squeezing its text.
	const s = state({ dark: false, width: 980, section: "releases", open: "2.4.0" });
	const palettes = {
		light: {
			window: "#ffffff",
			chrome: "#f6f7f9",
			side: "#f3f4f6",
			ink: "#111827",
			soft: "#6b7280",
			line: "#e5e7eb",
			hover: "#e8eaee",
			card: "#ffffff",
			accent: "#4f46e5",
			accentSoft: "#eef2ff",
		},
		dark: {
			window: "#16171b",
			chrome: "#1d1f24",
			side: "#1a1c20",
			ink: "#f3f4f6",
			soft: "#9ca3af",
			line: "#2d3039",
			hover: "#262932",
			card: "#1f2127",
			accent: "#818cf8",
			accentSoft: "#272a4a",
		},
	};
	const status = {
		live: { label: "Live", fill: "#dcfce7", ink: "#166534" },
		rolling: { label: "Rolling out", fill: "#fef3c7", ink: "#92400e" },
		failed: { label: "Failed checks", fill: "#fee2e2", ink: "#991b1b" },
		draft: { label: "Draft", fill: "#e5e7eb", ink: "#374151" },
	};
	const releases = [
		{
			version: "2.4.0",
			name: "Offline sync",
			status: "rolling",
			progress: 0.62,
			owner: "AL",
			hue: "#f59e0b",
			when: "Today 09:12",
		},
		{
			version: "2.3.2",
			name: "Crash fix for iPad",
			status: "live",
			progress: 1,
			owner: "JM",
			hue: "#10b981",
			when: "Yesterday",
		},
		{
			version: "2.3.1",
			name: "Billing retry",
			status: "failed",
			progress: 0.18,
			owner: "SK",
			hue: "#ef4444",
			when: "Oct 29",
		},
		{
			version: "2.5.0",
			name: "New onboarding",
			status: "draft",
			progress: 0,
			owner: "RB",
			hue: "#6366f1",
			when: "Planned",
		},
	];
	const kpis = [
		{
			key: "crash",
			label: "Crash-free sessions",
			value: "99.82%",
			delta: "+0.14",
			good: true,
			points: [3, 4, 3.5, 5, 4.8, 6, 6.4, 7],
		},
		{
			key: "adoption",
			label: "2.4.0 adoption",
			value: "41%",
			delta: "+18",
			good: true,
			points: [0, 1, 2, 4, 7, 9, 12, 15],
		},
		{
			key: "p95",
			label: "Cold start p95",
			value: "1.34 s",
			delta: "+0.09",
			good: false,
			points: [5, 5.2, 4.9, 5.3, 5.8, 5.6, 6.1, 6.3],
		},
	];
	const nav = [
		{ id: "overview", icon: "layout-dashboard", label: "Overview" },
		{ id: "releases", icon: "git-branch", label: "Releases" },
		{ id: "issues", icon: "circle-alert", label: "Issues" },
		{ id: "users", icon: "user", label: "Audience" },
		{ id: "settings", icon: "settings", label: "Settings" },
	];

	const spark = (points, good) =>
		ui.vector({
			width: 96,
			height: 32,
			label: "Trend",
			draw: (g) => {
				const max = Math.max(...points);
				const min = Math.min(...points);
				const xy = points.map((v, i) => [
					(i / (points.length - 1)) * 94 + 1,
					30 - ((v - min) / (max - min || 1)) * 26,
				]);
				g.path([...xy, [95, 32], [1, 32]], { fill: good ? "#22c55e" : "#f97316", opacity: 0.15, close: true });
				g.path(xy, { stroke: good ? "#16a34a" : "#ea580c", width: 2 });
				g.circle(xy[xy.length - 1][0], xy[xy.length - 1][1], 2.5, { fill: good ? "#16a34a" : "#ea580c" });
			},
		});

	const avatar = (initials, hue) =>
		ui.column(
			{ width: 26, height: 26, radius: 13, fill: hue, align: "center", justify: "center", color: "#ffffff" },
			[ui.text(initials, { size: 10, weight: 700 })],
		);

	const pill = (kind) =>
		ui.row(
			{
				padding: [3, 9],
				radius: 999,
				fill: status[kind].fill,
				color: status[kind].ink,
				gap: 5,
				align: "center",
				wrap: false,
			},
			[
				ui.vector({ width: 6, height: 6, draw: (g) => g.circle(3, 3, 3, { fill: status[kind].ink }) }),
				ui.text(status[kind].label, { size: 11, weight: 600 }),
			],
		);

	const window = (p, compact) =>
		ui.column(
			{
				width: s.width,
				radius: 12,
				fill: p.window,
				color: p.ink,
				border: p.line,
				shadow: { y: 24, blur: 60, spread: -12, color: "#0f172a40" },
				clip: true,
				gap: 0,
			},
			[
				// Title bar with traffic lights.
				ui.row({ height: 40, padding: [0, 14], align: "center", fill: p.chrome, wrap: false, gap: 12 }, [
					ui.vector({
						width: 52,
						height: 12,
						label: "Window controls",
						draw: (g) => {
							for (const [i, c] of ["#ff5f57", "#febc2e", "#28c840"].entries())
								g.circle(6 + i * 20, 6, 6, { fill: c });
						},
					}),
					ui.row({ grow: 1, justify: "center", wrap: false }, [
						ui.text("Lighthouse — Releases", { size: 13, weight: 600, color: p.soft }),
					]),
					ui.icon("panel-right", { size: 16, color: p.soft }),
				]),
				// The body's fill shows below the shorter sidebar; the content column paints the window.
				ui.row({ wrap: false, align: "start", fill: p.side }, [
					// Sidebar.
					ui.column({ width: compact ? 60 : 210, minHeight: 470, fill: p.side, padding: [14, 10], gap: 4 }, [
						ui.row({ gap: 10, align: "center", padding: [4, 6, 14, 6], wrap: false }, [
							ui.vector({
								width: 28,
								height: 28,
								label: "Lighthouse logo",
								draw: (g) => {
									g.rect(0, 0, 28, 28, { fill: p.accent, radius: 8 });
									g.path("M14 5l6 18h-12z M14 11l-3 9h6z", { fill: "#ffffff" });
								},
							}),
							!compact &&
								ui.column({ gap: 0 }, [
									ui.text("Lighthouse", { size: 14, weight: 700 }),
									ui.text("iOS · Production", { size: 11, color: p.soft }),
								]),
						]),
						nav.map((n) =>
							ui.row(
								{
									key: n.id,
									gap: 10,
									align: "center",
									padding: [7, 8],
									radius: 8,
									wrap: false,
									fill: s.section === n.id ? p.hover : undefined,
									onClick: () => (s.section = n.id),
								},
								[
									ui.icon(n.icon, { size: 17, color: s.section === n.id ? p.accent : p.soft }),
									!compact && ui.text(n.label, { size: 13, weight: s.section === n.id ? 600 : 500 }),
								],
							),
						),
					]),
					// Content.
					ui.column({ grow: 1, padding: [20, 24], gap: 18, minWidth: 0, fill: p.window }, [
						ui.row({ gap: 12, align: "center", wrap: false }, [
							ui.column({ grow: 1, gap: 2 }, [
								ui.text("Releases", { size: 26, weight: 700, font: "display", lineHeight: 1.2 }),
								ui.text("4 versions · 1 rolling out", { size: 13, color: p.soft }),
							]),
							!compact &&
								ui.row(
									{
										width: 200,
										padding: [7, 10],
										radius: 8,
										border: p.line,
										gap: 8,
										align: "center",
										wrap: false,
									},
									[
										ui.icon("search", { size: 15, color: p.soft }),
										ui.text("Search releases", { size: 13, color: p.soft }),
										ui.space(),
										ui.text("⌘K", { size: 11, weight: 600, color: p.soft, font: "mono" }),
									],
								),
							ui.row(
								{
									padding: [8, 14],
									radius: 8,
									fill: p.accent,
									color: "#ffffff",
									gap: 6,
									align: "center",
									wrap: false,
									shadow: "sm",
									onClick: () => (s.open = "2.5.0"),
								},
								[ui.icon("plus", { size: 15 }), ui.text("New release", { size: 13, weight: 600 })],
							),
						]),
						ui.column(
							{
								padding: [14, 18],
								radius: 12,
								fill: { from: "#4f46e5", to: "#0ea5e9", angle: 100 },
								color: "#ffffff",
								gap: 4,
							},
							[
								ui.row({ gap: 8, align: "center", wrap: false }, [
									ui.icon("loader-circle", { size: 16 }),
									ui.text("2.4.0 is rolling out to 41% of users", { size: 14, weight: 600 }),
								]),
								ui.row({ height: 6, radius: 3, fill: "#ffffff40", clip: true, wrap: false }, [
									ui.column({ grow: 41, height: 6, radius: 3, fill: "#ffffff" }, []),
									ui.column({ grow: 59 }, []),
								]),
							],
						),
						ui.grid({ columns: compact ? 1 : 3, gap: 12 }, [
							kpis.map((k) =>
								ui.column({ key: k.key, padding: 14, radius: 12, border: p.line, fill: p.card, gap: 8 }, [
									ui.text(k.label, { size: 12, weight: 500, color: p.soft }),
									ui.row({ justify: "between", align: "end", wrap: false }, [
										ui.column({ gap: 2 }, [
											ui.text(k.value, { size: 24, weight: 700, font: "display" }),
											ui.text(`${k.delta}${k.key === "adoption" ? " pts" : ""}`, {
												size: 12,
												weight: 600,
												color: k.good ? "#16a34a" : "#ea580c",
											}),
										]),
										spark(k.points, k.good),
									]),
								]),
							),
						]),
						ui.column({ radius: 12, border: p.line, clip: true, gap: 0 }, [
							ui.row({ padding: [8, 14], fill: p.chrome, gap: 12, wrap: false }, [
								ui.text("VERSION", { size: 11, weight: 600, color: p.soft }),
								ui.space(),
								ui.text("STATUS", { size: 11, weight: 600, color: p.soft }),
							]),
							releases.map((r) => [
								ui.column({ key: `${r.version}-line`, height: 1, fill: p.line }, []),
								ui.row(
									{
										key: r.version,
										padding: [10, 14],
										gap: 12,
										align: "center",
										wrap: false,
										fill: s.open === r.version ? p.accentSoft : undefined,
										onClick: () => (s.open = r.version),
									},
									[
										ui.text(r.version, { size: 13, weight: 600, font: "mono" }),
										ui.column({ grow: 1, gap: 1 }, [
											ui.text(r.name, { size: 13, weight: 600, lines: 1 }),
											s.open === r.version &&
												ui.text(`${r.when} · ${Math.round(r.progress * 100)}% of users`, {
													size: 12,
													color: p.soft,
												}),
										]),
										!compact && avatar(r.owner, r.hue),
										pill(r.status),
									],
								),
							]),
						]),
					]),
				]),
			],
		);

	return () => {
		const p = s.dark ? palettes.dark : palettes.light;
		return ui.column({ gap: 14 }, [
			ui.row({ gap: 20, align: "center", justify: "between" }, [
				ui.column({ gap: 2 }, [
					ui.text("Release dashboard · desktop", { size: "lg", weight: 600 }),
					ui.text(`Window at ${s.width} pt${s.width < 720 ? ", compact sidebar" : ""}`, {
						size: "sm",
						color: "muted",
					}),
				]),
				ui.row({ gap: 16, align: "center" }, [
					ui.toggle({ label: "Dark window", value: s.dark, onChange: (v) => (s.dark = v) }),
					ui.slider({
						label: "Width",
						min: 560,
						max: 1100,
						step: 20,
						value: s.width,
						unit: "pt",
						onChange: (v) => (s.width = v),
					}),
				]),
			]),
			// Room for the window's shadow inside the scrolling strip.
			ui.row({ scroll: "x", wrap: false, padding: [0, 48, 72, 0] }, [window(p, s.width < 720)]),
		]);
	};
}
