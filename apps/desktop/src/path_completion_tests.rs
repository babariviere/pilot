use super::*;
#[test]
fn captures_exact_unicode_token_and_utf16_range() {
    let text = "Read 🦀 café/日本";
    let t = token(text, text.len()..text.len()).unwrap();
    assert_eq!(&text[t.range.clone()], "café/日本");
    assert_eq!(t.utf16(text), 8..15);
    assert_eq!(
        t.replacement("café/日本語.txt", false).unwrap(),
        "café/日本語.txt"
    );
    let text = "before './Spaces h' after";
    let end = text.find("' after").unwrap();
    let t = token(text, end..end).unwrap();
    assert_eq!(t.prefix, "Spaces h");
    let mut result = text.to_owned();
    result.replace_range(
        t.range.clone(),
        &t.replacement("Spaces here", true).unwrap(),
    );
    assert_eq!(result, "before './Spaces here/' after");
}
#[test]
fn refuses_selection_suffix_expansion_and_unsafe_paths() {
    for s in [
        "",
        "Read ",
        "/etc/p",
        "../secret",
        "x/../s",
        "~/s",
        "https://a",
        "x//s",
        "x/./s",
        "trailing\\",
    ] {
        assert!(token(s, s.len()..s.len()).is_none(), "{s}");
    }
    assert!(token("abc", 1..1).is_none());
    assert!(token("abc", 0..3).is_none());
    assert!(token("🦀", 1..1).is_none());
    let s = "Spaces\\ h";
    let t = token(s, s.len()..s.len()).unwrap();
    assert_eq!(t.prefix, "Spaces h");
    assert_eq!(
        t.replacement("Spaces here", false).unwrap(),
        "Spaces\\ here"
    );
}
#[test]
fn captured_edit_and_source_are_exact_not_content_only() {
    let make = || Capture {
        revision: 1,
        target: Target {
            chat: "a".into(),
            cwd: "/a".into(),
            generation: 1,
        },
        key: "chat:a".into(),
        intent: 1,
        text: "R".into(),
        selection: 1..1,
        token: token("R", 1..1).unwrap(),
    };
    let a = make();
    for i in 0..6 {
        let mut b = make();
        match i {
            0 => b.intent += 1,
            1 => b.target.generation += 1,
            2 => b.target.cwd = "/b".into(),
            3 => b.key = "chat:b".into(),
            4 => b.selection = 0..0,
            _ => b.revision += 1,
        };
        assert_ne!(a, b);
    }
}
