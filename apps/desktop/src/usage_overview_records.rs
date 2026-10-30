//! One replaceable page of dated requests. Never an accounting reducer.
use crate::{
    LocalOptions,
    usage_overview::{self as model, Failure, Filter, Range, Status},
};
use serde_json::{Value, json};
use std::time::Duration;
pub(crate) const LIMIT: usize = 25;
pub(crate) const RESET: Failure =
    "Records cursor refused. Previous page cleared; refresh history before reopening records.";
type Key = (u64, String, String);

#[derive(Clone, Debug)]
pub(crate) struct Row {
    pub(crate) key: Key,
    pub(crate) value: Value,
}
impl Row {
    pub(crate) fn id(&self) -> String {
        // Source and operation together are the API identity, not a session ID.
        json!([self.value["generation"], self.key.1, self.key.2]).to_string()
    }
    pub(crate) fn json(&self) -> String {
        serde_json::to_string_pretty(&self.value).expect("JSON value")
    }
    pub(crate) fn counts(&self) -> String {
        let count = |name| {
            self.value["tokens"][name]
                .as_u64()
                .map(model::grouped)
                .unwrap_or_else(|| "Unknown".into())
        };
        format!(
            "Input {} · output {} · cache read {} · cache write {}",
            count("input"),
            count("output"),
            count("cacheRead"),
            count("cacheWrite")
        )
    }
    pub(crate) fn costs(&self) -> String {
        let cost = &self.value["cost"];
        let estimate = cost["estimatedUsdMicros"]
            .as_u64()
            .map(|n| format!("${}.{:06}", n / 1_000_000, n % 1_000_000))
            .unwrap_or_else(|| "Unknown".into());
        format!(
            "Catalog estimate (not billed): {estimate} · {}. Billed cost: unavailable.",
            cost["estimateStatus"].as_str().unwrap_or("unavailable")
        )
    }
}
#[derive(Clone, Debug)]
pub(crate) struct Page {
    pub(crate) rows: Vec<Row>,
    pub(crate) next: Option<String>,
    pub(crate) status: Status,
    // The endpoint supplies no queriedAt. This is a client receipt time only.
    pub(crate) received_at: u64,
}
#[derive(Clone, Debug)]
pub(crate) struct Request {
    pub(crate) serial: u64,
    pub(crate) range: Range,
    pub(crate) filter: Filter,
    pub(crate) generation: String,
    pub(crate) after: Option<String>,
    pub(crate) boundary: Option<Key>,
}
pub(crate) fn url(options: &LocalOptions, request: &Request) -> reqwest::Url {
    let host = options.host();
    let mut query =
        json!({"kind":"request","from":request.range.from,"to":request.range.to,"limit":LIMIT});
    match &request.filter {
        Filter::All => {}
        Filter::Project(id) => query["filters"] = json!({"projectId":id}),
        Filter::Unattributed => query["filters"] = json!({"missing":["project"]}),
    }
    if let Some(after) = &request.after {
        query["after"] = after.clone().into();
    }
    let mut url = reqwest::Url::parse(&format!("{}/api/usage-history/page", options.loopback()))
        .expect("loopback URL");
    url.query_pairs_mut()
        .append_pair("daemonId", &host.daemon_id)
        .append_pair("lineageId", &host.lineage_id)
        .append_pair("query", &query.to_string());
    url
}
impl Page {
    pub(crate) fn parse(value: Value, request: &Request) -> Result<Self, Failure> {
        // Erasure takes precedence even when the remaining payload is malformed.
        if value["status"]["generation"]
            .as_str()
            .is_some_and(|g| g != request.generation)
        {
            return Err(model::ERASED);
        }
        let status: Status = serde_json::from_value(value["status"].clone())
            .map_err(|_| "Malformed records status.")?;
        let safe = |v: &Value| v.as_u64().is_some_and(|n| n <= 9_007_199_254_740_991);
        if status.schema_version != 1
            || status.coverage != "partial"
            || status.generation != request.generation
            || [
                "coverageStartedAt",
                "captureFloor",
                "retentionFloor",
                "retainedRows",
                "rejected",
                "conflicts",
                "expired",
                "queueOverflows",
            ]
            .iter()
            .any(|k| !safe(&value["status"][k]))
        {
            return Err("Unsupported records status.");
        }
        let rows = value["rows"].as_array().ok_or("Malformed records page.")?;
        let next = match value.get("next") {
            None => None,
            Some(Value::String(s))
                if !s.is_empty() && s.len() <= 1024 && request.after.as_ref() != Some(s) =>
            {
                Some(s.clone())
            }
            _ => return Err(RESET),
        };
        if rows.len() > LIMIT || (next.is_some() && rows.len() != LIMIT) {
            return Err(RESET);
        }
        let mut boundary = request.boundary.clone();
        let mut seen = std::collections::HashSet::new();
        let mut parsed = Vec::with_capacity(rows.len());
        for v in rows {
            if v["generation"].as_str() != Some(&request.generation) {
                return Err(model::ERASED);
            }
            let source = v["sourceId"].as_str().ok_or("Missing record source ID.")?;
            let operation = v["operationId"]
                .as_str()
                .ok_or("Missing record operation ID.")?;
            let at = v["completedAt"]
                .as_u64()
                .ok_or("Missing dated request time.")?;
            let observed = v["observedAt"]
                .as_u64()
                .ok_or("Missing observation time.")?;
            let key = (at, source.to_owned(), operation.to_owned());
            let attribution = &v["attribution"];
            let filter_matches = match &request.filter {
                Filter::All => true,
                Filter::Project(id) => attribution["projectId"].as_str() == Some(id),
                Filter::Unattributed => attribution.get("projectId").is_none(),
            };
            if v["schemaVersion"] != 1
                || v["kind"] != "request"
                || v["scope"] != "direct"
                || !matches!(
                    v["coverage"].as_str(),
                    Some("committed" | "partial" | "legacy")
                )
                || v["purpose"].as_str().is_none()
                || !safe(&v["revision"])
                || v["revision"] == 0
                || uuid::Uuid::parse_str(source).is_err()
                || operation.is_empty()
                || at < request.range.from
                || at >= request.range.to
                || observed < at
                || !safe(&v["observedAt"])
                || !filter_matches
                || boundary.as_ref().is_some_and(|b| &key <= b)
                || !seen.insert((source, operation))
            {
                return Err(RESET);
            }
            if let Some(tokens) = v.get("tokens")
                && ["input", "output", "cacheRead", "cacheWrite"]
                    .iter()
                    .any(|k| !safe(&tokens[k]))
            {
                return Err("Malformed record token counts.");
            }
            // The current ledger explicitly has no billed amounts. Do not turn
            // a future/unsupported cost contract into an invented billing claim.
            if let Some(cost) = v.get("cost")
                && (cost["billedStatus"] != "unavailable"
                    || cost.get("billedUsdMicros").is_some()
                    || !matches!(
                        cost["estimateStatus"].as_str(),
                        Some("catalog_estimate" | "partial_catalog_estimate" | "unavailable")
                    )
                    || cost.get("estimatedUsdMicros").is_some_and(|v| !safe(v)))
            {
                return Err("Unsupported record cost evidence.");
            }
            if let Some(cost) = v.get("cost") {
                let unavailable = cost["estimateStatus"] == "unavailable";
                if unavailable != cost.get("estimatedUsdMicros").is_none()
                    || unavailable != cost.get("pricingRevision").is_none()
                    || (!unavailable && cost["pricingRevision"].as_str().is_none())
                {
                    return Err("Incomplete record pricing evidence.");
                }
            }
            boundary = Some(key.clone());
            parsed.push(Row {
                key,
                value: v.clone(),
            });
        }
        Ok(Self {
            rows: parsed,
            next,
            status,
            received_at: model::now(),
        })
    }
}
pub(crate) async fn fetch(
    client: &reqwest::Client,
    options: &LocalOptions,
    request: &Request,
) -> Result<Page, Failure> {
    if !request.range.valid()
        || !request.filter.valid()
        || request
            .after
            .as_ref()
            .is_some_and(|s| s.is_empty() || s.len() > 1024)
    {
        return Err(RESET);
    }
    let hello = crate::local_client::hello(client, options).await?;
    if hello["capabilities"]["usageQueries"] != 1 {
        return Err("Local does not support usage queries v1.");
    }
    let value = crate::usage_overview_reader::get(client, url(options, request)).await?;
    let page = Page::parse(value, request)?;
    crate::local_client::hello(client, options).await?;
    Ok(page)
}

#[derive(Default)]
pub(crate) struct State {
    pub(crate) serial: u64,
    pub(crate) open: bool,
    pub(crate) busy: bool,
    pub(crate) page: Option<Page>,
    pub(crate) error: Option<Failure>,
    pub(crate) expanded: Option<String>,
}
impl State {
    pub(crate) fn clear(&mut self) {
        let serial = self.serial + 1;
        *self = Self {
            serial,
            ..Self::default()
        };
    }
    pub(crate) fn begin(&mut self) -> u64 {
        self.serial += 1;
        self.busy = true;
        self.error = None;
        self.serial
    }
    pub(crate) fn accept(&mut self, serial: u64, result: Result<Page, Failure>) -> bool {
        if serial != self.serial || !self.open || !self.busy {
            return false;
        }
        self.busy = false;
        match result {
            Ok(page) => {
                self.page = Some(page);
                self.expanded = None;
                self.error = None;
            }
            Err(error) => {
                if error == model::ERASED || error == RESET {
                    self.page = None;
                    self.expanded = None;
                }
                self.error = Some(error);
            }
        }
        true
    }
}
// The page lane is dropped on every history/filter/range replacement. Closing
// its sender cancels the HTTP future, not merely adoption of its response.
pub(crate) struct Reader {
    commands: async_channel::Sender<Request>,
}
pub(crate) struct Response {
    pub(crate) request: Request,
    pub(crate) result: Result<Page, Failure>,
}
impl Reader {
    pub(crate) fn start(
        options: LocalOptions,
    ) -> Result<(Self, async_channel::Receiver<Response>), Failure> {
        let (commands, events) = async_channel::bounded::<Request>(1);
        let (updates, output) = async_channel::bounded(1);
        std::thread::Builder::new().name("local-usage-records".into()).spawn(move || {
            let run = || -> Result<(), ()> {
                let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|_| ())?;
                let client = reqwest::Client::builder().no_proxy().retry(reqwest::retry::never()).redirect(reqwest::redirect::Policy::none()).connect_timeout(Duration::from_secs(2)).timeout(Duration::from_secs(5)).build().map_err(|_| ())?;
                rt.block_on(async {
                    while let Ok(request) = events.recv().await {
                        let result = tokio::select! { biased; _ = events.recv() => return, result = fetch(&client, &options, &request) => result };
                        if updates.send(Response { request, result }).await.is_err() { return; }
                    }
                });
                Ok(())
            };
            let _ = run();
            events.close();
        }).map_err(|_| "Cannot start Local records reader.")?;
        Ok((Self { commands }, output))
    }
    pub(crate) fn request(&self, request: Request) -> bool {
        self.commands.try_send(request).is_ok()
    }
}
impl Drop for Reader {
    fn drop(&mut self) {
        self.commands.close();
    }
}

#[cfg(test)]
#[path = "usage_overview_records_tests.rs"]
mod tests;
