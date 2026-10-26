use super::*;
#[test]
fn chat_actions_inspection_started_before_ack_cannot_release_its_editor_fence() {
    let options = LocalOptions::synthetic(1);
    let raw = crate::chat_actions_fixture::source();
    let target = Target::new(&options, crate::local_model::chat(&raw).unwrap());
    let evidence = Evidence::read(&target, &raw, true).unwrap();
    let mut actions = Actions {
        renames: Default::default(),
        latest_rename: None,
        rename_observers: Default::default(),
        options: Some(options),
        worker: None,
        reports: BTreeMap::from([(
            "source".into(),
            Report {
                id: 1,
                evidence: evidence.clone(),
                outcome: None,
                observed_current: false,
            },
        )]),
        latest: None,
        error: None,
        next: 1,
    };
    // The read was admitted before the mutation's ACK. Its completion is delayed
    // in the UI queue until after that ACK arrives.
    let admitted = actions.inspection_ack("source");
    assert_eq!(admitted, None);
    actions
        .reports
        .get_mut("source")
        .unwrap()
        .finish(1, &evidence, Outcome::Acknowledged);
    actions.inspected(&evidence, admitted);
    assert!(
        actions.read_only("source"),
        "pre-ACK read cannot release the acknowledged archive fence"
    );
    assert!(actions.reports["source"].outcome == Some(Outcome::Acknowledged));
    let acknowledged = actions.inspection_ack("source");
    assert_eq!(acknowledged, Some(1));
    actions.inspected(&evidence, Some(0));
    assert!(actions.read_only("source"));
    let mut foreign = evidence.clone();
    foreign.target.home.lineage = "different".into();
    actions.inspected(&foreign, acknowledged);
    assert!(actions.read_only("source"));
    actions.inspected(&evidence, acknowledged);
    assert!(!actions.read_only("source"));
    let report = actions.reports.get_mut("source").unwrap();
    report.id = 2;
    report.outcome = Some(Outcome::Unknown);
    report.observed_current = false;
    actions.inspected(&evidence, acknowledged);
    assert!(actions.read_only("source"));
    assert!(actions.reports["source"].outcome == Some(Outcome::Unknown));
    assert_eq!(actions.inspection_ack("source"), None);
}
