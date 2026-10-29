//! Chat-list order and sidebar sections.
//!
//! Swift sources: `PilotCore/SessionListOrdering.swift` (`listPrecedes`,
//! `listActivityAt`, `hasTerminalPullRequest`).
//!
//! List order (Home, Inbox and Jump): pinned first, then chats whose PRs have
//! not all settled, then newest list activity, newest `createdAt`, and finally
//! ascending id, so equal or missing timestamps stay deterministic. List
//! activity is `updatedAt` while working; otherwise the later of
//! `lastUserMessageAt` and the visible `outcomeAt`, falling back to
//! `updatedAt`. Missing `createdAt` reads as 0 (oldest). Nothing here writes a
//! timestamp.
//!
//! The sidebar does not group by state: its sections are Drafts, Pinned,
//! Chats (mission threads and standalone chats, in the user's own activity
//! order, see `sidebar_tree`) and Archived, shown only with the Archived filter.
//! Pilot Next has no client review marks; Swift's sidebar is unchanged.
use crate::local_model::Chat;
use serde_json::Value;
use std::cmp::Ordering;

/// A finite timestamp in epoch milliseconds with a total order.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct Stamp(pub(crate) f64);
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
    /// `lastUserMessageAt`, else `createdAt`. The daemon also stamps automatic
    /// notices here, so the sidebar only seeds its own order from it.
    pub(crate) user: Stamp,
    /// When the agent's latest visible reply or result settled (`outcomeAt` of a
    /// done, question or failed outcome). Never `updatedAt`.
    pub(crate) reply: Option<Stamp>,
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
        question: outcome == Some("question")
            && (settled_view || crate::local_model::question_outranks_work(value)),
        activity: Stamp(activity),
        created: Stamp(created),
        archived: Stamp(stamp(&value["archivedAt"]).unwrap_or(0.)),
        user: Stamp(user.unwrap_or(created)),
        reply: (settled_view && matches!(outcome, Some("done" | "question" | "failed")))
            .then(|| stamp(&value["outcomeAt"]))
            .flatten()
            .map(Stamp),
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
pub(crate) fn upsert(chats: &mut Vec<Chat>, chat: Chat) {
    if let Some(old) = chats.iter_mut().find(|c| c.id == chat.id) {
        *old = chat;
    } else {
        chats.push(chat);
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
    Chats,
    Archived,
}
pub(crate) const SECTIONS: [Section; 4] = [
    Section::Drafts,
    Section::Pinned,
    Section::Chats,
    Section::Archived,
];
impl Section {
    pub(crate) fn title(self) -> &'static str {
        match self {
            Self::Drafts => "Drafts",
            Self::Pinned => "Pinned",
            Self::Chats => "Chats",
            Self::Archived => "Archived",
        }
    }
    pub(crate) fn key(self) -> &'static str {
        match self {
            Self::Drafts => "drafts",
            Self::Pinned => "pinned",
            Self::Chats => "chats",
            Self::Archived => "archived",
        }
    }
    pub(crate) fn of(chat: &Chat) -> Self {
        if chat.local_draft {
            Self::Drafts
        } else if chat.archived {
            Self::Archived
        } else if chat.order.pinned {
            Self::Pinned
        } else {
            Self::Chats
        }
    }
}

/// A row's complete state words, for its caption and accessible name. Quiet
/// chats say nothing.
pub(crate) fn row_state(chat: &Chat) -> String {
    chat.row_reason()
        .into_iter()
        .chain(chat.archived.then_some("Archived"))
        .collect::<Vec<_>>()
        .join(" · ")
}

#[cfg(test)]
#[path = "chat_order_tests.rs"]
mod tests;
