//! Swift `DesktopAppLink` on macOS: Linear issue/project links and Slack permalinks open in
//! the desktop apps. Content links only; anything else, or a link no installed app accepts,
//! opens as the exact web URL.
use reqwest::Url;

/// A Slack workspace the desktop app is signed in to.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct SlackWorkspace {
    pub(crate) id: String,
    pub(crate) host: Option<String>,
}

/// `workspaces` runs only for Slack permalinks that carry no team.
pub(crate) fn url(url: &Url, workspaces: impl FnOnce() -> Vec<SlackWorkspace>) -> Option<String> {
    if url.port().is_some() {
        return None;
    }
    let host = url.host_str()?.to_ascii_lowercase();
    let path: Vec<&str> = url
        .path_segments()
        .map(|s| s.filter(|p| !p.is_empty()).collect())
        .unwrap_or_default();
    if host == "linear.app" && path.len() >= 3 && ["issue", "project"].contains(&path[1]) {
        return Some(format!("linear{}", &url.as_str()[url.scheme().len()..]));
    }
    if host != "slack.com" && !host.ends_with(".slack.com") {
        return None;
    }
    let value = |name: &str| {
        url.query_pairs()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.into_owned())
    };
    let mut team = value("team");
    let channel: String;
    let mut message = None;
    if (path.len() == 2 || path.len() == 3) && path[0] == "archives" {
        channel = path[1].into();
        if let Some(stamp) = path.get(2) {
            let digits = stamp.strip_prefix('p')?;
            if digits.len() < 7 || !digits.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            let (seconds, micros) = digits.split_at(digits.len() - 6);
            message = Some(format!("{seconds}.{micros}"));
        }
    } else if host == "app.slack.com" && (path.len() == 3 || path.len() == 4) && path[0] == "client"
    {
        team = Some(path[1].into());
        channel = path[2].into();
        message = path.get(3).map(|s| s.to_string());
    } else {
        return None;
    }
    if !id(&channel, b"CDG") || team.as_deref().is_some_and(|t| !id(t, b"TE")) {
        return None;
    }
    // A reply permalink names the reply in its path and the parent in thread_ts.
    let thread = value("thread_ts");
    if [&message, &thread]
        .into_iter()
        .flatten()
        .any(|t| !timestamp(t))
    {
        return None;
    }
    // slack://channel needs a team, else Slack only comes to the front. An unknown
    // workspace opens in the browser, which can resolve it.
    let team = match team {
        Some(team) => team,
        None => slack_team(&host, &workspaces())?,
    };
    let mut native = format!("slack://channel?team={team}&id={channel}");
    // Slack scrolls to `message`; it ignores `ts`.
    if let Some(stamp) = message.as_ref().or(thread.as_ref()) {
        native += &format!("&message={stamp}");
    }
    if let Some(thread) = thread {
        native += &format!("&thread_ts={thread}");
    }
    Some(native)
}

/// A workspace subdomain names its team; bare slack.com links are unambiguous only with
/// one workspace.
fn slack_team(host: &str, workspaces: &[SlackWorkspace]) -> Option<String> {
    if host == "slack.com" || host == "app.slack.com" {
        return match workspaces {
            [only] => Some(only.id.clone()),
            _ => None,
        };
    }
    workspaces
        .iter()
        .find(|w| w.host.as_deref() == Some(host))
        .map(|w| w.id.clone())
}

/// `^[first][A-Z0-9]+$`
fn id(value: &str, first: &[u8]) -> bool {
    let bytes = value.as_bytes();
    bytes.len() > 1
        && first.contains(&bytes[0])
        && bytes[1..]
            .iter()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
}

/// `^[0-9]+\.[0-9]{6}$`
fn timestamp(value: &str) -> bool {
    value.split_once('.').is_some_and(|(seconds, micros)| {
        !seconds.is_empty()
            && micros.len() == 6
            && seconds
                .bytes()
                .chain(micros.bytes())
                .all(|b| b.is_ascii_digit())
    })
}

/// The Slack desktop app's signed-in workspaces. Read only on a Slack link click.
pub(crate) fn slack_workspaces() -> Vec<SlackWorkspace> {
    let Some(home) = std::env::var_os("HOME") else {
        return Vec::new();
    };
    let library = std::path::Path::new(&home).join("Library");
    for base in [
        "Application Support/Slack",
        "Containers/com.tinyspeck.slackmacgap/Data/Library/Application Support/Slack",
    ] {
        let file = library.join(base).join("storage/root-state.json");
        // The state file is a few kilobytes; skip anything implausibly large.
        let Ok(meta) = std::fs::metadata(&file) else {
            continue;
        };
        if meta.len() >= 4_000_000 {
            continue;
        }
        let Ok(data) = std::fs::read(&file) else {
            continue;
        };
        return slack_root_state(&data);
    }
    Vec::new()
}

pub(crate) fn slack_root_state(data: &[u8]) -> Vec<SlackWorkspace> {
    let Ok(serde_json::Value::Object(root)) = serde_json::from_slice(data) else {
        return Vec::new();
    };
    let Some(serde_json::Value::Object(entries)) = root.get("workspaces") else {
        return Vec::new();
    };
    let mut workspaces: Vec<SlackWorkspace> = entries
        .values()
        .filter_map(|entry| {
            let id = entry.get("id")?.as_str().filter(|i| self::id(i, b"TE"))?;
            let host = entry
                .get("url")
                .and_then(|u| u.as_str())
                .and_then(|u| Url::parse(u).ok())
                .and_then(|u| u.host_str().map(str::to_ascii_lowercase))
                .or_else(|| {
                    let domain = entry.get("domain")?.as_str()?;
                    Some(format!("{}.slack.com", domain.to_ascii_lowercase()))
                });
            Some(SlackWorkspace {
                id: id.into(),
                host,
            })
        })
        .collect();
    workspaces.sort_by(|a, b| a.id.cmp(&b.id));
    workspaces
}

/// Asks Launch Services to open `url`. False when no app handles the scheme or the
/// launch fails, so the caller can fall back to the web URL.
pub(crate) fn launch(url: &str) -> bool {
    use std::ffi::c_void;
    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFURLCreateWithBytes(
            allocator: *const c_void,
            bytes: *const u8,
            length: isize,
            encoding: u32,
            base: *const c_void,
        ) -> *const c_void;
        fn CFRelease(object: *const c_void);
    }
    #[link(name = "CoreServices", kind = "framework")]
    unsafe extern "C" {
        fn LSOpenCFURLRef(url: *const c_void, launched: *mut *const c_void) -> i32;
    }
    const UTF8: u32 = 0x0800_0100;
    let Ok(length) = isize::try_from(url.len()) else {
        return false;
    };
    // SAFETY: the bytes outlive the call; the created URL is released exactly once.
    unsafe {
        let cf = CFURLCreateWithBytes(
            std::ptr::null(),
            url.as_ptr(),
            length,
            UTF8,
            std::ptr::null(),
        );
        if cf.is_null() {
            return false;
        }
        let status = LSOpenCFURLRef(cf, std::ptr::null_mut());
        CFRelease(cf);
        status == 0
    }
}

#[cfg(test)]
#[path = "desktop_app_link_tests.rs"]
mod tests;
