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
/// One UTC day bucket: `input`/`output` known values, with `missing` records lacking both.
pub(crate) fn day(at: u64, input: u64, output: u64, missing: u64) -> Value {
    let m = |v: u64| json!({"value":v,"known":1,"unknown":missing,"partial":0,"overflow":false});
    let mut a = aggregate();
    a["records"] = (1 + missing).into();
    a["metrics"]["input"] = m(input);
    a["metrics"]["output"] = m(output);
    json!({"key":format!("{at:016}"),"aggregate":a})
}
/// Buckets cover every trend state: Outside (day 0, before collection), complete,
/// known partial subtotal, true zero, counts unavailable and Empty (days 3, 6).
pub(crate) fn report(range: Range, buckets: bool) -> Value {
    let at = |i: u64| range.from + i * DAY;
    let groups = if buckets {
        let mut unknown = aggregate();
        unknown["metrics"]["input"] = json!({"known":0,"unknown":2,"partial":0,"overflow":false});
        unknown["metrics"]["output"] = unknown["metrics"]["input"].clone();
        vec![
            day(at(1), 24000, 24000, 0),
            day(at(2), 36000, 24000, 1),
            day(at(4), 0, 0, 0),
            json!({"key":at(5).to_string(),"aggregate":unknown}),
        ]
    } else {
        vec![]
    };
    json!({"version":1,"queriedAt":range.to,"status":{"schemaVersion":1,"generation":"synthetic-generation","coverageStartedAt":at(1),"captureFloor":range.from,"retentionFloor":range.from,"coverage":"partial","rejected":0,"conflicts":0,"expired":4,"queueOverflows":0},"total":aggregate(),"reconciliation":{"not":"additive"},"groups":groups,"truncated":false,"coverage":"partial"})
}
/// Longer ranges with billions of tokens per day, a 30-day retention floor, and
/// periodic partial, empty and zero days.
pub(crate) fn long_report(range: Range, buckets: bool) -> Value {
    let mut v = report(range, false);
    let floor = range.to.saturating_sub(30 * DAY);
    v["status"]["coverageStartedAt"] = floor.into();
    v["status"]["retentionFloor"] = floor.into();
    if buckets {
        v["groups"] = (range.from..range.to)
            .step_by(DAY as usize)
            .enumerate()
            .filter(|&(i, at)| at + DAY > floor && i % 5 != 3)
            .map(|(i, at)| {
                let i = i as u64;
                let input = if i.is_multiple_of(11) {
                    0
                } else {
                    900_000_000 + i * 37_000_000 % 1_400_000_000
                };
                day(at, input, input / 6, u64::from(i % 4 == 1))
            })
            .collect::<Vec<_>>()
            .into();
    }
    v
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
