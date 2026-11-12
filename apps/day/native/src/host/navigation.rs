//! Web-only native navigation. No filesystem, shell, provider or custom schemes.
use super::Error;

/// Refuse parser repairs and hidden controls. Dispatch keeps the exact raw target.
pub(crate) fn web(raw: &str) -> Result<(), Error> {
    if raw.len() > 4096
        || !(raw.starts_with("https://") || raw.starts_with("http://"))
        || raw.contains('\\')
        || raw.chars().any(|c| {
            c.is_whitespace()
                || c.is_control()
                || matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
    {
        return Err(Error::Invalid);
    }
    for pair in raw.as_bytes().windows(3).filter(|s| s[0] == b'%') {
        let byte = std::str::from_utf8(&pair[1..])
            .ok()
            .and_then(|s| u8::from_str_radix(s, 16).ok());
        if byte.is_some_and(|b| b < 32 || b == 127 || b == b'\\') {
            return Err(Error::Invalid);
        }
    }
    let url = reqwest::Url::parse(raw).map_err(|_| Error::Invalid)?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || raw[raw.find("://").ok_or(Error::Invalid)? + 3..].starts_with('/')
    {
        return Err(Error::Invalid);
    }
    Ok(())
}

/// Used only by the native executable's explicit URL callback. Tests inject a
/// recorder instead; they never call NSWorkspace or launch a browser.
#[cfg(all(target_os = "macos", feature = "macos-host"))]
pub(crate) fn macos(raw: &str) -> Result<(), Error> {
    use nsh_platform_macos::{
        objc2::rc::autoreleasepool,
        objc2_app_kit::NSWorkspace,
        objc2_foundation::{NSString, NSURL},
    };
    web(raw)?;
    autoreleasepool(|_| {
        let url = NSURL::URLWithString(&NSString::from_str(raw)).ok_or(Error::Invalid)?;
        if NSWorkspace::sharedWorkspace().openURL(&url) {
            Ok(())
        } else {
            Err(Error::Unknown)
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_explicit_web_destinations_without_controls_or_credentials() {
        for value in [
            "https://github.com/a/b/pull/1",
            "http://example.com/docs?q=a#part",
            "https://example.com/a%20b",
        ] {
            assert_eq!(web(value), Ok(()), "{value}");
        }
        for value in [
            "file:///tmp/report.pdf",
            "../../a",
            "/tmp/a",
            "javascript:alert(1)",
            "data:text/html,x",
            "pilot://chat/a",
            "slack://open",
            "https:///example.com",
            "https://",
            "https://user:password@example.com",
            "https://example.com\\@evil.com",
            " https://example.com",
            "https://example.com/\n",
            "https://example.com/%0a",
            "https://example.com/%7F",
            "https://example.com/%5c",
            "https://example.com/\u{202e}x",
        ] {
            assert_eq!(web(value), Err(Error::Invalid), "{value}");
        }
        assert_eq!(
            web(&format!("https://example.com/{}", "a".repeat(4096))),
            Err(Error::Invalid)
        );
    }
}
