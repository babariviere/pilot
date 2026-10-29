use super::*;

fn titled(url: &str, label: Option<&str>) -> Option<(Service, String)> {
    badge(url, label).map(|b| (b.service, b.title))
}

#[test]
fn routes_web_and_internal_links_and_refuses_everything_else() {
    let web = |u: &str| match route(u) {
        Route::Web(url) => Some(url.to_string()),
        _ => None,
    };
    assert_eq!(
        web("https://example.com/a?q=1#x").as_deref(),
        Some("https://example.com/a?q=1#x")
    );
    assert_eq!(
        web("http://example.com/").as_deref(),
        Some("http://example.com/")
    );
    assert_eq!(route("pilot://chat/exact-ID"), Route::Chat);
    assert_eq!(route("PILOT://chat/x"), Route::Chat);
    for url in [
        "javascript:alert(1)",
        "JAVASCRIPT:alert(1)",
        "data:text/html,hi",
        "file:///etc/passwd",
        "vbscript:x",
        "ssh://host",
        "slack://channel?team=T1&id=C1",
        "linear://acme/issue/ENG-1",
        "artifact://id",
        "x-apple.systempreferences:com.apple",
        "https://user:pw@example.com/",
        "https://user@example.com/",
        "https://example.com/\u{1}",
        "https://example.com/%0A",
        "https://example.com/\\x",
        "https://example.com/\u{202e}gpj",
        "relative/path",
        "",
    ] {
        assert_eq!(route(url), Route::Refused, "{url:?}");
    }
    assert_eq!(
        route(&format!("https://e.io/{}", "a".repeat(4096))),
        Route::Refused
    );
}

#[test]
fn swift_service_titles_for_github_linear_and_slack() {
    assert_eq!(
        titled("https://github.com/acme/api/pull/412", None),
        Some((Service::GitHub, "acme/api#412".into()))
    );
    assert_eq!(
        titled(
            "https://github.com/acme/api/issues/9/",
            Some("https://github.com/acme/api/issues/9")
        ),
        Some((Service::GitHub, "acme/api#9".into()))
    );
    assert_eq!(
        titled("https://github.com/acme/api/commit/0123456789abcdef", None),
        Some((Service::GitHub, "acme/api@0123456".into()))
    );
    assert_eq!(
        titled("https://github.com/acme/api/pull/0123", None),
        Some((Service::GitHub, "acme/api · 0123".into()))
    );
    assert_eq!(
        titled("https://github.com/acme/api", None),
        Some((Service::GitHub, "acme/api".into()))
    );
    assert_eq!(
        titled("https://linear.app/acme/issue/eng-3/fix-the-thing", None),
        Some((Service::Linear, "ENG-3 · Fix the thing".into()))
    );
    assert_eq!(
        titled(
            "https://linear.app/acme/project/missions-0123456789ab",
            None
        ),
        Some((Service::Linear, "Missions".into()))
    );
    assert_eq!(
        titled("https://acme.slack.com/archives/C1/p1111111111111111", None),
        Some((Service::Slack, "Slack thread".into()))
    );
    assert_eq!(
        titled("https://acme.slack.com/archives/C1", None),
        Some((Service::Slack, "Slack channel".into()))
    );
    assert_eq!(
        titled("https://app.slack.com/client/T1/C1", None),
        Some((Service::Slack, "Slack channel".into()))
    );
    // Written labels win, collapsed to one line and capped like Swift.
    assert_eq!(
        titled(
            "https://github.com/o/r/pull/1",
            Some("  Review   this\n PR ")
        ),
        Some((Service::GitHub, "Review this PR".into()))
    );
    let long = "é".repeat(90);
    let title = titled("https://github.com/o/r", Some(&long)).unwrap().1;
    assert_eq!(title.chars().count(), 80);
    assert!(title.ends_with('…'));
}

#[test]
fn lookalikes_ports_credentials_and_other_schemes_get_no_badge() {
    for url in [
        "https://example.com/acme/api/pull/1",
        "https://github.com.evil.io/o/r/pull/1",
        "https://evilgithub.com/o/r/pull/1",
        "https://gist.github.com/o/r",
        "https://www.github.com/o/r",
        "https://github.com:8443/o/r",
        "https://user@github.com/o/r",
        "https://github.com@evil.io/o/r",
        "https://github.com/onlyowner",
        "https://linear.app.evil.io/acme/issue/ENG-1",
        "https://linear.app/acme/settings/x",
        "https://slack.com.evil.io/archives/C1",
        "https://evilslack.com/archives/C1",
        "https://acme.slack.com/messages/C1",
        "javascript://github.com/o/r",
        "ftp://github.com/o/r",
        "file://github.com/o/r",
    ] {
        assert_eq!(badge(url, None), None, "{url}");
    }
}
