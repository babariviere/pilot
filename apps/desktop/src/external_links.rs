//! Message links the user explicitly activates. Canonical Pilot chat links stay in the
//! app; ordinary http(s) links go to the platform URL opener; everything else is refused.
//! Service badges are Swift's local, deterministic GitHub/Linear/Slack labels: no fetch,
//! resolver or rewritten label. On macOS, Linear and Slack content links open in their
//! desktop apps (`desktop_app_link`), falling back to the exact web URL.
use gpui_kit::{App, Global};
use std::sync::Arc;

const URL_BYTES: usize = 4096;

/// A validated web destination. Opening uses its WHATWG serialization (percent and
/// punycode encoding only), never a guessed or converted target.
pub(crate) fn web(raw: &str) -> Option<reqwest::Url> {
    if raw.len() > URL_BYTES
        || raw.chars().any(|c| {
            c.is_control() || matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
        || raw.contains('\\')
    {
        return None;
    }
    // Reject encoded controls too. Never silently repair a copied target.
    for pair in raw.as_bytes().windows(3).filter(|s| s[0] == b'%') {
        if let Ok(hex) = std::str::from_utf8(&pair[1..])
            && let Ok(byte) = u8::from_str_radix(hex, 16)
            && (byte < 32 || byte == 127)
        {
            return None;
        }
    }
    let url = reqwest::Url::parse(raw).ok()?;
    (matches!(url.scheme(), "http" | "https")
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none())
    .then_some(url)
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Route {
    /// `pilot:` links; the chat route validates the exact identity.
    Chat,
    Web(reqwest::Url),
    Refused,
}

pub(crate) fn route(url: &str) -> Route {
    if url
        .get(..6)
        .is_some_and(|s| s.eq_ignore_ascii_case("pilot:"))
    {
        Route::Chat
    } else {
        web(url).map_or(Route::Refused, Route::Web)
    }
}

pub(crate) const REFUSED: &str = "This link can't be opened. Pilot opens web and Pilot chat links.";

/// Replaceable platform opener, so synthetic checks capture destinations instead of
/// launching a browser.
type OpenFn = dyn Fn(&str, &mut App);
#[derive(Clone)]
pub(crate) struct Opener(pub(crate) Arc<OpenFn>);
impl Global for Opener {}

/// Call only from an explicit user activation.
pub(crate) fn open(url: &reqwest::Url, cx: &mut App) {
    match cx.try_global::<Opener>().cloned() {
        Some(opener) => (opener.0)(url.as_str(), cx),
        None => {
            #[cfg(target_os = "macos")]
            if crate::desktop_app_link::url(url, crate::desktop_app_link::slack_workspaces)
                .is_some_and(|native| crate::desktop_app_link::launch(&native))
            {
                return;
            }
            cx.open_url(url.as_str())
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Service {
    GitHub,
    Linear,
    Slack,
}
impl Service {
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::GitHub => "GitHub",
            Self::Linear => "Linear",
            Self::Slack => "Slack",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Badge {
    pub(crate) service: Service,
    /// The written label, else a name derived locally from the URL.
    pub(crate) title: String,
}

/// Swift `ServiceLink`: exact hosts only, so lookalikes stay ordinary links.
pub(crate) fn badge(url: &str, label: Option<&str>) -> Option<Badge> {
    let parsed = web(url)?;
    if parsed.port().is_some() {
        return None;
    }
    let host = parsed.host_str()?;
    let path: Vec<&str> = parsed
        .path_segments()
        .map(|s| s.filter(|p| !p.is_empty()).collect())
        .unwrap_or_default();
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    let (service, fallback) = if host == "github.com" && path.len() >= 2 {
        let repository = format!("{}/{}", path[0], path[1]);
        let fallback = if path.len() >= 4
            && ["pull", "issues", "discussions"].contains(&path[2])
            && digits(path[3])
            && !path[3].starts_with('0')
        {
            format!("{repository}#{}", path[3])
        } else if path.len() >= 4
            && path[2] == "commit"
            && path[3].bytes().all(|b| b.is_ascii_hexdigit())
        {
            format!("{repository}@{}", &path[3][..path[3].len().min(7)])
        } else if path.len() > 2 {
            format!("{repository} · {}", path[path.len() - 1])
        } else {
            repository
        };
        (Service::GitHub, fallback)
    } else if host == "linear.app" && path.len() >= 3 && ["issue", "project"].contains(&path[1]) {
        let fallback = if path[1] == "issue" {
            let name = path.get(3).map(|s| words(s)).unwrap_or_default();
            let id = path[2].to_uppercase();
            if name.is_empty() {
                id
            } else {
                format!("{id} · {name}")
            }
        } else {
            let mut slug: Vec<&str> = path[2].split('-').collect();
            if slug
                .last()
                .is_some_and(|l| l.len() >= 8 && l.bytes().all(|b| b.is_ascii_hexdigit()))
            {
                slug.pop();
            }
            if slug.is_empty() {
                "Linear project".into()
            } else {
                words(&slug.join("-"))
            }
        };
        (Service::Linear, fallback)
    } else if host.ends_with(".slack.com") && path.len() >= 2 && path[0] == "archives" {
        let kind = if path.len() > 2 {
            "Slack thread"
        } else {
            "Slack channel"
        };
        (Service::Slack, kind.to_string())
    } else if host == "app.slack.com" && path.len() >= 3 && path[0] == "client" {
        let kind = if path.len() > 3 {
            "Slack thread"
        } else {
            "Slack channel"
        };
        (Service::Slack, kind.to_string())
    } else {
        return None;
    };
    let label = label.map(str::trim).filter(|l| {
        !l.is_empty()
            && !["https://", "http://", "artifact://"]
                .iter()
                .any(|p| l.get(..p.len()).is_some_and(|s| s.eq_ignore_ascii_case(p)))
    });
    let title = label.map_or(fallback, str::to_string);
    let single = title.split_whitespace().collect::<Vec<_>>().join(" ");
    let title = if single.chars().count() > 80 {
        single.chars().take(79).chain(['…']).collect()
    } else {
        single
    };
    Some(Badge { service, title })
}

fn words(slug: &str) -> String {
    let value = slug.replace('-', " ");
    let mut chars = value.chars();
    chars
        .next()
        .map(|c| c.to_uppercase().chain(chars).collect())
        .unwrap_or_default()
}

#[cfg(test)]
#[path = "external_links_tests.rs"]
mod tests;
