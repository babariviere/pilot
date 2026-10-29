//! Contextual destinations from exact linked PR metadata and a captured loaded reader.
//! No history reads, URL resolution or opening occurs here.
use super::{Catalog, Destination, Entry, Snapshot};
use crate::model::Message;
use std::collections::HashSet;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Reader {
    pub(crate) chat: String,
    pub(crate) generation: u64,
}

impl Catalog {
    pub(crate) fn with_links(s: &Snapshot, rows: Vec<Message>) -> Self {
        let mut catalog = Self::new(s);
        let Some(reader) = &s.reader else {
            return catalog;
        };
        let mut seen = HashSet::new();
        let mut push = |raw: &str, title: Option<&str>, confirmed_pr: bool| {
            let Some(url) = crate::external_links::web(raw) else {
                return;
            };
            if !seen.insert(url.to_string()) {
                return;
            }
            // An arbitrary web path named /pull isn't proof of a PR. Summary and
            // confirmed audit URLs also support private GitHub hosts.
            let pr = super::pr_url(url.as_str())
                .filter(|_| confirmed_pr || url.host_str() == Some("github.com"));
            let fallback = pr
                .as_ref()
                .map(|pr| format!("{} #{}", pr.repository, pr.number));
            let title = title
                .filter(|t| !t.trim().is_empty())
                .map(str::to_owned)
                .or(fallback)
                .or_else(|| crate::external_links::badge(url.as_str(), None).map(|b| b.title))
                .unwrap_or_else(|| format!("{}{}", url.host_str().unwrap_or_default(), url.path()));
            let mut entry = Entry::new(
                format!("link:{url}"),
                Destination::OpenLink {
                    reader: reader.clone(),
                    url: url.to_string(),
                },
                super::Kind::Link,
                if pr.is_some() {
                    format!("Open pull request · {title}")
                } else {
                    format!("Open link · {title}")
                },
                url.to_string(),
                vec![
                    url.to_string(),
                    "links URL web current chat".into(),
                    if pr.is_some() {
                        "PR GitHub pull request".into()
                    } else {
                        String::new()
                    },
                ],
                true,
            );
            entry.is_pr = pr.is_some();
            catalog.entries.push(entry);
        };
        // Canonical linked PRs first, then confirmed audits, then latest loaded
        // message mentions in the existing inspector's stable scan order.
        if let Some(chat) = s.chats.iter().find(|c| c.id == reader.chat) {
            for pr in &chat.pull_requests {
                push(&pr.url, None, true);
            }
        }
        for row in rows.iter().rev() {
            if let Some(event) = row.github_event()
                && event.outcome == crate::github_event::Outcome::Succeeded
                && let Some(url) = &event.url
            {
                push(url, event.title.as_deref(), true);
            }
        }
        let scan = crate::conversation_links::scan(rows);
        for link in scan.links {
            push(&link.url, None, false);
        }
        catalog.links_limited = scan.limited;
        catalog
    }
}

#[cfg(test)]
#[path = "jump_links_tests.rs"]
mod tests;
