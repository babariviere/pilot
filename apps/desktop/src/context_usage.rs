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
    fn line(&self, scope: &str) -> String {
        format!(
            "{scope}: input {} · output {} · cache read {} · cache write {}",
            number(self.input),
            number(self.output),
            number(self.cache_read),
            number(self.cache_write)
        )
    }
}
fn number(value: Option<u64>) -> String {
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
impl Usage {
    /// Comparable fields from the same summary only. Never merge partial reports.
    pub(crate) fn context_pair(&self) -> Option<(u64, u64)> {
        self.tokens.zip(self.window)
    }
    pub(crate) fn read(value: &Value) -> Self {
        Self {
            tokens: count(&value["context"]["tokens"]),
            window: count(&value["context"]["contextWindow"]).filter(|v| *v > 0),
            direct: Tokens::read(&value["ai"]["direct"]["tokens"]),
            child: Tokens::read(&value["ai"]["child"]["tokens"]),
        }
    }
    pub(crate) fn context_line(&self) -> String {
        let percent = self
            .tokens
            .zip(self.window)
            .map(|(tokens, window)| format!(" ({:.1}%)", tokens as f64 / window as f64 * 100.))
            .unwrap_or_default();
        format!(
            "Reported context: {} / {} tokens{percent}",
            number(self.tokens),
            number(self.window)
        )
    }
    pub(crate) fn lines(&self) -> Vec<String> {
        vec![
            self.context_line(),
            "Freshness unknown. Latest worker report, not a live measurement or a count of the visible history.".into(),
            self.direct.line("Direct reported tokens"),
            self.child.line("Child reported tokens"),
            "Token accounting spans reported attempts and worker restarts. Coverage may be partial; missing values are unknown. Reasoning is included in output, not added again. Costs and subscription limits are not shown here.".into(),
        ]
    }
}

#[cfg(test)]
#[path = "context_usage_tests.rs"]
mod tests;
