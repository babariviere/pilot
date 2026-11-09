//! Maps the trusted native host's planning reads (the daemon's exact
//! `MissionPlans.view` records, `questionDigests` and capabilities; see
//! docs/technical/day-native-host.md) to the planning read model, and the
//! screens' intents to exact `InterviewWrite` requests. Pure functions: the
//! host keeps transport, credentials, operation IDs and receipts.
//!
//! Digests are the backend's own (`questionDigests`); nothing here
//! recomputes one. A save sends the complete current answer list with one
//! answer replaced, fenced by the displayed interview revision; the host
//! rechecks the context digest before and after saving its envelope.

use std::collections::BTreeSet;

use serde_json::{Value, json};

use crate::plan::{
    AnswerIntent, Choice, Delivery, Exploration, ExploreKind, ExploreState, FogArea, Interview,
    OutcomeStatus, PlanPage, PlanRoute, PlanRow, PlanStage, Proposal, PrototypeSupport, Question,
    QuestionSection, QuestionState, RoundAnswer, RoundKind, RoundLine, RoundState, Slice,
    SliceOwner, Spec, Step, StepState, Story, SubmitIntent, SubmitState,
};
use crate::plan_desk::ANSWER_ROOM;

/// What the feed is doing for the selected mission, which the read cannot say.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Local {
    /// Questions whose save is on its way.
    pub saving: BTreeSet<String>,
    /// Whether a submission is on its way.
    pub submitting: bool,
    /// Whether a check of an unconfirmed operation is on its way.
    pub checking: bool,
}

fn s(v: &Value) -> String {
    v.as_str().unwrap_or_default().to_owned()
}

fn arr(v: &Value) -> &[Value] {
    v.as_array().map_or(&[], Vec::as_slice)
}

fn section(v: &Value) -> QuestionSection {
    match v.as_str() {
        Some("non-goals") => QuestionSection::NonGoals,
        Some("constraints") => QuestionSection::Constraints,
        Some("acceptance") => QuestionSection::Acceptance,
        Some("authority") => QuestionSection::Authority,
        _ => QuestionSection::Outcome,
    }
}

/// The screen's id of the interview round in `read`: its enrollment and
/// question-list revision, so a new round is a new interview.
pub fn interview_id(read: &Value) -> Option<String> {
    let fence = &read["view"]["interview"]["fence"];
    let enrollment = fence["enrollmentId"].as_str()?;
    let set = fence["questionSetRevision"].as_u64()?;
    Some(format!("{enrollment}-{set}"))
}

/// The operation summaries that were sent but not settled.
fn unsettled(ops: &[Value]) -> impl Iterator<Item = &Value> {
    ops.iter().filter(|op| {
        !matches!(
            op["state"].as_str(),
            Some("accepted" | "rejected" | "not-sent")
        )
    })
}

/// The unconfirmed operation a check should read, if any.
pub fn unsettled_operation(ops: &[Value]) -> Option<String> {
    unsettled(ops).next().map(|op| s(&op["operationId"]))
}

fn titles(plan: &Value, ids: &Value) -> Vec<String> {
    arr(ids)
        .iter()
        .map(|id| {
            arr(&plan["questions"])
                .iter()
                .find(|q| q["id"] == *id)
                .map_or_else(|| s(id), |q| s(&q["title"]))
        })
        .collect()
}

fn sources(view: &Value, list: &Value) -> Vec<String> {
    arr(list)
        .iter()
        .map(|src| match src["kind"].as_str() {
            Some("decision") => arr(&view["decisions"])
                .iter()
                .find(|d| d["decision"]["id"] == src["id"])
                .and_then(|d| d["decision"]["number"].as_u64())
                .map_or_else(|| "A decision".to_owned(), |n| format!("Decision {n}")),
            Some("knowledge") => {
                let entries = if view["knowledge"].is_array() {
                    &view["knowledge"]
                } else {
                    &view["knowledge"]["items"]
                };
                let title = arr(entries)
                    .iter()
                    .find(|k| k["id"] == src["id"])
                    .map(|k| s(&k["title"]))
                    .filter(|t| !t.is_empty())
                    .unwrap_or_else(|| "Knowledge".to_owned());
                format!("Knowledge: {title}, revision {}", src["revision"])
            }
            _ => "A saved source".to_owned(),
        })
        .collect()
}

fn question(read: &Value, q: &Value, local: &Local) -> Question {
    let interview = &read["view"]["interview"];
    let id = s(&q["id"]);
    let digest = s(&read["questionDigests"][&id]);
    let choices: Vec<Choice> = arr(&q["options"])
        .iter()
        .map(|o| Choice {
            id: s(&o["id"]),
            meaning: s(&o["meaning"]),
            recommended: o["id"] == q["recommendedOptionId"],
        })
        .collect();
    let answer = arr(&interview["answers"])
        .iter()
        .find(|a| a["questionId"] == q["id"]);
    let text = answer.map(|a| s(&a["text"])).unwrap_or_default();
    let selected = answer.and_then(|a| a["selectedOption"].as_object());
    let offered = selected.and_then(|o| {
        choices.iter().find(|c| {
            o.get("id") == Some(&json!(c.id)) && o.get("meaning") == Some(&json!(c.meaning))
        })
    });
    let filled = selected.is_some() || !text.trim().is_empty();
    let same = answer.is_some_and(|a| a["questionDigest"] == json!(digest))
        && (selected.is_none() || offered.is_some());
    let state = match (filled, same) {
        (false, _) => QuestionState::Open,
        (true, false) => QuestionState::Changed,
        (true, true) => QuestionState::Answered,
    };
    let earlier = if state == QuestionState::Changed {
        let meaning = selected
            .and_then(|o| o.get("meaning"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        [meaning, text.trim()]
            .into_iter()
            .filter(|p| !p.is_empty())
            .collect::<Vec<_>>()
            .join(". ")
    } else {
        String::new()
    };
    Question {
        section: section(&q["section"]),
        prompt: s(&q["prompt"]),
        digest,
        chosen: if state == QuestionState::Answered {
            offered.map(|c| c.id.clone())
        } else {
            None
        },
        choices,
        text,
        state,
        earlier,
        new: false,
        saving: if local.saving.contains(&id) {
            Delivery::Sending
        } else {
            Delivery::Idle
        },
        id,
    }
}

fn round_kind(read: &Value) -> (RoundKind, String, String) {
    let view = &read["view"];
    let plan = &view["plan"];
    let set = &view["interview"]["fence"]["questionSetRevision"];
    if plan["review"].is_object() && plan["review"]["questionSetRevision"] == *set {
        return (
            RoundKind::Review,
            String::new(),
            s(&plan["review"]["digest"]),
        );
    }
    if plan["round"].is_object() && plan["round"]["questionSetRevision"] == *set {
        let topic = titles(plan, &json!([plan["round"]["topicId"]]))
            .pop()
            .unwrap_or_default();
        return (RoundKind::Topic, topic, String::new());
    }
    (RoundKind::Mission, String::new(), String::new())
}

fn interview(read: &Value, ops: &[Value], local: &Local) -> Option<Interview> {
    let iv = &read["view"]["interview"];
    let id = interview_id(read)?;
    // A round with no questions (such as an enrollment's internal bootstrap
    // round) is never shown as an interview and can never be submitted.
    if arr(&iv["questions"]).is_empty() {
        return None;
    }
    let (kind, topic, proposal) = round_kind(read);
    let set = iv["fence"]["questionSetRevision"].as_u64().unwrap_or(0) as u32;
    let questions: Vec<Question> = arr(&iv["questions"])
        .iter()
        .map(|q| question(read, q, local))
        .collect();
    let submitted =
        iv["submission"]["fence"]["questionSetRevision"] == iv["fence"]["questionSetRevision"];
    let pending_submit = unsettled(ops).any(|op| op["kind"] == "interview-submit");
    let submit = if submitted {
        SubmitState::Submitted
    } else if local.checking {
        SubmitState::Checking
    } else if local.submitting {
        SubmitState::Submitting
    } else if pending_submit {
        SubmitState::Unknown
    } else {
        SubmitState::Open
    };
    let used = serde_json::to_string(&iv["answers"]).map_or(ANSWER_ROOM, |a| a.len());
    Some(Interview {
        id,
        kind,
        topic,
        round: set,
        revision: iv["revision"].as_u64().unwrap_or(0) as u32,
        question_set: set,
        current: true,
        answered: questions
            .iter()
            .filter(|q| q.state == QuestionState::Answered)
            .count() as u32,
        questions,
        submit,
        proposal,
        unconfirmed: !local.submitting && !local.checking && unsettled(ops).next().is_some(),
        room: ANSWER_ROOM.saturating_sub(used) as u32,
        accepting: read["capabilities"]["answers"] == 1,
    })
}

fn exploration(view: &Value, q: &Value) -> Exploration {
    let plan = &view["plan"];
    let id = q["id"].clone();
    let resolution = &q["resolution"];
    let state = if resolution.is_object() {
        ExploreState::Resolved
    } else if !q["claimedBy"].is_null() {
        ExploreState::Running
    } else if plan["round"]["topicId"] == id {
        ExploreState::Asking
    } else if arr(&view["frontier"]).iter().any(|f| f["id"] == id) {
        ExploreState::Ready
    } else {
        ExploreState::Waiting
    };
    let result = match resolution["kind"].as_str() {
        Some("decision") => "Settled by a decision",
        Some("knowledge") => "Answered by linked Knowledge. Not checked by Pilot.",
        Some("interview") => "Answered in your interview",
        _ => "",
    };
    Exploration {
        id: s(&id),
        title: s(&q["title"]),
        question: s(&q["question"]),
        kind: if q["kind"] == "research" {
            ExploreKind::Research
        } else {
            ExploreKind::Grilling
        },
        state,
        after: titles(plan, &q["dependsOn"]),
        by: if state == ExploreState::Running {
            "An agent is on it".into()
        } else {
            String::new()
        },
        result: result.into(),
        sources: sources(view, &q["sources"]),
        from_fog: arr(&plan["fog"])
            .iter()
            .find(|f| arr(&f["promotedTo"]).contains(&id))
            .map(|f| s(&f["area"]))
            .unwrap_or_default(),
    }
}

fn fog(view: &Value, f: &Value) -> FogArea {
    let plan = &view["plan"];
    let became = titles(plan, &f["promotedTo"]);
    FogArea {
        id: s(&f["id"]),
        area: s(&f["area"]),
        why: s(&f["why"]),
        ready_when: s(&f["readyWhen"]),
        after: titles(plan, &f["dependsOn"]),
        sources: sources(view, &f["sources"]),
        active: became.is_empty(),
        became,
    }
}

fn proposal(plan: &Value) -> Option<Proposal> {
    let spec = plan["spec"].as_object()?;
    let lines = |key: &str| arr(&spec[key]).iter().map(s).collect::<Vec<_>>();
    let slices = arr(&plan["slices"]);
    let slice_title = |id: &Value| {
        slices
            .iter()
            .find(|x| x["id"] == *id)
            .map_or_else(|| s(id), |x| s(&x["title"]))
    };
    let digest = plan["review"]["digest"]
        .as_str()
        .map_or_else(|| format!("plan-{}", plan["revision"]), str::to_owned);
    Some(Proposal {
        digest,
        spec: Spec {
            problem: s(&spec["problem"]),
            solution: s(&spec["solution"]),
            stories: arr(&spec["stories"])
                .iter()
                .map(|st| Story {
                    id: s(&st["id"]),
                    text: s(&st["text"]),
                })
                .collect(),
            implementation: lines("implementation"),
            testing: lines("testing"),
            exclusions: lines("exclusions"),
        },
        slices: slices
            .iter()
            .map(|x| Slice {
                id: s(&x["id"]),
                title: s(&x["title"]),
                outcome: s(&x["outcome"]),
                acceptance: arr(&x["acceptance"]).iter().map(s).collect(),
                stories: arr(&x["storyIds"]).iter().map(s).collect(),
                after: arr(&x["dependsOn"]).iter().map(slice_title).collect(),
                owners: arr(&x["owners"])
                    .iter()
                    .map(|o| {
                        if o == "opus-ui" {
                            SliceOwner::Ui
                        } else {
                            SliceOwner::Backend
                        }
                    })
                    .collect(),
            })
            .collect(),
        open_fog: arr(&plan["fog"])
            .iter()
            .filter(|f| arr(&f["promotedTo"]).is_empty())
            .map(|f| s(&f["area"]))
            .collect(),
    })
}

fn step(label: &str, state: StepState, line: &str) -> Step {
    Step {
        label: label.into(),
        state,
        line: line.into(),
    }
}

/// The planning page of the host's read, or an honest unavailable page.
pub fn page(read: &Value, ops: &[Value], local: &Local) -> PlanPage {
    let mission_id = s(&read["missionId"]);
    let fresh = read["fresh"].as_bool().unwrap_or(false);
    if read["status"] == "preparing" {
        // A new mission whose coordinator is still writing its first full list.
        return PlanPage {
            mission_id,
            available: true,
            fresh,
            stage: PlanStage::Planning,
            note: "Pilot is writing the questions. Nothing is asked yet.".into(),
            ..PlanPage::default()
        };
    }
    if read["status"] != "available" || !read["view"].is_object() {
        return PlanPage {
            mission_id,
            available: false,
            reason: "This mission did not start with a saved interview, so its planning cannot be shown or answered here. Nothing was changed.".into(),
            fresh,
            ..PlanPage::default()
        };
    }
    let view = &read["view"];
    let plan = &view["plan"];
    let caps = &read["capabilities"];
    let interview = interview(read, ops, local);
    let submitted_any = view["interview"]["submission"].is_object();
    // Only an exact new-flow worker binding reports continuation 1, with its phase.
    let continuation = caps["continuation"] == 1;
    let continued = match (continuation, submitted_any, caps["phase"].as_str()) {
        (false, _, _) => StepState::Unavailable,
        (true, true, Some("continuing")) => StepState::Now,
        (true, true, Some("active" | "holding")) => StepState::Done,
        _ => StepState::Waiting,
    };
    let publication = &plan["publication"];
    let published = publication.is_object();
    let tasks = arr(&publication["tasks"]).len();
    let published_line = format!("Published as {tasks} tasks. No work started.");
    let steps = vec![
        step(
            "Pilot continues planning",
            continued,
            if continuation {
                "Planning only. It starts no build work."
            } else {
                "Not connected here yet. Your submitted answers are kept."
            },
        ),
        step(
            "Plan approved",
            if published {
                StepState::Done
            } else {
                StepState::Waiting
            },
            "Only your answer to the review approves it.",
        ),
        step(
            "Published as tasks",
            if published {
                StepState::Done
            } else {
                StepState::Waiting
            },
            if published {
                &published_line
            } else {
                "Publishing adds tasks and starts nothing."
            },
        ),
        step(
            "Work started",
            StepState::Unavailable,
            "Starting work needs its own confirmation. Nothing here starts it.",
        ),
    ];
    let stage = match &interview {
        Some(i)
            if i.unconfirmed
                || matches!(i.submit, SubmitState::Unknown | SubmitState::Checking) =>
        {
            PlanStage::Unknown
        }
        Some(i) if matches!(i.submit, SubmitState::Open | SubmitState::Submitting) => {
            if i.kind == RoundKind::Review {
                PlanStage::Review
            } else {
                PlanStage::Questions
            }
        }
        _ if published => PlanStage::Published,
        _ if !continuation => PlanStage::Submitted,
        _ => PlanStage::Planning,
    };
    // The read holds the latest submission only; earlier rounds stay with the daemon.
    let rounds = if submitted_any {
        let sub = &view["interview"]["submission"];
        let answers = arr(&sub["questions"])
            .iter()
            .map(|q| {
                let a = arr(&sub["answers"])
                    .iter()
                    .find(|a| a["questionId"] == q["id"]);
                let meaning = a
                    .map(|a| s(&a["selectedOption"]["meaning"]))
                    .unwrap_or_default();
                let text = a.map(|a| s(&a["text"])).unwrap_or_default();
                RoundAnswer {
                    prompt: s(&q["prompt"]),
                    answer: [meaning.as_str(), text.trim()]
                        .into_iter()
                        .filter(|p| !p.is_empty())
                        .collect::<Vec<_>>()
                        .join(". "),
                }
            })
            .collect();
        vec![RoundLine {
            id: s(&sub["operationId"]),
            title: format!("Round {}", sub["fence"]["questionSetRevision"]),
            line: format!("{} answers, submitted", arr(&sub["answers"]).len()),
            state: RoundState::Submitted,
            answers,
        }]
    } else {
        Vec::new()
    };
    PlanPage {
        mission_id,
        title: String::new(),
        available: true,
        reason: String::new(),
        fresh,
        goal: String::new(),
        route: if plan.is_object() {
            PlanRoute::Wayfinder
        } else {
            PlanRoute::Interview
        },
        stage,
        destination: s(&view["destination"]),
        interview,
        rounds,
        explorations: arr(&plan["questions"])
            .iter()
            .map(|q| exploration(view, q))
            .collect(),
        prototypes: PrototypeSupport {
            available: false,
            line: "Prototypes are not available yet. Pilot does not make or guess one.".into(),
        },
        fog: arr(&plan["fog"]).iter().map(|f| fog(view, f)).collect(),
        proposal: proposal(plan),
        steps,
        note: if fresh {
            String::new()
        } else {
            "This is an older read. Pilot checks again before it saves anything.".into()
        },
    }
}

/// The row of a page, for Today and New.
pub fn row(page: &PlanPage, title: &str) -> PlanRow {
    let line = match (page.stage, &page.interview) {
        (PlanStage::Questions, Some(i)) => {
            format!("{} of {} answered", i.answered, i.questions.len())
        }
        (PlanStage::Review, _) => "The plan is ready for your review".into(),
        (PlanStage::Unknown, _) => "Not confirmed".into(),
        (PlanStage::Submitted, _) => "Submitted. Pilot cannot continue from it here yet".into(),
        (PlanStage::Published, _) => "Published. No work started".into(),
        _ => "Pilot is working on the plan".into(),
    };
    PlanRow {
        mission_id: page.mission_id.clone(),
        title: title.into(),
        stage: page.stage,
        line,
        needs_you: matches!(
            page.stage,
            PlanStage::Questions | PlanStage::Review | PlanStage::Unknown
        ),
    }
}

/// A refusal before anything is sent.
pub type Refusal = (OutcomeStatus, &'static str);

fn check_round(read: &Value, shown: &str) -> Result<(), Refusal> {
    if read["status"] != "available" || read["capabilities"]["answers"] != 1 {
        return Err((
            OutcomeStatus::Rejected,
            "Answers cannot be saved for this mission here.",
        ));
    }
    if interview_id(read).as_deref() != Some(shown) {
        return Err((
            OutcomeStatus::Stale,
            "This interview changed. Read it again; your text is kept here.",
        ));
    }
    Ok(())
}

/// The exact `interview-save` request for one answer: the current saved
/// answers of this question list, with `intent`'s answer replaced.
pub fn save_request(read: &Value, intent: &AnswerIntent) -> Result<(String, Value), Refusal> {
    check_round(read, &intent.interview_id)?;
    let iv = &read["view"]["interview"];
    if iv["submission"]["fence"]["questionSetRevision"] == iv["fence"]["questionSetRevision"] {
        return Err((
            OutcomeStatus::Rejected,
            "These answers were submitted and are fixed.",
        ));
    }
    if iv["fence"]["questionSetRevision"] != json!(intent.question_set) {
        return Err((
            OutcomeStatus::Stale,
            "Pilot changed the questions. Your text is kept here; read them again.",
        ));
    }
    let Some(q) = arr(&iv["questions"])
        .iter()
        .find(|q| q["id"] == json!(intent.question_id))
    else {
        return Err((
            OutcomeStatus::Rejected,
            "That question is not part of this interview. Each interview answers only its own topic.",
        ));
    };
    if read["questionDigests"][&intent.question_id] != json!(intent.digest) {
        return Err((
            OutcomeStatus::Stale,
            "This question changed. Your text is kept here; read it again.",
        ));
    }
    let option = match &intent.choice_id {
        None => Value::Null,
        Some(id) => arr(&q["options"])
            .iter()
            .find(|o| o["id"] == json!(id))
            .cloned()
            .ok_or((
                OutcomeStatus::Stale,
                "That suggestion is no longer offered.",
            ))?,
    };
    let current: Vec<&Value> = arr(&iv["questions"]).iter().map(|q| &q["id"]).collect();
    let mut answers: Vec<Value> = arr(&iv["answers"])
        .iter()
        .filter(|a| {
            a["questionId"] != json!(intent.question_id) && current.contains(&&a["questionId"])
        })
        .cloned()
        .collect();
    answers.push(json!({
        "questionId": intent.question_id,
        "questionDigest": intent.digest,
        "selectedOption": option,
        "text": intent.text,
    }));
    let order = |a: &Value| current.iter().position(|id| **id == a["questionId"]);
    answers.sort_by_key(order);
    if serde_json::to_string(&answers).map_or(usize::MAX, |a| a.len()) > ANSWER_ROOM {
        return Err((
            OutcomeStatus::Rejected,
            "Your answers together are too long to save. Shorten one; your text is kept here.",
        ));
    }
    let request = json!({
        "purpose": "interview-save",
        "expected": {"fence": iv["fence"], "revision": iv["revision"]},
        "answers": answers,
    });
    Ok((s(&read["contextDigest"]), request))
}

/// The exact `interview-submit` request, if `intent` names what the read shows.
pub fn submit_request(read: &Value, intent: &SubmitIntent) -> Result<(String, Value), Refusal> {
    check_round(read, &intent.interview_id)?;
    let iv = &read["view"]["interview"];
    if iv["submission"]["fence"]["questionSetRevision"] == iv["fence"]["questionSetRevision"] {
        return Err((
            OutcomeStatus::Rejected,
            "These answers were already submitted.",
        ));
    }
    if iv["revision"] != json!(intent.revision) {
        return Err((
            OutcomeStatus::Stale,
            "Your saved answers changed since this was shown. Read them and submit again.",
        ));
    }
    let (kind, _, proposal) = round_kind(read);
    if kind == RoundKind::Review && proposal != intent.proposal {
        return Err((
            OutcomeStatus::Stale,
            "The plan changed. Read it again before you answer.",
        ));
    }
    if kind != RoundKind::Review && !intent.proposal.is_empty() {
        return Err((OutcomeStatus::Rejected, "This interview reviews no plan."));
    }
    // Every current question needs the user's own answer; a recommendation,
    // a changed answer or a blank draft is not one.
    let shown = interview(read, &[], &Local::default());
    if shown.is_none_or(|i| i.answered as usize != i.questions.len()) {
        return Err((OutcomeStatus::Rejected, "Answer every question first."));
    }
    let request = json!({
        "purpose": "interview-submit",
        "expected": {"fence": iv["fence"], "revision": iv["revision"]},
    });
    Ok((s(&read["contextDigest"]), request))
}
