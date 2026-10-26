use super::*;
use serde_json::json;
fn full(rows: Value) -> Value {
    json!({"type":"sessions", "sessions":rows})
}
#[test]
fn metadata_is_bounded_atomic_and_not_guessed_from_titles() {
    let mut m = Arc::new(Metadata::default());
    assert_eq!(m.link("A"), &Link::Unknown);
    Metadata::accept(
        &mut m,
        &full(json!([
            {"id":"A","projectId":"P","missionId":"M","title":"Same"},
            {"id":"B","title":"Same"}, {"id":"C","missionId":"bad/id"}
        ])),
    );
    assert_eq!(
        m.link("A"),
        &Link::Mission {
            project: "P".into(),
            mission: "M".into()
        }
    );
    assert_eq!(m.link("B"), &Link::Unlinked);
    assert_eq!(m.link("C"), &Link::Malformed);
    let before = m.clone();
    Metadata::accept(
        &mut m,
        &json!({"type":"session","session":{"id":"B","projectId":"Q","missionId":"M"}}),
    );
    assert_eq!(m.link("A"), before.link("A"));
    assert_eq!(
        m.link("B"),
        &Link::Mission {
            project: "Q".into(),
            mission: "M".into()
        }
    );
    Metadata::accept(&mut m, &full(json!([])));
    assert_eq!(
        m.link("A"),
        &Link::Unknown,
        "full snapshot clears stale links"
    );
    for invalid in [
        json!(null),
        json!([{"id":"A"},{"id":"A"}]),
        json!([{"id":"bad/id"}]),
        json!(vec![json!({"id":"A"}); crate::local_model::SESSION_CAP + 1]),
    ] {
        Metadata::accept(&mut m, &full(invalid));
        assert_eq!(m.link("A"), &Link::Malformed);
    }
}
#[test]
fn metadata_cap_and_structural_sharing_preserve_unrelated_partial_rows() {
    let mut m = Arc::new(Metadata::default());
    Metadata::accept(
        &mut m,
        &full(json!(
            (0..crate::local_model::SESSION_CAP)
                .map(|n| json!({"id":format!("c{n}")}))
                .collect::<Vec<_>>()
        )),
    );
    let before = m.clone();
    Metadata::accept(
        &mut m,
        &json!({"type":"session","session":{"id":"overflow","missionId":"M","projectId":"P"}}),
    );
    assert!(Arc::ptr_eq(&m, &before));
    Metadata::accept(
        &mut m,
        &json!({"type":"session","session":{"id":"c1","missionId":"M","projectId":"P"}}),
    );
    assert_eq!(m.rows.len(), crate::local_model::SESSION_CAP);
    assert_eq!(m.link("c0"), &Link::Unlinked);
    let before = m.clone();
    Metadata::accept(
        &mut m,
        &json!({"type":"session","session":{"id":"c1","missionId":"M","projectId":"P","title":"changed only"}}),
    );
    assert!(Arc::ptr_eq(&m, &before));
    Metadata::accept(
        &mut m,
        &json!({"type":"session","session":{"id":"c1","missionId":false,"projectId":"P"}}),
    );
    assert_eq!(m.link("c1"), &Link::Malformed);
    assert_eq!(m.link("c0"), &Link::Unlinked);
}
#[test]
fn exact_home_project_and_case_are_required_for_catalog_qualification() {
    let f = crate::mission_browser_fixture::catalog();
    let c = crate::mission_browser::catalog(&f).unwrap();
    let mut s = Source {
        home: crate::mission_browser_fixture::key("mission-A").home,
        chat: "chat-A".into(),
        project: "project-A".into(),
        mission: "mission-A".into(),
        selection: 1,
    };
    assert!(s.canonical(&c));
    let mut truncated = f.clone();
    truncated["logicalMissions"] = json!([]);
    truncated["truncated"] = json!(true);
    assert!(
        !s.canonical(&crate::mission_browser::catalog(&truncated).unwrap()),
        "truncated absence is not identity evidence"
    );
    s.mission = "mission-a".into();
    assert!(!s.canonical(&c));
    s.mission = "mission-A".into();
    s.project = "project-B".into();
    assert!(!s.canonical(&c));
    s.project = "project-A".into();
    s.home.daemon = "other".into();
    assert!(!s.canonical(&c));
}
#[test]
fn responsive_bounds_reserve_readable_chat_and_bounded_lower_dock() {
    for (w, h) in [(680., 840.), (680., 520.), (1100., 840.), (1100., 520.)] {
        let content = w - 232.;
        let (side, extent) = placement(content, h);
        if side {
            assert!((280. ..=320.).contains(&extent));
            assert!(content - extent >= 420.);
        } else {
            assert!(extent <= h / 3. && extent <= 240.);
            assert!(h - extent >= 360.);
        }
    }
}
