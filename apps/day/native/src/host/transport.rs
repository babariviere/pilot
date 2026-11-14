//! Local-only, pinned existing daemon. No discovery, launch, redirects or retries.
use super::{Error, Source, valid_id};
use crate::contract::{self as c, ControlCommand, ControlOperation, DayOverview, MissionDetail};
use serde_json::Value;
use std::{
    io::Read,
    os::unix::fs::OpenOptionsExt,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

#[path = "../../../../native-daemon/credentials.rs"]
mod credentials;

pub(super) const MAX_BODY: usize = 16 * 1024 * 1024;

pub(super) struct Transport {
    pub client: reqwest::Client,
    pub source: Source,
    pub controls: AtomicBool,
    /// Whether the service links re-plans (`missionReplanning`).
    pub replanning: AtomicBool,
    pub planning_model: Option<String>,
    /// A global window's current project. Missions of other projects still
    /// resolve through their own project, as they do without a focus.
    pub focused: bool,
}

impl Transport {
    /// A project view of this same connection. Never changes the root or grants controls.
    pub(super) fn for_project(&self, project: &Value) -> Result<Self, Error> {
        let mut source = self.source.clone();
        source.project = Some(super::Project {
            project_id: project["projectId"].as_str().ok_or(Error::Invalid)?.into(),
            project_path: project["projectPath"]
                .as_str()
                .ok_or(Error::Invalid)?
                .into(),
        });
        Ok(Self {
            client: self.client.clone(),
            source,
            controls: AtomicBool::new(false),
            replanning: AtomicBool::new(false),
            planning_model: None,
            focused: false,
        })
    }

    /// A global window acting on one project: same client and identity, the
    /// project's own checks on every read and write.
    pub(super) fn focus(&self, project: super::Project) -> Self {
        let mut source = self.source.clone();
        source.project = Some(project);
        Self {
            client: self.client.clone(),
            source,
            controls: AtomicBool::new(false),
            replanning: AtomicBool::new(false),
            planning_model: self.planning_model.clone(),
            focused: true,
        }
    }

    /// Resolve only planning through the mission's current project, not Today's filter or New's choice.
    pub(super) async fn mission_planning_transport(
        &self,
        mission: &str,
    ) -> Result<Option<Self>, Error> {
        if self.source.project.is_some() && !self.focused {
            return Ok(None);
        }
        if !valid_id(mission) {
            return Err(Error::Invalid);
        }
        let catalog = super::new_chat::inventory(self).await?;
        let read = self.get(&format!("/api/missions/{mission}")).await?;
        if read["mission"]["id"] != mission {
            return Err(Error::Identity);
        }
        let project = catalog["projects"]
            .as_array()
            .ok_or(Error::Invalid)?
            .iter()
            .find(|p| p["projectId"] == read["mission"]["projectId"])
            .ok_or(Error::Identity)?;
        Ok(Some(self.for_project(project)?))
    }

    pub fn new(source: Source) -> Result<Self, Error> {
        Ok(Self {
            source,
            controls: AtomicBool::new(false),
            replanning: AtomicBool::new(false),
            planning_model: None,
            focused: false,
            client: reqwest::Client::builder()
                .no_proxy()
                .retry(reqwest::retry::never())
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(2))
                .timeout(Duration::from_secs(15))
                .build()
                .map_err(|_| Error::Unavailable)?,
        })
    }
    pub fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.source.port)
    }

    /// File identity and capability are checked again after every async read.
    pub fn local(&self) -> Result<reqwest::header::HeaderValue, Error> {
        Self::local_for(&self.source)
    }
    pub(super) fn local_for(source: &super::Source) -> Result<reqwest::header::HeaderValue, Error> {
        for (file, expected) in [
            ("daemon-id", &source.home.daemon_id),
            ("storage-lineage", &source.home.lineage_id),
        ] {
            let f = std::fs::OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
                .open(source.profile.join(file))
                .map_err(|_| Error::Identity)?;
            let meta = f.metadata().map_err(|_| Error::Identity)?;
            if !meta.is_file() || meta.len() > 128 {
                return Err(Error::Identity);
            }
            let mut value = String::new();
            f.take(129)
                .read_to_string(&mut value)
                .map_err(|_| Error::Identity)?;
            if value.trim() != expected {
                return Err(Error::Identity);
            }
        }
        let token = credentials::capability(
            &source.profile,
            &source.home.daemon_id,
            &source.home.lineage_id,
        )
        .map_err(|_| Error::Identity)?;
        let mut header =
            reqwest::header::HeaderValue::from_str(&token).map_err(|_| Error::Identity)?;
        header.set_sensitive(true);
        Ok(header)
    }

    pub async fn get(&self, path: &str) -> Result<Value, Error> {
        let header = self.local()?;
        let r = self
            .client
            .get(self.url(path))
            .header("x-pilot-github-capability", header)
            .send()
            .await
            .map_err(|_| Error::Offline)?;
        if matches!(r.status().as_u16(), 401 | 403)
            || (r.status().as_u16() == 404
                && self
                    .source
                    .project
                    .as_ref()
                    .is_some_and(|p| path == format!("/api/projects/{}", p.project_id)))
        {
            return Err(Error::Identity);
        }
        let value = body(r).await?;
        self.local()?;
        Ok(value)
    }

    /// Only this endpoint's versioned, project-bound overflow is capacity.
    pub async fn planning_inventory(&self) -> Result<Value, Error> {
        let header = self.local()?;
        let r = self
            .client
            .get(self.url(&format!(
                "/api/projects/{}/planning-inventory",
                self.source.project()?.project_id
            )))
            .header("x-pilot-github-capability", header)
            .send()
            .await
            .map_err(|_| Error::Offline)?;
        let result = inventory_body(r, &self.source.project()?.project_id).await;
        self.local()?;
        result
    }

    /// Profile identity and protocol only; no selected project or feature requirement.
    pub(super) async fn profile_gate(&self) -> Result<(), Error> {
        self.profile_hello().await.map(|_| ())
    }

    /// Same authenticated identity/protocol gate, with its observed version.
    pub(super) async fn profile_hello(&self) -> Result<Value, Error> {
        let v = self.get("/api/hello").await?;
        self.check_hello(&v)?;
        Ok(v)
    }

    fn check_hello(&self, v: &Value) -> Result<(), Error> {
        if v["daemonId"] != self.source.home.daemon_id
            || v["lineageId"] != self.source.home.lineage_id
        {
            return Err(Error::Identity);
        }
        if v["minimumClientProtocolVersion"]
            .as_u64()
            .is_none_or(|v| v > 1)
            || v["protocolVersion"].as_u64().is_none_or(|v| v < 1)
            || v["capabilities"]["independentExecution"] != true
        {
            return Err(Error::Unavailable);
        }
        Ok(())
    }

    pub async fn gate(&self, controls: bool) -> Result<(), Error> {
        self.source.project()?;
        let v = self.get("/api/hello").await?;
        self.controls
            .store(v["capabilities"]["missionControls"] == 1, Ordering::SeqCst);
        self.replanning.store(
            v["capabilities"]["missionReplanning"] == 1,
            Ordering::SeqCst,
        );
        self.check_hello(&v)?;
        if v["capabilities"]["dayOverview"] != 1
            || (controls && v["capabilities"]["missionControls"] != 1)
        {
            return Err(Error::Unavailable);
        }
        // Selected project must exist here. No cwd, replica or home fallback.
        let p = self
            .get(&format!(
                "/api/projects/{}",
                self.source.project()?.project_id
            ))
            .await?;
        if p["id"] != self.source.project()?.project_id
            || p["path"] != self.source.project()?.project_path
        {
            return Err(Error::Identity);
        }
        Ok(())
    }

    pub async fn overview(&self) -> Result<DayOverview, Error> {
        let project = self.source.project()?;
        let v = self
            .get(&format!(
                "/api/projects/{}/day",
                self.source.project()?.project_id
            ))
            .await?;
        if v["dashboard"]["projectId"] != self.source.project()?.project_id {
            return Err(Error::Identity);
        }
        let overview: DayOverview = serde_json::from_value(v)
            .map_err(|e| shape_error("overview", &project.project_id, &e))?;
        c::check_overview(&overview)
            .map_err(|e| shape_error("overview", &project.project_id, &e))?;
        let mut missions = std::collections::HashSet::new();
        let mut controls = std::collections::HashSet::new();
        if overview
            .dashboard
            .missions
            .items
            .iter()
            .any(|m| !valid_id(&m.id) || !missions.insert(m.id.as_str()))
            || overview
                .controls
                .iter()
                .any(|c| !controls.insert(c.mission_id.as_str()))
        {
            return Err(Error::Invalid);
        }
        if overview.project_id != self.source.project()?.project_id
            || overview.dashboard.missions.total as usize != overview.dashboard.missions.items.len()
            || overview.dashboard.working.total as usize != overview.dashboard.working.items.len()
            || overview
                .reports
                .iter()
                .any(|r| r.report.project_id != project.project_id)
        {
            return Err(Error::Invalid);
        }
        Ok(overview)
    }

    pub async fn detail(&self, id: &str) -> Result<MissionDetail, Error> {
        let v = self.get(&format!("/api/missions/{id}")).await?;
        if v["mission"]["id"] != id
            || v["mission"]["projectId"] != self.source.project()?.project_id
        {
            return Err(Error::Identity);
        }
        serde_json::from_value(v).map_err(|e| shape_error("mission", id, &e))
    }

    pub async fn planning(&self, id: &str) -> Result<Value, Error> {
        if !valid_id(id) {
            return Err(Error::Invalid);
        }
        let hello = self.get("/api/hello").await?;
        if hello["capabilities"]["nativePlanning"] != 1 {
            return Err(Error::Unavailable);
        }
        let v = self
            .get(&format!(
                "/api/projects/{}/missions/{id}/planning",
                self.source.project()?.project_id
            ))
            .await?;
        if v["version"] == 1
            && v["projectId"] == self.source.project()?.project_id
            && v["missionId"] == id
            && matches!(v["status"].as_str(), Some("not-enrolled" | "preparing"))
            && v["view"].is_null()
            && v["capabilities"]["answers"] == "unavailable"
        {
            return Ok(v);
        }
        if v["version"] != 1
            || v["projectId"] != self.source.project()?.project_id
            || v["missionId"] != id
            || v["status"] != "available"
            || v["view"]["interview"]["fence"]["missionId"] != id
            || !v["view"]["interviewHistory"].is_array()
            || v["contextDigest"].as_str().is_none_or(|s| s.len() != 64)
        {
            return Err(Error::Invalid);
        }
        Ok(v)
    }

    pub async fn planning_profile(&self) -> Result<Value, Error> {
        if self.planning_model.is_none() {
            return Err(Error::Unavailable);
        }
        self.gate(false).await?;
        let hello = self.get("/api/hello").await?;
        if hello["capabilities"]["nativePlanning"] != 1 {
            return Err(Error::Unavailable);
        }
        let v = self
            .get(&format!(
                "/api/projects/{}/planning-profile",
                self.source.project()?.project_id
            ))
            .await?;
        super::enrollment::profile(&v, &self.source.project()?.project_id)?;
        self.gate(false).await?;
        Ok(v)
    }

    pub async fn planning_operation(
        &self,
        operation: &Value,
        lookup: bool,
    ) -> Result<Value, Error> {
        let v = self.raw_operation(operation, lookup).await?;
        super::planning::exact(v, operation)
    }

    /// One immutable operation send or lookup. No retry, auth recovery or redirect.
    pub(super) async fn raw_operation(
        &self,
        operation: &Value,
        lookup: bool,
    ) -> Result<Value, Error> {
        let token = self.local()?;
        let r = self
            .client
            .post(self.url(if lookup {
                "/api/operations/receipt"
            } else {
                "/api/operations"
            }))
            .header("x-pilot-github-capability", token)
            .header("content-type", "application/json")
            .body(serde_json::to_vec(operation).map_err(|_| Error::Invalid)?)
            .send()
            .await
            .map_err(|_| Error::Unknown)?;
        let v = body(r).await.map_err(|_| Error::Unknown)?;
        self.local().map_err(|_| Error::Unknown)?;
        Ok(v)
    }

    pub async fn control(&self, id: &str) -> Result<c::Control, Error> {
        let v = self.get(&format!("/api/missions/{id}/controls")).await?;
        let c: c::Control = serde_json::from_value(v).map_err(|_| Error::Invalid)?;
        if c.version != 1 || c.mission_id != id {
            return Err(Error::Invalid);
        }
        Ok(c)
    }

    pub async fn lookup(
        &self,
        id: &str,
        command: &ControlCommand,
    ) -> Result<ControlOperation, Error> {
        let v = self
            .get(&format!(
                "/api/missions/{id}/controls/operations/{}",
                command.operation_id
            ))
            .await?;
        exact(v, id, command)
    }

    /// Caller has journaled and rechecked authority. One POST, every error Unknown.
    pub async fn post(
        &self,
        id: &str,
        command: &ControlCommand,
    ) -> Result<ControlOperation, Error> {
        let token = self.local()?;
        let bytes = serde_json::to_vec(command).map_err(|_| Error::Invalid)?;
        let r = self
            .client
            .post(self.url(&format!("/api/missions/{id}/controls")))
            .header("x-pilot-github-capability", token)
            .header("content-type", "application/json")
            .body(bytes)
            .send()
            .await
            .map_err(|_| Error::Unknown)?;
        let v = body(r).await.map_err(|_| Error::Unknown)?;
        self.local().map_err(|_| Error::Unknown)?;
        exact(v, id, command)
    }

    /// Stop re-planning `mission`: one POST naming the new mission shown.
    /// A refusal (the link changed) is Stale; any other failure is Unknown.
    pub async fn stop_replanning(&self, mission: &str, successor: &str) -> Result<(), Error> {
        let token = self.local()?;
        let bytes = serde_json::to_vec(
            &serde_json::json!({"action": "abandon", "newMissionId": successor}),
        )
        .map_err(|_| Error::Invalid)?;
        let r = self
            .client
            .post(self.url(&format!("/api/missions/{mission}/successor")))
            .header("x-pilot-github-capability", token)
            .header("content-type", "application/json")
            .body(bytes)
            .send()
            .await
            .map_err(|_| Error::Unknown)?;
        if r.status().as_u16() == 409 {
            return Err(Error::Stale);
        }
        let v = body(r).await.map_err(|_| Error::Unknown)?;
        self.local().map_err(|_| Error::Unknown)?;
        if v["missionId"] != mission
            || v["successor"]["missionId"] != successor
            || v["successor"]["state"] != "abandoned"
        {
            return Err(Error::Unknown);
        }
        Ok(())
    }

    /// Archive or reopen `mission` once (`POST /api/missions/:id/lifecycle`).
    /// `Ok(Err(message))` is the daemon's refusal (409); every other failure
    /// is Unknown and only a status read can settle it.
    pub async fn lifecycle(
        &self,
        mission: &str,
        action: crate::model::LifecycleAction,
    ) -> Result<Result<(), String>, Error> {
        let token = self.local()?;
        let request = lifecycle_body(&self.source, action, &uuid::Uuid::new_v4().to_string())?;
        let bytes = serde_json::to_vec(&request).map_err(|_| Error::Invalid)?;
        let r = self
            .client
            .post(self.url(&format!("/api/missions/{mission}/lifecycle")))
            .header("x-pilot-github-capability", token)
            .header("content-type", "application/json")
            .body(bytes)
            .send()
            .await
            .map_err(|_| Error::Unknown)?;
        if r.status().as_u16() == 409 {
            let v = json_body(r).await.map_err(|_| Error::Unknown)?;
            let message = v["error"].as_str().unwrap_or("The service refused it.");
            return Ok(Err(message.chars().take(300).collect()));
        }
        let v = body(r).await.map_err(|_| Error::Unknown)?;
        self.local().map_err(|_| Error::Unknown)?;
        if v["mission"]["id"] != mission || v["mission"]["status"] != action.target() {
            return Err(Error::Unknown);
        }
        Ok(Ok(()))
    }

    /// The mission's status now, read again. Sends nothing.
    pub async fn mission_status(&self, mission: &str) -> Result<String, Error> {
        self.mission_field(mission, "status").await
    }

    /// The mission's title now, read again. Sends nothing.
    pub async fn mission_title(&self, mission: &str) -> Result<String, Error> {
        self.mission_field(mission, "title").await
    }

    async fn mission_field(&self, mission: &str, field: &str) -> Result<String, Error> {
        let v = self.get(&format!("/api/missions/{mission}")).await?;
        if v["mission"]["id"] != mission
            || v["mission"]["projectId"] != self.source.project()?.project_id
        {
            return Err(Error::Identity);
        }
        v["mission"][field]
            .as_str()
            .map(str::to_owned)
            .ok_or(Error::Invalid)
    }

    /// Rename `mission` once (`PATCH /api/missions/:id`). `Ok(Err(message))`
    /// is the daemon's refusal (400, 404 or 409, before any change); every
    /// other failure is Unknown and only a title read can settle it.
    pub async fn rename(&self, mission: &str, title: &str) -> Result<Result<(), String>, Error> {
        let token = self.local()?;
        let bytes = serde_json::to_vec(&rename_body(title)).map_err(|_| Error::Invalid)?;
        let r = self
            .client
            .patch(self.url(&format!("/api/missions/{mission}")))
            .header("x-pilot-github-capability", token)
            .header("content-type", "application/json")
            .body(bytes)
            .send()
            .await
            .map_err(|_| Error::Unknown)?;
        if matches!(r.status().as_u16(), 400 | 404 | 409) {
            let v = json_body(r).await.map_err(|_| Error::Unknown)?;
            let message = v["error"].as_str().unwrap_or("The service refused it.");
            return Ok(Err(message.chars().take(300).collect()));
        }
        let v = body(r).await.map_err(|_| Error::Unknown)?;
        self.local().map_err(|_| Error::Unknown)?;
        if v["id"] != mission
            || v["projectId"] != self.source.project()?.project_id
            || v["title"] != title
        {
            return Err(Error::Unknown);
        }
        Ok(Ok(()))
    }
}

/// The exact rename body the daemon accepts (`UpdateMissionRequest`): only
/// the title, so no other field changes.
pub(super) fn rename_body(title: &str) -> Value {
    serde_json::json!({ "title": title })
}

/// The exact lifecycle body the daemon accepts (`parseMissionLifecycle`).
pub(super) fn lifecycle_body(
    source: &Source,
    action: crate::model::LifecycleAction,
    operation_id: &str,
) -> Result<Value, Error> {
    Ok(serde_json::json!({
        "action": action.name(),
        "expectedStatus": action.expected(),
        "projectId": source.project()?.project_id,
        "operationId": operation_id,
        "home": {"daemonId": source.home.daemon_id, "lineageId": source.home.lineage_id},
    }))
}

pub(super) fn exact(
    v: Value,
    id: &str,
    command: &ControlCommand,
) -> Result<ControlOperation, Error> {
    let r: ControlOperation = serde_json::from_value(v).map_err(|_| Error::Unknown)?;
    if r.version != 1
        || r.mission_id != id
        || r.command != *command
        || r.control.version != 1
        || r.control.mission_id != id
        || r.control.operation_id.as_deref() != Some(&command.operation_id)
        || r.control.pause_operation_id.as_deref()
            != match command.action {
                c::ControlAction::Pause => Some(command.operation_id.as_str()),
                c::ControlAction::Resume => command.pause_operation_id.as_deref(),
            }
        || r.control.revision <= command.expected_revision
    {
        return Err(Error::Unknown);
    }
    Ok(r)
}

/// Logs why a daemon read did not match this app's contract, for later
/// diagnosis, then refuses it. Quoted values are dropped: they may be content.
pub(super) fn shape_error(read: &str, id: &str, error: &dyn std::fmt::Display) -> Error {
    let mut reason = String::new();
    let mut quoted = false;
    for ch in error.to_string().chars() {
        if ch == '"' {
            quoted = !quoted;
            reason.push_str(if quoted { "\"…" } else { "\"" });
        } else if !quoted {
            reason.push(ch);
        }
    }
    crate::day_log::event(
        "read.shape_error",
        serde_json::json!({"read":read,"id":id,"reason":reason}),
    );
    Error::Invalid
}

pub(super) async fn body(r: reqwest::Response) -> Result<Value, Error> {
    if matches!(r.status().as_u16(), 401 | 403) {
        return Err(Error::Identity);
    }
    if r.status().as_u16() != 200 {
        return Err(Error::Unavailable);
    }
    json_body(r).await
}

async fn inventory_body(r: reqwest::Response, project_id: &str) -> Result<Value, Error> {
    // Conflict can mean a revoked owner/membership fence. It is not a
    // transport outage and must discard the prior inventory, not retain it.
    if r.status().as_u16() == 409 {
        return Err(Error::Invalid);
    }
    if r.status().as_u16() != 503 {
        return body(r).await;
    }
    let value = json_body(r).await.map_err(|_| Error::Unavailable)?;
    if value["version"] == 1
        && value["code"] == "planning_inventory_capacity"
        && value["projectId"] == project_id
        && value["limit"] == 100
        && value.get("items").is_none()
        && value.get("total").is_none()
    {
        return Err(Error::Capacity);
    }
    Err(Error::Unavailable)
}

async fn json_body(mut r: reqwest::Response) -> Result<Value, Error> {
    if r.content_length().is_some_and(|n| n > MAX_BODY as u64) {
        return Err(Error::Invalid);
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = r.chunk().await.map_err(|_| Error::Offline)? {
        if bytes.len().saturating_add(chunk.len()) > MAX_BODY {
            return Err(Error::Invalid);
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| Error::Invalid)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::LifecycleAction;

    #[test]
    fn the_lifecycle_body_is_exactly_what_the_daemon_accepts() {
        let source = Source {
            profile: std::env::temp_dir(),
            port: 1,
            home: c::Home {
                daemon_id: "daemon".into(),
                lineage_id: "lineage".into(),
            },
            project: Some(super::super::Project {
                project_id: "project".into(),
                project_path: "/project".into(),
            }),
        };
        let id = "6f1c2b8e-3d4a-4b5c-9d6e-7f8091a2b3c4";
        assert_eq!(
            lifecycle_body(&source, LifecycleAction::Archive, id).unwrap(),
            serde_json::json!({"action":"archive","expectedStatus":"active","projectId":"project",
                "operationId":id,"home":{"daemonId":"daemon","lineageId":"lineage"}})
        );
        let reopen = lifecycle_body(&source, LifecycleAction::Reopen, id).unwrap();
        assert_eq!(reopen["action"], "reopen");
        assert_eq!(reopen["expectedStatus"], "archived");
        let global = Source {
            project: None,
            ..source
        };
        assert!(lifecycle_body(&global, LifecycleAction::Archive, id).is_err());
    }

    #[test]
    fn the_rename_body_names_only_the_checked_title() {
        use crate::model::mission_title;
        let title = mission_title("  Quieter notes 💬\n").unwrap();
        assert_eq!(
            rename_body(title),
            serde_json::json!({"title":"Quieter notes 💬"})
        );
        assert_eq!(
            serde_json::to_string(&rename_body(title)).unwrap(),
            r#"{"title":"Quieter notes 💬"}"#
        );
        assert!(mission_title(" \u{feff}\t ").is_err());
        // The daemon counts UTF-16 units: 100 emoji are 200, 101 are too many.
        assert!(mission_title(&"💬".repeat(100)).is_ok());
        assert!(mission_title(&"💬".repeat(101)).is_err());
        assert!(mission_title(&format!("  {}  ", "a".repeat(200))).is_ok());
    }
}
