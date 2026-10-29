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
        }
    }
    fn tree(&self) -> Tree {
        let archived = self.archived;
        build(&Input {
            chats: &self.chats,
            keep: &move |c: &Chat| archived || !c.archived,
            query: &self.query,
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
    assert_eq!(rows[1], "  done-000");
    assert_eq!(rows[121], "  live");
    assert_eq!(rows[122], "  hide");
    f.collapsed.insert("m".into());
    assert_eq!(f.rows(), ["> coord"]);
    let tree = f.tree();
    assert_eq!(tree.threads[0].rollup.counts(), [(Mark::Working, 1)]);
    assert_eq!(tree.threads[0].rollup.words(), "1 working");
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
