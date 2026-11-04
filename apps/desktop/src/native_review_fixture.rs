//! Owned retained-wire examples. Never published as data by the application.
//! The request list shape is the proposed global source, not backend evidence.
use crate::{
    mission_browser_fixture::{Reply, Server},
    native_review as model,
};
use serde_json::{Value, json};
/// The global list, unfiltered and narrowed to one chat.
pub(crate) const REQUESTS: &str = "/api/review/requests?after=0";
pub(crate) fn requests_from(chat: &str) -> String {
    format!("{REQUESTS}&sessionId={chat}")
}
pub(crate) fn chat(id: &str) -> String {
    format!("/api/sessions/{id}/review")
}
/// The project each fixture chat is listed in; its reads expect exactly that project.
pub(crate) fn project_of(chat: &str) -> &'static str {
    if chat == "chat-N" {
        "project-B"
    } else {
        EXPECTED
    }
}
pub(crate) const EXPECTED: &str = "project-A";
/// A chat route as the reader requests it: with the listed project last.
pub(crate) fn at(path: &str) -> String {
    let Some(rest) = path.strip_prefix("/api/sessions/") else {
        return path.into();
    };
    let chat = rest.split('/').next().unwrap();
    let sep = if path.contains('?') { '&' } else { '?' };
    format!("{path}{sep}expectedProjectId={}", project_of(chat))
}
/// Replies to the route as requested with the expected project.
pub(crate) fn reply(s: &Server, path: &str, reply: Reply) {
    s.reply(&at(path), reply);
}
/// The mission worker chat whose revisions most journeys read.
pub(crate) const ROOT: &str = "/api/sessions/chat-B/review";
pub(crate) const PATCH: &str = "diff --git a/a.rs b/a.rs\nindex cccccccccccccccccccccccccccccccccccccccc..dddddddddddddddddddddddddddddddddddddddd 100644\n--- a/a.rs\n+++ b/a.rs\n@@ -1 +1 @@\n-before\n+retained lower\n";
pub(crate) fn comparison(n: u64, kind: &str) -> Value {
    json!({"snapshotId":format!("{n:064x}"),"sequence":n,"capturedAt":1000+n,"status":"complete","request":{
        "requestId":format!("capture-{n}"),"repositoryId":"a".repeat(64),"changeId":"k".repeat(32),"operationId":"b".repeat(128),
        "base":{"changeId":"l".repeat(32),"commitId":"c".repeat(40)},"head":{"changeId":"k".repeat(32),"commitId":"d".repeat(40)},"scope":{"kind":kind},"source":"committed"}})
}
pub(crate) fn snapshot(c: &Value) -> Value {
    snapshot_of(c, "chat-B")
}
/// The retained manifest of `c`, created by exactly `chat`.
pub(crate) fn snapshot_of(c: &Value, chat: &str) -> Value {
    let entry = |text: &str, oid: &str| json!({"path":"a.rs","mode":"100644","gitOid":oid.repeat(40),"state":"text","sha256":model::hash(text.as_bytes()),"bytes":text.len()});
    json!({"snapshotId":c["snapshotId"],"request":c["request"],"workerId":chat,"capturedAt":c["capturedAt"],"status":c["status"],"enrollmentTaskIds":["task-A"],
        "creation":{"changeId":"k".repeat(32),"commitId":"d".repeat(40),"operationId":"b".repeat(128),"kind":"workspace-created"},"omissions":[],
        "before":[entry("before\n","c")],"after":[entry("retained lower\n","d")],"changes":[{"status":"M","beforePath":"a.rs","afterPath":"a.rs","beforeMode":"100644","afterMode":"100644","beforeOid":"c".repeat(40),"afterOid":"d".repeat(40)}],"diff":{"sha256":model::hash(PATCH.as_bytes()),"bytes":PATCH.len()}})
}

/// A project-owned (v2) capture of `c` by a standalone `chat`: no task scope.
pub(crate) fn standalone(c: &Value, chat: &str) -> Value {
    let mut v = snapshot_of(c, chat);
    v["enrollmentTaskIds"] = json!([]);
    v["enrollmentProjectId"] = json!(project_of(chat));
    v
}
/// Three files in one retained comparison: modified, added under a long path, deleted.
#[cfg(feature = "native-probes")]
pub(crate) fn multi(c: &Value) -> (Value, String) {
    let long =
        "src/review/very/long/directory/name/that/keeps/going/retained_comparison_view_日本語.rs";
    let patch = format!(
        "{PATCH}diff --git a/{long} b/{long}\nnew file mode 100644\nindex 0000000000000000000000000000000000000000..eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\n--- /dev/null\n+++ b/{long}\n@@ -0,0 +1,2 @@\n+fn added() {{}}\n+// second line\ndiff --git a/old.txt b/old.txt\ndeleted file mode 100644\nindex ffffffffffffffffffffffffffffffffffffffff..0000000000000000000000000000000000000000\n--- a/old.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n"
    );
    let entry = |path: &str, text: &str, oid: &str| json!({"path":path,"mode":"100644","gitOid":oid.repeat(40),"state":"text","sha256":model::hash(text.as_bytes()),"bytes":text.len()});
    let mut m = snapshot(c);
    m["before"] = json!([
        entry("a.rs", "before\n", "c"),
        entry("old.txt", "gone\n", "f")
    ]);
    m["after"] = json!([
        entry("a.rs", "retained lower\n", "d"),
        entry(long, "fn added() {}\n// second line\n", "e")
    ]);
    m["changes"] = json!([
        {"status":"M","beforePath":"a.rs","afterPath":"a.rs","beforeMode":"100644","afterMode":"100644","beforeOid":"c".repeat(40),"afterOid":"d".repeat(40)},
        {"status":"A","beforePath":null,"afterPath":long,"beforeMode":"000000","afterMode":"100644","beforeOid":"0".repeat(40),"afterOid":"e".repeat(40)},
        {"status":"D","beforePath":"old.txt","afterPath":null,"beforeMode":"100644","afterMode":"000000","beforeOid":"f".repeat(40),"afterOid":"0".repeat(40)}
    ]);
    m["diff"] = json!({"sha256":model::hash(patch.as_bytes()),"bytes":patch.len()});
    (m, patch)
}

/// Another chat's comparison: same sequence number, different exact snapshot.
pub(crate) fn other(n: u64) -> Value {
    let mut c = comparison(n, "layer");
    c["snapshotId"] = json!(format!("{:064x}", 0xc000 + n));
    c["request"]["requestId"] = json!(format!("capture-c-{n}"));
    c
}
/// A standalone chat's change in another repository and project.
pub(crate) fn owned(n: u64) -> Value {
    let mut c = other(n);
    c["request"]["repositoryId"] = json!("e".repeat(64));
    c
}
pub(crate) fn request(id: &str, seq: u64, chat: &str, title: &str, c: &Value) -> Value {
    json!({"requestId":id,"sequence":seq,"state":"pending","actionability":"waiting","projectId":project_of(chat),"sessionId":chat,"title":title,"comparison":c})
}
pub(crate) const PARSER: &str = "Parse quoted strings 日本語 👩‍💻";
/// The default list: two revisions from one mission chat (one ready, one still waiting on
/// checks and agent review), one from another chat, and a standalone chat's project-owned
/// change in another project whose readiness is unknown.
pub(crate) fn requests() -> Vec<Value> {
    let mut v = vec![
        request("req-1", 1, "chat-B", PARSER, &comparison(1, "layer")),
        request("req-2", 2, "chat-B", PARSER, &comparison(2, "stack")),
        request("req-3", 3, "chat-C", "Lex numeric literals", &other(1)),
        request("req-4", 4, "chat-N", "Add standalone notes", &owned(5)),
    ];
    v[0]["actionability"] = json!("ready");
    v[3]["actionability"] = json!("unknown");
    v
}
pub(crate) fn list(requests: Vec<Value>) -> Value {
    json!({"requests":requests,"next":null})
}
fn install_chat(s: &Server, chat: &str, comparisons: Vec<Value>) {
    let root = self::chat(chat);
    reply(
        s,
        &format!("{root}?after=0"),
        Reply::json(200, json!({"comparisons":comparisons,"next":null})),
    );
    for c in comparisons {
        let id = c["snapshotId"].as_str().unwrap();
        let manifest = if chat == "chat-N" {
            standalone(&c, chat)
        } else {
            snapshot_of(&c, chat)
        };
        reply(s, &format!("{root}/{id}"), Reply::json(200, manifest));
        reply(
            s,
            &format!("{root}/{id}/patch"),
            Reply::json(200, json!({"snapshotId":id,"patch":PATCH})),
        );
        reply(
            s,
            &format!("{root}/{id}/records"),
            Reply::json(
                200,
                json!({"assessments":[],"reported":[],"allocations":[],"more":false}),
            ),
        );
        reply(
            s,
            &format!(
                "{root}/{id}/source?side=after&path=a.rs&sha256={}",
                model::hash(b"retained lower\n")
            ),
            Reply::json(200, json!({"snapshotId":id,"text":"retained lower\n"})),
        );
    }
}
pub(crate) fn install(s: &Server) {
    let all = requests();
    s.reply(REQUESTS, Reply::json(200, list(all.clone())));
    for chat in ["chat-B", "chat-C", "chat-N", "chat-S"] {
        let mine = all
            .iter()
            .filter(|r| r["sessionId"] == chat)
            .cloned()
            .collect();
        s.reply(&requests_from(chat), Reply::json(200, list(mine)));
    }
    install_chat(
        s,
        "chat-B",
        vec![comparison(1, "layer"), comparison(2, "stack")],
    );
    // After chat-B moves to project-B here, its saved list is read under that project.
    s.reply(
        &format!("{}?after=0&expectedProjectId=project-B", chat("chat-B")),
        Reply::json(
            200,
            json!({"comparisons":[comparison(1, "layer"), comparison(2, "stack")],"next":null}),
        ),
    );
    // chat-C also has a later saved revision nobody requested review for.
    install_chat(s, "chat-C", vec![other(1), other(2)]);
    install_chat(s, "chat-N", vec![owned(5)]);
    // A standalone chat without retained custody: an honest Not captured state.
    reply(
        s,
        &format!("{}?after=0", chat("chat-S")),
        Reply::json(
            200,
            json!({"comparisons":[],"next":null,"unavailable":"Not captured. No retained managed ownership binding for this chat. Reading does not enroll, capture or migrate existing work."}),
        ),
    );
}
