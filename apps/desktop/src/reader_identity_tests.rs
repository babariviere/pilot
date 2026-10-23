//! Real reducer snapshots, never handcrafted stable render IDs.
use crate::{
    local_model::LiveTranscript,
    model::{Message, ReaderKey},
};
use serde_json::{Value, json};
fn entry(id: u64, text: &str) -> Value {
    json!({"id":id,"head":id,"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"thinking","thinking":"hidden synthetic reasoning"},{"type":"text","text":text}]}]})
}
fn fresh(entries: Vec<Value>) -> Vec<Message> {
    let mut reducer = LiveTranscript::default();
    reducer.apply(&json!({"type":"snapshot","entries":entries}));
    reducer.rows()
}
#[test]
fn canonical_reader_reopen_does_not_alias_reallocated_render_numbers() {
    let first = fresh(vec![entry(20, "OLD entry20")]);
    let key = first[0].reader_key().unwrap();
    assert_eq!(key, ReaderKey::model(20, 0, Some(1)));
    for values in [
        vec![entry(20, "OLD entry20"), entry(30, "NEW entry30")],
        vec![entry(30, "NEW entry30"), entry(20, "OLD entry20")],
    ] {
        let reopened = fresh(values);
        let matches: Vec<_> = reopened.iter().filter(|m| m.matches_reader(&key)).collect();
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].source(), "OLD entry20");
        assert!(
            reopened
                .iter()
                .all(|m| !m.source().contains("hidden synthetic"))
        );
    }
    let reopened = fresh(vec![entry(20, "OLD entry20"), entry(30, "NEW entry30")]);
    assert_eq!(
        reopened
            .iter()
            .find(|m| m.source() == "NEW entry30")
            .unwrap()
            .id(),
        first[0].id(),
        "reproduces the old numeric collision"
    );
    let missing = fresh(vec![entry(30, "NEW entry30")]);
    assert_eq!(missing[0].id(), first[0].id());
    assert!(
        !missing[0].matches_reader(&key),
        "missing canonical marker cannot fall back to the same numeric render key"
    );
}
#[test]
fn canonical_reader_qualifies_models_and_blocks_including_collapsed_projection() {
    let original = json!({"id":20,"head":20,"kind":"pi.assistant","model":[
        {"role":"user","content":"model0"},
        {"role":"assistant","content":[{"type":"thinking","thinking":"hidden"},{"type":"text","text":"model1 block1"},{"type":"text","text":"model1 block2"}]},
        {"role":"assistant","content":[{"type":"text","text":"model2 block0"}]}
    ]});
    let keys: Vec<_> = fresh(vec![original.clone()])
        .iter()
        .map(|m| (m.reader_key().unwrap(), m.source().to_string()))
        .collect();
    let reopened = fresh(vec![entry(30, "new"), original]);
    for (key, text) in keys {
        assert_eq!(
            reopened.iter().filter(|m| m.matches_reader(&key)).count(),
            1
        );
        assert_eq!(
            reopened
                .iter()
                .find(|m| m.matches_reader(&key))
                .unwrap()
                .source(),
            text
        );
    }
    let collapsed = fresh(vec![entry(20, &"x".repeat(1024 * 1024 + 1))]);
    assert_eq!(
        collapsed[0].reader_key(),
        Some(ReaderKey::model(20, 0, None))
    );
    assert!(!collapsed[0].matches_reader(&ReaderKey::model(20, 0, Some(1))));
}
#[test]
fn canonical_reader_live_promotion_keeps_render_key_but_acquires_entry_identity() {
    for thinking in [false, true] {
        let content = if thinking {
            json!([{"type":"thinking","thinking":"private"},{"type":"text","text":"promoted answer"}])
        } else {
            json!([{"type":"text","text":"promoted answer"}])
        };
        let mut reducer = LiveTranscript::default();
        reducer.apply(&json!({"type":"message_start","message":{"timestamp":12,"role":"assistant","content":content}}));
        let live = reducer.rows();
        assert_eq!(live.len(), 1);
        assert!(
            live[0].reader_key().is_none(),
            "uncommitted text has no invented canonical identity"
        );
        let committed = json!({"id":20,"head":20,"kind":"pi.assistant","model":[{"role":"assistant","content":content}]});
        reducer.apply(&json!({"type":"message_end","entry":committed}));
        let promoted = reducer.rows();
        assert_eq!(promoted[0].id(), live[0].id());
        let key = promoted[0].reader_key().unwrap();
        assert_eq!(key, ReaderKey::model(20, 0, Some(usize::from(thinking))));
        let reopened = fresh(vec![committed, entry(30, "later")]);
        assert_eq!(
            reopened
                .iter()
                .find(|m| m.matches_reader(&key))
                .unwrap()
                .source(),
            "promoted answer"
        );
    }
}
#[test]
fn canonical_reader_tool_groups_survive_regroup_and_live_commit() {
    let note = entry(10, "note before the call");
    let note_key = fresh(vec![note.clone()])[0].reader_key().unwrap();
    let call = json!({"id":20,"head":20,"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"thinking","thinking":"hidden"},{"type":"toolCall","id":"call-a","name":"read","arguments":{"path":"/synthetic/a"}}]}]});
    let result = json!({"id":21,"head":21,"kind":"pi.tool_result","model":[{"role":"toolResult","toolCallId":"call-a","content":"synthetic result"}]});
    let original = fresh(vec![note.clone(), call.clone(), result.clone()]);
    let key = original[0].reader_key().unwrap();
    assert_eq!(key, ReaderKey::Tool("call-a".into()));
    assert!(
        original[0].matches_reader(&note_key),
        "group retains contributing canonical note identity"
    );
    let separator =
        json!({"id":25,"head":25,"kind":"pi.user","model":[{"role":"user","content":"new turn"}]});
    let other = json!({"id":30,"head":30,"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"toolCall","id":"call-b","name":"read","arguments":{"path":"/synthetic/b"}}]}]});
    for values in [
        vec![
            note.clone(),
            call.clone(),
            result.clone(),
            separator.clone(),
            other.clone(),
        ],
        vec![other, separator, result.clone(), call.clone(), note],
    ] {
        let reopened = fresh(values);
        let group = reopened.iter().find(|m| m.matches_reader(&key)).unwrap();
        assert_eq!(
            group.work_data().unwrap().calls().next().unwrap().id,
            "call-a"
        );
        assert_eq!(
            reopened.iter().filter(|m| m.matches_reader(&key)).count(),
            1
        );
    }
    let mut live = LiveTranscript::default();
    live.apply(&json!({"type":"message_start","message":{"timestamp":42,"role":"assistant","content":call["model"][0]["content"]}}));
    let live_key = live.rows()[0].reader_key().unwrap();
    live.apply(&json!({"type":"message_end","entry":call.clone()}));
    assert!(live.rows()[0].matches_reader(&live_key));
    assert!(fresh(vec![result, call])[0].matches_reader(&live_key));
}

#[test]
fn canonical_reader_never_truncates_tool_identity() {
    let entries = json!({"id":20,"head":20,"kind":"pi.assistant","model":[{"role":"assistant","content":[
        {"type":"text","text":"visible note"},
        {"type":"toolCall","id":"x".repeat(300),"name":"read","arguments":{}},
        {"type":"toolCall","id":"x".repeat(301),"name":"read","arguments":{}}
    ]}]});
    let rows = fresh(vec![entries]);
    assert_eq!(rows.len(), 3);
    assert!(rows.iter().all(|m| m.work_data().is_none()));
    let keys: std::collections::BTreeSet<_> = rows.iter().map(Message::id).collect();
    assert_eq!(
        keys.len(),
        rows.len(),
        "invalid tool placeholders still need distinct render keys"
    );
    for (block, row) in rows.iter().enumerate() {
        assert_eq!(row.reader_key(), Some(ReaderKey::model(20, 0, Some(block))));
    }
}

#[test]
fn canonical_reader_lookup_refuses_ambiguous_or_unqualified_render_matches() {
    let key = ReaderKey::model(20, 0, Some(1));
    let first = Message::live(7, "assistant".into(), "old".into()).anchored(key.clone());
    let duplicate = Message::live(8, "assistant".into(), "other".into()).anchored(key.clone());
    assert_eq!(crate::model::reader_index(&[first.clone()], &key), Some(0));
    assert_eq!(crate::model::reader_index(&[first, duplicate], &key), None);
    assert_eq!(
        crate::model::reader_index(&[Message::live(7, "assistant".into(), "new".into())], &key),
        None
    );
    assert!(Message::tool_ref(7, "").reader_key().is_none());
    assert!(
        Message::tool_ref(7, &"x".repeat(257))
            .reader_key()
            .is_none()
    );
}
