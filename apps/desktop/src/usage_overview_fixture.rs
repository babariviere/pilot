//! Synthetic usage only. Reuse the bounded GET-only faux socket owner.
pub(crate) use crate::mission_browser_fixture::{Reply, Server};
use crate::{
    LocalOptions,
    usage_overview::{DAY, Filter, Range, View},
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
#[cfg(feature = "native-probes")]
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
    let url = url(
        options,
        range,
        &Filter::All,
        if buckets {
            View::Buckets
        } else {
            View::Summary
        },
    );
    format!("{}?{}", url.path(), url.query().unwrap())
}
pub(crate) fn install(s: &Server, range: Range) {
    install_filter(s, range, &Filter::All);
}

pub(crate) fn scoped_path(
    options: &LocalOptions,
    range: Range,
    filter: &Filter,
    view: View,
) -> String {
    let url = url(options, range, filter, view);
    format!("{}?{}", url.path(), url.query().unwrap())
}
pub(crate) const PROJECT: &str = "550e8400-e29b-41d4-a716-446655440000";
pub(crate) fn projects(range: Range) -> Value {
    let mut v = report(range, false);
    v["groups"] = json!([
        {"key":json!(PROJECT).to_string(), "aggregate":aggregate()},
        {"key":"null", "aggregate":aggregate()}
    ]);
    v
}
pub(crate) fn install_filter(s: &Server, range: Range, filter: &Filter) {
    s.reply("/api/hello", Reply::json(200, hello()));
    for (view, buckets) in [(View::Summary, false), (View::Buckets, true)] {
        s.reply(
            &scoped_path(&s.options, range, filter, view),
            Reply::json(200, report(range, buckets)),
        );
    }
    s.reply(
        &scoped_path(&s.options, range, &Filter::All, View::Projects),
        Reply::json(200, projects(range)),
    );
}
pub(crate) fn records_request(range: Range) -> crate::usage_overview_records::Request {
    crate::usage_overview_records::Request {
        serial: 1,
        range,
        filter: Filter::All,
        generation: "synthetic-generation".into(),
        after: None,
        boundary: None,
    }
}
pub(crate) fn records(range: Range, start: usize, count: usize, next: bool) -> Value {
    let mut status = report(range, false)["status"].clone();
    status["retainedRows"] = 300.into();
    let mut page = json!({"status":status,"rows":(start..start+count).map(|i| {
        let mut row = json!({"schemaVersion":1,"generation":"synthetic-generation","sourceId":PROJECT,
            "operationId":format!("request-{i:04}"),"revision":2,"kind":"request","scope":"direct",
            "completedAt":range.from + 1000 + i as u64 * 1000,"observedAt":range.from + 2000 + i as u64 * 1000,
            "coverage":"partial","purpose":"agent",
            "cost":{"estimateStatus":"unavailable","billedStatus":"unavailable","subscriptionCoverage":"unknown"}});
        if i.is_multiple_of(2) {
            row["physicalModel"] = json!({"provider":"synthetic","model":"研究 👩‍💻 é long serving model"});
            row["tokens"] = json!({"input":0,"output":12000,"cacheRead":8000,"cacheWrite":0,"reasoningStatus":"unavailable"});
        }
        row
    }).collect::<Vec<_>>()});
    if next {
        page["next"] = format!("opaque-next-{}", start + count).into();
    }
    page
}
pub(crate) fn records_path(
    options: &LocalOptions,
    request: &crate::usage_overview_records::Request,
) -> String {
    let u = crate::usage_overview_records::url(options, request);
    format!("{}?{}", u.path(), u.query().unwrap())
}
