//! Turns the request sources in a `DayOverview` (`dashboard.tracked`) into
//! Today's New section. Pure: no clock, transport or storage. A request is
//! new while nobody started or linked work for it and, for Slack, while its
//! status is open. The dashboard holds only a short preview per source, so
//! the section says how many rows it does not show instead of looking
//! complete. Nothing here starts, defers or discards a request.

use crate::{
    contract::{SourceStatus, TrackedItem, TrackedSource},
    model::{Intake, Request, RequestSource},
    project::ago,
};

fn kind_of(source: &TrackedSource) -> RequestSource {
    match source.source.as_str() {
        "slack" => RequestSource::Slack,
        "linear" => RequestSource::Linear,
        _ => RequestSource::Other,
    }
}

/// One plain sentence when `source` cannot be read now, else None.
fn trouble(source: &TrackedSource) -> Option<String> {
    let label = &source.label;
    let reason = source
        .error
        .as_deref()
        .map(str::trim)
        .filter(|e| !e.is_empty())
        .map_or_else(String::new, |e| format!(": {}", e.trim_end_matches('.')));
    match source.status {
        SourceStatus::Idle | SourceStatus::Ok | SourceStatus::Syncing => None,
        SourceStatus::SignInRequired => Some(format!(
            "{label} needs you to sign in again. These are the requests Pilot read before."
        )),
        SourceStatus::Error => Some(format!(
            "Pilot could not read {label}{reason}. These are the requests it read before."
        )),
        SourceStatus::NotConfigured | SourceStatus::Unknown => {
            Some(format!("Pilot cannot tell whether {label} is up to date."))
        }
    }
}

/// Whether `item` is a new request: nothing started or linked for it, and
/// a Slack message is still open.
fn is_new(kind: RequestSource, item: &TrackedItem) -> bool {
    if item.linked() {
        return false;
    }
    match kind {
        RequestSource::Slack => {
            let status = item
                .slack
                .as_ref()
                .map(|s| s.status.as_str())
                .or(item.status.as_deref());
            status == Some("open")
        }
        RequestSource::Linear => !matches!(item.text("statusType"), Some("completed" | "canceled")),
        RequestSource::Other => true,
    }
}

fn capitalized(word: &str) -> String {
    let mut chars = word.chars();
    chars.next().map_or_else(String::new, |first| {
        first.to_uppercase().chain(chars).collect::<String>()
    })
}

fn slack_kind(item: &TrackedItem) -> String {
    let Some(triage) = &item.slack else {
        return String::new();
    };
    let mut parts = Vec::new();
    match triage.kind.as_str() {
        "bug" | "question" | "request" => parts.push(capitalized(&triage.kind)),
        _ => {}
    }
    if matches!(triage.severity.as_str(), "high" | "critical") {
        parts.push(triage.severity.clone());
    }
    let kind = parts.join(", ");
    match triage
        .label
        .as_deref()
        .map(str::trim)
        .filter(|l| !l.is_empty())
    {
        Some(label) if kind.is_empty() => label.to_owned(),
        Some(label) => format!("{kind} · {label}"),
        None => kind,
    }
}

fn request(kind: RequestSource, source: &TrackedSource, item: &TrackedItem, now: u64) -> Request {
    let place = match kind {
        RequestSource::Slack => item
            .text("channelName")
            .map(|name| format!("#{}", name.trim_start_matches('#')))
            .unwrap_or_default(),
        RequestSource::Linear => item.text("identifier").unwrap_or_default().to_owned(),
        RequestSource::Other => String::new(),
    };
    let what = match kind {
        RequestSource::Slack => slack_kind(item),
        _ => item
            .status
            .as_deref()
            .map(str::trim)
            .unwrap_or_default()
            .to_owned(),
    };
    Request {
        id: item.id.clone(),
        source: kind,
        source_label: source.label.clone(),
        title: item.title.trim().to_owned(),
        place,
        kind: what,
        age: item.updated_at.map_or_else(String::new, |at| ago(now, at)),
        link: item
            .url
            .as_deref()
            .filter(|u| u.starts_with("https://"))
            .unwrap_or_default()
            .to_owned(),
    }
}

/// How many rows of `source` the read counts but does not hold, as "7 more
/// Slack messages". Linear's finished issues are not new, so they are not
/// counted.
fn unshown(kind: RequestSource, source: &TrackedSource) -> Option<(u32, String)> {
    let finished = source.done.as_ref().map_or(0, |d| d.total);
    let held = u32::try_from(source.items.len()).unwrap_or(u32::MAX);
    let n = source
        .total
        .saturating_sub(held)
        .saturating_sub(match kind {
            RequestSource::Linear => finished,
            _ => 0,
        });
    if n == 0 {
        return None;
    }
    let noun = match (kind, n) {
        (RequestSource::Slack, 1) => "message",
        (RequestSource::Slack, _) => "messages",
        (RequestSource::Linear, 1) => "issue",
        (RequestSource::Linear, _) => "issues",
        (_, 1) => "request",
        _ => "requests",
    };
    Some((n, format!("{n} more {} {noun}", source.label)))
}

/// Today's New section from the read's request sources at `now`.
pub fn intake(sources: &[TrackedSource], now: u64) -> Intake {
    let sources: Vec<&TrackedSource> = sources
        .iter()
        .filter(|s| s.status != SourceStatus::NotConfigured)
        .collect();
    let mut requests: Vec<(Option<u64>, Request)> = Vec::new();
    let mut more = Vec::new();
    let mut trouble_lines = Vec::new();
    for source in &sources {
        let kind = kind_of(source);
        trouble_lines.extend(trouble(source));
        more.extend(unshown(kind, source));
        requests.extend(
            source
                .items
                .iter()
                .filter(|item| is_new(kind, item))
                .map(|item| (item.updated_at, request(kind, source, item, now))),
        );
    }
    // Newest first; a request without a time goes last, in the read's order.
    requests.sort_by(|a, b| b.0.cmp(&a.0));
    let count: u32 = more.iter().map(|(n, _)| n).sum();
    let more = if more.is_empty() {
        String::new()
    } else {
        format!(
            "{} {} not shown here.",
            more.iter()
                .map(|(_, line)| line.as_str())
                .collect::<Vec<_>>()
                .join(" and "),
            if count == 1 { "is" } else { "are" }
        )
    };
    Intake {
        watched: !sources.is_empty(),
        sources: sources.iter().map(|s| s.label.clone()).collect(),
        requests: requests.into_iter().map(|(_, r)| r).collect(),
        trouble: trouble_lines,
        more,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        contract::{Section, SlackTriage},
        project::MINUTE,
    };

    const NOW: u64 = 1_794_229_320_000;

    fn slack_item(id: &str, status: &str, minutes_ago: u64) -> TrackedItem {
        let mut metadata = serde_json::Map::new();
        metadata.insert("channelName".into(), "client-northwind".into());
        TrackedItem {
            id: id.into(),
            title: format!("Request {id}"),
            url: Some(format!("https://example.slack.com/archives/C1/p{id}")),
            status: Some(status.into()),
            updated_at: Some(NOW - minutes_ago * MINUTE),
            metadata,
            slack: Some(SlackTriage {
                kind: "bug".into(),
                label: None,
                severity: "high".into(),
                status: status.into(),
            }),
            ..TrackedItem::default()
        }
    }

    fn slack(items: Vec<TrackedItem>, total: u32) -> TrackedSource {
        TrackedSource {
            source: "slack".into(),
            label: "Slack".into(),
            status: SourceStatus::Idle,
            total,
            items,
            ..TrackedSource::default()
        }
    }

    #[test]
    fn only_open_unstarted_requests_are_new_newest_first() {
        let mut started = slack_item("s3", "open", 1);
        started.session_id = Some("chat".into());
        let mut linked = slack_item("s4", "open", 2);
        linked.mission_ids = vec!["m1".into()];
        let sources = [slack(
            vec![
                slack_item("s1", "open", 30),
                slack_item("s2", "open", 4),
                started,
                linked,
                slack_item("s5", "waiting", 5),
                slack_item("s6", "done", 6),
            ],
            6,
        )];
        let intake = intake(&sources, NOW);
        assert!(intake.watched);
        let ids: Vec<&str> = intake.requests.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, ["s2", "s1"]);
        let first = &intake.requests[0];
        assert_eq!(first.source, RequestSource::Slack);
        assert_eq!(first.place, "#client-northwind");
        assert_eq!(first.kind, "Bug, high");
        assert_eq!(first.age, "4 min ago");
        assert!(first.link.starts_with("https://"));
        assert!(intake.trouble.is_empty());
        assert_eq!(intake.more, "");
    }

    #[test]
    fn rows_the_preview_does_not_hold_are_counted_never_hidden() {
        let mut linear = TrackedSource {
            source: "linear".into(),
            label: "Linear".into(),
            status: SourceStatus::Ok,
            total: 9,
            items: vec![TrackedItem {
                id: "l1".into(),
                title: "CSV export times out".into(),
                status: Some("Todo".into()),
                ..TrackedItem::default()
            }],
            done: Some(Section {
                total: 3,
                items: Vec::new(),
            }),
            ..TrackedSource::default()
        };
        linear.items[0]
            .metadata
            .insert("identifier".into(), "BIL-231".into());
        let sources = [slack(vec![slack_item("s1", "open", 1)], 13), linear];
        let intake = intake(&sources, NOW);
        assert_eq!(intake.sources, ["Slack", "Linear"]);
        assert_eq!(
            intake.more,
            "12 more Slack messages and 5 more Linear issues are not shown here."
        );
        let issue = &intake.requests[1];
        assert_eq!(
            (issue.place.as_str(), issue.kind.as_str()),
            ("BIL-231", "Todo")
        );
        assert_eq!(issue.age, "", "no time is never guessed");
        let one = intake_one_more();
        assert_eq!(one, "1 more Slack message is not shown here.");
    }

    fn intake_one_more() -> String {
        intake(&[slack(vec![slack_item("s1", "open", 1)], 2)], NOW).more
    }

    #[test]
    fn a_source_that_cannot_be_read_says_so_and_keeps_its_rows() {
        let mut signed_out = slack(vec![slack_item("s1", "open", 1)], 1);
        signed_out.status = SourceStatus::SignInRequired;
        let mut failed = slack(Vec::new(), 0);
        failed.label = "Linear".into();
        failed.source = "linear".into();
        failed.status = SourceStatus::Error;
        failed.error = Some("rate limited.".into());
        let mut odd = slack(Vec::new(), 0);
        odd.label = "Jira".into();
        odd.source = "jira".into();
        odd.status = SourceStatus::Unknown;
        let intake = intake(&[signed_out, failed, odd], NOW);
        assert_eq!(intake.requests.len(), 1);
        assert_eq!(
            intake.trouble,
            [
                "Slack needs you to sign in again. These are the requests Pilot read before.",
                "Pilot could not read Linear: rate limited. These are the requests it read before.",
                "Pilot cannot tell whether Jira is up to date.",
            ]
        );
    }

    #[test]
    fn no_source_means_no_new_section_not_an_empty_one() {
        let none = intake(&[], NOW);
        assert!(!none.watched && none.requests.is_empty() && none.more.is_empty());
        let mut off = slack(Vec::new(), 0);
        off.status = SourceStatus::NotConfigured;
        assert!(!intake(&[off], NOW).watched);
    }

    #[test]
    fn a_daemon_shaped_source_reads_with_unknown_fields_ignored() {
        let json = r#"{
            "source": "slack", "label": "Slack", "status": "sign_in_required", "total": 1,
            "commonCases": [],
            "items": [{ "id": "t1", "title": "Northwind can't export invoices to CSV",
                "url": "https://example.slack.com/archives/C1/p1", "status": "open", "updatedAt": 1794229000000,
                "externalId": "C1:1.0", "caseId": "k1",
                "metadata": { "channel": "C1", "channelName": "client-northwind", "replies": 2, "severity": "high" },
                "slack": { "type": "bug", "label": null, "severity": "high", "status": "open", "overrides": {} } }]
        }"#;
        let source: TrackedSource = serde_json::from_str(json).unwrap();
        assert_eq!(source.status, SourceStatus::SignInRequired);
        let odd: TrackedSource =
            serde_json::from_str(&json.replace("sign_in_required", "paused")).unwrap();
        assert_eq!(odd.status, SourceStatus::Unknown);
        let intake = intake(&[source], NOW);
        assert_eq!(
            intake.requests[0].title,
            "Northwind can't export invoices to CSV"
        );
    }
}
