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
    pub planning_model: Option<String>,
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
            planning_model: None,
        })
    }

    /// Resolve only planning through the mission's current project, not Today's filter or New's choice.
    pub(super) async fn mission_planning_transport(
        &self,
        mission: &str,
    ) -> Result<Option<Self>, Error> {
        if self.source.project.is_some() {
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
            planning_model: None,
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
        let overview: DayOverview = serde_json::from_value(v).map_err(|_| Error::Invalid)?;
        c::check_overview(&overview).map_err(|_| Error::Invalid)?;
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
        serde_json::from_value(v).map_err(|_| Error::Invalid)
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
