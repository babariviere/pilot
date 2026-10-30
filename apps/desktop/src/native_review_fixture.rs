//! Owned retained-wire examples. Never published as data by the application.
use crate::{
    mission_browser_fixture::{Reply, Server},
    native_review as model,
};
use serde_json::{Value, json};
pub(crate) const ROOT: &str = "/api/missions/mission-A/review";
pub(crate) const PATCH: &str = "diff --git a/a.rs b/a.rs\nindex cccccccccccccccccccccccccccccccccccccccc..dddddddddddddddddddddddddddddddddddddddd 100644\n--- a/a.rs\n+++ b/a.rs\n@@ -1 +1 @@\n-before\n+retained lower\n";
pub(crate) fn comparison(n: u64, kind: &str) -> Value {
    json!({"snapshotId":format!("{n:064x}"),"sequence":n,"capturedAt":1000+n,"status":"complete","request":{
        "requestId":format!("capture-{n}"),"repositoryId":"a".repeat(64),"changeId":"k".repeat(32),"operationId":"b".repeat(128),
        "base":{"changeId":"l".repeat(32),"commitId":"c".repeat(40)},"head":{"changeId":"k".repeat(32),"commitId":"d".repeat(40)},"scope":{"kind":kind},"source":"committed"}})
}
pub(crate) fn snapshot(c: &Value) -> Value {
    let entry = |text: &str, oid: &str| json!({"path":"a.rs","mode":"100644","gitOid":oid.repeat(40),"state":"text","sha256":model::hash(text.as_bytes()),"bytes":text.len()});
    json!({"snapshotId":c["snapshotId"],"request":c["request"],"workerId":"chat-B","capturedAt":c["capturedAt"],"status":c["status"],"enrollmentTaskIds":["task-A"],
        "creation":{"changeId":"k".repeat(32),"commitId":"d".repeat(40),"operationId":"b".repeat(128),"kind":"workspace-created"},"omissions":[],
        "before":[entry("before\n","c")],"after":[entry("retained lower\n","d")],"changes":[{"status":"M","beforePath":"a.rs","afterPath":"a.rs","beforeMode":"100644","afterMode":"100644","beforeOid":"c".repeat(40),"afterOid":"d".repeat(40)}],"diff":{"sha256":model::hash(PATCH.as_bytes()),"bytes":PATCH.len()}})
}
pub(crate) fn install(s: &Server) {
    s.reply(ROOT,Reply::json(200,json!({"missionId":"mission-A","projectId":"project-A","workers":[{"id":"chat-B","title":"Parser worker 日本語 👩‍💻"}],"more":false})));
    let comparisons = vec![comparison(1, "layer"), comparison(2, "stack")];
    s.reply(
        &format!("{ROOT}/chat-B?after=0"),
        Reply::json(200, json!({"comparisons":comparisons,"next":null})),
    );
    for c in comparisons {
        let id = c["snapshotId"].as_str().unwrap();
        s.reply(
            &format!("{ROOT}/chat-B/{id}"),
            Reply::json(200, snapshot(&c)),
        );
        s.reply(
            &format!("{ROOT}/chat-B/{id}/patch"),
            Reply::json(200, json!({"snapshotId":id,"patch":PATCH})),
        );
        s.reply(
            &format!("{ROOT}/chat-B/{id}/records"),
            Reply::json(
                200,
                json!({"assessments":[],"reported":[],"allocations":[],"more":false}),
            ),
        );
        s.reply(
            &format!(
                "{ROOT}/chat-B/{id}/source?side=after&path=a.rs&sha256={}",
                model::hash(b"retained lower\n")
            ),
            Reply::json(200, json!({"snapshotId":id,"text":"retained lower\n"})),
        );
    }
}
