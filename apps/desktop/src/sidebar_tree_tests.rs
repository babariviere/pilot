use super::*;
use crate::local_model::chat;
use serde_json::{Value, json};

fn c(v: Value) -> Chat {
    chat(&v).unwrap()
}
fn coord(id: &str, mission: &str, created: f64) -> Value {
    json!({"id":id,"title":id,"missionCoordinator":true,"missionId":mission,"createdAt":created,"state":"idle"})
}
fn member(id: &str, mission: &str, created: f64) -> Value {
    json!({"id":id,"title":id,"missionId":mission,"createdAt":created,"state":"idle"})
}
fn plain(id: &str, created: f64) -> Value {
    json!({"id":id,"title":id,"createdAt":created,"state":"idle"})
}

struct Fixture {
    chats: Vec<Chat>,
    memory: Memory,
    collapsed: HashSet<String>,
    show_finished: HashSet<String>,
    opened: Option<String>,
    query: String,
    archived: bool,
    grouped: bool,
}
impl Fixture {
    fn new(values: Vec<Value>) -> Self {
        let chats: Vec<Chat> = values.into_iter().map(c).collect();
        let mut memory = Memory::ephemeral(0.);
        memory.observe(&chats);
        Self {
            chats,
            memory,
            collapsed: HashSet::new(),
            show_finished: HashSet::new(),
            opened: None,
            query: String::new(),
            archived: false,
            grouped: false,
        }
    }
    fn tree(&self) -> Tree {
        let archived = self.archived;
        build(&Input {
            chats: &self.chats,
            keep: &move |c: &Chat| archived || !c.archived,
            query: &self.query,
            grouped: self.grouped,
            collapsed: &self.collapsed,
            show_finished: &self.show_finished,
            opened: self.opened.as_deref(),
            memory: &self.memory,
        })
    }
    /// Rows as readable labels: chat ids, "> mission" parents, "  member", "+N".
    fn rows(&self) -> Vec<String> {
        let tree = self.tree();
        tree.rows
            .iter()
            .map(|row| match *row {
                Row::Chat(ix) => self.chats[ix].id.clone(),
                Row::Parent(_) => format!("> {}", tree.key(*row, &self.chats)),
                Row::Member { chat, .. } => format!("  {}", self.chats[chat].id),
                Row::Fold(t) => {
                    let thread = &tree.threads[t];
                    if thread.show_finished {
                        "  hide".to_owned()
                    } else {
                        format!("  +{}", thread.finished)
                    }
                }
                Row::Group(g) => format!("# {}", tree.groups[g].key),
            })
            .collect()
    }
    fn set(&mut self, value: Value) {
        let chat = c(value);
        let ix = self.chats.iter().position(|c| c.id == chat.id).unwrap();
        self.chats[ix] = chat;
        self.memory.observe(&self.chats);
    }
}

#[test]
fn missions_nest_one_level_under_their_coordinator_in_your_order() {
    let mut f = Fixture::new(vec![
        plain("solo-old", 1.),
        coord("coord", "m", 10.),
        member("m-b", "m", 12.),
        member("m-a", "m", 11.),
        plain("solo-new", 30.),
        // A member without a loaded coordinator still threads under its mission.
        member("orphan", "gone", 20.),
    ]);
    f.set(json!({"id":"m-a","title":"m-a","missionId":"m","createdAt":11,"state":"working"}));
    f.set(json!({"id":"m-b","title":"m-b","missionId":"m","createdAt":12,"state":"failed"}));
    f.set(
        json!({"id":"orphan","title":"orphan","missionId":"gone","createdAt":20,"state":"working"}),
    );
    assert_eq!(
        f.rows(),
        [
            "solo-new",
            "> mission:gone",
            "  orphan",
            "> coord",
            "  m-a",
            "  m-b",
            "solo-old"
        ]
    );
    let tree = f.tree();
    let parent = tree.threads.iter().find(|t| t.mission == "m").unwrap();
    assert_eq!(parent.rollup.working, 1);
    assert_eq!(parent.rollup.failed, 1);
    assert_eq!(tree.bounds[Section::Chats as usize], 0);
}

#[test]
fn usage_paused_members_remain_unfinished_and_roll_up_until_release() {
    let mut held = member("held", "m", 2.);
    held["subscriptionPause"] = json!({"windows":[]});
    let mut solo = plain("solo", 5.);
    solo["subscriptionPause"] = json!({"windows":[]});
    let mut f = Fixture::new(vec![
        coord("coord", "m", 1.),
        held.clone(),
        member("done", "m", 3.),
        solo,
    ]);
    assert_eq!(f.rows(), ["solo", "> coord", "  held", "  +1"]);
    let tree = f.tree();
    assert_eq!(tree.threads[0].finished, 1);
    assert_eq!(tree.threads[0].rollup.words(), "1 paused");
    f.collapsed.insert("m".into());
    assert_eq!(f.rows(), ["solo", "> coord"]);
    assert_eq!(f.tree().threads[0].rollup.words(), "1 paused");
    for chat in &mut f.chats {
        chat.project_id = Some(if chat.id == "solo" { "other" } else { "work" }.into());
    }
    f.grouped = true;
    let grouped = f.tree();
    assert_eq!(grouped.groups.len(), 2);
    for group in &grouped.groups {
        assert_eq!(group.mark(), Some(Mark::Paused));
        assert_eq!(group.rollup.words(), "1 paused");
    }
    held["subscriptionPause"] = Value::Null;
    held["projectId"] = json!("work");
    f.set(held);
    assert!(f.tree().threads[0].rollup.counts().is_empty());
    assert_eq!(f.tree().threads[0].finished, 2);
}

#[test]
fn finished_members_fold_unless_unread_or_open_and_parents_collapse() {
    let mut values = vec![coord("coord", "m", 1.)];
    for i in 0..120 {
        values.push(member(&format!("done-{i:03}"), "m", 10. + f64::from(i)));
    }
    values.push(member("live", "m", 500.));
    let mut f = Fixture::new(values);
    f.set(json!({"id":"live","title":"live","missionId":"m","createdAt":500,"state":"working"}));
    assert_eq!(f.rows(), ["> coord", "  live", "  +120"]);
    // A reply you haven't seen keeps the member in view; looking at it folds it.
    f.set(json!({"id":"done-007","title":"done-007","missionId":"m","createdAt":17,"state":"idle","outcome":"done","outcomeAt":40}));
    assert_eq!(f.rows(), ["> coord", "  done-007", "  live", "  +119"]);
    assert!(f.tree().threads[0].rollup.unread);
    let seen = f.chats.iter().find(|c| c.id == "done-007").unwrap().clone();
    f.memory.note_seen(&seen);
    assert_eq!(f.rows(), ["> coord", "  live", "  +120"]);
    // The open member stays visible.
    f.opened = Some("done-050".into());
    assert_eq!(f.rows(), ["> coord", "  done-050", "  live", "  +119"]);
    f.opened = None;
    f.show_finished.insert("m".into());
    let rows = f.rows();
    assert_eq!(rows.len(), 1 + 121 + 1);
    assert_eq!(rows[1], "  live");
    assert_eq!(rows[2], "  done-000");
    assert_eq!(rows[121], "  done-119");
    assert_eq!(rows[122], "  hide");
    f.collapsed.insert("m".into());
    assert_eq!(f.rows(), ["> coord"]);
    let tree = f.tree();
    assert_eq!(tree.threads[0].rollup.counts(), [(Mark::Working, 1)]);
    assert_eq!(tree.threads[0].rollup.words(), "1 working");
}

#[test]
fn revealed_finished_members_stay_below_unfinished_in_each_creation_order() {
    let mut f = Fixture::new(vec![
        plain("newer-thread", 100.),
        coord("coord", "m", 1.),
        member("done-old", "m", 2.),
        json!({"id":"live-old","title":"live-old","missionId":"m","createdAt":3,"state":"working"}),
        member("done-new", "m", 4.),
        json!({"id":"live-new","title":"live-new","missionId":"m","createdAt":5,"state":"failed"}),
    ]);
    let folded = [
        "newer-thread",
        "> coord",
        "  live-old",
        "  live-new",
        "  +2",
    ];
    assert_eq!(f.rows(), folded);
    f.show_finished.insert("m".into());
    let revealed = [
        "newer-thread",
        "> coord",
        "  live-old",
        "  live-new",
        "  done-old",
        "  done-new",
        "  hide",
    ];
    assert_eq!(f.rows(), revealed);
    // Transitions repartition only this thread, retaining creation order in both groups.
    f.set(member("live-old", "m", 3.));
    assert_eq!(
        f.rows(),
        [
            "newer-thread",
            "> coord",
            "  live-new",
            "  done-old",
            "  live-old",
            "  done-new",
            "  hide"
        ]
    );
    f.set(json!({"id":"live-old","title":"live-old","missionId":"m","createdAt":3,"state":"working","updatedAt":9000}));
    assert_eq!(f.rows(), revealed);
    // Keyboard selection keeps the canonical member identity across reveal/collapse.
    let key = "done-new";
    let tree = f.tree();
    assert_eq!(
        tree.key(tree.rows[tree.find(key, &f.chats).unwrap()], &f.chats),
        key
    );
    // An opened quiet member retains the existing unfinished exemption.
    f.opened = Some(key.into());
    assert_eq!(
        f.rows(),
        [
            "newer-thread",
            "> coord",
            "  live-old",
            "  done-new",
            "  live-new",
            "  done-old",
            "  hide"
        ]
    );
    f.opened = None;
    f.collapsed.insert("m".into());
    assert_eq!(f.rows(), ["newer-thread", "> coord"]);
    f.collapsed.clear();
    assert_eq!(f.rows(), revealed);
    f.show_finished.clear();
    assert_eq!(f.rows(), folded);
}

#[test]
fn agent_activity_never_reorders_the_sidebar() {
    let mut f = Fixture::new(vec![
        plain("a", 3.),
        plain("b", 2.),
        coord("coord", "m", 1.),
        json!({"id":"member","title":"member","missionId":"m","createdAt":4,"state":"working"}),
    ]);
    let before = f.rows();
    assert_eq!(before, ["a", "b", "> coord", "  member"]);
    // Working, failing, replies, metadata and automatic notices all leave
    // every row in place (the notice moves lastUserMessageAt on the wire).
    f.set(json!({"id":"b","title":"b","createdAt":2,"state":"working","updatedAt":900,"lastUserMessageAt":901}));
    f.set(json!({"id":"coord","title":"coord","missionCoordinator":true,"missionId":"m","createdAt":1,"state":"idle","outcome":"question","outcomeAt":950,"lastUserMessageAt":940}));
    f.set(json!({"id":"member","title":"member","missionId":"m","createdAt":4,"state":"failed","lastUserMessageAt":990}));
    assert_eq!(f.rows(), before);
    // A new member created by the coordinator joins its thread, not the top.
    f.chats.push(c(member("new-member", "m", 999.)));
    f.memory.observe(&f.chats);
    f.set(json!({"id":"new-member","title":"new-member","missionId":"m","createdAt":999,"state":"working"}));
    assert_eq!(f.rows(), ["a", "b", "> coord", "  member", "  new-member"]);
    // Your own send moves a chat, or the whole thread for a member.
    f.memory.note_sent("member", 5000.);
    assert_eq!(f.rows()[0], "> coord");
    f.memory.note_sent("b", 6000.);
    assert_eq!(f.rows()[0], "b");
    // A chat you create (newest creation) leads.
    f.chats.push(c(plain("created", 7000.)));
    f.memory.observe(&f.chats);
    assert_eq!(f.rows()[0], "created");
}

#[test]
fn search_pinned_drafts_and_archived_stay_flat() {
    let mut f = Fixture::new(vec![
        coord("coord", "m", 1.),
        json!({"id":"needle-member","title":"needle member","missionId":"m","createdAt":2,"state":"working"}),
        json!({"id":"pinned-member","title":"pinned needle","missionId":"m","createdAt":3,"pinned":true}),
        json!({"id":"archived","title":"archived needle","createdAt":4,"archivedAt":9}),
        json!({"id":"needle-solo","title":"needle solo","createdAt":5}),
    ]);
    let mut draft = c(json!({"id":"draft","title":"Draft"}));
    draft.id = "new:1".into();
    draft.local_draft = true;
    f.chats.insert(0, draft);
    assert_eq!(
        f.rows(),
        [
            "new:1",
            "pinned-member",
            "needle-solo",
            "> coord",
            "  needle-member"
        ]
    );
    let tree = f.tree();
    assert_eq!(tree.section_rows(Section::Drafts as usize).len(), 1);
    assert_eq!(tree.section_rows(Section::Pinned as usize).len(), 1);
    assert!(tree.section_rows(Section::Archived as usize).is_empty());
    f.archived = true;
    assert_eq!(f.rows().last().map(String::as_str), Some("archived"));
    f.query = "needle".into();
    assert_eq!(
        f.rows(),
        ["pinned-member", "needle-solo", "needle-member", "archived"]
    );
    assert!(f.tree().threads.is_empty(), "search results are flat");
}

#[test]
fn selection_keys_survive_rebuilds() {
    let mut f = Fixture::new(vec![
        coord("coord", "m", 1.),
        member("x", "m", 2.),
        member("orphan", "o", 3.),
    ]);
    let tree = f.tree();
    assert_eq!(
        tree.find("coord", &f.chats).map(|ix| tree.rows[ix]),
        Some(Row::Parent(
            tree.threads.iter().position(|t| t.mission == "m").unwrap()
        ))
    );
    assert!(tree.find("mission:o", &f.chats).is_some());
    f.set(json!({"id":"x","title":"x","missionId":"m","createdAt":2,"state":"working"}));
    let tree = f.tree();
    let ix = tree.find("x", &f.chats).unwrap();
    assert!(matches!(tree.rows[ix], Row::Member { .. }));
    assert!(
        tree.find("fold:o", &f.chats).is_some(),
        "the orphan thread folds its finished member"
    );
}

fn in_project(mut v: Value, project: &str) -> Value {
    v["projectId"] = json!(project);
    v
}
fn in_dir(mut v: Value, dir: &str) -> Value {
    v["cwd"] = json!(dir);
    v
}

#[test]
fn chats_split_into_project_sections_in_your_send_order() {
    let mut f = Fixture::new(vec![
        in_project(plain("p-old", 1.), "pilot"),
        in_project(plain("d-new", 30.), "dotfiles"),
        in_project(coord("coord", "m", 10.), "pilot"),
        // A member from another project stays in its coordinator's section.
        in_project(member("m-x", "m", 11.), "dotfiles"),
        in_dir(plain("scratch", 20.), "/tmp/scratch"),
        json!({"id":"pinned","title":"pinned","createdAt":40,"pinned":true,"projectId":"pilot"}),
    ]);
    f.set(in_project(
        json!({"id":"m-x","title":"m-x","missionId":"m","createdAt":11,"state":"working"}),
        "dotfiles",
    ));
    f.grouped = true;
    assert_eq!(
        f.rows(),
        [
            "pinned",
            "# project:dotfiles",
            "d-new",
            "# dir:/tmp/scratch",
            "scratch",
            "# project:pilot",
            "> coord",
            "  m-x",
            "p-old",
        ]
    );
    let tree = f.tree();
    let pilot = &tree.groups[2];
    assert_eq!((pilot.chats, pilot.mark()), (3, Some(Mark::Working)));
    assert_eq!(
        tree.thread_group(0, &f.chats).as_deref(),
        Some("project:pilot")
    );
    // Your send moves its whole section to the top; agent activity never does.
    f.memory.note_sent("p-old", 5000.);
    assert_eq!(f.rows()[1], "# project:pilot");
    assert_eq!(f.rows()[2], "p-old", "the sent chat leads its section");
    f.set(in_dir(
        json!({"id":"scratch","title":"scratch","createdAt":20,"state":"failed","lastUserMessageAt":9000}),
        "/tmp/scratch",
    ));
    assert_eq!(f.rows()[1], "# project:pilot");
    // Collapsing a section leaves only its label, with its count and mark.
    f.memory.set_group_collapsed("dir:/tmp/scratch", true);
    let rows = f.rows();
    assert!(rows.contains(&"# dir:/tmp/scratch".to_owned()));
    assert!(!rows.contains(&"scratch".to_owned()));
    let tree = f.tree();
    let scratch = tree
        .groups
        .iter()
        .find(|g| g.key == "dir:/tmp/scratch")
        .unwrap();
    assert!(scratch.collapsed);
    assert_eq!((scratch.chats, scratch.mark()), (1, Some(Mark::Failed)));
    assert!(tree.find("group:dir:/tmp/scratch", &f.chats).is_some());
    // Search, and a single section, stay flat.
    f.query = "p-".into();
    assert_eq!(f.rows(), ["p-old"]);
    assert!(f.tree().groups.is_empty());
    f.query.clear();
    f.chats.retain(|c| c.project_id.as_deref() == Some("pilot"));
    assert!(f.tree().groups.is_empty(), "one project needs no label");
    f.grouped = false;
    assert!(f.tree().groups.is_empty());
}
