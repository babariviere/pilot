//! Mounted diagnostic repair panel. Synthetic summaries and a recording writer
//! only: no Local, no diagnostic send, no repair run.
use super::*;
use crate::{
    diagnostic_repair::{
        self as repair, Attempt, Draft, ModelChoice, Outcome, ProjectState, Review,
        SUGGEST_MESSAGE, State,
    },
    interaction::{Interaction, WriteCommand},
};
use gpui_kit::{
    AnyWindowHandle, Bounds, EntityInputHandler, HeadlessAppContext, WindowBounds, WindowOptions,
    size, test::TestWindowExt,
};
use serde_json::{Value, json};

const PROPOSAL: &str = "diagnostic-proposal:v1:12345678-1234-4234-8234-123456789abc";

fn settle(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    for _ in 0..6 {
        cx.run_until_parked();
        cx.advance_clock(Duration::from_millis(16));
        cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
    }
}
fn host(lineage: &str) -> Value {
    json!({"hostId":"local","daemonId":"test-daemon","lineageId":lineage})
}
fn proposal() -> Value {
    json!({
        "schemaVersion":1,"id":PROPOSAL,"createdAt":"2026-11-02T10:00:00.000Z",
        "repairTitle":"Tool calls stall after a lost provider stream 日本語 with a long title that wraps",
        "evidenceRefs":["diagnostic:v1:a","diagnostic:v1:b"],
        "findings":"The tool stalled 👩‍💻 after the provider stream closed. Long findings keep their full text in the review, wrapping across lines without clipping, so the user can read them before any repair starts.",
        "uncertainty":"medium","suggestedRepair":"Add a bounded timeout and surface it as a failure.",
        "regressionTestGuidance":"Cover a stream that closes mid-tool."
    })
}
fn specialist(lineage: &str, with_proposal: bool) -> Arc<repair::Specialist> {
    let mut value = json!({"id":"synthetic","role":"diagnostics","mode":"ask","diagnosticScope":"app","diagnosticHost":host(lineage)});
    if with_proposal {
        value["diagnosticRepairProposal"] = proposal();
    }
    Arc::new(repair::specialist(&value).unwrap())
}
fn handoff() -> Value {
    json!({
        "schemaVersion":1,"host":host("test-lineage"),"subject":{"kind":"app","host":host("test-lineage")},
        "evidence":[
            {"ref":"diagnostic:v1:a","kind":"tool.in_flight","source":"kernel","at":"2026-11-02T09:00:00.000Z"},
            {"ref":"diagnostic:v1:b","kind":"model.request","source":"daemon","at":"2026-11-02T09:01:00.000Z"}
        ],
        "proposalId":PROPOSAL,"findings":proposal()["findings"],"uncertainty":"medium",
        "suggestedRepair":proposal()["suggestedRepair"],"regressionTestGuidance":proposal()["regressionTestGuidance"],
        "repairTitle":proposal()["repairTitle"]
    })
}
fn review(project: Value, checkouts: bool) -> Review {
    let spec = specialist("test-lineage", true);
    review_of(
        project,
        checkouts,
        Draft::of(spec.proposal().unwrap()),
        handoff(),
    )
}
/// What pilotd returns for `draft`, with the repair project's scoped catalog.
fn review_of(project: Value, checkouts: bool, draft: Draft, handoff: Value) -> Review {
    let spec = specialist("test-lineage", true);
    let p = spec.proposal().unwrap();
    let subject = spec.subject.clone().unwrap();
    let available = project["state"] == "available";
    Review {
        draft,
        models: available.then(|| {
            Ok(Arc::new(
                serde_json::from_value(crate::chat_models_fixture::catalog()).unwrap(),
            ))
        }),
        handoff: repair::handoff(&handoff, p, &subject),
        project: repair::project_status(&project),
        checkouts: checkouts.then(|| {
            crate::local_model::projects(
                &json!([{"id":"pilot-src","name":"Pilot source","path":"/src/pilot"}]),
            )
        }),
    }
}
fn binding() -> Value {
    json!({
        "schemaVersion":1,"id":"11111111-2222-4333-8444-555555555555","revision":3,
        "host":host("test-lineage"),"projectId":"pilot-src","path":"/src/pilot",
        "origin":repair::PILOT_ORIGIN,"configuredAt":"2026-11-01T00:00:00.000Z"
    })
}

struct Probe {
    h: AnyWindowHandle,
    v: Entity<LocalViewer>,
    writes: async_channel::Receiver<WriteCommand>,
}
impl Probe {
    fn open(cx: &mut HeadlessAppContext, width: f32, spec: Arc<repair::Specialist>) -> Self {
        let (writer, writes) = Interaction::recording();
        let (client, _reads) = LocalClient::synthetic_commands();
        client.set_synthetic_daemon(crate::local_client::ConnectedDaemon::Connected(None));
        let (h, v) = cx
            .update(|cx| {
                gpui_kit::open_window(
                    WindowOptions {
                        window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                            Default::default(),
                            size(px(width), px(760.)),
                        ))),
                        show: false,
                        focus: false,
                        ..Default::default()
                    },
                    cx,
                    |w, cx| {
                        cx.new(|cx| {
                            let mut v = LocalViewer::preview(PreviewState::Conversation, w, cx);
                            v.client = Some(client);
                            v.writer = Some(writer.clone());
                            v.usage_options = Some(LocalOptions::synthetic(1));
                            v.editor
                                .update(cx, |e, cx| e.shell_probe_setup(writer, w, cx));
                            v.selected = Some("synthetic".into());
                            let mut chat = v.state.chats[0].clone();
                            (chat.id, chat.writable, chat.busy) = ("synthetic".into(), true, false);
                            chat.state = "idle".into();
                            chat.signal = None;
                            chat.diagnostic = Some(spec);
                            v.state.chats = Arc::new(vec![chat]);
                            v
                        })
                    },
                )
            })
            .unwrap();
        settle(cx, h);
        Self { h, v, writes }
    }
    fn click(&self, cx: &mut HeadlessAppContext, id: &'static str) {
        cx.update_window(self.h, |_, w, cx| w.click(id, cx))
            .unwrap();
        settle(cx, self.h);
    }
    /// Click inside the bounded review scroll, scrolling the target into view first.
    fn reveal_click(&self, cx: &mut HeadlessAppContext, id: &'static str) {
        for _ in 0..24 {
            let clicked = cx
                .update_window(self.h, |_, w, cx| {
                    let target = w.find(id).bounds();
                    let viewport = w.find("diagnostic-repair-review-scroll").bounds();
                    if viewport.contains(&target.center()) {
                        w.click(id, cx);
                        return true;
                    }
                    let up = target.center().y > viewport.bottom();
                    w.scroll(
                        "diagnostic-repair-review-scroll",
                        gpui_kit::ScrollDelta::Pixels(gpui_kit::point(
                            px(0.),
                            px(if up { -80. } else { 80. }),
                        )),
                        cx,
                    );
                    false
                })
                .unwrap();
            settle(cx, self.h);
            if clicked {
                return;
            }
        }
        panic!("{id} never scrolled into the review");
    }
    fn visible(&self, cx: &mut HeadlessAppContext, id: &'static str) -> bool {
        cx.update_window(self.h, |_, w, _| {
            w.try_find(id).is_some_and(|e| e.visible())
        })
        .unwrap()
    }
    fn mounted(&self, cx: &mut HeadlessAppContext, id: &'static str) -> bool {
        cx.update_window(self.h, |_, w, _| w.try_find(id).is_some())
            .unwrap()
    }
    fn review(&self, cx: &mut HeadlessAppContext, review: Review) {
        cx.update_window(self.h, |_, w, cx| {
            self.v
                .update(cx, |v, cx| v.probe_repair_review(PROPOSAL, review, w, cx))
        })
        .unwrap();
        settle(cx, self.h);
    }
    fn commands(&self) -> Vec<WriteCommand> {
        std::iter::from_fn(|| self.writes.try_recv().ok()).collect()
    }
    fn panel(
        &self,
        cx: &mut HeadlessAppContext,
        f: impl FnOnce(&mut diagnostic_repair_view::RepairPanel),
    ) {
        cx.update_window(self.h, |_, _, cx| {
            self.v.update(cx, |v, cx| {
                f(&mut v.repair);
                cx.notify();
            })
        })
        .unwrap();
        settle(cx, self.h);
    }
    fn contained(&self, cx: &mut HeadlessAppContext, id: &'static str) {
        cx.update_window(self.h, |_, w, _| {
            let panel = w.find(id).bounds();
            let editor = w.find("conversation-editor").bounds();
            let viewport = w.viewport_size();
            assert!(
                panel.left() >= editor.left() && panel.right() <= editor.right(),
                "{id} within the conversation column"
            );
            assert!(
                panel.bottom() <= viewport.height && panel.top() >= px(0.),
                "{id} within the window"
            );
        })
        .unwrap();
    }
    fn close(self, cx: &mut HeadlessAppContext) {
        cx.update_window(self.h, |_, w, _| w.remove_window())
            .unwrap();
        cx.run_until_parked();
    }
}
fn repairs(commands: &[WriteCommand]) -> Vec<&crate::diagnostic_repair::Action> {
    commands
        .iter()
        .filter_map(|c| match c {
            WriteCommand::Repair {
                specialist, action, ..
            } if specialist == "synthetic" => Some(action),
            _ => None,
        })
        .collect()
}
fn attempt(state: State) -> Attempt {
    let host = LocalOptions::synthetic(1).host();
    Attempt {
        proposal_id: PROPOSAL.into(),
        operation: crate::delivery_store::Operation {
            schema_version: 1,
            operation_id: "op".into(),
            producer_id: "producer".into(),
            sequence: 1,
            origin: host.clone(),
            destination: host,
            kind: "repair-create".into(),
            target_id: "repair-chat".into(),
            payload: "{}".into(),
            payload_hash: crate::delivery_store::hash("{}"),
        },
        state,
        reason: None,
    }
}
fn book(state: State) -> crate::delivery_store::Book {
    let mut book = crate::delivery_store::Book::shell_probe();
    book.repairs.insert("synthetic".into(), attempt(state));
    book
}

pub fn run_diagnostic_repair_probe(cx: &mut HeadlessAppContext) {
    let captures =
        std::env::var_os("PILOT_NEXT_DIAGNOSTIC_REPAIR_DIR").map(std::path::PathBuf::from);
    if let Some(p) = &captures {
        std::fs::create_dir_all(p).unwrap();
    }
    let capture = |cx: &mut HeadlessAppContext, h: AnyWindowHandle, name: &str| {
        if let Some(p) = &captures {
            cx.capture_screenshot(h)
                .unwrap()
                .save(p.join(format!("{name}.png")))
                .unwrap();
        }
    };
    for width in [680., 1100.] {
        for dark in [false, true] {
            cx.update(|cx| {
                crate::appearance::commit_appearance(
                    if dark {
                        crate::settings_state::AppearancePreference::Dark
                    } else {
                        crate::settings_state::AppearancePreference::Light
                    },
                    cx,
                )
            });
            let tag = format!("{}-{}", width as u32, if dark { "dark" } else { "light" });

            // No proposal: one quiet Suggest action. It sends the fixed request through
            // the ordinary composer delivery as a queued follow-up, nothing else.
            let p = Probe::open(cx, width, specialist("test-lineage", false));
            assert!(p.visible(cx, "diagnostic-repair-suggest"));
            assert!(!p.visible(cx, "diagnostic-repair-review"));
            p.contained(cx, "diagnostic-repair-panel");
            capture(cx, p.h, &format!("suggest-{tag}"));
            p.click(cx, "diagnostic-repair-suggest");
            let sent = p.commands();
            let submits: Vec<_> = sent
                .iter()
                .filter_map(|c| match c {
                    WriteCommand::Submit {
                        key,
                        draft,
                        follow_up,
                        stop,
                        ..
                    } => Some((key.clone(), draft.text.clone(), *follow_up, *stop)),
                    _ => None,
                })
                .collect();
            assert_eq!(
                submits,
                [(
                    "chat:synthetic".to_owned(),
                    SUGGEST_MESSAGE.to_owned(),
                    true,
                    false
                )]
            );
            assert!(repairs(&sent).is_empty(), "Suggest never starts a repair");
            assert!(
                !p.visible(cx, "diagnostic-repair-suggest"),
                "one request at a time"
            );
            assert!(p.visible(cx, "diagnostic-repair-caption"));
            p.close(cx);

            // A typed draft or open IME composition is never replaced or sent.
            let p = Probe::open(cx, width, specialist("test-lineage", false));
            let input = cx.update(|cx| p.v.read(cx).editor.read(cx).shell_probe().0);
            cx.update_window(p.h, |_, w, cx| {
                input.update(cx, |i, cx| {
                    i.focus(w, cx);
                    i.replace_text_in_range(None, "Draft café 日本語 👩‍💻", w, cx);
                    i.replace_and_mark_text_in_range(None, "にほ", None, w, cx);
                })
            })
            .unwrap();
            settle(cx, p.h);
            p.click(cx, "diagnostic-repair-suggest");
            let sent = p.commands();
            assert!(
                !sent.iter().any(|c| matches!(
                    c,
                    WriteCommand::Submit { .. } | WriteCommand::Repair { .. }
                ))
            );
            cx.update_window(p.h, |_, w, cx| {
                assert!(
                    input.update(cx, |i, cx| i.marked_text_range(w, cx).is_some()),
                    "preedit kept"
                );
                assert!(input.read(cx).value().starts_with("Draft café 日本語 👩‍💻"));
            })
            .unwrap();
            p.close(cx);

            // A structured proposal: visible title and meta, review on request, exact Start.
            let p = Probe::open(cx, width, specialist("test-lineage", true));
            assert!(p.visible(cx, "diagnostic-repair-title"));
            assert!(!p.visible(cx, "diagnostic-repair-suggest"));
            assert!(
                !p.visible(cx, "diagnostic-repair-review-body"),
                "review is disclosed, not forced"
            );
            p.click(cx, "diagnostic-repair-review");
            p.review(
                cx,
                review(
                    json!({"state":"available","revision":3,"binding":binding()}),
                    false,
                ),
            );
            capture(cx, p.h, &format!("review-{tag}"));
            for id in ["diagnostic-repair-findings", "diagnostic-repair-start"] {
                assert!(p.visible(cx, id), "{id}");
            }
            // Lower sections stay mounted inside the bounded review scroll.
            for id in [
                "diagnostic-repair-suggestion",
                "diagnostic-repair-regression",
                "diagnostic-repair-evidence",
                "diagnostic-repair-project",
            ] {
                assert!(p.mounted(cx, id), "{id}");
            }
            p.contained(cx, "diagnostic-repair-review-body");
            cx.update_window(p.h, |_, w, _| {
                let scroll = w.find("diagnostic-repair-review-scroll").bounds();
                assert!(
                    scroll.size.height <= w.viewport_size().height * 0.46,
                    "review scrolls inside a bounded region"
                );
            })
            .unwrap();
            assert!(p.commands().is_empty(), "reviewing sends nothing");
            p.click(cx, "diagnostic-repair-start");
            let sent = p.commands();
            let started = repairs(&sent);
            let spec = specialist("test-lineage", true);
            let reviewed = review(
                json!({"state":"available","revision":3,"binding":binding()}),
                false,
            );
            let ProjectState::Available(b) = reviewed.project.as_ref().unwrap().state.clone()
            else {
                panic!()
            };
            let expected = repair::start_payload(
                "synthetic",
                spec.proposal().unwrap(),
                spec.subject.as_ref().unwrap(),
                reviewed.handoff.as_ref().unwrap(),
                &b,
                true,
                &ModelChoice::default(),
            )
            .unwrap();
            assert!(
                matches!(started.as_slice(), [repair::Action::Start { proposal_id, payload }] if proposal_id == PROPOSAL && *payload == expected),
                "one exact start"
            );
            p.click(cx, "diagnostic-repair-review");
            assert!(!p.visible(cx, "diagnostic-repair-review-body"));
            p.close(cx);

            // Edited text and an explicit model: Local reviews the edit before the one start.
            let p = Probe::open(cx, width, specialist("test-lineage", true));
            p.click(cx, "diagnostic-repair-review");
            let project = json!({"state":"available","revision":3,"binding":binding()});
            p.review(cx, review(project.clone(), false));
            assert!(p.mounted(cx, "diagnostic-repair-models"));
            for (menu, option) in [
                ("diagnostic-repair-model", "repair-option-p/b"),
                ("diagnostic-repair-thinking", "repair-option-high"),
            ] {
                p.reveal_click(cx, menu);
                p.click(cx, option);
            }
            capture(cx, p.h, &format!("model-{tag}"));
            p.reveal_click(cx, "diagnostic-repair-edit");
            for id in [
                "diagnostic-repair-edit-title",
                "diagnostic-repair-edit-findings",
                "diagnostic-repair-uncertainty",
                "diagnostic-repair-revert",
            ] {
                assert!(p.mounted(cx, id), "{id}");
            }
            assert!(
                !p.mounted(cx, "diagnostic-repair-findings"),
                "fields replace prose"
            );
            let (title, findings) = cx.update(|cx| p.v.read(cx).probe_repair_inputs().unwrap());
            cx.update_window(p.h, |_, w, cx| {
                title.update(cx, |i, cx| i.set_value("Edited title 日本語", w, cx));
                findings.update(cx, |i, cx| {
                    i.focus(w, cx);
                    i.replace_text_in_range(None, " Edited 👩‍💻", w, cx);
                    i.replace_and_mark_text_in_range(None, "にほ", None, w, cx);
                });
            })
            .unwrap();
            settle(cx, p.h);
            capture(cx, p.h, &format!("edit-{tag}"));
            p.click(cx, "diagnostic-repair-start");
            assert!(
                p.commands().is_empty(),
                "an open composition is never started"
            );
            assert!(!cx.update(|cx| p.v.read(cx).probe_repair_preparing()));
            cx.update_window(p.h, |_, w, cx| {
                findings.update(cx, |i, cx| i.replace_text_in_range(None, "日本", w, cx))
            })
            .unwrap();
            settle(cx, p.h);
            p.click(cx, "diagnostic-repair-start");
            assert!(
                p.commands().is_empty(),
                "edited text is reviewed before any start"
            );
            assert!(cx.update(|cx| p.v.read(cx).probe_repair_preparing()));
            let draft = cx.update(|cx| p.v.read(cx).probe_repair_draft(cx).unwrap());
            assert_eq!(draft.title, "Edited title 日本語");
            assert!(
                draft.findings.contains(" Edited 👩‍💻日本") && !draft.findings.contains("にほ"),
                "committed text only: {}",
                draft.findings
            );
            let mut edited = handoff();
            edited["repairTitle"] = json!("Edited title 日本語");
            edited["findings"] = json!(draft.findings.clone());
            let again = review_of(project.clone(), false, draft, edited);
            p.review(cx, again.clone());
            let ProjectState::Available(b) = again.project.as_ref().unwrap().state.clone() else {
                panic!()
            };
            let spec = specialist("test-lineage", true);
            let expected = repair::start_payload(
                "synthetic",
                spec.proposal().unwrap(),
                spec.subject.as_ref().unwrap(),
                again.handoff.as_ref().unwrap(),
                &b,
                true,
                &ModelChoice {
                    model: Some("p/b".into()),
                    thinking: Some("high".into()),
                },
            )
            .unwrap();
            let sent = p.commands();
            assert!(
                matches!(repairs(&sent).as_slice(), [repair::Action::Start { payload, .. }] if *payload == expected),
                "one start with the reviewed edit and chosen model"
            );
            assert!(
                expected.contains("Edited title 日本語") && expected.contains("\"model\":\"p/b\"")
            );
            p.reveal_click(cx, "diagnostic-repair-revert");
            assert!(p.mounted(cx, "diagnostic-repair-findings"));
            p.close(cx);

            // Setup is required: verified checkouts are offered; Start stays unavailable.
            let p = Probe::open(cx, width, specialist("test-lineage", true));
            p.click(cx, "diagnostic-repair-review");
            p.review(cx, review(json!({"state":"missing","revision":0}), true));
            assert!(p.mounted(cx, "diagnostic-repair-setup"));
            assert!(!p.mounted(cx, "diagnostic-repair-project"));
            capture(cx, p.h, &format!("setup-{tag}"));
            p.click(cx, "diagnostic-repair-start");
            assert!(
                repairs(&p.commands()).is_empty(),
                "no destination, no start"
            );
            p.close(cx);

            // An unconfirmed start outranks review and can only be checked.
            let p = Probe::open(cx, width, specialist("test-lineage", true));
            p.panel(cx, |panel| panel.probe_book(book(State::Unknown)));
            assert!(p.visible(cx, "diagnostic-repair-check"));
            assert!(!p.visible(cx, "diagnostic-repair-review"));
            assert!(!p.visible(cx, "diagnostic-repair-start"));
            capture(cx, p.h, &format!("check-{tag}"));
            p.click(cx, "diagnostic-repair-check");
            assert!(matches!(
                repairs(&p.commands()).as_slice(),
                [repair::Action::Check]
            ));
            p.panel(cx, |panel| panel.probe_book(book(State::Accepted)));
            assert!(p.visible(cx, "diagnostic-repair-open"));
            assert!(!p.visible(cx, "diagnostic-repair-check"));
            p.close(cx);

            // Another host identity is refused in words; nothing can be reviewed or started.
            let p = Probe::open(cx, width, specialist("other-lineage", true));
            assert!(p.visible(cx, "diagnostic-repair-title"));
            p.click(cx, "diagnostic-repair-review");
            assert!(!p.visible(cx, "diagnostic-repair-review-body"));
            assert!(p.commands().is_empty());
            p.close(cx);
            let _ = Outcome::Pending;
            println!(
                "diagnostic_repair mounted {tag}: suggest, draft/IME fence, review, exact start, edit + model, setup, check and cross-host refusal passed"
            );
        }
    }
}
