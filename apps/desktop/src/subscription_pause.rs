//! Read-only projection of SessionSummary.subscriptionPause and the words for its
//! composer row. pilotd owns the policy (hold at 95%, resume on reset, Force);
//! this only describes it and explains what continuing with another model does.
use crate::chat_models::Catalog;
use serde_json::Value;

/// pilotd holds work once a window reaches this share.
const LIMIT_PERCENT: u32 = 95;

#[derive(Clone, Debug, PartialEq, Eq)]
struct Window {
    provider: &'static str,
    label: String,
    percent: Option<u32>,
    resets_at: Option<i64>,
}
impl Window {
    fn read(v: &Value) -> Option<Self> {
        let label = v["label"]
            .as_str()
            .filter(|l| !l.is_empty() && l.len() <= 64)?;
        Some(Self {
            provider: provider_name(v["provider"].as_str()),
            label: label.into(),
            percent: v["usedPercent"]
                .as_f64()
                .filter(|p| p.is_finite() && *p >= 0.)
                .map(|p| p.round().min(9999.) as u32),
            resets_at: v["resetsAt"].as_str().and_then(parse_iso),
        })
    }
    /// "5h" is "5-hour", "Week" is "weekly", like the Swift app.
    fn limit_name(&self) -> String {
        let lower = self.label.to_lowercase();
        if lower.starts_with("extra") {
            return "extra usage".into();
        }
        if let Some(hours) = lower
            .strip_suffix('h')
            .filter(|h| !h.is_empty())
            .and_then(|h| h.parse::<u32>().ok())
        {
            return format!("{hours}-hour");
        }
        if matches!(lower.as_str(), "week" | "weekly" | "7d") {
            return "weekly".into();
        }
        lower
    }
    fn percent_label(&self) -> String {
        self.percent
            .map(|p| format!("{p}%"))
            .unwrap_or_else(|| "Unknown".into())
    }
}
fn provider_name(provider: Option<&str>) -> &'static str {
    match provider {
        Some("anthropic") => "Claude",
        Some("openai") => "Codex",
        _ => "Subscription",
    }
}

/// A chat held at a usage limit, or forced past it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Pause {
    pub(crate) forced: bool,
    windows: Vec<Window>,
    /// Catalog provider the chat's subscription usage bills through, when reported.
    physical_provider: Option<&'static str>,
}
impl Pause {
    pub(crate) fn read(v: &Value) -> Option<Self> {
        let p = &v["subscriptionPause"];
        if !p.is_object() {
            return None;
        }
        Some(Self {
            forced: p["forced"] == true,
            windows: p["windows"]
                .as_array()
                .map(|w| w.iter().take(16).filter_map(Window::read).collect())
                .unwrap_or_default(),
            physical_provider: match v["usage"]["subscription"]["provider"].as_str() {
                Some("anthropic") => Some("anthropic"),
                Some("openai") => Some("openai-codex"),
                _ => None,
            },
        })
    }
    /// The window that decides when work resumes: the latest reset, else the most used.
    fn deciding(&self) -> Option<&Window> {
        self.windows
            .iter()
            .filter(|w| w.resets_at.is_some())
            .max_by_key(|w| w.resets_at)
            .or_else(|| self.windows.iter().max_by_key(|w| w.percent))
    }
    /// "Paused at Claude 5-hour limit · resumes at 18:00", or when forced,
    /// "Working past usage limit · Claude 5-hour at 97%".
    pub(crate) fn notice(&self, now: i64) -> String {
        let window = self.deciding();
        if self.forced {
            let mut text = String::from("Working past usage limit");
            if let Some(w) = window {
                text += &format!(
                    " · {} {} at {}",
                    w.provider,
                    w.limit_name(),
                    w.percent_label()
                );
            }
            return text;
        }
        let mut text = window
            .map(|w| format!("Paused at {} {} limit", w.provider, w.limit_name()))
            .unwrap_or_else(|| "Paused at usage limit".into());
        match window
            .and_then(|w| w.resets_at)
            .filter(|reset| *reset > now)
        {
            Some(reset) => text += &format!(" · resumes {}", clock(reset, now)),
            None => text += " · resumes when usage resets",
        }
        text
    }
    pub(crate) fn help(&self, now: i64) -> String {
        let mut lines = vec![if self.forced {
            format!(
                "Working past the {LIMIT_PERCENT}% usage limit. Pause at limit holds work again until usage resets."
            )
        } else {
            format!(
                "Pilot holds new work at {LIMIT_PERCENT}% of a usage window and resumes on its own once it resets."
            )
        }];
        for w in &self.windows {
            let mut line = format!(
                "{} {}: {} used",
                w.provider,
                w.limit_name(),
                w.percent_label()
            );
            if let Some(reset) = w.resets_at {
                line += &format!(", resets {}", clock(reset, now));
            }
            lines.push(line);
        }
        lines.join("\n")
    }
    /// Same chat only when the current model's provider (catalog, else ID prefix)
    /// matches the target's, and so does the reported physical subscription
    /// provider. Mirrors pilotd's continue-model decision.
    pub(crate) fn continuation(
        &self,
        current: Option<&str>,
        target: &str,
        catalog: &Catalog,
    ) -> Continuation {
        match (provider(current, catalog), provider(Some(target), catalog)) {
            (Some(from), Some(to))
                if from == to && self.physical_provider.is_none_or(|p| p == to) =>
            {
                Continuation::SameChat
            }
            _ => Continuation::NewChat,
        }
    }
}
fn provider<'a>(model: Option<&'a str>, catalog: &'a Catalog) -> Option<&'a str> {
    let model = model.filter(|m| !m.is_empty())?;
    catalog
        .models
        .iter()
        .find(|m| m.id == model)
        .map(|m| m.provider.as_str())
        .or_else(|| model.split_once('/').map(|(p, _)| p))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Continuation {
    /// Same provider: this chat switches model and keeps its history; the same limit holds it.
    SameChat,
    /// Another provider: a new chat starts from a plain-text handoff; this one becomes read-only.
    NewChat,
}
impl Continuation {
    pub(crate) fn confirm(self) -> &'static str {
        match self {
            Self::SameChat => "Switch model",
            Self::NewChat => "Start new chat",
        }
    }
    pub(crate) fn explanation(self, model: &str) -> String {
        match self {
            Self::SameChat => format!(
                "Same provider and limit. This chat switches to {model} and keeps its history, but work waits for the reset unless you force work."
            ),
            Self::NewChat => format!(
                "Different provider. Pilot starts a new chat with {model} from a plain-text summary of this one, including its branch, pull requests and tasks. Provider context isn't reused, and this chat becomes read-only. Usage limits still apply."
            ),
        }
    }
}
pub(crate) const PICKER_HELP: &str = "A model from the same provider stays in this chat and shares its limit. Another provider starts a new chat with a plain-text handoff.";

pub(crate) fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// RFC 3339 with Z or an offset and an optional fraction, as seconds since the epoch.
pub(crate) fn parse_iso(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 20
        || b[4] != b'-'
        || b[7] != b'-'
        || !matches!(b[10], b'T' | b't')
        || b[13] != b':'
        || b[16] != b':'
    {
        return None;
    }
    let num = |r: std::ops::Range<usize>| -> Option<i64> {
        s.get(r)
            .filter(|d| d.bytes().all(|c| c.is_ascii_digit()))?
            .parse()
            .ok()
    };
    let (year, month, day) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (hour, minute, second) = (num(11..13)?, num(14..16)?, num(17..19)?);
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }
    let mut rest = s.get(19..)?;
    if let Some(fraction) = rest.strip_prefix('.') {
        let digits = fraction.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 {
            return None;
        }
        rest = &fraction[digits..];
    }
    let offset = if rest == "Z" || rest == "z" {
        0
    } else {
        let r = rest.as_bytes();
        let sign = match r.first()? {
            b'+' => 1,
            b'-' => -1,
            _ => return None,
        };
        if r.len() != 6 || r[3] != b':' {
            return None;
        }
        let h: i64 = rest.get(1..3)?.parse().ok()?;
        let m: i64 = rest.get(4..6)?.parse().ok()?;
        sign * (h * 3600 + m * 60)
    };
    Some(days_from_civil(year, month, day) * 86_400 + hour * 3600 + minute * 60 + second - offset)
}
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}
fn civil_from_days(z: i64) -> (i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (m, d)
}
pub(crate) fn local_offset(t: i64) -> i64 {
    let t = t as libc::time_t;
    // SAFETY: localtime_r only writes the struct it is given.
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    if unsafe { libc::localtime_r(&t, &mut tm) }.is_null() {
        0
    } else {
        tm.tm_gmtoff as i64
    }
}
/// "at 18:00", "tomorrow at 09:00", "on Tue at 06:34" within a week, else "on 20 Oct at 06:34".
pub(crate) fn clock(at: i64, now: i64) -> String {
    clock_with(at, now, local_offset)
}
fn clock_with(at: i64, now: i64, offset: impl Fn(i64) -> i64) -> String {
    let local = at + offset(at);
    let day = local.div_euclid(86_400);
    let days = day - (now + offset(now)).div_euclid(86_400);
    let secs = local.rem_euclid(86_400);
    let time = format!("{:02}:{:02}", secs / 3600, secs % 3600 / 60);
    match days {
        0 => format!("at {time}"),
        1 => format!("tomorrow at {time}"),
        2..=6 => {
            // Day 0 of the epoch was a Thursday.
            const DAYS: [&str; 7] = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];
            format!("on {} at {time}", DAYS[day.rem_euclid(7) as usize])
        }
        _ => {
            const MONTHS: [&str; 12] = [
                "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
            ];
            let (month, d) = civil_from_days(day);
            format!("on {d} {} at {time}", MONTHS[(month - 1) as usize])
        }
    }
}

#[cfg(test)]
#[path = "subscription_pause_tests.rs"]
mod tests;
