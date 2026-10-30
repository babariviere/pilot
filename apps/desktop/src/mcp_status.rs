//! Passive daemon-reported MCP observations, not chat connections or account identity.
use serde::Deserialize;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Status {
    Connected,
    NeedsSignIn,
    Failed,
    Disabled,
    #[serde(other)]
    Unknown,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Server {
    pub(crate) name: String,
    pub(crate) transport: String,
    pub(crate) state: Status,
    pub(crate) tools: Option<u64>,
    pub(crate) problem: Option<String>,
    pub(crate) checked_at: Option<u64>,
}
impl Server {
    pub(crate) fn label(&self) -> &'static str {
        if self.checked_at.is_none() {
            return "Unknown · no completed check";
        }
        match self.state {
            Status::Connected => "Reported connected",
            Status::NeedsSignIn => "Needs sign-in",
            Status::Failed => "Connection failed",
            Status::Disabled => "Disabled",
            Status::Unknown => "Unknown",
        }
    }
    pub(crate) fn details(&self) -> String {
        let transport = match self.transport.as_str() {
            "http" => "HTTP",
            "stdio" => "Local process (stdio)",
            _ => "Unknown",
        };
        let checked = self
            .checked_at
            .map_or_else(|| "Not reported".into(), timestamp);
        let tools = if self.state == Status::Connected && self.checked_at.is_some() {
            self.tools
                .map_or_else(|| "Not reported".into(), |n| n.to_string())
        } else {
            "Not reported for this state".into()
        };
        format!(
            "Transport: {transport}\nLast check: {checked}\nTools: {tools}\nAccount: not reported"
        )
    }
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    pub(crate) servers: Vec<Server>,
    pub(crate) checking: bool,
    pub(crate) config_problems: Option<u64>,
}
impl Snapshot {
    pub(crate) fn parse(bytes: &[u8]) -> Result<Self, &'static str> {
        let value: Self =
            serde_json::from_slice(bytes).map_err(|_| "Local returned malformed MCP status.")?;
        let mut names = std::collections::HashSet::new();
        // The daemon's existing global probe reports at most 64 servers.
        if value
            .config_problems
            .is_some_and(|n| n > 9_007_199_254_740_991)
            || value.servers.len() > 64
            || value.servers.iter().any(|s| {
                s.name.is_empty()
                    || !names.insert(&s.name)
                    || s.checked_at.is_some_and(|n| n > 9_007_199_254_740_991)
                    || s.tools.is_some_and(|n| n > 9_007_199_254_740_991)
            })
        {
            return Err("Local returned an invalid MCP roster.");
        }
        Ok(value)
    }
}
#[derive(Default)]
pub(crate) struct State {
    pub(crate) generation: u64,
    pub(crate) snapshot: Option<Snapshot>,
    pub(crate) busy: bool,
    pub(crate) error: Option<&'static str>,
    pub(crate) read_at: Option<u64>,
}
impl State {
    pub(crate) fn begin(&mut self) -> u64 {
        self.generation += 1;
        self.busy = true;
        self.error = None;
        self.generation
    }
    pub(crate) fn accept(
        &mut self,
        generation: u64,
        result: Result<Snapshot, &'static str>,
        at: u64,
    ) -> bool {
        if generation != self.generation {
            return false;
        }
        self.busy = false;
        match result {
            Ok(snapshot) => {
                self.snapshot = Some(snapshot);
                self.error = None;
                self.read_at = Some(at);
            }
            Err(error) => self.error = Some(error),
        }
        true
    }
}

pub(crate) fn timestamp(at: u64) -> String {
    format!(
        "{} {:02}:{:02}:{:02} UTC",
        crate::usage_overview::date(at),
        at / 3_600_000 % 24,
        at / 60_000 % 60,
        at / 1000 % 60
    )
}
