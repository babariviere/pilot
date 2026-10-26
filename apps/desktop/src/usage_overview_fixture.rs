//! Synthetic usage only. Reuse the bounded GET-only faux socket owner.
pub(crate) use crate::mission_browser_fixture::{Reply, Server};
use crate::{
    LocalOptions,
    usage_overview::{DAY, Range},
    usage_overview_reader::url,
};
use serde_json::{Value, json};
pub(crate) fn hello() -> Value {
    json!({"daemonId":"test-daemon","lineageId":"test-lineage","protocolVersion":1,"minimumClientProtocolVersion":1,"capabilities":{"independentExecution":true,"usageQueries":1}})
}
pub(crate) fn metric(value: Option<u64>) -> Value {
    json!({"value":value,"known":if value.is_some(){1}else{0},"unknown":if value.is_some(){0}else{1},"partial":0,"overflow":false})
}
pub(crate) fn aggregate() -> Value {
    json!({"records":2,"unpriced":1,"partialPriced":0,"metrics":{"input":{"value":120000,"known":1,"unknown":1,"partial":0,"overflow":false},"output":metric(Some(24000)),"cacheRead":metric(Some(84000)),"estimatedUsdMicros":{"value":320000,"known":1,"unknown":1,"partial":0,"overflow":false}}})
}
pub(crate) fn report(range: Range, buckets: bool) -> Value {
    let groups = if buckets {
        (0..7)
            .filter(|i| i % 3 != 0)
            .map(|i| {
                let mut a = aggregate();
                a["metrics"]["input"] = metric(Some(12000 * (i + 1)));
                json!({"key":(range.from+i*DAY).to_string(),"aggregate":a})
            })
            .collect::<Vec<_>>()
    } else {
        vec![]
    };
    json!({"version":1,"queriedAt":range.to,"status":{"schemaVersion":1,"generation":"synthetic-generation","coverageStartedAt":range.from,"captureFloor":range.from,"retentionFloor":range.from,"coverage":"partial","rejected":0,"conflicts":0,"expired":4,"queueOverflows":0},"total":aggregate(),"reconciliation":{"not":"additive"},"groups":groups,"truncated":false,"coverage":"partial"})
}
pub(crate) fn path(options: &LocalOptions, range: Range, buckets: bool) -> String {
    let url = url(options, range, buckets);
    format!("{}?{}", url.path(), url.query().unwrap())
}
pub(crate) fn install(s: &Server, range: Range) {
    s.reply("/api/hello", Reply::json(200, hello()));
    for buckets in [false, true] {
        s.reply(
            &path(&s.options, range, buckets),
            Reply::json(200, report(range, buckets)),
        );
    }
}
