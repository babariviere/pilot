//! Words for what Pilot's planning agent does: its step now and its chat
//! rows. Pure functions over the daemon's `PlanningActivity` and
//! `PlanningChatPage` records (packages/protocol/src/planning-activity.ts).
//! A step is activity, not progress. The screen words times against its
//! own clock (activityWords.ts), so a cached page never shows an old "ago".

use serde_json::Value;

use crate::plan::{ChatRole, ChatRow, PlanActivity, PlanChat};

/// A step as a sentence: present while it runs, past once its result is saved.
pub fn step_words(step: &Value) -> String {
    let running = step["running"] != false;
    let tool = step["tool"].as_str().unwrap_or("tool");
    let action = step["action"].as_str().unwrap_or("");
    let target = step["target"].as_str().unwrap_or("");
    let (now, done): (&str, &str) = match (tool, action) {
        ("mission_plan", "read") => ("Reading the mission map", "Read the mission map"),
        ("mission_plan", "questions" | "plan-ask") => {
            ("Writing questions for you", "Wrote questions for you")
        }
        ("mission_plan", "plan-map") => ("Updating the map", "Updated the map"),
        ("mission_plan", "plan-claim") => (
            "Taking the next open question",
            "Took the next open question",
        ),
        ("mission_plan", "plan-resolve") => ("Settling a question", "Settled a question"),
        ("mission_plan", "plan-promote") => {
            ("Turning fog into questions", "Turned fog into questions")
        }
        ("mission_plan", "plan-propose") => ("Writing the plan", "Wrote the plan"),
        ("mission_plan", "plan-review") => (
            "Preparing the plan for your review",
            "Prepared the plan for your review",
        ),
        ("mission_plan", "plan-publish") => (
            "Publishing the plan as tasks",
            "Published the plan as tasks",
        ),
        ("mission_plan", "plan-prototype-result") => {
            ("Saving prototype findings", "Saved prototype findings")
        }
        ("mission_plan", "revision") => ("Drafting a revision", "Drafted a revision"),
        ("mission_plan", "knowledge") | ("knowledge", _) => {
            ("Reading project knowledge", "Read project knowledge")
        }
        ("mission_plan", "check") => ("Checking a saved request", "Checked a saved request"),
        ("mission_plan", _) => ("Working on the plan", "Worked on the plan"),
        ("read", _) if !target.is_empty() => ("Reading", "Read"),
        ("ls", _) if !target.is_empty() => ("Listing", "Listed"),
        ("find", _) if !target.is_empty() => ("Looking through", "Looked through"),
        ("grep", _) if !target.is_empty() => {
            return quoted(running, "Searching for", "Searched for", target);
        }
        ("web" | "browser", _) if target.starts_with("http") => ("Reading", "Read"),
        ("web" | "browser", _) if !target.is_empty() => {
            return quoted(
                running,
                "Searching the web for",
                "Searched the web for",
                target,
            );
        }
        ("read" | "ls" | "find", _) => ("Reading files", "Read files"),
        ("grep", _) => ("Searching files", "Searched files"),
        ("web" | "browser", _) => ("Searching the web", "Searched the web"),
        _ => {
            return format!("{} {tool}", if running { "Using" } else { "Used" });
        }
    };
    let verb = if running { now } else { done };
    let named = matches!(tool, "read" | "ls" | "find" | "web" | "browser") && !target.is_empty();
    if named {
        format!("{verb} {target}")
    } else {
        verb.into()
    }
}

fn quoted(running: bool, now: &str, done: &str, target: &str) -> String {
    format!("{} “{target}”", if running { now } else { done })
}

/// The agent's activity in a planning read. None when the read has no
/// activity record (an older service).
pub fn activity(read: &Value) -> Option<PlanActivity> {
    let a = &read["activity"];
    let working = a["working"].as_bool()?;
    if !working {
        return Some(PlanActivity::default());
    }
    let step = match &a["step"] {
        Value::Object(_) if a["step"]["running"] == true => step_words(&a["step"]),
        Value::Object(_) => "Working on the next step".into(),
        _ => String::new(),
    };
    Some(PlanActivity {
        working,
        step,
        working_since: a["workingSince"].as_u64(),
        last_step_at: a["lastStepAt"].as_u64(),
    })
}

/// The open chat as the host keeps it: daemon rows, oldest first.
pub fn chat(v: &Value) -> PlanChat {
    let rows = v["rows"]
        .as_array()
        .map(|rows| rows.iter().filter_map(row).collect())
        .unwrap_or_default();
    PlanChat {
        reading: v["reading"] == true,
        reason: v["reason"].as_str().unwrap_or_default().into(),
        rows,
        more: v["more"] == true,
    }
}

fn row(r: &Value) -> Option<ChatRow> {
    let key = r["key"].as_str()?.to_owned();
    let text = |r: &Value| r["text"].as_str().unwrap_or_default().to_owned();
    Some(match r["role"].as_str()? {
        "you" => ChatRow {
            key,
            role: ChatRole::You,
            text: text(r),
            shortened: r["shortened"] == true,
            ..ChatRow::default()
        },
        "pilot" => ChatRow {
            key,
            role: ChatRole::Pilot,
            text: text(r),
            shortened: r["shortened"] == true,
            ..ChatRow::default()
        },
        "request" => ChatRow {
            key,
            role: ChatRole::Request,
            text: "Pilot sent it a planning request.".into(),
            ..ChatRow::default()
        },
        "step" => ChatRow {
            key,
            role: ChatRole::Step,
            text: step_words(&r["step"]),
            running: r["step"]["running"] == true,
            failed: r["step"]["failed"] == true,
            ..ChatRow::default()
        },
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn step(tool: &str, running: bool, extra: Value) -> Value {
        let mut v = json!({"tool":tool,"running":running,"failed":false});
        v.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        v
    }

    #[test]
    fn steps_read_as_sentences() {
        assert_eq!(
            step_words(&step("read", true, json!({"target":"docs/a.md"}))),
            "Reading docs/a.md"
        );
        assert_eq!(
            step_words(&step("read", false, json!({"target":"docs/a.md"}))),
            "Read docs/a.md"
        );
        assert_eq!(
            step_words(&step("grep", true, json!({"target":"map"}))),
            "Searching for “map”"
        );
        assert_eq!(
            step_words(&step("web", false, json!({"target":"csv import"}))),
            "Searched the web for “csv import”"
        );
        assert_eq!(
            step_words(&step("web", true, json!({"target":"https://x.dev"}))),
            "Reading https://x.dev"
        );
        assert_eq!(
            step_words(&step("mission_plan", true, json!({"action":"plan-map"}))),
            "Updating the map"
        );
        assert_eq!(
            step_words(&step("mission_plan", false, json!({"action":"questions"}))),
            "Wrote questions for you"
        );
        assert_eq!(
            step_words(&step("mission_plan", true, json!({"action":"new-thing"}))),
            "Working on the plan"
        );
        assert_eq!(step_words(&step("read", true, json!({}))), "Reading files");
        assert_eq!(
            step_words(&step("odd_tool", false, json!({}))),
            "Used odd_tool"
        );
    }

    #[test]
    fn activity_says_what_runs_and_when() {
        let read = |a: Value| json!({"activity": a});
        let running = read(
            json!({"working":true,"workingSince":1_000,"lastStepAt":2_000,
            "step":{"tool":"read","running":true,"failed":false,"target":"docs/a.md"}}),
        );
        assert_eq!(
            activity(&running),
            Some(PlanActivity {
                working: true,
                step: "Reading docs/a.md".into(),
                working_since: Some(1_000),
                last_step_at: Some(2_000),
            })
        );
        let between = read(
            json!({"working":true,"workingSince":null,"lastStepAt":2_000,
            "step":{"tool":"read","running":false,"failed":false}}),
        );
        let between = activity(&between).unwrap();
        assert_eq!(between.step, "Working on the next step");
        assert_eq!(between.working_since, None);
        let unknown =
            read(json!({"working":true,"workingSince":null,"lastStepAt":null,"step":null}));
        assert_eq!(activity(&unknown).unwrap().step, "");
        // Idle: no step or time, even if the record has old ones.
        let idle = read(json!({"working":false,"workingSince":5,"lastStepAt":5,"step":null}));
        assert_eq!(activity(&idle), Some(PlanActivity::default()));
        assert_eq!(activity(&json!({})), None);
    }

    #[test]
    fn chat_rows_keep_their_roles_and_step_state() {
        let v = json!({"reading":false,"reason":"","more":true,"rows":[
            {"key":"1","entryId":1,"role":"request"},
            {"key":"2","entryId":2,"role":"you","text":"Go","shortened":false},
            {"key":"3","entryId":3,"role":"pilot","text":"Long","shortened":true},
            {"key":"3.0","entryId":3,"role":"step","step":{"tool":"read","running":true,"failed":false,"target":"a"}},
            {"key":"3.1","entryId":3,"role":"step","step":{"tool":"read","running":false,"failed":true,"target":"b"}},
            {"key":"4","entryId":4,"role":"admin"}
        ]});
        let c = chat(&v);
        assert!(c.more);
        let roles: Vec<_> = c.rows.iter().map(|r| r.role).collect();
        assert_eq!(
            roles,
            [
                ChatRole::Request,
                ChatRole::You,
                ChatRole::Pilot,
                ChatRole::Step,
                ChatRole::Step
            ]
        );
        assert!(c.rows[2].shortened);
        assert_eq!(
            (c.rows[3].text.as_str(), c.rows[3].running),
            ("Reading a", true)
        );
        assert_eq!(
            (c.rows[4].text.as_str(), c.rows[4].failed),
            ("Read b", true)
        );
    }
}
