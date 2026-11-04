//! One user-confirmed resolution of one exact pending withdrawal proposal. A single POST,
//! no redirects, retries, replay or GET-based settlement. Edit and hard Remove stay unsupported.
use crate::{
    LocalOptions,
    mission_brief::Source,
    mission_browser::Home,
    mission_decisions::{self, Kind, Proposal},
};
use serde_json::Value;
use std::time::Duration;
const CAP: usize = 64 * 1024;
const ATTEMPTS: usize = 16;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Choice {
    Accept,
    Reject,
}
impl Choice {
    fn wire(self) -> &'static str {
        match self {
            Self::Accept => "accept",
            Self::Reject => "reject",
        }
    }
    fn status(self) -> &'static str {
        match self {
            Self::Accept => "accepted",
            Self::Reject => "rejected",
        }
    }
}
/// The exact proposal the user reviewed: identity, target and reason.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Send {
    pub(crate) source: Source,
    pub(crate) proposal: String,
    pub(crate) decision: String,
    pub(crate) reason: String,
    pub(crate) choice: Choice,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Outcome {
    Pending,
    NotSent(&'static str),
    Unknown(&'static str),
    Ack,
}
/// Bounded per-proposal outcomes. Pending, Unknown and Ack never resend.
#[derive(Default)]
pub(crate) struct Attempts {
    rows: Vec<(Send, Outcome)>,
}
impl Attempts {
    pub(crate) fn get(&self, source: &Source, proposal: &str) -> Option<&(Send, Outcome)> {
        self.rows
            .iter()
            .find(|(s, _)| &s.source == source && s.proposal == proposal)
    }
    pub(crate) fn sending(&self) -> Option<&Send> {
        self.rows
            .iter()
            .find(|(_, o)| *o == Outcome::Pending)
            .map(|(s, _)| s)
    }
    pub(crate) fn begin(
        &mut self,
        source: &Source,
        p: &Proposal,
        target_active: bool,
        choice: Choice,
    ) -> Result<Send, &'static str> {
        if p.kind != Kind::Withdraw || !source.valid() {
            return Err("Only a pending withdrawal can be resolved here.");
        }
        if choice == Choice::Accept && !target_active {
            return Err("Only an active decision can be withdrawn.");
        }
        if self.sending().is_some() {
            return Err("Another decision response is still sending.");
        }
        if let Some(i) = self
            .rows
            .iter()
            .position(|(s, _)| &s.source == source && s.proposal == p.id)
        {
            if !matches!(self.rows[i].1, Outcome::NotSent(_)) {
                return Err("This response can't be sent again. Refresh to see the result.");
            }
            self.rows.remove(i);
        }
        if self.rows.len() >= ATTEMPTS {
            // Settled outcomes are dropped oldest first; Unknown stays a lock.
            let Some(i) = self
                .rows
                .iter()
                .position(|(_, o)| matches!(o, Outcome::NotSent(_) | Outcome::Ack))
            else {
                return Err("Too many unconfirmed responses. Refresh to see the result.");
            };
            self.rows.remove(i);
        }
        let send = Send {
            source: source.clone(),
            proposal: p.id.clone(),
            decision: p.target.clone(),
            reason: p.reason.value.clone(),
            choice,
        };
        self.rows.push((send.clone(), Outcome::Pending));
        Ok(send)
    }
    pub(crate) fn finish(&mut self, send: &Send, outcome: Outcome) -> bool {
        let Some((_, current)) = self
            .rows
            .iter_mut()
            .find(|(s, o)| s == send && *o == Outcome::Pending)
        else {
            return false;
        };
        *current = outcome;
        true
    }
}
fn client() -> Result<reqwest::Client, &'static str> {
    reqwest::Client::builder()
        .no_proxy()
        .retry(reqwest::retry::never())
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|_| "Can't start the request. Nothing was sent.")
}
pub(crate) fn start(
    o: LocalOptions,
    s: Send,
) -> Result<async_channel::Receiver<Outcome>, &'static str> {
    let (tx, rx) = async_channel::bounded(1);
    std::thread::Builder::new()
        .name("mission-decision".into())
        .spawn(move || {
            let outcome = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(rt) => rt.block_on(async {
                    match client() {
                        Ok(c) => write(&c, &o, &s).await,
                        Err(e) => Outcome::NotSent(e),
                    }
                }),
                Err(_) => Outcome::NotSent("Can't start the request. Nothing was sent."),
            };
            let _ = tx.send_blocking(outcome);
        })
        .map_err(|_| "Can't start the request. Nothing was sent.")?;
    Ok(rx)
}
/// The captured Local home, canonical mission and exact pending proposal, rechecked now.
async fn qualify(c: &reqwest::Client, o: &LocalOptions, s: &Send) -> Result<(), &'static str> {
    if !s.source.valid() || s.source.key.home != Home::local(&o.host()) {
        return Err("This mission's Local home is unavailable. Nothing was sent.");
    }
    let crate::mission_reader::Data::Catalog(catalog) =
        crate::mission_reader::fetch(c, o, &crate::mission_reader::Route::Catalog)
            .await
            .map_err(|_| "Couldn't verify the mission. Nothing was sent.")?
    else {
        return Err("Couldn't verify the mission. Nothing was sent.");
    };
    if !s.source.canonical(&catalog) {
        return Err("This mission isn't available here. Nothing was sent.");
    }
    let r = c
        .get(format!("{}/api/missions/{}", o.loopback(), s.source.key.id))
        .send()
        .await
        .map_err(|_| "Couldn't read the mission. Nothing was sent.")?;
    if r.status().as_u16() != 200 {
        return Err("Couldn't read the mission. Nothing was sent.");
    }
    let v = crate::mission_tasks_reader::detail_body(r).await?;
    if v["mission"]["id"].as_str() != Some(&s.source.key.id)
        || v["mission"]["projectId"].as_str() != Some(&s.source.project)
    {
        return Err("The mission changed. Nothing was sent.");
    }
    let snapshot = mission_decisions::project(&v)
        .map_err(|_| "Couldn't check the proposal. Nothing was sent.")?;
    let target_active = snapshot
        .decisions
        .rows
        .iter()
        .flatten()
        .find(|d| d.id == s.decision)
        .is_some_and(|d| d.active());
    let same = snapshot.proposals.rows.iter().flatten().any(|p| {
        p.id == s.proposal
            && p.kind == Kind::Withdraw
            && p.target == s.decision
            && p.reason.value == s.reason
    });
    if !same || (s.choice == Choice::Accept && !target_active) {
        return Err("The proposal changed or was resolved. Nothing was sent.");
    }
    // The same pinned Local daemon still answers, just before the one POST.
    crate::local_client::gate(c, o)
        .await
        .map_err(|_| "Local changed. Nothing was sent.")
}
pub(crate) async fn write(c: &reqwest::Client, o: &LocalOptions, s: &Send) -> Outcome {
    if let Err(e) = qualify(c, o, s).await {
        return Outcome::NotSent(e);
    }
    let r = match c
        .post(format!(
            "{}/api/missions/{}/decision-proposals/{}/{}",
            o.loopback(),
            s.source.key.id,
            s.proposal,
            s.choice.wire()
        ))
        .header("Content-Type", "application/json")
        .body("{}")
        .send()
        .await
    {
        Ok(r) => r,
        Err(_) => return Outcome::Unknown("No response. It may have applied."),
    };
    if r.status().as_u16() != 200 {
        return Outcome::Unknown("No confirmed success. It may have applied, even after an error.");
    }
    match body(r).await {
        Ok(v)
            if v["id"].as_str() == Some(&s.proposal)
                && v["decisionId"].as_str() == Some(&s.decision)
                && v["kind"] == "withdraw"
                && v["status"].as_str() == Some(s.choice.status()) =>
        {
            Outcome::Ack
        }
        _ => Outcome::Unknown("Incomplete or mismatched response. It may have applied."),
    }
}
async fn body(mut r: reqwest::Response) -> Result<Value, &'static str> {
    if r.content_length().is_some_and(|n| n > CAP as u64) {
        return Err("Response exceeds limit.");
    }
    let mut b = Vec::new();
    while let Some(chunk) = r.chunk().await.map_err(|_| "Interrupted response.")? {
        if b.len().saturating_add(chunk.len()) > CAP {
            return Err("Response exceeds limit.");
        }
        b.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&b).map_err(|_| "Malformed response.")
}
#[cfg(test)]
#[path = "mission_decision_resolve_tests.rs"]
mod tests;
