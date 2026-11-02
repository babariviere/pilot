//! Daemon-reported MCP observations and Local sign-in progress, not chat connections or account identity.
use crate::ui::Tone;
use serde::Deserialize;

const MAX_SAFE: u64 = 9_007_199_254_740_991;

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
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SignInStatus {
    Waiting,
    Done,
    Failed,
    Cancelled,
    #[serde(other)]
    Unknown,
}
/// The daemon's latest browser sign-in for one server. `started_at` is its exact cancellation fence.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SignIn {
    pub(crate) state: SignInStatus,
    pub(crate) again: Option<bool>,
    pub(crate) started_at: u64,
    pub(crate) expires_at: u64,
    pub(crate) finished_at: Option<u64>,
    pub(crate) error: Option<String>,
}
impl SignIn {
    fn valid(&self) -> bool {
        [
            Some(self.started_at),
            Some(self.expires_at),
            self.finished_at,
        ]
        .into_iter()
        .flatten()
        .all(|n| n <= MAX_SAFE)
    }
    pub(crate) fn waiting(&self) -> bool {
        self.state == SignInStatus::Waiting
    }
}
/// The one row action the reported state supports. Cancel binds the observed start.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RowAction {
    SignIn,
    Cancel(u64),
    CheckAgain,
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
    #[serde(default)]
    pub(crate) can_sign_in: bool,
    pub(crate) sign_in: Option<SignIn>,
}
impl Server {
    pub(crate) fn label(&self) -> &'static str {
        if self.checked_at.is_none() {
            return "Unknown · no completed check";
        }
        match self.state {
            Status::Connected => "Reported connected",
            Status::NeedsSignIn if self.can_sign_in => "Needs sign-in",
            Status::NeedsSignIn => "Needs sign-in · use pi mcp login in a terminal",
            Status::Failed => "Connection failed",
            Status::Disabled => "Disabled",
            Status::Unknown => "Unknown",
        }
    }
    pub(crate) fn tone(&self) -> Tone {
        match (self.checked_at, &self.state) {
            (Some(_), Status::NeedsSignIn) => Tone::Warning,
            (Some(_), Status::Failed) => Tone::Error,
            _ => Tone::Quiet,
        }
    }
    pub(crate) fn action(&self) -> Option<RowAction> {
        if let Some(sign_in) = self.sign_in.as_ref().filter(|s| s.waiting()) {
            return Some(RowAction::Cancel(sign_in.started_at));
        }
        match self.state {
            Status::NeedsSignIn if self.can_sign_in => Some(RowAction::SignIn),
            Status::Failed => Some(RowAction::CheckAgain),
            _ => None,
        }
    }
    /// Replacing a working sign-in stays an explicit secondary choice.
    pub(crate) fn can_sign_in_again(&self) -> bool {
        self.can_sign_in
            && self.state == Status::Connected
            && self.checked_at.is_some()
            && !self.sign_in.as_ref().is_some_and(SignIn::waiting)
    }
    /// Latest reported sign-in outcome. Never inferred from the connection state.
    pub(crate) fn sign_in_line(&self) -> Option<(String, Tone)> {
        let s = self.sign_in.as_ref()?;
        let at = timestamp(s.finished_at.unwrap_or(s.started_at));
        Some(match s.state {
            SignInStatus::Waiting => ("Waiting for sign-in in your browser…".into(), Tone::Normal),
            SignInStatus::Done => (format!("Signed in {at}"), Tone::Success),
            // A later working connection supersedes an old failure; Details keeps it.
            SignInStatus::Failed if self.state == Status::Connected => return None,
            SignInStatus::Failed => (
                s.error
                    .clone()
                    .unwrap_or_else(|| "Sign-in didn't finish. Try again.".into()),
                Tone::Error,
            ),
            SignInStatus::Cancelled => (format!("Sign-in cancelled {at}"), Tone::Quiet),
            SignInStatus::Unknown => ("Sign-in state not recognised".into(), Tone::Quiet),
        })
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
        let browser = if self.can_sign_in {
            "Available through Local"
        } else {
            "Not available"
        };
        let mut text = format!(
            "Transport: {transport}\nLast check: {checked}\nTools: {tools}\nAccount: not reported\nBrowser sign-in: {browser}"
        );
        if let Some(s) = &self.sign_in {
            let again = if s.again == Some(true) {
                " (again)"
            } else {
                ""
            };
            let line = match s.state {
                SignInStatus::Waiting => format!(
                    "waiting since {}, expires {}",
                    timestamp(s.started_at),
                    timestamp(s.expires_at)
                ),
                SignInStatus::Done => format!("finished {}", finished(s)),
                SignInStatus::Failed => format!(
                    "failed {} · {}",
                    finished(s),
                    s.error.as_deref().unwrap_or("no reason reported")
                ),
                SignInStatus::Cancelled => format!("cancelled {}", finished(s)),
                SignInStatus::Unknown => "not recognised".into(),
            };
            text.push_str(&format!("\nLast sign-in{again}: {line}"));
        }
        text
    }
}
fn finished(s: &SignIn) -> String {
    s.finished_at
        .map_or_else(|| "at an unreported time".into(), timestamp)
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
        serde_json::from_slice(bytes)
            .map_err(|_| "Local returned malformed MCP status.")
            .and_then(Self::validate)
    }
    /// The control stream's `mcp` message carries the same status object.
    pub(crate) fn from_value(value: &serde_json::Value) -> Result<Self, &'static str> {
        Self::deserialize(value)
            .map_err(|_| "Local returned malformed MCP status.")
            .and_then(Self::validate)
    }
    fn validate(value: Self) -> Result<Self, &'static str> {
        let mut names = std::collections::HashSet::new();
        // The daemon's existing global probe reports at most 64 servers.
        if value.config_problems.is_some_and(|n| n > MAX_SAFE)
            || value.servers.len() > 64
            || value.servers.iter().any(|s| {
                s.name.is_empty()
                    || !names.insert(&s.name)
                    || s.checked_at.is_some_and(|n| n > MAX_SAFE)
                    || s.tools.is_some_and(|n| n > MAX_SAFE)
                    || s.sign_in.as_ref().is_some_and(|s| !s.valid())
            })
        {
            return Err("Local returned an invalid MCP roster.");
        }
        Ok(value)
    }
}
/// A sign-in acknowledgment: the started (or still running) sign-in, or none.
pub(crate) fn parse_sign_in(bytes: &[u8]) -> Option<Option<SignIn>> {
    serde_json::from_slice::<Option<SignIn>>(bytes)
        .ok()
        .filter(|s| s.as_ref().is_none_or(SignIn::valid))
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
    /// A newer daemon report (control-stream update or check ACK) replaces any read in flight.
    pub(crate) fn adopt(&mut self, result: Result<Snapshot, &'static str>, at: u64) {
        let generation = self.begin();
        self.accept(generation, result, at);
    }
    /// Merge a sign-in ACK into the exact named row without regressing a newer report.
    pub(crate) fn record_sign_in(&mut self, name: &str, ack: SignIn) {
        let Some(server) = self
            .snapshot
            .as_mut()
            .and_then(|s| s.servers.iter_mut().find(|s| s.name == name))
        else {
            return;
        };
        let newer = server.sign_in.as_ref().is_none_or(|current| {
            current.started_at < ack.started_at
                || (current.started_at == ack.started_at && current.waiting())
        });
        if newer {
            server.sign_in = Some(ack);
        }
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
