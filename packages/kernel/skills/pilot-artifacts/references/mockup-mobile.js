// biome-ignore lint/correctness/noUnusedVariables: a visual function, published with String(visual).
function visual({ ui, state }) {
	// Two directions for a running coach's home screen, side by side on phone artboards.
	// Tap the tab bar inside either phone; the width slider resizes both artboards.
	const s = state({ tab: "home", width: 360 });
	const directions = [
		{
			key: "calm",
			name: "A · Calm",
			note: "Light, airy, one green accent",
			page: "#ffffff",
			ink: "#0f172a",
			soft: "#64748b",
			card: "#f1f5f9",
			line: "#e2e8f0",
			accent: "#10b981",
			track: "#d1fae5",
			hero: { from: "#ecfdf5", to: "#d1fae5", angle: 160 },
			heroInk: "#064e3b",
			font: "ui",
		},
		{
			key: "bold",
			name: "B · Bold",
			note: "Dark, high contrast, display type",
			page: "#0b0b0f",
			ink: "#fafafa",
			soft: "#a1a1aa",
			card: "#18181b",
			line: "#27272a",
			accent: "#f97316",
			track: "#3f1d0a",
			hero: { from: "#f97316", to: "#db2777", angle: 135 },
			heroInk: "#ffffff",
			font: "display",
		},
	];
	const week = [
		{ day: "Mon", km: 5.2, kind: "Easy run" },
		{ day: "Tue", km: 0, kind: "Rest" },
		{ day: "Wed", km: 8.0, kind: "Tempo" },
		{ day: "Thu", km: 4.1, kind: "Recovery" },
		{ day: "Sat", km: 12.5, kind: "Long run" },
	];
	const tabs = [
		{ id: "home", icon: "house", label: "Today" },
		{ id: "plan", icon: "calendar", label: "Plan" },
		{ id: "stats", icon: "chart-pie", label: "Stats" },
		{ id: "me", icon: "user", label: "Profile" },
	];

	const ring = (d, size, done) =>
		ui.vector({
			width: size,
			height: size,
			label: `${Math.round(done * 100)}% of the weekly goal`,
			draw: (g, box) => {
				const c = box.width / 2;
				g.arc(c, c, c - 2, 0, Math.PI * 2, { fill: d.track, inner: c - 14 });
				g.arc(c, c, c - 2, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * done, { fill: d.accent, inner: c - 14 });
				const end = -Math.PI / 2 + Math.PI * 2 * done;
				g.circle(c + (c - 8) * Math.cos(end), c + (c - 8) * Math.sin(end), 7, { fill: d.page });
				g.circle(c + (c - 8) * Math.cos(end), c + (c - 8) * Math.sin(end), 4, { fill: d.accent });
			},
		});

	const avatar = (d) =>
		ui.vector({
			width: 40,
			height: 40,
			label: "Maya's avatar",
			draw: (g) => {
				g.circle(20, 20, 20, { fill: d.accent });
				g.circle(20, 16, 7, { fill: d.page, opacity: 0.9 });
				g.path("M7 34a13 11 0 0 1 26 0z", { fill: d.page, opacity: 0.9 });
			},
		});

	const statusBar = (d) =>
		ui.row({ justify: "between", align: "center", padding: [14, 24, 6, 28], wrap: false }, [
			ui.text("9:41", { size: 15, weight: 600, color: d.ink }),
			ui.row({ gap: 6, align: "center", wrap: false }, [
				ui.vector({
					width: 18,
					height: 12,
					label: "Signal",
					draw: (g) => {
						for (const [i, h] of [3, 6, 9, 12].entries()) g.rect(i * 5, 12 - h, 3, h, { fill: d.ink, radius: 1 });
					},
				}),
				ui.icon("battery-full", { size: 20, color: d.ink }),
			]),
		]);

	const today = (d) => [
		ui.row({ justify: "between", align: "center", padding: [8, 0], wrap: false }, [
			ui.column({ gap: 2 }, [
				ui.text("Good morning", { size: 14, color: d.soft }),
				ui.text("Maya", { size: 28, weight: 700, font: d.font, lineHeight: 1.15 }),
			]),
			avatar(d),
		]),
		ui.column({ padding: 20, radius: 28, fill: d.hero, gap: 16, color: d.heroInk }, [
			ui.row({ gap: 18, align: "center", wrap: false }, [
				ui.column({ width: 120, height: 120 }, [
					ring(d, 120, 18.4 / 25),
					ui.column({ x: 0, y: 0, right: 0, bottom: 0, align: "center", justify: "center" }, [
						ui.text("18.4", { size: 30, weight: 800, font: d.font, lineHeight: 1 }),
						ui.text("of 25 km", { size: 12, weight: 500 }),
					]),
				]),
				ui.column({ gap: 6, grow: 1 }, [
					ui.text("Weekly goal", { size: 13, weight: 600 }),
					ui.text("6.6 km to go. One easy run gets you there.", { size: 15, lineHeight: 1.35 }),
				]),
			]),
		]),
		ui.grid({ columns: 3, gap: 10 }, [
			[
				["timer", "clock", "5:12", "avg pace"],
				["streak", "star", "12", "day streak"],
				["load", "heart", "Low", "fatigue"],
			].map(([key, icon, value, label]) =>
				ui.column({ key, padding: [12, 12], radius: 18, fill: d.card, gap: 6 }, [
					ui.icon(icon, { size: 18, color: d.accent }),
					ui.text(value, { size: 20, weight: 700, font: d.font }),
					ui.text(label, { size: 12, color: d.soft }),
				]),
			),
		]),
		ui.row({ padding: 16, radius: 20, border: d.line, gap: 14, align: "center", wrap: false }, [
			ui.column({ width: 44, height: 44, radius: 14, fill: d.card, align: "center", justify: "center" }, [
				ui.icon("play", { size: 20, color: d.accent }),
			]),
			ui.column({ grow: 1, gap: 2 }, [
				ui.text("Next: Easy run", { size: 16, weight: 600 }),
				ui.text("Tomorrow · 6.0 km · Zone 2", { size: 13, color: d.soft }),
			]),
			ui.column({ padding: [8, 14], radius: 999, fill: d.accent, color: d.page }, [
				ui.text("Start", { size: 14, weight: 700 }),
			]),
		]),
	];

	const plan = (d) => [
		ui.text("This week", { size: 28, weight: 700, font: d.font }),
		ui.column({ gap: 8 }, [
			week.map((w) =>
				ui.row(
					{
						key: w.day,
						padding: [12, 14],
						radius: 16,
						fill: w.km ? d.card : undefined,
						border: w.km ? undefined : d.line,
						gap: 12,
						align: "center",
						wrap: false,
					},
					[
						ui.text(w.day, { size: 13, weight: 700, color: d.soft, font: "mono" }),
						ui.column({ grow: 1 }, [ui.text(w.kind, { size: 15, weight: 600 })]),
						ui.column({ width: 70, height: 6, radius: 3, fill: d.line }, [
							ui.column({ width: Math.max(4, (w.km / 12.5) * 70), height: 6, radius: 3, fill: d.accent }, []),
						]),
						ui.text(w.km ? `${w.km.toFixed(1)} km` : "—", { size: 13, weight: 600, align: "end" }),
					],
				),
			),
		]),
	];

	const tabBar = (d) =>
		ui.row({ justify: "between", padding: [10, 18, 26, 18], border: d.line, wrap: false, fill: d.page }, [
			tabs.map((t) =>
				ui.column(
					{
						key: t.id,
						align: "center",
						gap: 4,
						padding: [6, 10],
						radius: 14,
						fill: s.tab === t.id ? d.card : undefined,
						onClick: () => (s.tab = t.id),
					},
					[
						ui.icon(t.icon, { size: 22, color: s.tab === t.id ? d.accent : d.soft }),
						ui.text(t.label, { size: 11, weight: 600, color: s.tab === t.id ? d.ink : d.soft }),
					],
				),
			),
		]);

	const phone = (d) =>
		ui.column({ key: d.key, gap: 10, align: "center" }, [
			ui.column(
				{
					width: s.width,
					height: 720,
					radius: 44,
					fill: d.page,
					color: d.ink,
					border: d.line,
					borderWidth: 6,
					shadow: { y: 18, blur: 40, color: "#0f172a33" },
					clip: true,
				},
				[
					statusBar(d),
					ui.column(
						{ grow: 1, gap: 16, padding: [8, 20], scroll: "y", height: "fill" },
						s.tab === "plan" ? plan(d) : today(d),
					),
					tabBar(d),
				],
			),
			ui.text(d.name, { size: "md", weight: 600 }),
			ui.text(d.note, { size: "sm", color: "muted" }),
		]);

	return () =>
		ui.column({ gap: 16 }, [
			ui.row({ justify: "between", align: "center" }, [
				ui.column({ gap: 2 }, [
					ui.text("Running coach · home screen", { size: "lg", weight: 600 }),
					ui.text("Two visual directions for the same content", { size: "sm", color: "muted" }),
				]),
				ui.slider({
					label: "Artboard",
					min: 320,
					max: 420,
					step: 10,
					value: s.width,
					unit: "pt",
					onChange: (v) => (s.width = v),
				}),
			]),
			ui.row({ gap: 28, justify: "center", align: "start" }, directions.map(phone)),
		]);
}
