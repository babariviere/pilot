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
    assert_eq!(wrapped("é👩🏽‍💻界", 1), "é\n👩🏽‍💻\n界");
    assert!(prepare(&format!("graph TD\nA[{}]", "界".repeat(49))).is_err());
    assert!(prepare(&format!("graph TD\nA{{{}}}", "界".repeat(17))).is_err());
    assert!(prepare(&format!("graph TD\nA -->|{}| B", "x".repeat(25))).is_err());
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
