use super::*;
use serde_json::json;

fn phases() -> Value {
    // Out of order on the wire; order then ID decides.
    json!([
        {"id":"p-release","missionId":"m","name":"Release","order":3},
        {"id":"p-build","missionId":"m","name":"Build 日本語","order":1},
        {"id":"p-polish","missionId":"m","name":"Polish","order":2},
        {"id":"p-empty","missionId":"m","name":"Empty","order":4}
    ])
}
#[test]
fn first_class_phases_order_by_order_then_id_and_count_without_dropped() {
    let index = Index::new(&phases(), std::iter::empty()).unwrap();
    let build = index.of(Some("p-build"), None);
    let polish = index.of(Some("p-polish"), Some("Build 日本語"));
    let release = index.of(Some("p-release"), None);
    assert_eq!((build, polish, release), (Some(0), Some(1), Some(2)));
    // An unknown phase is no phase; a milestone never stands in for an ID.
    assert_eq!(index.of(Some("p-gone"), None), None);
    assert_eq!(index.of(None, Some("Build 日本語")), None);
    let tasks = [
        (build, "done"),
        (build, "done"),
        (build, "dropped"),
        (polish, "in_progress"),
        (polish, "done"),
        (release, "todo"),
        (None, "in_review"),
    ];
    let g = index.groups(&tasks);
    let names: Vec<_> = g.iter().map(|g| g.name.as_str()).collect();
    assert_eq!(
        names,
        ["Build 日本語", "Polish", "Release", "Empty", "No phase"]
    );
    assert_eq!((g[0].done, g[0].total, g[0].dropped), (2, 2, 1));
    assert_eq!(g[0].progress(), "2/2 done");
    assert_eq!(g[0].tasks, [0, 1, 2]);
    // The first phase with unfinished work is current; only one is.
    assert_eq!(
        g.iter().map(|g| g.current).collect::<Vec<_>>(),
        [false, true, false, false, false]
    );
    assert_eq!(g[1].counts, [("done", 1), ("in_progress", 1)]);
    assert_eq!(g[3].progress(), "No tasks");
    assert_eq!(g[4].phase, None);
    assert_eq!(g[4].counts, [("in_review", 1)]);
    // Every task lands in exactly one group.
    let mut all: Vec<_> = g.iter().flat_map(|g| g.tasks.clone()).collect();
    all.sort();
    assert_eq!(all, (0..tasks.len()).collect::<Vec<_>>());
}
#[test]
fn no_phases_is_flat_and_unphased_tasks_never_invent_one() {
    let index = Index::new(&json!([]), std::iter::empty()).unwrap();
    assert!(index.groups(&[(None, "todo"), (None, "done")]).is_empty());
    assert!(index.groups(&[]).is_empty());
    // Phases exist but nothing is in them: they still show, with No phase last.
    let index = Index::new(&phases(), std::iter::empty()).unwrap();
    let g = index.groups(&[(None, "todo")]);
    assert_eq!(g.len(), 5);
    assert!(g.iter().all(|g| !g.current), "no phase has unfinished work");
}
#[test]
fn all_dropped_phase_reads_dropped_not_done() {
    let index = Index::new(&phases(), std::iter::empty()).unwrap();
    let g = index.groups(&[(Some(0), "dropped"), (None, "dropped")]);
    assert_eq!((g[0].total, g[0].dropped), (0, 1));
    assert_eq!(g[0].progress(), "1 dropped");
    assert!(!g[0].current);
    // Dropped unphased tasks stay listed under No phase.
    assert_eq!(g.last().unwrap().tasks, [1]);
}
#[test]
fn older_daemon_milestones_stand_in_by_first_appearance() {
    let ms = [
        Some(" Polish "),
        None,
        Some("Build"),
        Some(""),
        Some("Polish"),
    ];
    let index = Index::new(&Value::Null, ms.iter().copied()).unwrap();
    assert_eq!(index.of(None, Some("Polish")), Some(0));
    assert_eq!(index.of(Some("Polish"), Some("Build")), Some(1));
    assert_eq!(index.of(None, Some("  ")), None);
    let tasks: Vec<_> = ms.iter().map(|m| (index.of(None, *m), "todo")).collect();
    let g = index.groups(&tasks);
    assert_eq!(
        g.iter().map(|g| g.name.as_str()).collect::<Vec<_>>(),
        ["Polish", "Build", "No phase"]
    );
    // Stand-ins with only dropped tasks don't make phases; the list is flat.
    assert!(
        index
            .groups(&[(Some(0), "dropped"), (None, "todo")])
            .is_empty()
    );
}
#[test]
fn malformed_phases_are_refused_not_guessed() {
    for bad in [
        json!({}),
        json!([{"id":"p","name":"A"}]),
        json!([{"id":"bad/id","name":"A","order":1}]),
        json!([{"id":"p","order":1}]),
        json!([{"id":"p","name":"A","order":1},{"id":"p","name":"B","order":2}]),
    ] {
        assert!(Index::new(&bad, std::iter::empty()).is_err(), "{bad}");
    }
}
