use super::*;

#[test]
fn native_and_publication_share_typed_syntax_admission_corpus() {
    let cases: serde_json::Value = serde_json::from_str(include_str!(
        "../../../packages/protocol/fixtures/mermaid/syntax.json"
    ))
    .unwrap();
    for case in cases.as_array().unwrap() {
        let kind = match prepare(case["source"].as_str().unwrap()) {
            Ok(_) => "supported",
            Err(Bad::Invalid(_)) => "invalid",
            Err(Bad::Unsupported(_)) => "unsupported",
            Err(Bad::Limit(_)) => "limit",
        };
        assert_eq!(kind, case["kind"].as_str().unwrap(), "{}", case["name"]);
    }
}

#[test]
fn common_flowchart_corpus_preserves_every_label_edge_shape_and_direction() {
    for direction in ["TD", "TB", "LR", "BT", "RL"] {
        let source = format!(
            "%% ordinary comment\nflowchart {direction}\nA[Receive] --> B{{\"Valid?\"}};B -->|yes| C(\"Store\"); B -->|no| D[Reject]; C --- E[Done]; D --> E"
        );
        let graph = parse(&source).unwrap();
        assert_eq!(graph.nodes.len(), 5);
        assert_eq!(graph.edges.len(), 5);
        assert_eq!(graph.nodes[1].shape, Shape::Diamond);
        assert_eq!(graph.nodes[2].shape, Shape::Rounded);
        assert_eq!(graph.edges[1].label, "yes");
        assert!(!graph.edges[3].arrow);
        let plan = prepare(&source).unwrap();
        let a = &plan.nodes[0];
        let b = &plan.nodes[1];
        match direction {
            "LR" => assert!(b.x > a.x),
            "RL" => assert!(b.x < a.x),
            "BT" => assert!(b.y < a.y),
            _ => assert!(b.y > a.y),
        }
        assert_eq!(plan.routes.len(), 5);
        for route in &plan.routes {
            for p in &route.points {
                assert!(p[0] >= 0. && p[1] >= 0. && p[0] <= plan.width && p[1] <= plan.height);
            }
        }
    }
}
#[test]
fn no_partial_diagrams_or_inert_directives_silently_accepted() {
    for tail in [
        "click A href https://example.com",
        "style A fill:red",
        "classDef hot fill:red",
        "subgraph group",
        "end",
        "direction RL",
        "A --> B :::red",
        "A --> B missing",
        "A -.-> B",
        "A ==> B",
        "A & B --> C",
        "A <--> B",
        "A -->",
        "A[<b>HTML</b>]",
        "A[&amp;]",
        "A[`markdown`]",
        "A[bad\\ntext]",
        "A[\"unfinished]",
        "%%{init: {'theme':'dark'}}%%",
        "---\ntitle: Test",
        "A((circle))",
        "A@{shape:rect}",
    ] {
        assert!(
            prepare(&format!("flowchart TD\nA --> B\n{tail}")).is_err(),
            "{tail}"
        );
    }
    for header in [
        "sequenceDiagram",
        "pie",
        "flowchart",
        "flowchart XX",
        "flowchart-elk TD",
        "flowchart TD garbage",
    ] {
        assert!(prepare(&format!("{header}\nA --> B")).is_err());
    }
}
#[test]
fn malformed_conflicts_cycles_and_parallel_edges_fail_closed() {
    for source in [
        "",
        "flowchart TD",
        "graph TD\nA --> A",
        "graph TD\nA --> B --> A",
        "graph TD\nA --> B; A --> B",
        "graph TD\nA[one]; A[two]",
        "graph TD\nA[one]; A(one)",
        "graph TD\nA[]",
        "graph TD\nA[bad\u{202e}text]",
        "graph TD\nA[bad\0text]",
    ] {
        assert!(prepare(source).is_err(), "{source}");
    }
    let g = parse("graph TD\nA --> B; A[Later label]; A --> C").unwrap();
    assert_eq!(g.nodes[0].label, "Later label");
}
#[test]
fn unicode_graphemes_and_exact_source_are_not_normalized_or_executed() {
    let source = "  graph TD\r\n A[\"Café 👩🏽‍💻 中文\"] -->|\"Sí\"| B[Fine];\n";
    let p = Prepared::new(source);
    assert_eq!(p.source.as_ref(), source);
    let graph = p.diagram.unwrap();
    assert_eq!(graph.nodes[0].node.label, "Café 👩🏽‍💻 中文");
    assert_eq!(wrapped("é👩🏽‍💻界", 1, 3), "é\n👩🏽‍💻\n界");
    assert!(prepare(&format!("graph TD\nA[{}]", "界".repeat(49))).is_err());
    assert!(prepare(&format!("graph TD\nA{{{}}}", "界".repeat(17))).is_err());
    assert!(prepare(&format!("graph TD\nA -->|{}| B", "x".repeat(25))).is_err());
}
#[test]
fn labels_wrap_at_spaces_and_break_only_overlong_words_between_graphemes() {
    assert_eq!(wrapped("Receive 👩🏽‍💻 request", 15, 4), "Receive 👩🏽‍💻\nrequest");
    assert_eq!(wrapped("Is it valid now?", 8, 3), "Is it\nvalid\nnow?");
    assert_eq!(wrapped("yes, store it", 12, 2), "yes, store\nit");
    assert_eq!(wrapped("short", 15, 4), "short");
    // Unspaced words, combining marks and ZWJ emoji split between clusters.
    assert_eq!(
        wrapped("go supercalifragilisticexpialidocious", 15, 4),
        "go\nsupercalifragil\nisticexpialidoc\nious"
    );
    assert_eq!(
        wrapped("cafe\u{301}cafe\u{301}", 3, 4),
        "caf\ne\u{301}ca\nfe\u{301}"
    );
    assert_eq!(wrapped("日本語の長い説明", 4, 4), "日本語の\n長い説明");
    assert_eq!(wrapped("a 👩🏽‍💻👩🏽‍💻👩🏽‍💻", 2, 4), "a\n👩🏽‍💻👩🏽‍💻\n👩🏽‍💻");
    // A break drops one space; other spacing is kept.
    assert_eq!(wrapped("ab  cd", 4, 4), "ab \ncd");
    // When words would need too many lines, lines are filled instead; the
    // label limits always fit that.
    let label = "aaaaaaaa bbbbbbbb cccccccc dddddddd eeeeeeee";
    assert_eq!(
        wrapped(label, 15, 4),
        "aaaaaaaa bbbbbb\nbb cccccccc ddd\nddddd eeeeeeee"
    );
    for (text, columns, lines) in [
        ("界".repeat(48), 15, 4),
        ("ab ".repeat(16).trim().to_string(), 15, 4),
        ("界 ".repeat(8).trim().to_string(), 8, 3),
        ("x".repeat(24), 12, 2),
        ("a ".repeat(12).trim().to_string(), 12, 2),
    ] {
        let out = wrapped(&text, columns, lines);
        assert!(out.lines().count() <= lines, "{out}");
        assert!(
            out.lines().all(|l| l.graphemes(true).count() <= columns),
            "{out}"
        );
        assert_eq!(
            out.replace('\n', "").replace(' ', ""),
            text.replace(' ', "")
        );
    }
    let plan =
        prepare("graph TD\nA[Receive 👩🏽‍💻 request] -->|yes, store it| B{Is it valid now?}").unwrap();
    assert_eq!(plan.nodes[0].node.label, "Receive 👩🏽‍💻 request");
    assert_eq!(plan.nodes[0].text, "Receive 👩🏽‍💻\nrequest");
    assert_eq!(plan.nodes[1].text, "Is it\nvalid\nnow?");
    assert_eq!(plan.routes[0].edge.label, "yes, store it");
    assert_eq!(plan.routes[0].text, "yes, store\nit");
    assert_eq!(plan.routes[0].label_size, [10. * 160. / 12., 32.]);
}
#[test]
fn canvas_is_the_measured_extent_plus_one_margin_in_every_direction() {
    // Two nodes: no empty band beside them, either way round.
    let lr = prepare("graph LR\nA --> B").unwrap();
    assert_eq!((lr.width, lr.height), (584., MARGIN + NODE_H + MARGIN));
    let td = prepare("graph TD\nA --> B").unwrap();
    assert_eq!((td.width, td.height), (MARGIN + NODE_W + MARGIN, 272.));
    // A vertical edge label extends past the last column only by its own
    // reserved width: a short one stays beside its link.
    let labelled = prepare("graph TD\nA -->|go| B").unwrap();
    assert_eq!(labelled.width, MARGIN + NODE_W + MARGIN);
    let wide = prepare("graph TD\nA -->|a long enough label| B").unwrap();
    assert_eq!(
        wide.width,
        MARGIN + NODE_W / 2. + 8. + EDGE_LABEL_W + MARGIN
    );
    for d in ["TD", "BT", "LR", "RL"] {
        let p = prepare(&format!(
            "graph {d}\nA[Receive 👩🏽‍💻 request] -->|ok| B{{Is it valid now?}}\nB -->|yes, store it| C(Store)\nA --> D[Reject]; A --> C"
        ))
        .unwrap();
        let mut extent = [0f32; 2];
        let mut start = [f32::MAX; 2];
        for n in &p.nodes {
            extent = [extent[0].max(n.x + NODE_W), extent[1].max(n.y + NODE_H)];
            start = [start[0].min(n.x), start[1].min(n.y)];
        }
        for r in &p.routes {
            assert!(r.label_size[0] <= EDGE_LABEL_W && r.label_size[1] <= EDGE_LABEL_H);
            for q in &r.points {
                extent = [extent[0].max(q[0]), extent[1].max(q[1])];
            }
            if !r.text.is_empty() {
                let [x, y] = r.label_at;
                extent = [
                    extent[0].max(x + r.label_size[0]),
                    extent[1].max(y + r.label_size[1]),
                ];
                start = [start[0].min(x), start[1].min(y)];
            }
        }
        assert_eq!(
            [p.width, p.height],
            [extent[0] + MARGIN, extent[1] + MARGIN],
            "{d}"
        );
        assert_eq!(start, [MARGIN, MARGIN], "{d}");
    }
}
#[test]
fn source_graph_depth_slots_and_work_are_capped_before_expansion() {
    let full = (1..48)
        .map(|i| format!("N{} --> N{i}", (i - 1) / 2))
        .collect::<Vec<_>>()
        .join("\n");
    let full = prepare(&format!("graph TD\n{full}")).unwrap();
    assert_eq!(full.nodes.len(), 48);
    assert_eq!(full.routes.len(), 47);
    assert!(prepare(&"a".repeat(MAX_SOURCE + 1)).is_err());
    assert!(
        prepare(&format!(
            "graph TD\n{}",
            (0..49)
                .map(|i| format!("N{i}"))
                .collect::<Vec<_>>()
                .join("\n")
        ))
        .is_err()
    );
    assert!(
        prepare(&format!(
            "graph TD\n{}",
            (0..25)
                .map(|i| format!("N{i}"))
                .collect::<Vec<_>>()
                .join(" --> ")
        ))
        .is_err()
    );
    assert!(prepare(&format!("graph TD\n{}", "%% comment\n".repeat(193))).is_err());
    let dense = (0..15)
        .flat_map(|i| (i + 1..15).map(move |j| format!("N{i} --> N{j}")))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(prepare(&format!("graph TD\n{dense}")).is_err());
    let p = prepare(&format!(
        "graph TD\n{}",
        (0..24)
            .map(|i| format!("N{i}"))
            .collect::<Vec<_>>()
            .join(" --> ")
    ))
    .unwrap();
    assert!(p.height <= 8192. && p.width * p.height <= 16_777_216.);
}
#[test]
fn long_links_have_reserved_empty_slots_and_no_node_body_intersections() {
    for d in ["TD", "BT", "LR", "RL"] {
        let p = prepare(&format!("graph {d}\nA --> B --> C --> D; A --> D; A --> C")).unwrap();
        assert_eq!(p.routes.len(), 5);
        for r in &p.routes {
            for segment in r.points.windows(2) {
                let (a, b) = (segment[0], segment[1]);
                for (ix, n) in p.nodes.iter().enumerate() {
                    if ix == r.edge.from || ix == r.edge.to {
                        continue;
                    }
                    let crosses = if a[0] == b[0] {
                        a[0] > n.x
                            && a[0] < n.x + NODE_W
                            && a[1].min(b[1]) < n.y + NODE_H
                            && a[1].max(b[1]) > n.y
                    } else {
                        a[1] > n.y
                            && a[1] < n.y + NODE_H
                            && a[0].min(b[0]) < n.x + NODE_W
                            && a[0].max(b[0]) > n.x
                    };
                    assert!(
                        !crosses,
                        "{d} edge {} -> {} crosses {}",
                        r.edge.from, r.edge.to, n.node.id
                    );
                }
            }
        }
    }
}
#[test]
fn scene_keeps_unsupported_diagram_local_and_siblings_intact() {
    let scene = crate::visual_scene::Scene::parse(serde_json::json!({"api":1,"root":{"type":"column","children":[{"type":"mermaid","source":"sequenceDiagram\nA->>B: hello"},{"type":"toggle","id":"0.1","label":"Keep me","value":true},{"type":"mermaid","source":"graph TD\nA --> B"}]}})).unwrap();
    assert!(scene.mermaids["0.0"].diagram.is_err());
    assert!(scene.mermaids["0.2"].diagram.is_ok());
    assert!(scene.controls.contains_key("0.1"));
    let source = "graph TD\nA --> B";
    let children: Vec<_> = (0..12)
        .map(|_| serde_json::json!({"type":"mermaid","source":source}))
        .collect();
    let scene = crate::visual_scene::Scene::parse(
        serde_json::json!({"api":1,"root":{"type":"column","children":children}}),
    )
    .unwrap();
    assert_eq!(scene.mermaids.len(), 8);
}

#[test]
fn edge_labels_stay_in_reserved_gaps_and_in_canvas_in_all_directions() {
    for d in ["TD", "BT", "LR", "RL"] {
        let p = prepare(&format!(
            "graph {d}\nA -->|a long enough edge label| B; A -->|second| C; B --> D; C --> D"
        ))
        .unwrap();
        for r in &p.routes {
            if r.edge.label.is_empty() {
                continue;
            }
            let [x, y] = r.label_at;
            assert!(
                x >= 0. && y >= 0. && x + 160. <= p.width && y + 32. <= p.height,
                "{d}"
            );
            for n in &p.nodes {
                assert!(
                    !(x < n.x + NODE_W && x + 160. > n.x && y < n.y + NODE_H && y + 32. > n.y),
                    "{d} label overlaps {}",
                    n.node.id
                );
            }
        }
    }
}
