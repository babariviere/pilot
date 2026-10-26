//! Local analytics v1 only. Totals come from `total`, never pages/checkpoints.
use serde::Deserialize;
use std::collections::BTreeMap;
pub(crate) const DAY: u64 = 86_400_000;
pub(crate) const WIRE_CAP: usize = 512 * 1024;
const SAFE: u64 = 9_007_199_254_740_991;
pub(crate) type Failure = &'static str;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Range {
    pub(crate) from: u64,
    pub(crate) to: u64,
}
impl Range {
    pub(crate) fn preset(days: u64, now: u64) -> Option<Self> {
        if ![7, 30, 90].contains(&days) || now >= SAFE {
            return None;
        }
        Some(Self {
            from: (now / DAY * DAY).saturating_sub((days - 1) * DAY),
            to: now + 1,
        })
    }
    pub(crate) fn valid(self) -> bool {
        self.to > self.from
            && self.to <= SAFE
            && self.to - self.from <= 90 * DAY
            && self.from.is_multiple_of(DAY)
    }
    pub(crate) fn label(self) -> String {
        format!("{} to {} UTC", date(self.from), date(self.to - 1))
    }
}
pub(crate) fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(SAFE as u128) as u64
}
// Gregorian civil date from UTC epoch days, independent of local timezone/DST.
pub(crate) fn date(ms: u64) -> String {
    let z = (ms / DAY) as i64 + 719468;
    let era = z / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let mut y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    y += i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}
pub(crate) fn stamp(ms: u64) -> String {
    format!(
        "{} {:02}:{:02}:{:02} UTC",
        date(ms),
        ms / 3_600_000 % 24,
        ms / 60_000 % 60,
        ms / 1000 % 60
    )
}
#[derive(Clone, Debug, Deserialize)]
pub(crate) struct Metric {
    pub(crate) value: Option<u64>,
    pub(crate) known: u64,
    pub(crate) unknown: u64,
    pub(crate) partial: u64,
    pub(crate) overflow: bool,
}
impl Metric {
    fn valid(&self) -> bool {
        [self.known, self.unknown, self.partial]
            .into_iter()
            .all(|n| n <= SAFE)
            && self.partial <= self.known
            && self.value.is_none_or(|n| n <= SAFE)
            && !(self.overflow && self.value.is_some())
            && !(self.known == 0 && self.value.is_some())
    }
    pub(crate) fn label(&self, cost: bool) -> String {
        if self.overflow {
            return "Overflow".into();
        }
        let Some(value) = self.value.filter(|_| self.known > 0) else {
            return "Unknown".into();
        };
        let suffix = if self.unknown > 0 || self.partial > 0 {
            " · partial"
        } else {
            ""
        };
        if cost {
            if value > 0 && value < 100 {
                format!("≈ ${:.6}{suffix}", value as f64 / 1_000_000.)
            } else {
                format!("≈ ${:.4}{suffix}", value as f64 / 1_000_000.)
            }
        } else {
            format!("{value}{suffix}")
        }
    }
    pub(crate) fn coverage(&self) -> String {
        format!(
            "{} known, {} unknown, {} incomplete",
            self.known, self.unknown, self.partial
        )
    }
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Aggregate {
    pub(crate) records: u64,
    pub(crate) unpriced: u64,
    pub(crate) partial_priced: u64,
    pub(crate) metrics: BTreeMap<String, Metric>,
}
impl Aggregate {
    pub(crate) fn metric(&self, key: &str) -> Option<&Metric> {
        self.metrics.get(key)
    }
    fn valid(&self) -> bool {
        self.records <= 50_000
            && self.unpriced <= self.records
            && self.partial_priced <= self.records
            && self.metrics.len() <= 16
            && self.metrics.values().all(Metric::valid)
    }
    pub(crate) fn tokens(&self) -> Option<u64> {
        let a = self.metric("input")?;
        let b = self.metric("output")?;
        if a.overflow
            || b.overflow
            || a.unknown > 0
            || b.unknown > 0
            || a.partial > 0
            || b.partial > 0
        {
            return None;
        }
        a.value?.checked_add(b.value?).filter(|v| *v <= SAFE)
    }
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Status {
    pub(crate) schema_version: u32,
    pub(crate) generation: String,
    pub(crate) coverage_started_at: u64,
    pub(crate) capture_floor: u64,
    pub(crate) retention_floor: u64,
    pub(crate) coverage: String,
    pub(crate) rejected: u64,
    pub(crate) conflicts: u64,
    pub(crate) expired: u64,
    pub(crate) queue_overflows: u64,
}
#[derive(Clone, Debug, Deserialize)]
pub(crate) struct Group {
    pub(crate) key: String,
    pub(crate) aggregate: Aggregate,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Report {
    pub(crate) version: u32,
    pub(crate) queried_at: u64,
    pub(crate) status: Status,
    pub(crate) total: Aggregate,
    pub(crate) groups: Vec<Group>,
    pub(crate) next: Option<String>,
    pub(crate) truncated: bool,
    pub(crate) coverage: String,
}
impl Report {
    pub(crate) fn parse(
        value: serde_json::Value,
        range: Range,
        buckets: bool,
    ) -> Result<Self, Failure> {
        let report: Self = serde_json::from_value(value)
            .map_err(|_| "Malformed Local usage response. Missing evidence is not zero.")?;
        let s = &report.status;
        if !range.valid()
            || report.version != 1
            || s.schema_version != 1
            || report.coverage != "partial"
            || s.coverage != "partial"
            || s.generation.is_empty()
            || s.generation.len() > 128
            || report.queried_at > SAFE
            || [
                s.coverage_started_at,
                s.capture_floor,
                s.retention_floor,
                s.rejected,
                s.conflicts,
                s.expired,
                s.queue_overflows,
            ]
            .into_iter()
            .any(|n| n > SAFE)
            || !report.total.valid()
            || report.groups.len() > 100
            || (!buckets && !report.groups.is_empty())
            || report.truncated
            || report.next.is_some()
        {
            return Err(
                "Local usage response is unsupported or truncated. No partial trend or invented totals shown.",
            );
        }
        // The daemon orders bucket keys as text. Validate uniqueness separately,
        // then sort numerically after decoding.
        let mut seen = std::collections::HashSet::new();
        for group in &report.groups {
            let at = group
                .key
                .parse::<u64>()
                .map_err(|_| "Invalid UTC usage bucket.")?;
            if !at.is_multiple_of(DAY)
                || at < range.from
                || at >= range.to
                || !seen.insert(at)
                || !group.aggregate.valid()
            {
                return Err("Invalid or duplicate UTC usage bucket.");
            }
        }
        Ok(report)
    }
}
#[derive(Clone, Debug)]
pub(crate) struct Snapshot {
    pub(crate) range: Range,
    pub(crate) summary: Report,
    pub(crate) trend: Result<Report, Failure>,
}
#[derive(Default)]
pub(crate) struct State {
    pub(crate) serial: u64,
    pub(crate) range: Option<Range>,
    pub(crate) busy: bool,
    pub(crate) snapshot: Option<Snapshot>,
    pub(crate) error: Option<Failure>,
}
impl State {
    pub(crate) fn begin(&mut self, range: Range) -> u64 {
        self.serial += 1;
        if self.range.is_some_and(|r| r.from != range.from) {
            self.snapshot = None;
        }
        self.range = Some(range);
        self.busy = true;
        self.error = None;
        self.serial
    }
    pub(crate) fn accept(
        &mut self,
        serial: u64,
        range: Range,
        result: Result<Snapshot, Failure>,
    ) -> bool {
        if self.serial != serial || self.range != Some(range) || !self.busy {
            return false;
        }
        self.busy = false;
        match result {
            Ok(s) => {
                self.snapshot = Some(s);
                self.error = None;
            }
            Err(e) => self.error = Some(e),
        }
        true
    }
}
#[cfg(test)]
#[path = "usage_overview_tests.rs"]
mod tests;
