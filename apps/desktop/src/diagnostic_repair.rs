//! Diagnostic repair proposals and the separately confirmed repair start.
//! Authority is the persisted diagnostics role plus the daemon's structured
//! proposal, never transcript text. A start is one immutable durable operation:
//! it is saved before its single POST, and only an explicit Check looks it up and,
//! if Local never received it, sends the same bytes again (idempotent by ID).
use crate::{
    LocalOptions,
    delivery_store::{Failure, Operation},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::Arc;

/// The verified Pilot source origin identity, as pilotd records it.
pub(crate) const PILOT_ORIGIN: &str = r#"["github.com","babariviere/pilot"]"#;
/// The fixed, explicit request. It asks for a proposal only; it grants nothing.
pub(crate) const SUGGEST_MESSAGE: &str = "Suggest a repair based on bounded diagnostics and available sanitized chat history. Publish one proposal with repair_proposal. Include a concise issue-specific repairTitle, plain-language findings, uncertainty, a suggested repair, cited evidence refs, and regression-test guidance. Do not copy raw history or logs into the proposal, and do not start or execute a repair.";
const BODY_CAP: usize = 256 * 1024;
const PAYLOAD_CAP: usize = 64 * 1024;
const PROJECT_SCAN_CAP: usize = 32;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Uncertainty {
    Low,
    Medium,
    High,
}
impl Uncertainty {
    pub(crate) const ALL: [Self; 3] = [Self::Low, Self::Medium, Self::High];
    fn read(value: &Value) -> Option<Self> {
        match value.as_str()? {
            "low" => Some(Self::Low),
            "medium" => Some(Self::Medium),
            "high" => Some(Self::High),
            _ => None,
        }
    }
    pub(crate) fn wire(self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
        }
    }
    pub(crate) fn parse(value: &str) -> Option<Self> {
        Self::read(&Value::from(value))
    }
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Low => "Low uncertainty",
            Self::Medium => "Medium uncertainty",
            Self::High => "High uncertainty",
        }
    }
}

/// A specialist-authored proposal, exactly as pilotd published it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Proposal {
    pub(crate) id: String,
    pub(crate) created_at: String,
    pub(crate) title: String,
    repair_title: Option<String>,
    pub(crate) findings: String,
    pub(crate) uncertainty: Uncertainty,
    pub(crate) suggested_repair: String,
    pub(crate) regression: String,
    pub(crate) evidence_refs: Vec<String>,
    subject: Option<Value>,
    target_session_id: Option<String>,
}

/// The text a repair starts from: the specialist's proposal, or the user's edit of it.
/// pilotd validates and sanitizes it again during review; nothing here grants authority.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Draft {
    pub(crate) title: String,
    pub(crate) findings: String,
    pub(crate) uncertainty: Uncertainty,
    pub(crate) suggested_repair: String,
    pub(crate) regression: String,
}
impl Draft {
    pub(crate) fn of(proposal: &Proposal) -> Self {
        Self {
            title: proposal.title.clone(),
            findings: proposal.findings.clone(),
            uncertainty: proposal.uncertainty,
            suggested_repair: proposal.suggested_repair.clone(),
            regression: proposal.regression.clone(),
        }
    }
    /// pilotd's bounds (UTF-16 units, as JavaScript counts), checked before anything is read.
    pub(crate) fn problem(&self) -> Option<Failure> {
        let title = self.title.trim();
        if title.is_empty() {
            return Some("Add an issue title.");
        }
        if title.encode_utf16().count() > 160
            || title.len() > 480
            || title.chars().any(|c| {
                c.is_control()
                    || matches!(c, '\u{2028}' | '\u{2029}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
            })
        {
            return Some("Keep the issue title to one line of at most 160 characters.");
        }
        let bounded = |value: &str, cap: usize| {
            let value = value.trim();
            !value.is_empty()
                && value.encode_utf16().count() <= cap
                && value.len() <= cap * 3
                && !value
                    .chars()
                    .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
        };
        if !bounded(&self.findings, 1_200) {
            return Some("Findings need 1 to 1,200 characters of plain text.");
        }
        if !bounded(&self.suggested_repair, 1_200) {
            return Some("The suggested repair needs 1 to 1,200 characters of plain text.");
        }
        if !bounded(&self.regression, 800) {
            return Some("The regression test needs 1 to 800 characters of plain text.");
        }
        None
    }
}

/// The repair chat's model and thinking. None means the repair project's default.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct ModelChoice {
    pub(crate) model: Option<String>,
    pub(crate) thinking: Option<String>,
}
impl ModelChoice {
    /// The catalog entry this choice runs on: the explicit model, else the repair project's
    /// Pilot model, else pi's default, as pilotd applies them.
    pub(crate) fn resolve<'a>(
        &self,
        catalog: &'a crate::chat_models::Catalog,
        project_model: Option<&'a str>,
    ) -> Option<&'a crate::chat_models::Model> {
        match &self.model {
            Some(id) => catalog.models.iter().find(|m| m.id == *id),
            None => catalog.inherited(project_model).model,
        }
    }
    /// An explicit choice must be in the repair project's scoped catalog.
    pub(crate) fn problem(
        &self,
        catalog: Option<&crate::chat_models::Catalog>,
        project_model: Option<&str>,
    ) -> Option<Failure> {
        if self.model.is_none() && self.thinking.is_none() {
            return None;
        }
        let Some(catalog) = catalog else {
            return Some(
                "Models for the repair project aren't loaded. Use the default or try again.",
            );
        };
        let model = self.resolve(catalog, project_model);
        if self.model.is_some() && model.is_none() {
            return Some("That model isn't available for the repair project. Choose another.");
        }
        if let Some(level) = &self.thinking
            && model.is_none_or(|m| !m.thinking_levels.contains(level))
        {
            return Some("That thinking level isn't available for this model.");
        }
        None
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ProposalState {
    None,
    Ready(Arc<Proposal>),
    Malformed,
}

/// The persisted diagnostics role of one chat. Only pilotd's summary fields count.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Specialist {
    /// The exact evidence subject repairs bind to. None for legacy chats without it.
    pub(crate) subject: Option<Value>,
    pub(crate) proposal: ProposalState,
    pub(crate) continued: bool,
}
impl Specialist {
    pub(crate) fn proposal(&self) -> Option<&Arc<Proposal>> {
        match &self.proposal {
            ProposalState::Ready(p) => Some(p),
            _ => None,
        }
    }
    /// Same daemon and lineage as this app's Local. Diagnostics never switch hosts.
    pub(crate) fn same_host(&self, options: &LocalOptions) -> bool {
        self.subject
            .as_ref()
            .is_some_and(|s| same_identity(&s["host"], options))
    }
}

fn host(value: &Value) -> Option<Value> {
    let map = value.as_object()?;
    let ok = map.len() == 3
        && ["hostId", "daemonId", "lineageId"].iter().all(|k| {
            map.get(*k).and_then(Value::as_str).is_some_and(|s| {
                !s.is_empty()
                    && s.len() <= 128
                    && s.bytes()
                        .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
            })
        });
    ok.then(|| value.clone())
}
fn same_identity(host: &Value, options: &LocalOptions) -> bool {
    let local = options.host();
    host["daemonId"] == local.daemon_id.as_str() && host["lineageId"] == local.lineage_id.as_str()
}
fn chat_subject(host_value: &Value, session: &str) -> Option<Value> {
    let host = host(host_value)?;
    crate::local_model::valid_id(session).then(|| {
        json!({"kind":"chat","host":host,"sessionId":session,"chatUrl":format!("pilot://chat/{session}")})
    })
}
fn subject(value: &Value) -> Option<Value> {
    match value["kind"].as_str()? {
        "app" if value.as_object()?.len() == 2 => {
            Some(json!({"kind":"app","host":host(&value["host"])?}))
        }
        "chat" if value.as_object()?.len() == 4 => {
            let id = value["sessionId"].as_str()?;
            let expected = chat_subject(&value["host"], id)?;
            (value["chatUrl"] == expected["chatUrl"]).then_some(expected)
        }
        _ => None,
    }
}
fn text(value: &Value, cap: usize) -> Option<String> {
    let s = value.as_str()?;
    (!s.trim().is_empty() && s.chars().count() <= cap).then(|| s.to_owned())
}
/// Display title only. pilotd computes the authoritative title during review.
fn display_title(repair_title: Option<&str>, findings: &str) -> String {
    if let Some(title) = repair_title.map(str::trim).filter(|t| !t.is_empty()) {
        return title.to_owned();
    }
    let line = findings
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("");
    let plain: String = line
        .trim_start_matches(['#', '>', '*', '-', ' '])
        .chars()
        .filter(|c| !c.is_control())
        .take(150)
        .collect();
    let plain = plain.trim();
    if plain.is_empty() {
        "Investigate reported application issue".into()
    } else {
        plain.into()
    }
}

fn proposal(value: &Value, derived: Option<&Value>) -> Option<Proposal> {
    let id = value["id"].as_str()?;
    let suffix = id.strip_prefix("diagnostic-proposal:v1:")?;
    if value["schemaVersion"] != 1
        || suffix.len() != 36
        || !suffix.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-')
    {
        return None;
    }
    let refs = value["evidenceRefs"].as_array()?;
    if refs.is_empty() || refs.len() > 16 {
        return None;
    }
    let evidence_refs = refs
        .iter()
        .map(|r| {
            r.as_str()
                .filter(|s| s.starts_with("diagnostic:v1:") && s.len() <= 256)
                .map(str::to_owned)
        })
        .collect::<Option<Vec<_>>>()?;
    let subject = match &value["subject"] {
        Value::Null => None,
        other => Some(subject(other)?),
    };
    let target_session_id = match &value["targetSessionId"] {
        Value::Null => None,
        other => Some(
            other
                .as_str()
                .filter(|s| crate::local_model::valid_id(s))?
                .to_owned(),
        ),
    };
    // The proposal's own subject wins; otherwise it must match the persisted role.
    let bound = subject.as_ref().or(derived)?;
    if bound["sessionId"].as_str() != target_session_id.as_deref() {
        return None;
    }
    let repair_title = match &value["repairTitle"] {
        Value::Null => None,
        other => Some(text(other, 160)?),
    };
    let findings = text(&value["findings"], 1_200)?;
    Some(Proposal {
        id: id.into(),
        created_at: value["createdAt"]
            .as_str()
            .unwrap_or("")
            .chars()
            .take(64)
            .collect(),
        title: display_title(repair_title.as_deref(), &findings),
        repair_title,
        uncertainty: Uncertainty::read(&value["uncertainty"])?,
        suggested_repair: text(&value["suggestedRepair"], 1_200)?,
        regression: text(&value["regressionTestGuidance"], 800)?,
        findings,
        evidence_refs,
        subject,
        target_session_id,
    })
}

/// None unless pilotd reports the persisted diagnostics role.
pub(crate) fn specialist(value: &Value) -> Option<Specialist> {
    if value["role"] != "diagnostics" {
        return None;
    }
    let derived = if value["diagnosticScope"] == "app" {
        host(&value["diagnosticHost"]).map(|host| json!({"kind":"app","host":host}))
    } else {
        let target = &value["diagnosticTarget"];
        target["sessionId"]
            .as_str()
            .filter(|id| value["diagnosticTargetId"] == *id)
            .and_then(|id| chat_subject(&target["host"], id))
            .filter(|s| target["chatUrl"].is_null() || target["chatUrl"] == s["chatUrl"])
    };
    let state = match &value["diagnosticRepairProposal"] {
        Value::Null => ProposalState::None,
        raw => proposal(raw, derived.as_ref()).map_or(ProposalState::Malformed, |p| {
            ProposalState::Ready(Arc::new(p))
        }),
    };
    let subject = match &state {
        ProposalState::Ready(p) => p.subject.clone().or(derived),
        _ => derived,
    };
    Some(Specialist {
        subject,
        proposal: state,
        continued: !value["continuedTo"].is_null(),
    })
}

/// pilotd's configured repair destination. The binding is reused byte-for-byte.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Binding {
    raw: Value,
    pub(crate) project_id: String,
    pub(crate) path: String,
}
impl Binding {
    pub(crate) fn host(&self) -> Value {
        self.raw["host"].clone()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum ProjectState {
    Missing,
    Available(Binding),
    Unavailable(&'static str),
    Invalid,
}
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ProjectStatus {
    pub(crate) state: ProjectState,
    pub(crate) revision: u64,
}
fn binding(value: &Value) -> Option<Binding> {
    let map = value.as_object()?;
    if map.len() != 8
        || value["schemaVersion"] != 1
        || value["origin"] != PILOT_ORIGIN
        || value["revision"].as_u64().is_none_or(|r| r == 0)
        || host(&value["host"]).is_none()
        || value["id"].as_str().is_none_or(|s| s.len() != 36)
        || !value["configuredAt"].is_string()
    {
        return None;
    }
    Some(Binding {
        raw: value.clone(),
        project_id: value["projectId"]
            .as_str()
            .filter(|s| crate::local_model::valid_id(s))?
            .into(),
        path: value["path"]
            .as_str()
            .filter(|p| p.starts_with('/') && p.len() <= 2048)?
            .into(),
    })
}
pub(crate) fn project_status(value: &Value) -> Result<ProjectStatus, Failure> {
    let revision = value["revision"]
        .as_u64()
        .ok_or("Repair project status is malformed.")?;
    let state = match value["state"].as_str() {
        Some("missing") => ProjectState::Missing,
        Some("invalid") => ProjectState::Invalid,
        Some("available") => ProjectState::Available(
            binding(&value["binding"]).ok_or("Repair project status is malformed.")?,
        ),
        Some("unavailable") => ProjectState::Unavailable(match value["reason"].as_str() {
            Some("identity_changed") => "The repair project was set up for another Local identity.",
            Some("project_missing") => "The repair project is no longer a registered project.",
            Some("path_changed") => "The repair project's folder changed.",
            Some("origin_changed") => "The repair project is no longer a Pilot source checkout.",
            _ => "The repair project is unavailable.",
        }),
        _ => return Err("Repair project status is malformed."),
    };
    Ok(ProjectStatus { state, revision })
}

/// One cited evidence row from pilotd's reviewed handoff.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Evidence {
    pub(crate) title: String,
    pub(crate) detail: String,
}
/// Read-only review material: pilotd's validated handoff, kept as received.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Handoff {
    raw: Value,
    pub(crate) title: String,
    pub(crate) evidence: Vec<Evidence>,
}
fn words(value: &str) -> String {
    let out: String = value
        .chars()
        .take(80)
        .map(|c| if matches!(c, '.' | '_') { ' ' } else { c })
        .collect();
    let mut chars = out.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => out,
    }
}
pub(crate) fn handoff(
    value: &Value,
    proposal: &Proposal,
    subject: &Value,
) -> Result<Handoff, Failure> {
    let title = value["repairTitle"]
        .as_str()
        .map(str::trim)
        .filter(|t| !t.is_empty() && t.chars().count() <= 160 && !t.chars().any(char::is_control))
        .ok_or("The reviewed repair has no usable title. Ask for a new suggestion.")?;
    let evidence = value["evidence"]
        .as_array()
        .ok_or("Reviewed repair evidence is malformed.")?;
    if value["proposalId"] != proposal.id.as_str()
        || value["subject"] != *subject
        || value["schemaVersion"] != 1
        || evidence.len() != proposal.evidence_refs.len()
        || evidence
            .iter()
            .zip(&proposal.evidence_refs)
            .any(|(e, r)| e["ref"] != r.as_str())
    {
        return Err("The reviewed repair no longer matches this proposal. Review it again.");
    }
    Ok(Handoff {
        raw: value.clone(),
        title: title.into(),
        evidence: evidence
            .iter()
            .map(|e| Evidence {
                title: words(e["kind"].as_str().unwrap_or("Evidence")),
                detail: [
                    e["source"].as_str().map(words),
                    e["at"].as_str().map(|s| s.chars().take(40).collect()),
                ]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join(" · "),
            })
            .collect(),
    })
}

/// The exact SpawnRequest a confirmed start sends. Pure, so it is checked exactly.
pub(crate) fn start_payload(
    specialist: &str,
    proposal: &Proposal,
    subject: &Value,
    handoff: &Handoff,
    project: &Binding,
    read_diagnostics: bool,
    choice: &ModelChoice,
) -> Result<String, Failure> {
    if project.raw["host"] != subject["host"] {
        return Err("The repair project belongs to another host identity. Set it up again.");
    }
    if handoff.raw["proposalId"] != proposal.id.as_str() || handoff.raw["subject"] != *subject {
        return Err("The reviewed repair no longer matches this proposal. Review it again.");
    }
    let access = if read_diagnostics {
        " You may use the host-provided diagnostic tools for fresh bounded, sanitized evidence of the approved subject and host only. Shared Pilot host logs may include other operational records. Do not inspect other chats or switch hosts."
    } else {
        " No fresh diagnostic access was granted; report missing evidence rather than assuming permission."
    };
    let material =
        serde_json::to_string(&handoff.raw).map_err(|_| "Cannot encode the reviewed repair.")?;
    let mut payload = json!({
        "projectId": project.project_id,
        "message": format!("Investigate and repair the diagnosed issue. Use the reviewed specialist proposal and cited bounded evidence below as initial operational context.{access} Verify the findings and suggested repair, add the requested regression coverage, and do not retry, restart, replay, or mutate the diagnosed chat.\n\n{material}"),
        "title": handoff.title,
        "mode": "build",
        "workspace": "clone",
        "diagnosticRepair": {
            "specialistSessionId": specialist,
            "proposalId": proposal.id,
            "subject": subject,
            "binding": project.raw,
            "repairTitle": handoff.title,
            "readDiagnostics": read_diagnostics,
        },
    });
    if let Some(model) = &choice.model {
        payload["model"] = model.as_str().into();
    }
    if let Some(thinking) = &choice.thinking {
        payload["thinking"] = thinking.as_str().into();
    }
    let payload = payload.to_string();
    if payload.len() > PAYLOAD_CAP {
        return Err("The reviewed repair exceeds the 64 KiB start limit.");
    }
    Ok(payload)
}

/// The proposal (as published, or as the user edited it) for pilotd's read-only review.
pub(crate) fn review_request(proposal: &Proposal, draft: &Draft, subject: &Value) -> Value {
    let mut request = json!({
        "proposalId": proposal.id,
        "findings": draft.findings,
        "uncertainty": draft.uncertainty.wire(),
        "suggestedRepair": draft.suggested_repair,
        "regressionTestGuidance": draft.regression,
        "subject": subject,
    });
    if let Some(id) = &proposal.target_session_id {
        request["targetSessionId"] = id.as_str().into();
    }
    // An unedited untitled proposal keeps pilotd's derived title; edits keep the shown one.
    if *draft != Draft::of(proposal) {
        request["repairTitle"] = draft.title.trim().into();
    } else if let Some(title) = &proposal.repair_title {
        request["repairTitle"] = title.as_str().into();
    }
    request
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum State {
    /// Saved, outcome not known. Only an explicit Check proceeds.
    Unknown,
    Pending,
    Accepted,
    Rejected,
}
/// The one retained repair start of a diagnostics chat, never replaced while open.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Attempt {
    pub(crate) proposal_id: String,
    pub(crate) operation: Operation,
    pub(crate) state: State,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) reason: Option<String>,
}
impl Attempt {
    pub(crate) fn open(&self) -> bool {
        matches!(self.state, State::Unknown | State::Pending)
    }
    pub(crate) fn validate(&self, specialist: &str) -> Result<(), Failure> {
        let payload: Value = serde_json::from_str(&self.operation.payload)
            .map_err(|_| "Stored repair start is corrupt.")?;
        if self.operation.kind != "repair-create"
            || payload["diagnosticRepair"]["specialistSessionId"] != specialist
            || payload["diagnosticRepair"]["proposalId"] != self.proposal_id.as_str()
            || self.reason.as_ref().is_some_and(|r| r.len() > 2048)
            || !crate::delivery_store::token(specialist)
        {
            return Err("Stored repair start is corrupt.");
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Outcome {
    /// The repair chat exists with this ID.
    Accepted(String),
    Pending,
    Rejected(String),
    /// Possibly sent. Saved and never resent without an explicit Check.
    Unknown(Failure),
    /// Nothing was saved or sent.
    Refused(Failure),
}
impl Outcome {
    pub(crate) fn state(&self) -> Option<(State, Option<String>)> {
        match self {
            Self::Accepted(_) => Some((State::Accepted, None)),
            Self::Pending => Some((State::Pending, None)),
            Self::Rejected(reason) => Some((State::Rejected, Some(reason.clone()))),
            Self::Unknown(_) | Self::Refused(_) => None,
        }
    }
}
#[derive(Clone, Debug)]
pub(crate) enum Action {
    Start {
        proposal_id: String,
        payload: String,
    },
    Check,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Reply {
    pub(crate) specialist: String,
    pub(crate) request: u64,
    /// None while the writer is still working on it.
    pub(crate) outcome: Option<Outcome>,
}

pub(crate) fn outcome(attempt: &Attempt) -> Outcome {
    match attempt.state {
        State::Unknown => Outcome::Unknown(
            "Couldn't confirm the repair start. Check it; a second repair is never created.",
        ),
        State::Pending => Outcome::Pending,
        State::Accepted => Outcome::Accepted(attempt.operation.target_id.clone()),
        State::Rejected => Outcome::Rejected(
            attempt
                .reason
                .clone()
                .unwrap_or_else(|| "Local refused the start.".into()),
        ),
    }
}

async fn body(mut response: reqwest::Response) -> Result<Value, Failure> {
    if response
        .content_length()
        .is_some_and(|n| n > BODY_CAP as u64)
    {
        return Err("Local response exceeds the bounded reader limit.");
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Local response was interrupted.")?
    {
        if bytes.len() + chunk.len() > BODY_CAP {
            return Err("Local response exceeds the bounded reader limit.");
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "Local returned malformed JSON.")
}
fn capability(options: &LocalOptions) -> Result<reqwest::header::HeaderValue, Failure> {
    let token = options
        .model_scope_capability()
        .map_err(|_| "Native repair authorization is unavailable on this Local.")?;
    let mut header = reqwest::header::HeaderValue::from_str(&token)
        .map_err(|_| "Native repair authorization is malformed.")?;
    header.set_sensitive(true);
    Ok(header)
}
async fn read(request: reqwest::RequestBuilder, refused: Failure) -> Result<Value, Failure> {
    let response = request
        .send()
        .await
        .map_err(|_| "Couldn't reach Local. Check that Pilot is running.")?;
    match response.status().as_u16() {
        200 => body(response).await,
        404 | 405 | 501 => Err("This Local doesn't support diagnostic repairs. Update Pilot."),
        _ => Err(refused),
    }
}

pub(crate) async fn read_project(
    client: &reqwest::Client,
    options: &LocalOptions,
) -> Result<ProjectStatus, Failure> {
    let value = read(
        client
            .get(format!(
                "{}/api/diagnostics/repair-project",
                options.loopback()
            ))
            .header("x-pilot-github-capability", capability(options)?),
        "Couldn't read the repair project.",
    )
    .await?;
    project_status(&value)
}

/// Registered projects whose local Git origin is the Pilot source. Read-only.
pub(crate) async fn pilot_checkouts(
    client: &reqwest::Client,
    options: &LocalOptions,
) -> Result<Vec<crate::local_model::Project>, Failure> {
    let catalog = crate::local_model::projects(
        &read(
            client.get(format!("{}/api/projects", options.loopback())),
            "Couldn't load projects.",
        )
        .await?,
    )?;
    let mut verified = Vec::new();
    for project in catalog.into_iter().take(PROJECT_SCAN_CAP) {
        let origin = read(
            client.get(format!(
                "{}/api/projects/{}/origin",
                options.loopback(),
                project.id
            )),
            "Couldn't check a project's origin.",
        )
        .await?;
        if origin["identity"] == PILOT_ORIGIN {
            verified.push(project);
        }
    }
    Ok(verified)
}

/// A CAS write. A lost reply is resolved by reading the status again.
pub(crate) async fn configure(
    client: &reqwest::Client,
    options: &LocalOptions,
    expected_revision: u64,
    host: &Value,
    project: &crate::local_model::Project,
) -> Result<ProjectStatus, Failure> {
    crate::local_client::gate(client, options).await?;
    let request = json!({
        "expectedRevision": expected_revision,
        "host": host,
        "projectId": project.id,
        "path": project.path,
        "origin": PILOT_ORIGIN,
    });
    let value = read(
        client
            .put(format!(
                "{}/api/diagnostics/repair-project",
                options.loopback()
            ))
            .header("x-pilot-github-capability", capability(options)?)
            .header("Content-Type", "application/json")
            .body(request.to_string()),
        "Local didn't accept this checkout. Choose a registered Pilot source checkout.",
    )
    .await?;
    project_status(&value)
}

pub(crate) async fn review(
    client: &reqwest::Client,
    options: &LocalOptions,
    specialist: &str,
    proposal: &Proposal,
    draft: &Draft,
    subject: &Value,
) -> Result<Handoff, Failure> {
    let host = &subject["host"];
    let mut url = reqwest::Url::parse(&format!(
        "{}/api/sessions/{specialist}/diagnostics/handoff",
        options.loopback()
    ))
    .map_err(|_| "Invalid diagnostics chat identity.")?;
    url.query_pairs_mut()
        .append_pair("hostId", host["hostId"].as_str().unwrap_or(""))
        .append_pair("daemonId", host["daemonId"].as_str().unwrap_or(""))
        .append_pair("lineageId", host["lineageId"].as_str().unwrap_or(""));
    let value = read(
        client
            .post(url)
            .header("Content-Type", "application/json")
            .body(review_request(proposal, draft, subject).to_string()),
        if *draft == Draft::of(proposal) {
            "This proposal is stale or its cited evidence is no longer available. Ask for a new suggestion."
        } else {
            "Local didn't accept the edited proposal. Check the text, or revert to the specialist's version."
        },
    )
    .await?;
    handoff(&value, proposal, subject)
}

/// Everything the review shows, read once per opening and again for edited text.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Review {
    /// The text pilotd reviewed. A start sends only this exact review.
    pub(crate) draft: Draft,
    pub(crate) handoff: Result<Handoff, Failure>,
    pub(crate) project: Result<ProjectStatus, Failure>,
    /// Verified Pilot checkouts, read only when setup is needed.
    pub(crate) checkouts: Option<Result<Vec<crate::local_model::Project>, Failure>>,
    /// The repair project's scoped models, read once it is set up.
    pub(crate) models: Option<Result<Arc<crate::chat_models::Catalog>, Failure>>,
}
impl Review {
    pub(crate) fn failed(draft: Draft, error: Failure) -> Self {
        Self {
            draft,
            handoff: Err(error),
            project: Err(error),
            checkouts: None,
            models: None,
        }
    }
}
pub(crate) async fn load_review(
    client: &reqwest::Client,
    options: &LocalOptions,
    specialist: &str,
    proposal: &Proposal,
    draft: &Draft,
    subject: &Value,
) -> Review {
    if let Err(error) = crate::local_client::gate(client, options).await {
        return Review::failed(draft.clone(), error);
    }
    let handoff = review(client, options, specialist, proposal, draft, subject).await;
    let project = read_project(client, options).await;
    let checkouts = match &project {
        Ok(ProjectStatus {
            state: ProjectState::Missing | ProjectState::Unavailable(_),
            ..
        }) => Some(pilot_checkouts(client, options).await),
        _ => None,
    };
    let models = match &project {
        Ok(ProjectStatus {
            state: ProjectState::Available(binding),
            ..
        }) => Some(
            crate::chat_models::catalog(client, options, &binding.path)
                .await
                .map(Arc::new),
        ),
        _ => None,
    };
    Review {
        draft: draft.clone(),
        handoff,
        project,
        checkouts,
        models,
    }
}

/// Writer preflight: the chat still carries this exact proposal. Nothing is saved yet.
pub(crate) async fn start_preflight(
    client: &reqwest::Client,
    options: &LocalOptions,
    specialist: &str,
    proposal_id: &str,
) -> Result<(), Failure> {
    crate::local_client::gate(client, options).await?;
    let summary = read(
        client.get(format!("{}/api/sessions/{specialist}", options.loopback())),
        "Couldn't read this diagnostics chat.",
    )
    .await?;
    let current = (summary["id"] == specialist)
        .then(|| crate::diagnostic_repair::specialist(&summary))
        .flatten()
        .ok_or("This chat is no longer a diagnostics chat. Nothing was started.")?;
    if !summary["archivedAt"].is_null() || current.continued {
        return Err("This diagnostics chat was archived or continued. Nothing was started.");
    }
    if current.proposal().is_none_or(|p| p.id != proposal_id) {
        return Err("The proposal changed. Review the current one; nothing was started.");
    }
    Ok(())
}

/// Exact receipt adoption: the immutable identity must echo back unchanged.
pub(crate) fn adopt(op: &Operation, receipt: &Value) -> Outcome {
    const MISMATCH: Failure = "The receipt doesn't match this repair start. It was kept unchanged.";
    if receipt["state"] == "unknown" {
        return Outcome::Unknown(
            "Local has no record of this start yet. Check again to send the same request.",
        );
    }
    if receipt["operationId"] != op.operation_id.as_str()
        || receipt["payloadHash"] != op.payload_hash.as_str()
        || receipt["targetId"] != op.target_id.as_str()
        || serde_json::to_value(&op.destination).ok().as_ref() != Some(&receipt["destination"])
    {
        return Outcome::Unknown(MISMATCH);
    }
    match receipt["state"].as_str() {
        Some("pending") => Outcome::Pending,
        Some("accepted") if receipt["result"]["sessionId"] == op.target_id.as_str() => {
            Outcome::Accepted(op.target_id.clone())
        }
        Some("rejected") => Outcome::Rejected(
            receipt["reason"]
                .as_str()
                .unwrap_or("Local refused the start.")
                .chars()
                .take(512)
                .collect(),
        ),
        _ => Outcome::Unknown(MISMATCH),
    }
}

async fn post(
    client: &reqwest::Client,
    options: &LocalOptions,
    op: &Operation,
    lookup: bool,
) -> Result<Value, Failure> {
    let encoded = serde_json::to_vec(op).map_err(|_| "Cannot encode the repair start.")?;
    let mut request = client
        .post(format!(
            "{}/api/operations{}",
            options.loopback(),
            if lookup { "/receipt" } else { "" }
        ))
        .header("Content-Type", "application/json")
        .body(encoded);
    if !lookup {
        request = request.header("x-pilot-github-capability", capability(options)?);
    }
    let response = request
        .send()
        .await
        .map_err(|_| "The repair start request was interrupted.")?;
    if response.status() != reqwest::StatusCode::OK {
        return Err("Local refused the repair start request.");
    }
    body(response).await
}

/// The single POST of a saved start. Any failure after sending stays Unknown.
pub(crate) async fn execute(
    client: &reqwest::Client,
    options: &LocalOptions,
    op: &Operation,
) -> Outcome {
    if crate::local_client::gate(client, options).await.is_err() {
        return Outcome::Unknown(
            "Couldn't reach Local. The start was saved but not sent; Check repair start sends it once.",
        );
    }
    match post(client, options, op, false).await {
        Ok(receipt) => adopt(op, &receipt),
        Err(_) => Outcome::Unknown(
            "Couldn't confirm the repair start. Check it; a second repair is never created.",
        ),
    }
}

/// Explicit Check: look the saved start up; send the same bytes only if Local never saw it.
pub(crate) async fn check(
    client: &reqwest::Client,
    options: &LocalOptions,
    op: &Operation,
) -> Outcome {
    if crate::local_client::gate(client, options).await.is_err() {
        return Outcome::Unknown("Couldn't reach Local. Check again when Pilot is running.");
    }
    match post(client, options, op, true).await {
        Ok(receipt) if receipt["state"] == "unknown" => execute(client, options, op).await,
        Ok(receipt) => adopt(op, &receipt),
        Err(_) => Outcome::Unknown("Couldn't check the repair start. Try again."),
    }
}

/// Read-only review work on its own thread, like other one-shot Local reads.
pub(crate) struct Job {
    pub(crate) specialist: String,
    pub(crate) proposal: Arc<Proposal>,
    pub(crate) draft: Draft,
    pub(crate) subject: Value,
    /// Set up this verified checkout first (CAS on the read revision).
    pub(crate) configure: Option<(u64, crate::local_model::Project)>,
}
pub(crate) type JobReply = (Review, Option<Failure>);
pub(crate) fn start(options: LocalOptions, job: Job) -> Option<async_channel::Receiver<JobReply>> {
    let (tx, rx) = async_channel::bounded(1);
    std::thread::Builder::new()
        .name("local-diagnostic-repair".into())
        .spawn(move || {
            let reply = match (
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build(),
                crate::chat_settings::client(),
            ) {
                (Ok(runtime), Ok(client)) => runtime.block_on(run(&client, &options, job)),
                _ => (
                    Review::failed(job.draft, "Couldn't start the review."),
                    None,
                ),
            };
            let _ = tx.send_blocking(reply);
        })
        .ok()?;
    Some(rx)
}
pub(crate) async fn run(client: &reqwest::Client, options: &LocalOptions, job: Job) -> JobReply {
    let error = match &job.configure {
        Some((revision, project)) => {
            configure(client, options, *revision, &job.subject["host"], project)
                .await
                .err()
        }
        None => None,
    };
    // Always read again after setup: a lost reply is resolved by the current status.
    let review = load_review(
        client,
        options,
        &job.specialist,
        &job.proposal,
        &job.draft,
        &job.subject,
    )
    .await;
    (review, error)
}

#[cfg(test)]
#[path = "diagnostic_repair_tests.rs"]
mod tests;
