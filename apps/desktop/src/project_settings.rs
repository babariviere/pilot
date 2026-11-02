//! One project's General, Workspace and Slack settings, edited against the daemon's project record.
//! Edits stay local until an explicit Save, which sends only the changed fields once.
//! Projects carry no revision, so the form keeps its baseline and never resends on its own.
use crate::{
    local_model::Project,
    project_slack::{self, Effect, Normal, Slack},
};
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
    /// Present when the Slack settings changed. Tracking is replaced whole, so it carries the
    /// tracking value the edits started from.
    pub(crate) tracking: Option<TrackingChange>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct TrackingChange {
    pub(crate) base: Value,
    pub(crate) slack: Normal,
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
        if let Some(change) = &self.tracking {
            body.insert(
                "tracking".into(),
                project_slack::body(&change.base, &change.slack),
            );
        }
        Value::Object(body)
    }
    /// The daemon still holds the baseline for every field this save changes. For Slack that is
    /// the whole tracking value, since the save replaces it.
    pub(crate) fn current(&self, server: &Fields, tracking: &Value) -> bool {
        (self.fields.name == self.baseline.name || server.name == self.baseline.name)
            && (self.fields.isolated == self.baseline.isolated
                || server.isolated == self.baseline.isolated)
            && (self.fields.require_pull_request == self.baseline.require_pull_request
                || server.require_pull_request == self.baseline.require_pull_request)
            && self.tracking.as_ref().is_none_or(|t| t.base == *tracking)
    }
    /// The returned project carries every value this save wrote.
    pub(crate) fn applied(&self, saved: &Project, tracking: &Value) -> bool {
        saved.id == self.project_id
            && Fields::of(saved) == self.merged(&Fields::of(saved))
            && self
                .tracking
                .as_ref()
                .is_none_or(|t| project_slack::stored(tracking, &t.base, &t.slack))
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
    /// The returned project and its tracking value.
    Saved(Project, Value),
    /// Definitely not written; the reason is safe to show.
    NotSent(&'static str),
    /// The write may or may not have happened. Never repeated automatically.
    Unknown(&'static str),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum SlackLoad {
    Loading,
    Failed(&'static str),
    /// The project's tracking holds something this editor can't round-trip; shown read-only.
    Unsupported,
    Ready,
}

/// The Slack part of the form. Unlike the other fields it comes from its own read, since the
/// project catalog carries only navigation metadata.
#[derive(Clone, Debug)]
struct SlackPart {
    load: SlackLoad,
    /// The tracking value the baseline was read from (Null when the project has none).
    raw: Value,
    /// The newest tracking value read, which Revert loads.
    newest: Value,
    base: Slack,
    draft: Slack,
    /// The daemon's Slack values changed while this form had unsaved Slack edits.
    elsewhere: bool,
    next_key: u64,
    /// Only the newest read may settle; saves invalidate reads started before them.
    reads: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Status {
    Idle,
    Saving(Box<Submission>),
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
    slack: SlackPart,
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
            slack: SlackPart {
                load: SlackLoad::Loading,
                raw: Value::Null,
                newest: Value::Null,
                base: Slack::default(),
                draft: Slack::default(),
                elsewhere: false,
                next_key: 0,
                reads: 0,
            },
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
    fn general_dirty(&self) -> bool {
        self.draft.normalized() != self.baseline.normalized()
    }
    pub(crate) fn slack_dirty(&self) -> bool {
        self.slack.load == SlackLoad::Ready && self.slack.draft.normal() != self.slack.base.normal()
    }
    pub(crate) fn dirty(&self) -> bool {
        self.general_dirty() || self.slack_dirty()
    }
    /// Unsaved, in flight or unresolved: closing would hide something the user must decide.
    pub(crate) fn unsettled(&self) -> bool {
        self.dirty() || self.saving() || matches!(self.status, Status::Unknown(_))
    }
    pub(crate) fn editable(&self) -> bool {
        !self.removed() && !self.saving()
    }
    pub(crate) fn slack_load(&self) -> &SlackLoad {
        &self.slack.load
    }
    pub(crate) fn slack(&self) -> &Slack {
        &self.slack.draft
    }
    /// Channels as last saved, to tell a new channel from one Pilot already reads.
    pub(crate) fn slack_saved(&self, id: &str) -> bool {
        self.slack.base.channels.iter().any(|c| c.id == id)
    }
    pub(crate) fn slack_elsewhere(&self) -> bool {
        self.slack.elsewhere && self.slack_dirty()
    }
    pub(crate) fn slack_editable(&self) -> bool {
        self.editable() && self.slack.load == SlackLoad::Ready
    }
    /// Why Save is unavailable for a dirty form, if anything blocks it.
    pub(crate) fn problem(&self) -> Option<&'static str> {
        name_problem(&self.draft.name).or_else(|| {
            self.slack_dirty()
                .then(|| self.slack.draft.problem())
                .flatten()
        })
    }
    pub(crate) fn can_save(&self) -> bool {
        self.editable() && self.dirty() && self.problem().is_none()
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

    fn edit_slack(&mut self, f: impl FnOnce(&mut Slack) -> bool) -> bool {
        self.slack_editable() && f(&mut self.slack.draft)
    }
    pub(crate) fn add_channel(&mut self, id: &str, name: Option<&str>) -> bool {
        self.edit_slack(|s| {
            if id.trim().is_empty()
                || s.channels.len() >= project_slack::CHANNELS
                || s.channels.iter().any(|c| c.id == id)
            {
                return false;
            }
            s.channels.push(project_slack::Channel {
                id: id.into(),
                name: name.map(Into::into),
                mention_only: false,
            });
            true
        })
    }
    pub(crate) fn remove_channel(&mut self, id: &str) -> bool {
        self.edit_slack(|s| {
            let before = s.channels.len();
            s.channels.retain(|c| c.id != id);
            s.channels.len() != before
        })
    }
    pub(crate) fn set_mention_only(&mut self, id: &str, on: bool) -> bool {
        self.edit_slack(|s| {
            match s.channels.iter_mut().find(|c| c.id == id) {
                Some(c) if c.mention_only != on => c.mention_only = on,
                _ => return false,
            }
            true
        })
    }
    pub(crate) fn set_groups(&mut self, text: &str) -> bool {
        self.edit_slack(|s| {
            if s.groups == text {
                return false;
            }
            s.groups = text.into();
            true
        })
    }
    /// A new blank label row; None when labels can't be added.
    pub(crate) fn add_label(&mut self) -> Option<u64> {
        let key = self.slack.next_key + 1;
        self.edit_slack(|s| {
            if s.labels.len() >= project_slack::LABELS {
                return false;
            }
            s.labels.push(project_slack::Label {
                key,
                name: String::new(),
                description: String::new(),
                effect: Effect::None,
            });
            true
        })
        .then(|| {
            self.slack.next_key = key;
            key
        })
    }
    pub(crate) fn remove_label(&mut self, key: u64) -> bool {
        self.edit_slack(|s| {
            let before = s.labels.len();
            s.labels.retain(|l| l.key != key);
            s.labels.len() != before
        })
    }
    fn edit_label(&mut self, key: u64, f: impl FnOnce(&mut project_slack::Label) -> bool) -> bool {
        self.edit_slack(|s| s.labels.iter_mut().find(|l| l.key == key).is_some_and(f))
    }
    pub(crate) fn set_label_name(&mut self, key: u64, name: &str) -> bool {
        self.edit_label(key, |l| {
            let changed = l.name != name;
            l.name = name.into();
            changed
        })
    }
    pub(crate) fn set_label_description(&mut self, key: u64, description: &str) -> bool {
        self.edit_label(key, |l| {
            let changed = l.description != description;
            l.description = description.into();
            changed
        })
    }
    pub(crate) fn set_label_effect(&mut self, key: u64, effect: Effect) -> bool {
        self.edit_label(key, |l| {
            let changed = l.effect != effect;
            l.effect = effect;
            changed
        })
    }

    /// Starts a tracking read; None while saving, since the save's reply settles it.
    pub(crate) fn begin_read(&mut self) -> Option<u64> {
        if self.saving() || self.removed() {
            return None;
        }
        self.slack.reads += 1;
        Some(self.slack.reads)
    }
    /// Settles only the newest read. A failure is shown only while nothing has loaded.
    pub(crate) fn finish_read(&mut self, token: u64, read: Result<Value, &'static str>) -> bool {
        if token != self.slack.reads || self.saving() {
            return false;
        }
        match read {
            Ok(raw) => self.tracking(raw),
            Err(reason) => match self.slack.load {
                SlackLoad::Loading | SlackLoad::Failed(_) => {
                    self.slack.load = SlackLoad::Failed(reason);
                    true
                }
                _ => false,
            },
        }
    }
    /// A tracking value read from the daemon.
    fn tracking(&mut self, raw: Value) -> bool {
        if self.slack.load == SlackLoad::Ready && raw == self.slack.raw && raw == self.slack.newest
        {
            return false;
        }
        self.slack.newest = raw.clone();
        let mut key = self.slack.next_key;
        let parsed = project_slack::parse(&raw, &mut key);
        self.slack.next_key = key;
        let dirty = self.slack_dirty();
        match parsed {
            Some(parsed) if !dirty || parsed.normal() == self.slack.draft.normal() => {
                // Nothing unsaved, or the daemon now holds exactly these values.
                self.load_slack(raw, parsed);
            }
            // Only the Linear part changed: keep the edits on top of it.
            Some(parsed) if parsed.normal() == self.slack.base.normal() => self.slack.raw = raw,
            None if !dirty => {
                self.slack.load = SlackLoad::Unsupported;
                self.slack.raw = raw;
                self.slack.elsewhere = false;
            }
            _ => self.slack.elsewhere = true,
        }
        true
    }
    fn load_slack(&mut self, raw: Value, slack: Slack) {
        self.slack.raw = raw.clone();
        self.slack.newest = raw;
        self.slack.base = slack.clone();
        self.slack.draft = slack;
        self.slack.load = SlackLoad::Ready;
        self.slack.elsewhere = false;
        self.replaced += 1;
        if !self.dirty() && !self.saving() {
            self.status = Status::Idle;
        }
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
        if self.slack.load == SlackLoad::Ready {
            let raw = self.slack.newest.clone();
            let mut key = self.slack.next_key;
            let parsed = project_slack::parse(&raw, &mut key);
            self.slack.next_key = key;
            match parsed {
                Some(parsed) => self.load_slack(raw, parsed),
                None => {
                    self.slack.load = SlackLoad::Unsupported;
                    self.slack.raw = raw;
                    self.slack.elsewhere = false;
                }
            }
        }
        match self.latest.as_ref().map(Fields::of) {
            Some(server) => self.load(server),
            None => {
                self.draft = self.baseline.clone();
                self.slack.draft = self.slack.base.clone();
                self.status = Status::Idle;
                self.replaced += 1;
            }
        }
        true
    }

    pub(crate) fn begin_save(&mut self) -> Option<Submission> {
        if !self.can_save() {
            return None;
        }
        self.next_token += 1;
        // Reads started before this save can't tell what it wrote.
        self.slack.reads += 1;
        let submission = Submission {
            token: self.next_token,
            project_id: self.project_id.clone(),
            baseline: self.baseline.clone(),
            fields: self.draft.normalized(),
            tracking: self.slack_dirty().then(|| TrackingChange {
                base: self.slack.raw.clone(),
                slack: self.slack.draft.normal(),
            }),
        };
        self.status = Status::Saving(Box::new(submission.clone()));
        Some(submission)
    }

    /// Settles only the in-flight submission; stale or duplicate replies are ignored.
    pub(crate) fn finish(&mut self, submission: &Submission, outcome: Outcome) -> bool {
        if !matches!(&self.status, Status::Saving(s) if **s == *submission) {
            return false;
        }
        match outcome {
            Outcome::Saved(saved, tracking) if submission.applied(&saved, &tracking) => {
                self.status = Status::Idle;
                self.slack.reads += 1;
                self.saved_tracking(submission, tracking);
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
            Outcome::Saved(..) => {
                self.status = Status::Unknown(
                    "Pilot didn't confirm these values. The save may have applied; it won't be resent.",
                )
            }
            Outcome::NotSent(reason) => self.status = Status::Failed(reason),
            Outcome::Unknown(reason) => self.status = Status::Unknown(reason),
        }
        true
    }
    /// The tracking value a confirmed save returned.
    fn saved_tracking(&mut self, submission: &Submission, raw: Value) {
        let Some(change) = &submission.tracking else {
            // Not written by this save, but just as current as any read.
            self.tracking(raw);
            return;
        };
        let mut key = self.slack.next_key;
        let Some(parsed) = project_slack::parse(&raw, &mut key) else {
            return;
        };
        self.slack.next_key = key;
        let edited = self.slack.draft.normal() != change.slack;
        self.slack.raw = raw.clone();
        self.slack.newest = raw;
        self.slack.base = parsed.clone();
        self.slack.elsewhere = false;
        if !edited {
            self.slack.draft = parsed;
            self.replaced += 1;
        }
    }

    fn load(&mut self, server: Fields) {
        self.baseline = server.clone();
        self.draft = server;
        self.updated_elsewhere = false;
        if !self.slack_dirty() {
            self.status = Status::Idle;
        }
        self.replaced += 1;
    }
}

#[cfg(test)]
#[path = "project_settings_tests.rs"]
mod tests;
