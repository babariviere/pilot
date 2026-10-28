//! Passive provider snapshots forwarded by Local, independent of token/cost accounting.
use crate::local_model::{self, Chat};
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Snapshot {
    pub(crate) provider: &'static str,
    pub(crate) fetched_at: Option<u64>,
    pub(crate) windows: Vec<Window>,
    // Provider errors may contain account details. Never retain their raw text.
    pub(crate) update_error: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Window {
    pub(crate) label: String,
    pub(crate) value: String,
    pub(crate) basis_points: u16,
    pub(crate) warning: bool,
    pub(crate) extra: bool,
    pub(crate) resets_at: Option<i64>,
}

impl Snapshot {
    pub(crate) fn read(v: &Value) -> Option<Self> {
        let provider = match v["provider"].as_str()? {
            "anthropic" => "Claude",
            "openai" => "Codex",
            _ => return None,
        };
        let windows = v["windows"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|w| {
                let percent = w["usedPercent"]
                    .as_f64()
                    .filter(|p| p.is_finite() && *p >= 0.)?;
                let label = local_model::bounded(w["label"].as_str()?.trim(), 80);
                if label.is_empty() {
                    return None;
                }
                let extra = label.starts_with("Extra");
                let value = if extra {
                    // pi reports extra spend in the label, not as a rate-limit window.
                    let rest = label.trim_start_matches("Extra").trim();
                    let rest = rest
                        .strip_prefix('[')
                        .and_then(|s| s.split_once(']'))
                        .map_or(rest, |(_, s)| s.trim());
                    if rest.is_empty() {
                        format!("{percent:.0}%")
                    } else {
                        rest.to_owned()
                    }
                } else {
                    format!("{percent:.0}% used")
                };
                Some(Window {
                    label: if extra { "Extra usage".into() } else { label },
                    value,
                    basis_points: (percent.clamp(0., 100.) * 100.).round() as u16,
                    warning: !extra && percent >= 80.,
                    extra,
                    resets_at: w["resetsAt"]
                        .as_str()
                        .and_then(crate::subscription_pause::parse_iso),
                })
            })
            .collect();
        Some(Self {
            provider,
            fetched_at: v["fetchedAt"]
                .as_f64()
                .filter(|ms| (0. ..=253_402_300_799_999.).contains(ms))
                .map(|ms| ms as u64),
            windows,
            update_error: v["error"].as_str().is_some_and(|e| !e.is_empty()),
        })
    }

    pub(crate) fn freshness(&self, now_ms: u64) -> String {
        match self.fetched_at {
            None => "Time unknown".into(),
            Some(at) if at > now_ms => "Report time is in the future".into(),
            Some(at) if now_ms - at > 10 * 60 * 1000 => "Not recent".into(),
            Some(at) => format!("Reported {}m ago", (now_ms - at) / 60_000),
        }
    }
    pub(crate) fn help(&self) -> String {
        format!(
            "{} subscription snapshot from loaded Local chat summaries. Reported: {}. Updates arrive while a session uses this subscription. Not a live measurement, billing total or complete account coverage. Separate from Local token and cost Usage.",
            self.provider,
            self.fetched_at
                .map(crate::message_time::detail)
                .unwrap_or_else(|| "Unknown".into())
        )
    }
}

impl Window {
    pub(crate) fn reset(&self, now: i64) -> String {
        if self.extra {
            return "Provider-reported spend".into();
        }
        match self.resets_at {
            Some(at) if at <= now => "Reset passed · awaiting report".into(),
            Some(at) => format!("Resets {}", crate::subscription_pause::clock(at, now)),
            None => "Reset unknown".into(),
        }
    }
}

/// Same source as Swift Home: newest forwarded snapshot per known provider.
/// A failed or empty report is still meaningful and must not disappear.
pub(crate) fn newest(chats: &[Chat]) -> Vec<Snapshot> {
    ["Claude", "Codex"]
        .into_iter()
        .filter_map(|provider| {
            chats
                .iter()
                .filter_map(|c| c.subscription_usage.as_ref())
                .filter(|s| s.provider == provider)
                .max_by_key(|s| s.fetched_at)
                .cloned()
        })
        .collect()
}

#[cfg(test)]
#[path = "provider_usage_tests.rs"]
mod tests;
