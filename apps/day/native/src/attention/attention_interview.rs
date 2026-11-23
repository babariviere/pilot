//! Standalone round drafts use local JSON at the form boundary, never a chat message.
//! Only native code resolves picks and digests against the exact round.
use crate::{
    attention_host::Refusal,
    model::{AttentionInterviewQuestion, OutcomeStatus},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeSet;

/// Backend's complete answer list limit, in UTF-8 JSON bytes.
pub(crate) const ANSWERS_LIMIT: usize = 48 * 1024;
/// The local JSON draft is itself stored in a JSON string. Leave room for
/// its escaped characters and the journal's draft fields, not more answers.
pub const DRAFT_STORAGE_LIMIT: usize = 2 * ANSWERS_LIMIT + 1024;

pub fn is_draft(value: &Value) -> bool {
    value["text"].as_str().is_some_and(|text| {
        text.len() <= ANSWERS_LIMIT && serde_json::from_str::<RoundDraft>(text).is_ok()
    })
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DraftAnswer {
    question_id: String,
    selected_option_id: Option<String>,
    text: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RoundDraft {
    round_id: String,
    answers: Vec<DraftAnswer>,
}

fn draft(round: &Value, text: &str) -> Option<RoundDraft> {
    if text.len() > ANSWERS_LIMIT {
        return None;
    }
    let draft: RoundDraft = serde_json::from_str(text).ok()?;
    (round["roundId"].as_str() == Some(&draft.round_id)).then_some(draft)
}

/// Drafts may be incomplete, but must name the exact round.
pub(crate) fn matches_draft(round: &Value, text: &str) -> bool {
    draft(round, text).is_some()
}

pub fn project(round: &Value, text: &str) -> Vec<AttentionInterviewQuestion> {
    let saved = draft(round, text);
    round["questions"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|q| {
            let id = q["id"].as_str().unwrap_or_default();
            let answer = saved
                .as_ref()
                .and_then(|d| d.answers.iter().find(|a| a.question_id == id));
            let options = serde_json::from_value(q["options"].clone()).unwrap_or_default();
            AttentionInterviewQuestion {
                id: id.into(),
                section: q["section"].as_str().unwrap_or_default().into(),
                prompt: q["prompt"].as_str().unwrap_or_default().into(),
                context: q["context"].as_str().unwrap_or_default().into(),
                recommended_option_id: q["recommendedOptionId"].as_str().map(str::to_owned),
                selected_option_id: answer.and_then(|a| a.selected_option_id.clone()).filter(
                    |id| {
                        q["options"]
                            .as_array()
                            .is_some_and(|os| os.iter().any(|o| o["id"] == *id))
                    },
                ),
                text: answer.map(|a| a.text.clone()).unwrap_or_default(),
                options,
            }
        })
        .collect()
}

const INCOMPLETE: Refusal = Refusal {
    status: OutcomeStatus::Rejected,
    message: "Answer every question before submitting. Your draft stays here.",
};

/// An unknown submission stays readable even after its question leaves the feed.
pub fn sent(request: &Value) -> Vec<AttentionInterviewQuestion> {
    let round = json!({"roundId":request["interview"]["roundId"],"questions":request["interviewQuestions"]});
    let answers: Vec<Value> = request["interview"]["answers"].as_array().into_iter().flatten()
        .map(|a| json!({"questionId":a["questionId"],"selectedOptionId":a["selectedOption"]["id"],"text":a["text"]})).collect();
    let draft = json!({"roundId":round["roundId"],"answers":answers});
    project(&round, &draft.to_string())
}

pub fn answer(round: &Value, text: &str) -> Result<Value, Refusal> {
    wire_draft(round, text, true).ok_or(INCOMPLETE)
}

/// A save can contain a subset of questions and can store blank answers.
pub(crate) fn partial_answer(round: &Value, text: &str) -> Option<Value> {
    wire_draft(round, text, false)
}

fn wire_answer(round: &Value, q: &Value, a: &DraftAnswer) -> Option<Value> {
    let digest = round["questionDigests"][&a.question_id]
        .as_str()
        .filter(|s| !s.is_empty())?;
    let option = match &a.selected_option_id {
        None => Value::Null,
        Some(id) => q["options"]
            .as_array()?
            .iter()
            .find(|o| o["id"] == *id)
            .map(|o| json!({"id":o["id"],"meaning":o["meaning"]}))?,
    };
    (a.text.len() <= 4000).then(|| {
        json!({"questionId":a.question_id,"questionDigest":digest,"selectedOption":option,"text":a.text})
    })
}

fn within_answer_limit(answers: &[Value]) -> bool {
    // The daemon caps every saved answer list, even when the round is incomplete.
    answers.len() <= 40
        && serde_json::to_vec(answers).is_ok_and(|bytes| bytes.len() <= ANSWERS_LIMIT)
}

fn wire_draft(round: &Value, text: &str, complete: bool) -> Option<Value> {
    let draft = draft(round, text)?;
    let questions = round["questions"].as_array()?;
    if questions.is_empty() || complete && questions.len() != draft.answers.len() {
        return None;
    }
    let mut seen = BTreeSet::new();
    let mut answers = Vec::new();
    for q in questions {
        let id = q["id"].as_str().filter(|s| !s.is_empty())?;
        if !seen.insert(id) {
            return None;
        }
        let Some(a) = draft.answers.iter().find(|a| a.question_id == id) else {
            continue;
        };
        if complete && a.selected_option_id.is_none() && a.text.trim().is_empty() {
            return None;
        }
        answers.push(wire_answer(round, q, a)?);
    }
    // A foreign or repeated ID never gets dropped silently.
    if answers.len() != draft.answers.len() || !within_answer_limit(&answers) {
        return None;
    }
    Some(json!({"roundId":draft.round_id,"answers":answers}))
}

/// Project the daemon record back into the existing RoundDraft JSON shape.
pub(crate) fn saved_text(round: &Value, saved: &Value) -> Option<String> {
    let round_id = round["roundId"].as_str()?;
    let questions = round["questions"].as_array()?;
    let answers = saved["answers"].as_array()?;
    if saved["roundId"] != round_id || !within_answer_limit(answers) {
        return None;
    }
    let mut seen = BTreeSet::new();
    let mut local = RoundDraft {
        round_id: round_id.into(),
        answers: Vec::new(),
    };
    for answer in answers {
        let id = answer["questionId"].as_str()?;
        let q = questions.iter().find(|q| q["id"] == id)?;
        let a = DraftAnswer {
            question_id: id.into(),
            selected_option_id: answer["selectedOption"]["id"].as_str().map(str::to_owned),
            text: answer["text"].as_str()?.into(),
        };
        if !seen.insert(id) || wire_answer(round, q, &a)? != *answer {
            return None;
        }
        local.answers.push(a);
    }
    let text = serde_json::to_string(&local).ok()?;
    (text.len() <= ANSWERS_LIMIT).then_some(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn round() -> Value {
        json!({"roundId":"r1","questionDigests":{"q1":"digest-1","q2":"digest-2"},"questions":[
            {"id":"q1","section":"outcome","prompt":"What changes?","options":[{"id":"a","meaning":"Ship the fix"}],"recommendedOptionId":"a"},
            {"id":"q2","section":"authority","prompt":"Who approves?","options":[],"recommendedOptionId":null}
        ]})
    }
    fn complete() -> Value {
        json!({"roundId":"r1","answers":[
            {"questionId":"q2","selectedOptionId":null,"text":"  Me\n日本  "},
            {"questionId":"q1","selectedOptionId":"a","text":""}
        ]})
    }
    #[test]
    fn drafts_restore_without_turning_recommendations_into_answers() {
        let qs = project(&round(), "");
        assert_eq!(qs.len(), 2);
        assert_eq!(qs[0].recommended_option_id.as_deref(), Some("a"));
        assert_eq!(qs[0].selected_option_id, None);
        let qs = project(&round(), &complete().to_string());
        assert_eq!(qs[0].selected_option_id.as_deref(), Some("a"));
        assert_eq!(qs[1].text, "  Me\n日本  ");
        let mut wrong = complete();
        wrong["roundId"] = json!("r2");
        assert_eq!(project(&round(), &wrong.to_string())[1].text, "");
    }
    #[test]
    fn submission_uses_exact_native_options_and_digests_in_round_order() {
        let result = answer(&round(), &complete().to_string()).unwrap();
        assert_eq!(result["roundId"], "r1");
        assert_eq!(
            result["answers"][0],
            json!({"questionId":"q1","questionDigest":"digest-1","selectedOption":{"id":"a","meaning":"Ship the fix"},"text":""})
        );
        assert_eq!(result["answers"][1]["text"], "  Me\n日本  ");
    }

    #[test]
    fn a_partial_save_keeps_blank_answers_but_refuses_tampered_answers() {
        let round = round();
        let mut local = json!({"roundId":"r1","answers":[
            {"questionId":"q2","selectedOptionId":null,"text":" \n "}
        ]});
        let payload = partial_answer(&round, &local.to_string()).unwrap();
        let projected: Value =
            serde_json::from_str(&saved_text(&round, &payload).unwrap()).unwrap();
        assert_eq!(projected, local);
        assert!(answer(&round, &local.to_string()).is_err());
        let mut tampered = payload;
        tampered["answers"][0]["questionDigest"] = json!("wrong");
        assert!(saved_text(&round, &tampered).is_none());
        local["answers"][0]["selectedOptionId"] = json!("foreign");
        assert!(partial_answer(&round, &local.to_string()).is_none());
        let duplicate = complete()["answers"][0].clone();
        local["answers"] = json!([duplicate, duplicate]);
        assert!(partial_answer(&round, &local.to_string()).is_none());
    }
    #[test]
    fn incomplete_foreign_duplicate_and_tampered_answers_refuse() {
        assert!(answer(&round(), "").is_err());
        let mut d = complete();
        d["roundId"] = json!("other");
        assert!(answer(&round(), &d.to_string()).is_err());
        for (field, value) in [
            ("questionId", json!("q1")),
            ("text", json!(" \n ")),
            ("selectedOptionId", json!("foreign")),
            ("questionDigest", json!("forged")),
        ] {
            let mut d = complete();
            d["answers"][0][field] = value;
            assert!(answer(&round(), &d.to_string()).is_err(), "{field}");
        }
        let mut d = complete();
        d["answers"].as_array_mut().unwrap().pop();
        assert!(answer(&round(), &d.to_string()).is_err());
        let mut r = round();
        r["questionDigests"] = Value::Null;
        assert!(answer(&r, &complete().to_string()).is_err());
    }
    #[test]
    fn full_round_drafts_share_the_48k_limit_not_the_ordinary_reply_limit() {
        let mut r = round();
        let mut qs = Vec::new();
        let mut answers = Vec::new();
        for n in 0..3 {
            let id = format!("q{n}");
            qs.push(json!({"id":id,"options":[]}));
            r["questionDigests"][&id] = json!("digest");
            answers.push(json!({"questionId":id,"selectedOptionId":null,"text":"x".repeat(3500)}));
        }
        r["questions"] = json!(qs);
        let mut d = json!({"roundId":"r1","answers":answers});
        assert!(d.to_string().len() > 8000);
        assert!(answer(&r, &d.to_string()).is_ok());
        d["answers"][0]["text"] = json!("x".repeat(4001));
        assert!(answer(&r, &d.to_string()).is_err());
        d["answers"][0]["text"] = json!("x".repeat(ANSWERS_LIMIT));
        assert!(answer(&r, &d.to_string()).is_err());
    }
}
