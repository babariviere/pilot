use super::*;
use serde_json::json;

fn catalog() -> Catalog {
    serde_json::from_value(json!({"models":[
        {"id":"anthropic/opus","provider":"anthropic","name":"Opus"},
        {"id":"anthropic/haiku","provider":"anthropic","name":"Haiku"},
        {"id":"openai-codex/sol","provider":"openai-codex","name":"Sol"}
    ]}))
    .unwrap()
}
fn at(s: &str) -> i64 {
    parse_iso(s).unwrap()
}

#[test]
fn iso_and_clock_follow_the_swift_wording() {
    assert_eq!(parse_iso("1970-01-01T00:00:00Z"), Some(0));
    assert_eq!(parse_iso("2026-10-28T18:00:00.000Z"), Some(1_793_210_400));
    assert_eq!(parse_iso("2026-10-28T20:00:00+02:00"), Some(1_793_210_400));
    for bad in [
        "",
        "2026-10-28",
        "2026-13-28T18:00:00Z",
        "2026-10-28T18:00:00",
        "2026-10-28T18:00:00.Z",
        "２026-10-28T18:00:00Z",
    ] {
        assert_eq!(parse_iso(bad), None, "{bad}");
    }
    let now = at("2026-10-28T09:30:00Z"); // a Wednesday
    let utc = |_| 0;
    assert_eq!(clock_with(at("2026-10-28T18:05:00Z"), now, utc), "at 18:05");
    assert_eq!(
        clock_with(at("2026-10-29T09:00:00Z"), now, utc),
        "tomorrow at 09:00"
    );
    assert_eq!(
        clock_with(at("2026-11-02T06:34:00Z"), now, utc),
        "on Mon at 06:34"
    );
    assert_eq!(
        clock_with(at("2026-11-20T06:34:00Z"), now, utc),
        "on 20 Nov at 06:34"
    );
    // Local day boundaries come from the offset, not UTC.
    assert_eq!(
        clock_with(at("2026-10-28T22:00:00Z"), now, |_| 3 * 3600),
        "tomorrow at 01:00"
    );
}

#[test]
fn notice_uses_the_deciding_window_and_forced_state() {
    let now = at("2026-10-28T09:30:00Z");
    assert_eq!(Pause::read(&json!({})), None);
    assert_eq!(Pause::read(&json!({"subscriptionPause": null})), None);
    let bare = Pause::read(&json!({"subscriptionPause": {}})).unwrap();
    assert!(!bare.forced);
    assert_eq!(
        bare.notice(now),
        "Paused at usage limit · resumes when usage resets"
    );
    let v = json!({"subscriptionPause": {"windows": [
        {"provider":"anthropic","label":"5h","usedPercent":96.4,"resetsAt":"2026-10-28T09:00:00Z"},
        {"provider":"anthropic","label":"Week","usedPercent":99.6,"resetsAt":"2026-10-28T23:59:00Z"},
        {"provider":"future","label":"","usedPercent":1}
    ]}});
    let paused = Pause::read(&v).unwrap();
    let notice = paused.notice(now);
    assert!(
        notice.starts_with("Paused at Claude weekly limit · resumes "),
        "{notice}"
    );
    let help = paused.help(now);
    assert!(help.starts_with("Pilot holds new work at 95%"));
    assert!(help.contains("Claude 5-hour: 96% used, resets "));
    assert!(help.contains("Claude weekly: 100% used"));
    let mut forced = v.clone();
    forced["subscriptionPause"]["forced"] = json!(true);
    let forced = Pause::read(&forced).unwrap();
    assert!(forced.forced);
    assert_eq!(
        forced.notice(now),
        "Working past usage limit · Claude weekly at 100%"
    );
    assert!(
        forced
            .help(now)
            .starts_with("Working past the 95% usage limit. Pause at limit")
    );
    // A reset already in the past never claims a resume time.
    let past = Pause::read(&json!({"subscriptionPause": {"windows": [
        {"provider":"openai","label":"Week","usedPercent":97,"resetsAt":"2026-10-27T09:00:00Z"}
    ]}}))
    .unwrap();
    assert_eq!(
        past.notice(now),
        "Paused at Codex weekly limit · resumes when usage resets"
    );
}

#[test]
fn continuation_kind_matches_configured_and_physical_provider() {
    let c = catalog();
    let paused = |provider: Option<&str>| {
        let mut v = json!({"subscriptionPause": {"forced": false}});
        if let Some(p) = provider {
            v["usage"] = json!({"subscription": {"provider": p, "windows": []}});
        }
        Pause::read(&v).unwrap()
    };
    let p = paused(None);
    let kind = |p: &Pause, from: Option<&str>, to: &str| p.continuation(from, to, &c);
    assert_eq!(
        kind(&p, Some("anthropic/opus"), "anthropic/haiku"),
        Continuation::SameChat
    );
    assert_eq!(
        kind(&p, Some("anthropic/opus"), "openai-codex/sol"),
        Continuation::NewChat
    );
    assert_eq!(kind(&p, None, "anthropic/haiku"), Continuation::NewChat);
    // A model outside the catalog falls back to its ID prefix.
    assert_eq!(
        kind(&p, Some("anthropic/retired"), "anthropic/haiku"),
        Continuation::SameChat
    );
    let anthropic = paused(Some("anthropic"));
    assert_eq!(
        kind(&anthropic, Some("anthropic/opus"), "anthropic/haiku"),
        Continuation::SameChat
    );
    // A chat billing through another provider (a router) starts fresh.
    let openai = paused(Some("openai"));
    assert_eq!(
        kind(&openai, Some("anthropic/opus"), "anthropic/haiku"),
        Continuation::NewChat
    );
    assert_eq!(
        kind(&openai, Some("openai-codex/x"), "openai-codex/sol"),
        Continuation::SameChat
    );
    assert!(
        Continuation::SameChat
            .explanation("Haiku")
            .contains("keeps its history")
    );
    assert!(
        Continuation::NewChat
            .explanation("Sol")
            .contains("becomes read-only")
    );
    assert_eq!(Continuation::NewChat.confirm(), "Start new chat");
}
