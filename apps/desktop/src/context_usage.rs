//! Content-free projection of SessionUsage. No catalog guesses, costs, or limit policy.
//! Context has no observation timestamp in the supported contract, so it is never
//! described as a current measurement. Accounting is cumulative and only reported coverage.
use serde_json::Value;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Usage {
    tokens: Option<u64>,
    window: Option<u64>,
    direct: Tokens,
    child: Tokens,
}
#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct Tokens {
    input: Option<u64>,
    output: Option<u64>,
    cache_read: Option<u64>,
    cache_write: Option<u64>,
}
/// One cumulative accounting row. Missing values read Unknown, never zero.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Row {
    pub(crate) label: &'static str,
    pub(crate) direct: String,
    pub(crate) child: String,
}
fn count(value: &Value) -> Option<u64> {
    value.as_u64().filter(|v| *v <= 9_007_199_254_740_991)
}
impl Tokens {
    fn read(value: &Value) -> Self {
        Self {
            input: count(&value["input"]),
            output: count(&value["output"]),
            cache_read: count(&value["cacheRead"]),
            cache_write: count(&value["cacheWrite"]),
        }
    }
    fn values(&self) -> [Option<u64>; 4] {
        [self.input, self.output, self.cache_read, self.cache_write]
    }
}
/// Exact count with thousands separators; missing is Unknown, never zero.
pub(crate) fn number(value: Option<u64>) -> String {
    value
        .map(|v| {
            let digits = v.to_string();
            let mut result = String::with_capacity(digits.len() + digits.len() / 3);
            for (ix, c) in digits.chars().enumerate() {
                if ix > 0 && (digits.len() - ix).is_multiple_of(3) {
                    result.push(',');
                }
                result.push(c);
            }
            result
        })
        .unwrap_or_else(|| "Unknown".into())
}
/// Short count for the summary: 999, 42.6K, 240K, 1.2M. Exact values live in Details.
pub(crate) fn compact(value: Option<u64>) -> String {
    let Some(v) = value else {
        return "Unknown".into();
    };
    if v < 1_000 {
        return v.to_string();
    }
    // Choose the unit after rounding, so 999,999 reads 1M rather than 1000K.
    let (scale, suffix) = [(1e12, "T"), (1e9, "B"), (1e6, "M"), (1e3, "K")]
        .into_iter()
        .find(|(scale, _)| v as f64 >= scale * 0.9995)
        .unwrap_or((1e3, "K"));
    let x = v as f64 / scale;
    let text = if x < 99.95 {
        format!("{x:.1}")
    } else {
        format!("{x:.0}")
    };
    format!("{}{suffix}", text.strip_suffix(".0").unwrap_or(&text))
}
impl Usage {
    /// Comparable fields from the same summary only. Never merge partial reports.
    pub(crate) fn context_pair(&self) -> Option<(u64, u64)> {
        self.tokens.zip(self.window)
    }
    /// Either side of the context report is known.
    pub(crate) fn has_context(&self) -> bool {
        self.tokens.is_some() || self.window.is_some()
    }
    pub(crate) fn read(value: &Value) -> Self {
        Self {
            tokens: count(&value["context"]["tokens"]),
            window: count(&value["context"]["contextWindow"]).filter(|v| *v > 0),
            direct: Tokens::read(&value["ai"]["direct"]["tokens"]),
            child: Tokens::read(&value["ai"]["child"]["tokens"]),
        }
    }
    /// Whole percent of the reported window, floored so a nearly full window never
    /// reads 100%. A nonzero share below 1% reads "<1%"; overage is not clamped.
    pub(crate) fn percent(&self) -> Option<String> {
        let (used, window) = self.context_pair()?;
        let share = u128::from(used) * 100 / u128::from(window);
        Some(if used > 0 && share == 0 {
            "<1%".into()
        } else {
            format!("{share}%")
        })
    }
    /// Short used/limit, e.g. "42.6K / 200K tokens". Missing sides stay Unknown.
    pub(crate) fn amount(&self) -> String {
        if self.tokens.is_none() && self.window.is_none() {
            return "Not reported".into();
        }
        format!("{} / {} tokens", compact(self.tokens), compact(self.window))
    }
    /// Exact occupancy, e.g. "42,600 / 200,000".
    pub(crate) fn exact(&self) -> String {
        format!("{} / {}", number(self.tokens), number(self.window))
    }
    /// Cumulative direct/child token rows, or None when neither scope reported anything.
    /// The child column is shown unless every child value is a reported zero.
    pub(crate) fn accounting(&self) -> Option<(Vec<Row>, bool)> {
        let (direct, child) = (self.direct.values(), self.child.values());
        if direct.iter().chain(&child).all(Option::is_none) {
            return None;
        }
        let rows = ["Input", "Output", "Cache read", "Cache write"]
            .into_iter()
            .zip(direct.into_iter().zip(child))
            .map(|(label, (direct, child))| Row {
                label,
                direct: number(direct),
                child: number(child),
            })
            .collect();
        Some((rows, child.iter().any(|v| *v != Some(0))))
    }
}

#[cfg(test)]
#[path = "context_usage_tests.rs"]
mod tests;
