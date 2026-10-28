use super::*;
use serde_json::json;

const ID: &str = "0f8e3c2a-9b1d-4e7f-a5c6-1d2e3f4a5b6c";

fn chat(raw: Value) -> Chat {
    crate::local_model::chat(&raw).unwrap()
}

#[test]
fn path_is_only_the_reported_absolute_session_folder() {
    let c =
        chat(json!({"id":ID,"cwd":"/synthetic/project","sessionPath":"/data/sessions/0f8e 私"}));
    assert_eq!(c.session_path.as_deref(), Some("/data/sessions/0f8e 私"));
    for missing in [
        json!({"id":ID,"cwd":"/synthetic/project"}),
        json!({"id":ID,"cwd":"/synthetic/project","sessionPath":"relative/sessions"}),
        json!({"id":ID,"cwd":"/synthetic/project","sessionPath":""}),
        json!({"id":ID,"cwd":"/synthetic/project","sessionPath":"/a\u{0}b"}),
        json!({"id":ID,"cwd":"/synthetic/project","sessionPath":7}),
    ] {
        // Never derived from cwd, project or title.
        assert_eq!(chat(missing).session_path, None);
    }
}

#[test]
fn link_matches_swift_canonical_chat_url_without_changing_identity() {
    assert_eq!(
        link(&chat(json!({"id":ID}))).as_deref(),
        Some("pilot://chat/0f8e3c2a-9b1d-4e7f-a5c6-1d2e3f4a5b6c")
    );
    for id in [
        "0F8E3C2A-9B1D-4E7F-A5C6-1D2E3F4A5B6C",
        "synthetic",
        "0f8e3c2a9b1d4e7fa5c61d2e3f4a5b6c",
        "0f8e3c2a-9b1d-4e7f-a5c6-1d2e3f4a5b6",
        "0f8e3c2a-9b1d-4e7f-a5c6-1d2e3f4a5b6g",
    ] {
        assert_eq!(link(&chat(json!({"id":id}))), None, "{id}");
    }
    let mut draft = chat(json!({"id":ID}));
    draft.local_draft = true;
    assert_eq!(link(&draft), None);
}
