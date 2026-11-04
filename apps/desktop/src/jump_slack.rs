//! A pasted Slack message link: the exact message wherever pilotd already holds it, then an
//! explicit add for each other project that tracks Slack. Pure; the palette's lookup is the
//! passive read that feeds it. Nothing here posts, reads Slack or guesses a project.
use super::{Destination, Entry, Kind};
use crate::slack_triage::{LinkLookup, MessageLink};

pub(crate) fn entries(
    link: &MessageLink,
    lookup: &LinkLookup,
    focused: Option<&str>,
) -> Vec<Entry> {
    let name = |id: &str| {
        lookup
            .projects
            .iter()
            .find(|p| p.id == id)
            .map_or_else(|| "Project unavailable".to_owned(), |p| p.name.clone())
    };
    let mut out: Vec<Entry> = lookup
        .items
        .iter()
        .map(|item| {
            Entry::new(
                format!("slack:open:{}", item.id),
                Destination::SlackOpen(Box::new(item.clone())),
                Kind::Slack,
                item.title.clone(),
                [
                    item.triage.status_title(),
                    item.channel(),
                    name(&item.project_id),
                ]
                .join(" · "),
                Vec::new(),
                true,
            )
        })
        .collect();
    out.extend(lookup.add_targets(link, focused).into_iter().map(|p| {
        Entry::new(
            format!("slack:add:{}", p.id),
            Destination::SlackAdd {
                project: p.id.clone(),
                url: link.url.clone(),
            },
            Kind::Slack,
            format!("Add to Slack triage in {}", p.name),
            "Reads the message from Slack".into(),
            Vec::new(),
            true,
        )
    }));
    out
}
