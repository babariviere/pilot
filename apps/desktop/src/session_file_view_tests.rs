use super::*;
use serde_json::json;
fn parse(text: &str, truncated: bool) -> Content {
    Content::parse(
        json!({"path":"src/日本語.rs","text":text,"binary":false,"truncated":truncated}),
        "src/日本語.rs",
    )
    .unwrap()
}
#[test]
fn exact_unicode_newlines_empty_and_server_truncation() {
    for text in [
        "",
        "\u{feff}日本語 👩‍💻 e\u{301}\r\n\tend\r\n",
        "no final newline",
    ] {
        assert_eq!(
            parse(text, false),
            Content::Text {
                shown: text.into(),
                truncated: false
            }
        );
        assert_eq!(
            parse(text, true),
            Content::Text {
                shown: text.into(),
                truncated: true
            }
        );
    }
}
#[test]
fn bounded_prefix_at_scalar_line_and_total_limits() {
    for text in [
        "a\n".repeat(400),
        "語".repeat(600),
        "line 🦀\n".repeat(6000),
    ] {
        let Content::Text { shown, truncated } = parse(&text, false) else {
            panic!()
        };
        assert!(truncated);
        assert!(text.starts_with(&shown));
        assert!(shown.len() <= TEXT_CAP);
        assert!(shown.lines().count() <= LINE_CAP);
        assert!(shown.split('\n').all(|l| l.len() <= LINE_BYTES));
    }
}
#[test]
fn binary_lossy_or_control_text_is_never_rendered() {
    for text in ["bad\u{fffd}bytes", "NUL\0", "\u{1b}[31m"] {
        assert_eq!(parse(text, false), Content::Unsupported);
    }
    assert_eq!(
        Content::parse(
            json!({"path":"a","text":"secret","binary":true,"truncated":false}),
            "a"
        )
        .unwrap(),
        Content::Binary
    );
    for v in [
        json!({}),
        json!({"path":"wrong","text":"x","binary":false,"truncated":false}),
    ] {
        assert!(Content::parse(v, "a").is_err());
    }
}
#[test]
fn paths_and_stale_generations_fail_closed_retaining_previous_content() {
    for p in [
        "",
        "/etc/passwd",
        "../x",
        "a/../b",
        "a//b",
        "a\\b",
        "a/./b",
        "a\0b",
    ] {
        assert!(!valid_path(p));
    }
    assert!(valid_path("src/日本語 ?#%.rs"));
    let mut s = State::default();
    let one = s.begin();
    assert!(s.accept(one, Ok(parse("old", false))));
    let two = s.begin();
    assert!(!s.accept(one, Ok(parse("late", false))));
    assert!(s.accept(two, Err("refused")));
    assert_eq!(s.content, Some(parse("old", false)));
    s.cancel();
    assert!(!s.accept(two, Ok(parse("late", false))));
}
