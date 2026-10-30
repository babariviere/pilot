//! App-requested limits state, separate from historical usage and agent admission.
use crate::provider_usage::Snapshot;
use serde_json::Value;

#[derive(Default)]
pub(crate) struct State {
    pub(crate) busy: bool,
    pub(crate) snapshots: Vec<Snapshot>,
    pub(crate) status: Option<String>,
}
impl State {
    pub(crate) fn begin(&mut self) -> bool {
        if self.busy {
            return false;
        }
        self.busy = true;
        self.status = Some("Refreshing limits…".into());
        true
    }
    pub(crate) fn merge(&mut self, reports: Vec<Snapshot>) {
        for report in reports {
            if let Some(old) = self
                .snapshots
                .iter_mut()
                .find(|s| s.provider == report.provider)
            {
                if report.update_error {
                    old.update_error = true;
                } else if report.fetched_at > old.fetched_at
                    || (report.fetched_at == old.fetched_at
                        && (report.app_requested || !old.app_requested))
                {
                    *old = report;
                }
            } else {
                self.snapshots.push(report);
            }
        }
        self.snapshots.sort_by_key(|s| s.provider);
    }
    pub(crate) fn finish(&mut self, result: Result<Vec<Value>, &'static str>) {
        self.busy = false;
        let values = match result {
            Ok(values) => values,
            Err(error) => {
                self.status = Some(error.into());
                return;
            }
        };
        let mut statuses = Vec::new();
        for (index, provider) in ["anthropic", "openai"].into_iter().enumerate() {
            let name = if provider == "anthropic" {
                "Claude"
            } else {
                "Codex"
            };
            let Some(value) = values
                .get(index)
                .filter(|v| v["provider"] == provider && v["account"] == "not_reported")
            else {
                statuses.push(format!("{name}: invalid response"));
                continue;
            };
            let state = value["state"].as_str().unwrap_or("error");
            let report = (value["usage"]["provider"] == provider)
                .then(|| Snapshot::read(&value["usage"]))
                .flatten();
            let state = if matches!(state, "refreshed" | "cached")
                && !report
                    .as_ref()
                    .is_some_and(|r| r.fetched_at.is_some() && !r.update_error)
            {
                "error"
            } else {
                state
            };
            if let Some(mut report) = report {
                report.app_requested = true;
                self.merge(vec![report]);
            }
            statuses.push(format!(
                "{name}: {}",
                match state {
                    "refreshed" => "updated",
                    "cached" => "recent cached report",
                    "deferred" => "not refreshed; retry later",
                    "unavailable" => "Pi OAuth unavailable",
                    _ => "refresh failed",
                }
            ));
        }
        self.status = Some(statuses.join(" · "));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn explicit_refresh_retains_report_time_errors_and_rejects_other_provider() {
        let mut s = State::default();
        assert!(s.begin());
        assert!(!s.begin());
        let report = |state, at| json!({"provider":"anthropic","account":"not_reported","state":state,"usage":{"provider":"anthropic","fetchedAt":at,"windows":[{"label":"5h","usedPercent":42}]}});
        let missing = json!({"provider":"openai","account":"not_reported","state":"unavailable"});
        s.finish(Ok(vec![report("refreshed", 1000), missing.clone()]));
        assert_eq!(s.snapshots[0].fetched_at, Some(1000));
        assert!(s.status.as_ref().unwrap().contains("updated"));
        s.finish(Ok(vec![report("cached", 1000), missing.clone()]));
        assert!(s.status.as_ref().unwrap().contains("cached"));
        s.finish(Err("Refresh failed. Previous reports retained."));
        assert_eq!(s.snapshots[0].fetched_at, Some(1000));
        s.finish(Ok(vec![report("refreshed", 500), missing]));
        assert_eq!(
            s.snapshots[0].fetched_at,
            Some(1000),
            "late cached response must not replace a newer summary"
        );
        assert!(
            s.snapshots[0]
                .help()
                .contains("Account identity is not reported")
        );
        s.finish(Ok(vec![
            json!({"provider":"anthropic","account":"not_reported","state":"refreshed"}),
        ]));
        assert!(
            s.status.as_ref().unwrap().contains("refresh failed"),
            "missing reports cannot claim success"
        );
        s.finish(Ok(vec![json!({"provider":"openai","account":"not_reported","state":"refreshed","usage":{"provider":"openai","fetchedAt":2000,"windows":[]}})]));
        assert!(s.status.as_ref().unwrap().contains("invalid response"));
        assert_eq!(s.snapshots.len(), 1, "cross-provider response refused");
    }
}
