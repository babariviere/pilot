//! One project's General and Workspace settings, edited against the daemon's project record.
//! Edits stay local until an explicit Save, which sends only the changed fields once.
//! Projects carry no revision, so the form keeps its baseline and never resends on its own.
use crate::local_model::Project;
use serde_json::{Map, Value, json};

/// Matches the catalog's display bound so a saved name is never shown truncated.
pub(crate) const NAME_BYTES: usize = 240;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Fields {
    pub(crate) name: String,
    pub(crate) isolated: bool,
    pub(crate) require_pull_request: bool,
}
impl Fields {
    pub(crate) fn of(project: &Project) -> Self {
        Self {
            name: project.name.clone(),
            isolated: project.policy.isolated,
            require_pull_request: project.policy.require_pull_request,
        }
    }
    fn normalized(&self) -> Self {
        Self {
            name: self.name.trim().into(),
            ..self.clone()
        }
    }
}

pub(crate) fn name_problem(name: &str) -> Option<&'static str> {
    let name = name.trim();
    if name.is_empty() {
        Some("Enter a name.")
    } else if name.len() > NAME_BYTES {
        Some("Use a shorter name.")
    } else {
        None
    }
}

/// One captured Save: the exact project, its baseline and the values to write.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Submission {
    pub(crate) token: u64,
    pub(crate) project_id: String,
    pub(crate) baseline: Fields,
    pub(crate) fields: Fields,
}
impl Submission {
    /// PATCH body with only the changed fields, so unrelated settings are never rewritten.
    pub(crate) fn patch(&self) -> Value {
        let mut body = Map::new();
        if self.fields.name != self.baseline.name {
            body.insert("name".into(), json!(self.fields.name));
        }
        if self.fields.isolated != self.baseline.isolated {
            body.insert(
                "workspace".into(),
                json!(if self.fields.isolated {
                    "clone"
                } else {
                    "direct"
                }),
            );
        }
        if self.fields.require_pull_request != self.baseline.require_pull_request {
            body.insert(
                "requirePullRequest".into(),
                json!(self.fields.require_pull_request),
            );
        }
        Value::Object(body)
    }
    /// The daemon still holds the baseline for every field this save changes.
    pub(crate) fn current(&self, server: &Fields) -> bool {
        (self.fields.name == self.baseline.name || server.name == self.baseline.name)
            && (self.fields.isolated == self.baseline.isolated
                || server.isolated == self.baseline.isolated)
            && (self.fields.require_pull_request == self.baseline.require_pull_request
                || server.require_pull_request == self.baseline.require_pull_request)
    }
    /// The returned project carries every value this save wrote.
    pub(crate) fn applied(&self, saved: &Project) -> bool {
        saved.id == self.project_id && Fields::of(saved) == self.merged(&Fields::of(saved))
    }
    fn merged(&self, server: &Fields) -> Fields {
        let mut out = server.clone();
        if self.fields.name != self.baseline.name {
            out.name = self.fields.name.clone();
        }
        if self.fields.isolated != self.baseline.isolated {
            out.isolated = self.fields.isolated;
        }
        if self.fields.require_pull_request != self.baseline.require_pull_request {
            out.require_pull_request = self.fields.require_pull_request;
        }
        out
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Outcome {
    Saved(Project),
    /// Definitely not written; the reason is safe to show.
    NotSent(&'static str),
    /// The write may or may not have happened. Never repeated automatically.
    Unknown(&'static str),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Status {
    Idle,
    Saving(Submission),
    Failed(&'static str),
    Unknown(&'static str),
}

/// The form for one exact project ID. It never follows another project.
#[derive(Clone, Debug)]
pub(crate) struct Editor {
    project_id: String,
    /// The newest catalog value for this ID; None once the project is removed.
    latest: Option<Project>,
    /// The last catalog value seen, kept for display after removal.
    known: Project,
    baseline: Fields,
    draft: Fields,
    status: Status,
    /// The daemon's value changed while this form had unsaved edits.
    updated_elsewhere: bool,
    next_token: u64,
    /// Bumped whenever the draft is replaced rather than edited, so fields know to reload.
    replaced: u64,
}
impl Editor {
    pub(crate) fn new(project: &Project) -> Self {
        let fields = Fields::of(project);
        Self {
            project_id: project.id.clone(),
            latest: Some(project.clone()),
            known: project.clone(),
            baseline: fields.clone(),
            draft: fields,
            status: Status::Idle,
            updated_elsewhere: false,
            next_token: 0,
            replaced: 0,
        }
    }
    #[cfg(test)]
    pub(crate) fn project_id(&self) -> &str {
        &self.project_id
    }
    pub(crate) fn latest(&self) -> Option<&Project> {
        self.latest.as_ref()
    }
    pub(crate) fn known(&self) -> &Project {
        &self.known
    }
    pub(crate) fn removed(&self) -> bool {
        self.latest.is_none()
    }
    pub(crate) fn draft(&self) -> &Fields {
        &self.draft
    }
    pub(crate) fn replaced(&self) -> u64 {
        self.replaced
    }
    pub(crate) fn status(&self) -> &Status {
        &self.status
    }
    pub(crate) fn saving(&self) -> bool {
        matches!(self.status, Status::Saving(_))
    }
    pub(crate) fn updated_elsewhere(&self) -> bool {
        self.updated_elsewhere
    }
    pub(crate) fn dirty(&self) -> bool {
        self.draft.normalized() != self.baseline.normalized()
    }
    /// Unsaved, in flight or unresolved: closing would hide something the user must decide.
    pub(crate) fn unsettled(&self) -> bool {
        self.dirty() || self.saving() || matches!(self.status, Status::Unknown(_))
    }
    pub(crate) fn editable(&self) -> bool {
        !self.removed() && !self.saving()
    }

    pub(crate) fn set_name(&mut self, name: &str) -> bool {
        if !self.editable() || self.draft.name == name {
            return false;
        }
        self.draft.name = name.into();
        true
    }
    pub(crate) fn set_isolated(&mut self, isolated: bool) -> bool {
        if !self.editable() || self.draft.isolated == isolated {
            return false;
        }
        self.draft.isolated = isolated;
        true
    }
    pub(crate) fn set_require_pull_request(&mut self, require: bool) -> bool {
        if !self.editable() || self.draft.require_pull_request == require {
            return false;
        }
        self.draft.require_pull_request = require;
        true
    }

    /// A new catalog. Only this exact ID counts; a removed project is never replaced.
    pub(crate) fn catalog(&mut self, projects: &[Project]) -> bool {
        let latest = projects.iter().find(|p| p.id == self.project_id).cloned();
        if latest == self.latest {
            return false;
        }
        self.latest = latest;
        let Some(project) = &self.latest else {
            return true;
        };
        self.known = project.clone();
        if self.saving() {
            // Ordered against the reply in finish().
            return true;
        }
        let server = Fields::of(project);
        if !self.dirty() || server.normalized() == self.draft.normalized() {
            // Nothing unsaved, or the daemon now holds exactly these values.
            self.load(server);
        } else if server != self.baseline {
            self.updated_elsewhere = true;
        }
        true
    }

    /// Drops unsaved edits and shows the daemon's newest value.
    pub(crate) fn revert(&mut self) -> bool {
        if self.saving() {
            return false;
        }
        match self.latest.as_ref().map(Fields::of) {
            Some(server) => self.load(server),
            None => {
                self.draft = self.baseline.clone();
                self.status = Status::Idle;
                self.replaced += 1;
            }
        }
        true
    }

    pub(crate) fn begin_save(&mut self) -> Option<Submission> {
        if !self.editable() || !self.dirty() || name_problem(&self.draft.name).is_some() {
            return None;
        }
        self.next_token += 1;
        let submission = Submission {
            token: self.next_token,
            project_id: self.project_id.clone(),
            baseline: self.baseline.clone(),
            fields: self.draft.normalized(),
        };
        self.status = Status::Saving(submission.clone());
        Some(submission)
    }

    /// Settles only the in-flight submission; stale or duplicate replies are ignored.
    pub(crate) fn finish(&mut self, submission: &Submission, outcome: Outcome) -> bool {
        if !matches!(&self.status, Status::Saving(s) if s == submission) {
            return false;
        }
        match outcome {
            Outcome::Saved(saved) if submission.applied(&saved) => {
                self.status = Status::Idle;
                let saved_fields = Fields::of(&saved);
                match self.latest.as_ref().map(Fields::of) {
                    // A different value arrived meanwhile and its order against this reply is
                    // unknown: keep the form, take the arrival as baseline and say so.
                    Some(observed)
                        if observed != saved_fields && observed != submission.baseline =>
                    {
                        self.baseline = observed;
                        self.updated_elsewhere = true;
                    }
                    _ => {
                        if self.latest.is_some() {
                            self.latest = Some(saved.clone());
                            self.known = saved;
                        }
                        if self.draft.normalized() == submission.fields {
                            // Edits made while saving stay unsaved; otherwise the form is clean.
                            self.draft = saved_fields.clone();
                            self.replaced += 1;
                        }
                        self.baseline = saved_fields;
                        self.updated_elsewhere = false;
                    }
                }
            }
            Outcome::Saved(_) => {
                self.status = Status::Unknown(
                    "Pilot didn't confirm these values. The save may have applied; it won't be resent.",
                )
            }
            Outcome::NotSent(reason) => self.status = Status::Failed(reason),
            Outcome::Unknown(reason) => self.status = Status::Unknown(reason),
        }
        true
    }

    fn load(&mut self, server: Fields) {
        self.baseline = server.clone();
        self.draft = server;
        self.updated_elsewhere = false;
        self.status = Status::Idle;
        self.replaced += 1;
    }
}

#[cfg(test)]
#[path = "project_settings_tests.rs"]
mod tests;
