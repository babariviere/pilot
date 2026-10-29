//! What would be lost or left unconfirmed if the app restarted to install an update, and
//! where the user resolves it. Read-only: nothing here saves, sends, discards or retries.
#![cfg_attr(not(any(target_os = "macos", target_os = "linux")), allow(dead_code))]
use crate::mission_browser::Key;

/// User state a secondary form holds that an update restart must not drop.
///
/// An Unknown outcome is not held: a restart never resends it, and Local stays the authority
/// on whether it applied. Holding it would make the update impossible with no way to resolve it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Hold {
    /// Typed or chosen input that was never sent.
    Unsaved,
    /// A request whose outcome hasn't arrived yet.
    Sending,
    /// A preferences write whose durability was not confirmed.
    Unconfirmed,
}
impl Hold {
    pub(crate) fn of(sending: bool, unsaved: bool) -> Option<Self> {
        if sending {
            Some(Self::Sending)
        } else if unsaved {
            Some(Self::Unsaved)
        } else {
            None
        }
    }
}

/// Why installing has to wait, named by the place that holds the work.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Blocker {
    /// An input method composition in a secondary field.
    Composition,
    /// Preferences could not be loaded, or their last load/save reported an error.
    PreferencesFailed,
    PreferencesLoading,
    Preferences(Hold),
    ScopedModels(Hold),
    Jump,
    /// The convert-chat-to-mission sheet.
    Conversion(Hold),
    AddProject(Hold),
    QueuedMessage {
        chat: String,
    },
    ChatRename {
        chat: String,
        hold: Hold,
    },
    ChatAction,
    NewMission(Hold),
    Mission {
        key: Key,
        hold: Hold,
    },
}

/// Where the Show action takes the user.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Destination {
    ScopedModels,
    MainWindow,
    Chat(String),
    Missions,
    Mission(Key),
}

impl Blocker {
    pub(crate) fn message(&self) -> &'static str {
        use Hold::*;
        match self {
            Self::Composition => "Finish the text you're composing first. Nothing was discarded.",
            Self::PreferencesFailed => {
                "Settings couldn't be loaded or saved. Resolve the Settings error, then try again."
            }
            Self::PreferencesLoading => "Settings are still loading. Try again in a moment.",
            Self::Preferences(Unsaved) => {
                "Save or revert your Settings changes first. Nothing was discarded."
            }
            Self::Preferences(Sending) => {
                "Settings are still saving. Try again when the save finishes."
            }
            Self::Preferences(Unconfirmed) => {
                "Your last Settings save is unconfirmed. Save again to confirm it first."
            }
            Self::ScopedModels(Unsaved) => {
                "Save or revert your Scoped models changes first. Nothing was discarded."
            }
            Self::ScopedModels(Sending) => {
                "Scoped models are still saving or checking. Try again when they finish."
            }
            Self::ScopedModels(Unconfirmed) => {
                "Your Scoped models save is unconfirmed. Check again in Scoped models first."
            }
            Self::Jump => "Close the Jump palette first.",
            Self::Conversion(Sending) => {
                "Converting the chat to a mission is still in progress. Try again when it finishes."
            }
            Self::Conversion(_) => {
                "Finish or cancel converting the chat to a mission first. Nothing was discarded."
            }
            Self::AddProject(Sending) => {
                "A project is still being added. Try again when it finishes."
            }
            Self::AddProject(_) => "Finish or close Add project first.",
            Self::QueuedMessage { .. } => {
                "Save or cancel the queued-message edit first. Nothing was discarded."
            }
            Self::ChatRename { hold: Sending, .. } => {
                "A chat rename is still saving. Try again when it finishes."
            }
            Self::ChatRename { .. } => {
                "Save or cancel the chat rename first. Nothing was discarded."
            }
            Self::ChatAction => "A chat action is still in progress. Try again when it finishes.",
            Self::NewMission(Sending) => {
                "A new mission is still being created. Try again when it finishes."
            }
            Self::NewMission(_) => {
                "Create or clear the new mission draft first. Nothing was discarded."
            }
            Self::Mission { hold: Sending, .. } => {
                "A mission change is still saving. Try again when it finishes."
            }
            Self::Mission { .. } => {
                "Save or revert your unsaved mission edits first. Nothing was discarded."
            }
        }
    }
    /// None when the blocker is already on screen beside the message (Settings Save/Revert)
    /// or resolves on its own.
    pub(crate) fn destination(&self) -> Option<Destination> {
        match self {
            Self::PreferencesFailed
            | Self::PreferencesLoading
            | Self::Preferences(_)
            | Self::ChatAction => None,
            Self::ScopedModels(_) => Some(Destination::ScopedModels),
            Self::Composition | Self::Jump | Self::Conversion(_) | Self::AddProject(_) => {
                Some(Destination::MainWindow)
            }
            Self::QueuedMessage { chat } | Self::ChatRename { chat, .. } => {
                Some(Destination::Chat(chat.clone()))
            }
            Self::NewMission(_) => Some(Destination::Missions),
            Self::Mission { key, .. } => Some(Destination::Mission(key.clone())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sending_wins_over_unsaved_and_clean_holds_nothing() {
        assert_eq!(Hold::of(true, true), Some(Hold::Sending));
        assert_eq!(Hold::of(false, true), Some(Hold::Unsaved));
        assert_eq!(Hold::of(false, false), None);
    }
    #[test]
    fn every_blocker_names_its_resolution_without_claiming_a_discard() {
        let key = Key {
            home: crate::mission_browser::Home {
                daemon: "d".into(),
                lineage: "l".into(),
            },
            id: "m".into(),
        };
        let all = [
            Blocker::Composition,
            Blocker::PreferencesFailed,
            Blocker::PreferencesLoading,
            Blocker::Preferences(Hold::Unsaved),
            Blocker::Preferences(Hold::Sending),
            Blocker::Preferences(Hold::Unconfirmed),
            Blocker::ScopedModels(Hold::Unsaved),
            Blocker::ScopedModels(Hold::Sending),
            Blocker::ScopedModels(Hold::Unconfirmed),
            Blocker::Jump,
            Blocker::Conversion(Hold::Unsaved),
            Blocker::Conversion(Hold::Sending),
            Blocker::AddProject(Hold::Unsaved),
            Blocker::AddProject(Hold::Sending),
            Blocker::QueuedMessage { chat: "c".into() },
            Blocker::ChatRename {
                chat: "c".into(),
                hold: Hold::Unsaved,
            },
            Blocker::ChatRename {
                chat: "c".into(),
                hold: Hold::Sending,
            },
            Blocker::ChatAction,
            Blocker::NewMission(Hold::Unsaved),
            Blocker::NewMission(Hold::Sending),
            Blocker::Mission {
                key: key.clone(),
                hold: Hold::Unsaved,
            },
            Blocker::Mission {
                key: key.clone(),
                hold: Hold::Sending,
            },
        ];
        let messages: std::collections::BTreeSet<_> = all.iter().map(Blocker::message).collect();
        assert_eq!(messages.len(), all.len(), "each blocker is distinguishable");
        for b in &all {
            let m = b.message();
            assert!(!m.contains("secondary editor"), "{m}");
            assert!(
                !m.to_lowercase().contains("discarded.") || m.ends_with("Nothing was discarded.")
            );
        }
        assert_eq!(
            Blocker::Mission {
                key: key.clone(),
                hold: Hold::Unsaved
            }
            .destination(),
            Some(Destination::Mission(key))
        );
        assert_eq!(
            Blocker::ChatRename {
                chat: "c".into(),
                hold: Hold::Unsaved
            }
            .destination(),
            Some(Destination::Chat("c".into()))
        );
        assert_eq!(Blocker::Preferences(Hold::Unsaved).destination(), None);
    }
}
