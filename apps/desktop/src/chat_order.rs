//! Chat-list order and status groups, matching the Swift app.
//!
//! Swift sources: `PilotCore/SessionListOrdering.swift` (`listPrecedes`,
//! `listActivityAt`, `hasTerminalPullRequest`), `PilotCore/SessionSignal.swift`
//! (`SidebarUrgency.groups`) and `Pilot/Sidebar.swift`.
//!
//! Order (one comparator for every summary list): pinned first, then chats
//! whose PRs have not all settled, then newest list activity, newest
//! `createdAt`, and finally ascending id, so equal or missing timestamps stay
//! deterministic. List activity is `updatedAt` while working; otherwise the
//! later of `lastUserMessageAt` and the visible `outcomeAt`, falling back to
//! `updatedAt`. Metadata updates (parking, PR polling, model changes) do not
//! move a settled chat. Missing `createdAt` reads as 0 (oldest). Nothing here
//! writes a timestamp.
//!
//! Sidebar groups, in order: Pinned, Needs you (failed, then questions, then
//! other attention), Ready to merge, Working, Recent. Each group keeps list
//! order. Intentional differences: Pilot Next has no client review marks, so
//! unread results stay in Recent rather than Needs you (and nothing is held
//! there while open); local new-chat drafts lead under Drafts; archived chats,
//! shown only with the Archived filter, follow under Archived, newest
//! `archivedAt` first as in Swift's archive; retained-history chats stay
//! visible under Recent instead of being hidden.
use crate::{dither::Signal, local_model::Chat};
use serde_json::Value;
use std::cmp::Ordering;

/// A finite timestamp in epoch milliseconds with a total order.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct Stamp(f64);
impl PartialEq for Stamp {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other).is_eq()
    }
}
impl Eq for Stamp {}
impl PartialOrd for Stamp {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for Stamp {
    fn cmp(&self, other: &Self) -> Ordering {
        self.0.total_cmp(&other.0)
    }
}

/// Summary fields the list order needs, read once from the wire.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Order {
    pub(crate) pinned: bool,
    /// Swift `hasTerminalPullRequest`: every linked PR merged or closed.
    pub(crate) settled: bool,
    /// Swift `status == .question`.
    pub(crate) question: bool,
    pub(crate) activity: Stamp,
    pub(crate) created: Stamp,
    pub(crate) archived: Stamp,
}

fn stamp(value: &Value) -> Option<f64> {
    value.as_f64().filter(|t| t.is_finite())
}
fn terminal(pr: &Value) -> bool {
    matches!(pr["state"].as_str(), Some("merged" | "closed"))
}

/// `working` is Swift's `isWorking` (`local_model::working`).
pub(crate) fn read(value: &Value, working: bool) -> Order {
    let created = stamp(&value["createdAt"]).unwrap_or(0.);
    let updated = stamp(&value["updatedAt"]).unwrap_or(created);
    let state = value["state"].as_str().unwrap_or("");
    let paused = value["sleepPaused"] == true || value["offlinePaused"] == true;
    let usage_held = value["subscriptionPause"].is_object()
        && value["subscriptionPause"]["forced"] != true
        && !working
        && matches!(state, "working" | "starting");
    let outcome = value["outcome"]
        .as_str()
        .filter(|o| matches!(*o, "done" | "question" | "failed" | "stopped"));
    let settled_view = !paused && !usage_held && !working;
    let finish = settled_view
        .then(|| outcome.and_then(|_| stamp(&value["outcomeAt"])))
        .flatten();
    let user = stamp(&value["lastUserMessageAt"]);
    let activity = if working {
        updated
    } else {
        user.into_iter()
            .chain(finish)
            .reduce(f64::max)
            .unwrap_or(updated)
    };
    let active_coordinator = value["activeMissionCoordinator"] == true;
    let coordinator = value["missionCoordinator"]
        .as_bool()
        .unwrap_or(active_coordinator);
    let linked: Vec<&Value> = if coordinator {
        Vec::new()
    } else if let Some(prs) = value["pullRequests"].as_array().filter(|p| !p.is_empty()) {
        prs.iter().collect()
    } else {
        value["pullRequest"]
            .is_object()
            .then_some(&value["pullRequest"])
            .into_iter()
            .collect()
    };
    Order {
        pinned: value["pinned"] == true,
        settled: !active_coordinator
            && value["unpublishedWork"] != true
            && terminal(&value["pullRequest"])
            && linked.into_iter().all(terminal),
        question: settled_view && outcome == Some("question"),
        activity: Stamp(activity),
        created: Stamp(created),
        archived: Stamp(stamp(&value["archivedAt"]).unwrap_or(0.)),
    }
}

/// Swift `SessionSummary.listPrecedes` as a total order.
pub(crate) fn precedes(a: &Chat, b: &Chat) -> Ordering {
    let (x, y) = (&a.order, &b.order);
    y.pinned
        .cmp(&x.pinned)
        .then(x.settled.cmp(&y.settled))
        .then(y.activity.cmp(&x.activity))
        .then(y.created.cmp(&x.created))
        .then_with(|| a.id.cmp(&b.id))
}

pub(crate) fn sort(chats: &mut [Chat]) {
    chats.sort_by(precedes);
}

/// Replace or add one live summary and restore list order.
pub(crate) fn upsert(chats: &mut Vec<Chat>, chat: Chat, cap: usize) {
    if let Some(old) = chats.iter_mut().find(|c| c.id == chat.id) {
        *old = chat;
    } else if chats.len() < cap {
        chats.push(chat);
    } else {
        return;
    }
    sort(chats);
}

/// Most recent activity first (Swift's Jump palette order). Use with a stable
/// sort over list order, so ties keep `precedes`.
pub(crate) fn recent(a: &Chat, b: &Chat) -> Ordering {
    b.order.activity.cmp(&a.order.activity)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Section {
    Drafts,
    Pinned,
    NeedsYou,
    Ready,
    Working,
    Recent,
    Archived,
}
pub(crate) const SECTIONS: [Section; 7] = [
    Section::Drafts,
    Section::Pinned,
    Section::NeedsYou,
    Section::Ready,
    Section::Working,
    Section::Recent,
    Section::Archived,
];
impl Section {
    pub(crate) fn title(self) -> &'static str {
        match self {
            Self::Drafts => "Drafts",
            Self::Pinned => "Pinned",
            Self::NeedsYou => "Needs you",
            Self::Ready => "Ready to merge",
            Self::Working => "Working",
            Self::Recent => "Recent",
            Self::Archived => "Archived",
        }
    }
    pub(crate) fn key(self) -> &'static str {
        match self {
            Self::Drafts => "drafts",
            Self::Pinned => "pinned",
            Self::NeedsYou => "needs-you",
            Self::Ready => "ready",
            Self::Working => "working",
            Self::Recent => "recent",
            Self::Archived => "archived",
        }
    }
    /// Swift counts only Needs you and Working in their headers.
    pub(crate) fn counted(self) -> bool {
        matches!(self, Self::NeedsYou | Self::Working)
    }
    pub(crate) fn of(chat: &Chat) -> Self {
        if chat.local_draft {
            Self::Drafts
        } else if chat.archived {
            Self::Archived
        } else if chat.order.pinned {
            Self::Pinned
        } else {
            match chat.signal {
                Some(Signal::Working) => Self::Working,
                Some(Signal::Failed | Signal::NeedsYou) => Self::NeedsYou,
                Some(Signal::Ready) => Self::Ready,
                None => Self::Recent,
            }
        }
    }
}

/// A sidebar row's state words: what the row shows, and the complete state for
/// its accessible name. The shown words never repeat the row's section heading
/// ("Working" under Working); quiet chats say nothing.
pub(crate) fn row_state(chat: &Chat, section: Section) -> (String, String) {
    let full: Vec<&str> = chat
        .row_reason()
        .into_iter()
        .chain(chat.archived.then_some("Archived"))
        .collect();
    let shown: Vec<&str> = full
        .iter()
        .copied()
        .filter(|s| *s != section.title())
        .collect();
    (shown.join(" · "), full.join(" · "))
}

/// Indices of `chats` (already in list order) per section, keeping only `keep`.
pub(crate) fn sections(chats: &[Chat], keep: impl Fn(&Chat) -> bool) -> [Vec<usize>; 7] {
    let mut out: [Vec<usize>; 7] = Default::default();
    for (ix, chat) in chats.iter().enumerate().filter(|(_, c)| keep(c)) {
        out[Section::of(chat) as usize].push(ix);
    }
    // Failed, then questions, then other attention; stable within each.
    out[Section::NeedsYou as usize].sort_by_key(|ix| {
        let chat = &chats[*ix];
        match chat.signal {
            Some(Signal::Failed) => 0,
            _ if chat.order.question => 1,
            _ => 2,
        }
    });
    out[Section::Archived as usize].sort_by(|a, b| {
        let (a, b) = (&chats[*a], &chats[*b]);
        b.order
            .archived
            .cmp(&a.order.archived)
            .then_with(|| a.id.cmp(&b.id))
    });
    out
}

#[cfg(test)]
#[path = "chat_order_tests.rs"]
mod tests;
