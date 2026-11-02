//! The Slack part of a project's tracking settings: followed channels, mention-only filters,
//! group handles and labels. The daemon replaces the whole tracking object on save, so a Slack
//! save resends the Linear values exactly as last read and changes nothing else.
use serde_json::{Map, Value, json};

pub(crate) const CHANNELS: usize = 100;
pub(crate) const LABELS: usize = 50;
const GROUPS: usize = 30;
const NAME_UNITS: usize = 80;
const DESCRIPTION_UNITS: usize = 240;
/// Every key the daemon accepts in tracking. Anything else is a format this editor can't round-trip.
const KEYS: [&str; 8] = [
    "slackChannels",
    "slackMentionOnlyChannels",
    "slackGroupHandles",
    "slackChannelNames",
    "slackLabels",
    "linearTeam",
    "linearTeamName",
    "linearStateMappings",
];
/// Kept verbatim: Slack settings never edit the Linear team or its mappings.
const LINEAR: [&str; 3] = ["linearTeam", "linearTeamName", "linearStateMappings"];

/// What a label does to its messages, as the daemon applies it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Effect {
    None,
    Hide,
    Close,
}
impl Effect {
    pub(crate) const ALL: [Self; 3] = [Self::None, Self::Hide, Self::Close];
    fn wire(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Hide => "hide",
            Self::Close => "close",
        }
    }
    pub(crate) fn title(self) -> &'static str {
        match self {
            Self::None => "No effect",
            Self::Hide => "Hide from Inbox",
            Self::Close => "Close",
        }
    }
    /// What the effect does, shown beside the label rather than only in a tooltip.
    pub(crate) fn consequence(self) -> Option<&'static str> {
        match self {
            Self::None => None,
            Self::Hide => Some(
                "Matching messages stay out of the Inbox. Slack triage still lists them under Show hidden.",
            ),
            Self::Close => Some(
                "Pilot dismisses matching messages unless you set their status. They reopen if the label stops applying.",
            ),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Channel {
    /// As configured: a Slack channel ID, or a name in older configs. Never rewritten.
    pub(crate) id: String,
    /// Display only.
    pub(crate) name: Option<String>,
    pub(crate) mention_only: bool,
}
impl Channel {
    pub(crate) fn display(&self) -> String {
        let value = self.name.as_deref().unwrap_or(&self.id);
        if value.starts_with('#') {
            value.into()
        } else {
            format!("#{value}")
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Label {
    /// Local row identity, so a row keeps its fields while its name changes.
    pub(crate) key: u64,
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) effect: Effect,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Slack {
    pub(crate) channels: Vec<Channel>,
    /// As typed: handles separated by commas or spaces.
    pub(crate) groups: String,
    pub(crate) labels: Vec<Label>,
}

/// The values a save writes, spelled the way the daemon stores them.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Normal {
    pub(crate) channels: Vec<(String, Option<String>, bool)>,
    pub(crate) groups: Vec<String>,
    pub(crate) labels: Vec<(String, String, Effect)>,
}

fn one_line(value: &str) -> String {
    value
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .trim()
        .to_owned()
}
fn units(value: &str) -> usize {
    value.encode_utf16().count()
}
fn handles(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for handle in text.split(|c: char| c == ',' || c.is_whitespace()) {
        let handle = handle.trim();
        let handle = handle.strip_prefix('@').unwrap_or(handle).to_lowercase();
        if !handle.is_empty() && !out.contains(&handle) {
            out.push(handle);
        }
    }
    out
}
fn valid_handle(handle: &str) -> bool {
    let mut chars = handle.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && handle.len() <= NAME_UNITS
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        && !matches!(handle, "here" | "channel" | "everyone")
}

impl Slack {
    pub(crate) fn normal(&self) -> Normal {
        let mut channels: Vec<(String, Option<String>, bool)> = Vec::new();
        for c in &self.channels {
            let id = c.id.trim().to_owned();
            if id.is_empty() || channels.iter().any(|(seen, _, _)| *seen == id) {
                continue;
            }
            let name = c
                .name
                .as_deref()
                .map(str::trim)
                .map(|n| n.strip_prefix('#').unwrap_or(n).trim().to_owned())
                .filter(|n| !n.is_empty());
            channels.push((id, name, c.mention_only));
        }
        Normal {
            channels,
            groups: handles(&self.groups),
            labels: self
                .labels
                .iter()
                .map(|l| (one_line(&l.name), one_line(&l.description), l.effect))
                // A row left blank is not a label.
                .filter(|(name, description, _)| !name.is_empty() || !description.is_empty())
                .collect(),
        }
    }
    pub(crate) fn groups_problem(&self) -> Option<&'static str> {
        let groups = handles(&self.groups);
        if groups.len() > GROUPS {
            Some("Use at most 30 groups.")
        } else if !groups.iter().all(|g| valid_handle(g)) {
            Some("Use group handles like @support. @here, @channel and @everyone don't count.")
        } else {
            None
        }
    }
    pub(crate) fn label_problem(&self, key: u64) -> Option<&'static str> {
        let label = self.labels.iter().find(|l| l.key == key)?;
        let (name, description) = (one_line(&label.name), one_line(&label.description));
        if name.is_empty() {
            return (!description.is_empty()).then_some("Name this label.");
        }
        if units(&name) > NAME_UNITS {
            return Some("Use a shorter name.");
        }
        if units(&description) > DESCRIPTION_UNITS {
            return Some("Use a shorter description.");
        }
        let same = self
            .labels
            .iter()
            .filter(|l| one_line(&l.name) == name)
            .count();
        (same > 1).then_some("Another label has this name.")
    }
    /// The first reason this draft can't be saved.
    pub(crate) fn problem(&self) -> Option<&'static str> {
        self.groups_problem()
            .or_else(|| self.labels.iter().find_map(|l| self.label_problem(l.key)))
            .or_else(|| (self.channels.len() > CHANNELS).then_some("Follow at most 100 channels."))
            .or_else(|| (self.normal().labels.len() > LABELS).then_some("Use at most 50 labels."))
    }
    /// Groups only filter mention-only channels; keep them shown while any are set so they can be cleared.
    pub(crate) fn shows_groups(&self) -> bool {
        self.channels.iter().any(|c| c.mention_only) || !self.groups.trim().is_empty()
    }
}

/// Reads a project's tracking value. None when it holds something this editor can't round-trip,
/// so it is shown read-only rather than rewritten.
pub(crate) fn parse(raw: &Value, next_key: &mut u64) -> Option<Slack> {
    let object = match raw {
        Value::Null => return Some(Slack::default()),
        Value::Object(object) => object,
        _ => return None,
    };
    if object.keys().any(|k| !KEYS.contains(&k.as_str())) {
        return None;
    }
    let strings = |key: &str| -> Option<Vec<String>> {
        match object.get(key) {
            None | Some(Value::Null) => Some(Vec::new()),
            Some(Value::Array(values)) => values
                .iter()
                .map(|v| v.as_str().map(str::to_owned))
                .collect(),
            Some(_) => None,
        }
    };
    let ids = strings("slackChannels")?;
    let mention = strings("slackMentionOnlyChannels")?;
    let groups = strings("slackGroupHandles")?;
    let names = match object.get("slackChannelNames") {
        None | Some(Value::Null) => Map::new(),
        Some(Value::Object(names)) => names.clone(),
        Some(_) => return None,
    };
    let channels = ids
        .into_iter()
        .map(|id| Channel {
            name: names.get(&id).and_then(Value::as_str).map(str::to_owned),
            mention_only: mention.contains(&id),
            id,
        })
        .collect();
    let mut labels = Vec::new();
    match object.get("slackLabels") {
        None | Some(Value::Null) => {}
        Some(Value::Array(values)) => {
            for value in values {
                let name = value["name"].as_str()?;
                let description = value["description"].as_str().unwrap_or("");
                let effect = match value["effect"].as_str() {
                    Some("hide") => Effect::Hide,
                    Some("close") => Effect::Close,
                    Some("none") => Effect::None,
                    None if value["hideFromInbox"] == true => Effect::Hide,
                    None => Effect::None,
                    Some(_) => return None,
                };
                *next_key += 1;
                labels.push(Label {
                    key: *next_key,
                    name: name.into(),
                    description: description.into(),
                    effect,
                });
            }
        }
        Some(_) => return None,
    }
    Some(Slack {
        channels,
        groups: groups
            .iter()
            .map(|g| format!("@{}", g.trim_start_matches('@')))
            .collect::<Vec<_>>()
            .join(", "),
        labels,
    })
}

/// The Linear part of a tracking value, which Slack saves send back unchanged.
pub(crate) fn linear(raw: &Value) -> Map<String, Value> {
    LINEAR
        .iter()
        .filter_map(|k| raw.get(*k).map(|v| ((*k).to_owned(), v.clone())))
        .collect()
}

/// The complete tracking value for a Slack save: the Linear values as read, plus these Slack values.
pub(crate) fn body(base: &Value, slack: &Normal) -> Value {
    let mut out = linear(base);
    out.insert(
        "slackChannels".into(),
        json!(slack.channels.iter().map(|c| &c.0).collect::<Vec<_>>()),
    );
    let names: Map<String, Value> = slack
        .channels
        .iter()
        .filter_map(|(id, name, _)| name.as_ref().map(|n| (id.clone(), json!(n))))
        .collect();
    if !names.is_empty() {
        out.insert("slackChannelNames".into(), Value::Object(names));
    }
    let mention: Vec<_> = slack
        .channels
        .iter()
        .filter(|c| c.2)
        .map(|c| &c.0)
        .collect();
    if !mention.is_empty() {
        out.insert("slackMentionOnlyChannels".into(), json!(mention));
    }
    if !slack.groups.is_empty() {
        out.insert("slackGroupHandles".into(), json!(slack.groups));
    }
    if !slack.labels.is_empty() {
        out.insert(
            "slackLabels".into(),
            Value::Array(
                slack
                    .labels
                    .iter()
                    .map(|(name, description, effect)| {
                        json!({"name":name,"description":description,"effect":effect.wire()})
                    })
                    .collect(),
            ),
        );
    }
    Value::Object(out)
}

/// The daemon stored exactly these Slack values and left the Linear ones as they were.
pub(crate) fn stored(saved: &Value, base: &Value, slack: &Normal) -> bool {
    let mut key = 0;
    linear(saved) == linear(base) && parse(saved, &mut key).is_some_and(|s| s.normal() == *slack)
}

/// One channel's last reported read, from the project's Slack source.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ChannelHealth {
    pub(crate) status: String,
    pub(crate) error: Option<String>,
}
/// The project's Slack source as pilotd last described it. Local state only, never a live check.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Source {
    pub(crate) status: String,
    pub(crate) error: Option<String>,
    pub(crate) sign_in_command: Option<String>,
    pub(crate) budget_limited: bool,
    pub(crate) channels: Vec<(String, ChannelHealth)>,
}
fn short(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(one_line)
        .filter(|s| !s.is_empty())
        .map(|s| s.chars().take(300).collect())
}
impl Source {
    /// The Slack entry for exactly this project in a GET /api/sources list.
    pub(crate) fn read(list: &Value, project_id: &str) -> Option<Self> {
        let source = list
            .as_array()?
            .iter()
            .find(|s| s["kind"] == "slack" && s["projectId"] == project_id)?;
        Some(Self {
            status: source["status"].as_str()?.to_owned(),
            error: short(&source["error"]),
            sign_in_command: short(&source["signInCommand"]),
            budget_limited: source["budgetLimited"] == true,
            channels: source["channels"]
                .as_array()
                .map(|channels| {
                    channels
                        .iter()
                        .take(CHANNELS)
                        .filter_map(|c| {
                            Some((
                                c["id"].as_str()?.to_owned(),
                                ChannelHealth {
                                    status: c["status"].as_str()?.to_owned(),
                                    error: short(&c["error"]),
                                },
                            ))
                        })
                        .collect()
                })
                .unwrap_or_default(),
        })
    }
    pub(crate) fn channel(&self, id: &str) -> Option<&ChannelHealth> {
        self.channels.iter().find(|(c, _)| c == id).map(|(_, h)| h)
    }
}

/// A channel offered by the read-only Slack channel lookup.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ChannelOption {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) private: bool,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Lookup {
    Found {
        items: Vec<ChannelOption>,
        more: bool,
    },
    SignIn,
    Failed(String),
}
impl Lookup {
    pub(crate) fn read(value: &Value) -> Self {
        match value["status"].as_str() {
            Some("ok") => Self::Found {
                items: value["items"]
                    .as_array()
                    .map(|items| {
                        items
                            .iter()
                            .take(CHANNELS)
                            .filter_map(|i| {
                                let id = i["id"].as_str()?.trim();
                                let name = one_line(i["name"].as_str()?);
                                (!id.is_empty() && id.len() <= 200 && !name.is_empty()).then(|| {
                                    ChannelOption {
                                        id: id.into(),
                                        name,
                                        private: i["private"] == true,
                                    }
                                })
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
                more: value["more"] == true,
            },
            Some("sign_in_required") => Self::SignIn,
            _ => Self::Failed(
                short(&value["error"]).unwrap_or_else(|| "Couldn't reach Slack.".into()),
            ),
        }
    }
}

#[cfg(test)]
#[path = "project_slack_tests.rs"]
mod tests;
