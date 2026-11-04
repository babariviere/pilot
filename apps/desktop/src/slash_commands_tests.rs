use super::*;
use serde_json::json;

fn session() -> Vec<Command> {
    parse_session(&json!({"commands":[
        {"name":"review","source":"prompt","description":"Review the diff","argumentHint":"<pr>"},
        {"name":"help","source":"prompt","description":"Project help"},
        {"name":"jobs","source":"prompt","description":"Shadow attempt"},
        {"name":"skill:commit","source":"skill","description":"Commit\n  changes"},
        {"name":"bad name","source":"prompt"},
        {"name":"/slash","source":"prompt"},
        {"name":"other","source":"extension"},
        {"name":"review","source":"skill"},
        {"source":"prompt"}
    ]}))
    .unwrap()
}

fn names(commands: &[Command]) -> Vec<&str> {
    commands.iter().map(|c| c.name.as_str()).collect()
}

#[test]
fn parse_skips_malformed_and_normalizes_display_text() {
    let s = session();
    assert_eq!(names(&s), ["review", "help", "jobs", "skill:commit"]);
    assert_eq!(s[0].argument_hint.as_deref(), Some("<pr>"));
    assert_eq!(s[3].kind, Kind::Skill);
    assert_eq!(s[3].description.as_deref(), Some("Commit changes"));
    assert!(parse_session(&json!({"commands":"no"})).is_none());
    assert_eq!(parse_session(&json!({"commands":[]})).unwrap(), []);
}

#[test]
fn builtins_are_reserved_and_session_commands_win_app_names() {
    let all = available(Scope::Chat { model: true }, &session());
    assert_eq!(
        names(&all),
        [
            "jobs",
            "model",
            "changes",
            "artifacts",
            "review",
            "help",
            "skill:commit"
        ]
    );
    assert_eq!(all[0].kind, Kind::Builtin(Action::Jobs));
    // The session's /help is a prompt; the app control stays in its menu and shortcut.
    assert_eq!(
        all.iter().find(|c| c.name == "help").unwrap().kind,
        Kind::Prompt
    );
    // Model is offered only where the composer has a model picker.
    let without = available(Scope::Chat { model: false }, &[]);
    assert_eq!(names(&without), ["jobs", "changes", "artifacts", "help"]);
}

#[test]
fn new_chats_offer_only_app_controls_they_have() {
    assert_eq!(
        names(&available(Scope::NewChat { model: true }, &session())),
        ["model", "help"]
    );
    assert_eq!(
        names(&available(Scope::NewChat { model: false }, &[])),
        ["help"]
    );
}

#[test]
fn token_requires_leading_slash_and_caret_at_token_end() {
    assert_eq!(token("/rev", 4..4), Some(0..4));
    assert_eq!(token("/", 1..1), Some(0..1));
    assert_eq!(token("/rev more", 4..4), Some(0..4));
    assert_eq!(token("/rev\nmore", 4..4), Some(0..4));
    assert_eq!(token("/review", 4..4), None, "inside a token");
    assert_eq!(token("/rev", 0..0), None);
    assert_eq!(token("/rev", 1..4), None, "selection");
    assert_eq!(token(" /rev", 5..5), None, "not leading");
    assert_eq!(token("say /rev", 8..8), None);
    assert_eq!(token("/rev x", 6..6), None, "after whitespace");
    assert_eq!(token("/é🦀", 7..7), Some(0..7), "multibyte names");
    assert_eq!(token("/é", 2..2), None, "not a char boundary");
    assert_eq!(token("/a", 9..9), None, "out of range");
}

#[test]
fn matching_prefers_prefix_then_substring_and_bare_skill_names() {
    let all = available(Scope::Chat { model: true }, &session());
    assert_eq!(matches("", &all, 50).len(), all.len());
    assert_eq!(names(&matches("co", &all, 50)), ["skill:commit"]);
    assert_eq!(
        names(&matches("E", &all, 50)),
        ["model", "changes", "review", "help"]
    );
    assert_eq!(names(&matches("a", &all, 2)), ["artifacts", "changes"]);
    assert!(matches("zzz", &all, 50).is_empty());
}

#[test]
fn invocations_are_whole_native_messages_only() {
    let all = available(Scope::Chat { model: true }, &session());
    let (command, args) = invocation("  /model  ", &all).unwrap();
    assert_eq!((command.kind, args), (Kind::App(Action::Model), ""));
    let (command, args) = invocation("/jobs now please", &all).unwrap();
    assert_eq!((command.action(), args), (Some(Action::Jobs), "now please"));
    // Session commands, unknown and partial slash prose are ordinary messages.
    for message in [
        "/help",
        "/review 12",
        "/skill:commit",
        "/modelx",
        "/unknown",
        "say /model",
        "/",
        "model",
    ] {
        assert!(invocation(message, &all).is_none(), "{message}");
    }
    // Without the session's /help, the app control owns the name.
    let app = available(Scope::Chat { model: true }, &[]);
    assert_eq!(
        invocation("/help", &app).unwrap().0.action(),
        Some(Action::Help)
    );
    assert!(invocation("/changes", &available(Scope::NewChat { model: true }, &[])).is_none());
}
