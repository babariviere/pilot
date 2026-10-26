use super::*;
fn row(id: u64, source: &str) -> Message {
    Message::live(id, "assistant".into(), source.into()).anchored(ReaderKey::model(9, 0, Some(0)))
}
#[test]
fn boundaries_and_exact_prefix() {
    assert!(!preview(&"a".repeat(1600)).long);
    assert!(preview(&"a".repeat(1601)).long);
    assert!(!preview(&("a\r\n".repeat(15) + "a")).long);
    assert!(preview(&("a\r\n".repeat(16) + "a")).long);
    let s = "👩‍💻e\u{301}日本\r\n".repeat(400);
    let p = preview(&s);
    assert!(p.long && p.text.len() <= 3200 && s.starts_with(&p.text));
    assert!(s.grapheme_indices(true).any(|(i, _)| i == p.text.len()));
}
#[test]
fn giant_clusters_are_not_split_or_unbounded() {
    let s = format!("a{}", "\u{301}".repeat(1_000_000));
    assert_eq!(
        preview(&s),
        Preview {
            long: true,
            text: String::new()
        }
    );
    let s = format!("start {} tail", "👩‍💻".repeat(200_000));
    assert!(preview(&s).text.len() <= 3200);
}
#[test]
fn source_identity_stream_prepend_and_reset() {
    let source = "line e\u{301} 日本\n".repeat(90);
    let mut f = Folds::default();
    let r = row(1, &source);
    f.sync(std::slice::from_ref(&r));
    assert!(f.collapsed(&r));
    f.toggle(&r);
    let renamed = row(999, &(source.clone() + "stream"));
    f.sync(std::slice::from_ref(&renamed));
    assert!(!f.collapsed(&renamed));
    assert_eq!(r.source(), source);
    let reset = row(1, &"different\n".repeat(100));
    f.sync(std::slice::from_ref(&reset));
    assert!(f.collapsed(&reset));
    assert_eq!(plain("<>&\r\n"), "<pre>&lt;&gt;&amp;\r\n</pre>");
}
#[test]
fn scopes_do_not_alias_or_forget_on_reconnect() {
    let mut f = Folds::default();
    let r = row(1, &"long\n".repeat(100));
    let scope = |chat: &str, generation| {
        Some(Source::new(
            crate::LocalOptions::synthetic(9),
            chat.into(),
            generation,
        ))
    };
    f.scope(scope("A", 1));
    f.sync(std::slice::from_ref(&r));
    f.toggle(&r);
    f.scope(scope("B", 2));
    f.sync(std::slice::from_ref(&r));
    assert!(f.collapsed(&r));
    f.scope(scope("A", 3));
    f.sync(std::slice::from_ref(&r));
    assert!(!f.collapsed(&r));
    // An already visible short message never auto-collapses as it grows.
    let short = row(1, "x");
    f.sync(&[short]);
    let grown = row(1, &"x".repeat(3000));
    f.sync(std::slice::from_ref(&grown));
    assert!(!f.collapsed(&grown));
}

#[test]
fn streaming_commit_never_auto_folds_or_adopts_ambiguous_identity() {
    let source = "live source\n".repeat(100);
    let live = Message::live(18, "Assistant · streaming".into(), source.clone());
    let mut f = Folds::default();
    f.sync(std::slice::from_ref(&live));
    assert!(!f.long(&live));
    let committed = row(900, &(source + "committed"));
    f.sync(std::slice::from_ref(&committed));
    assert!(f.long(&committed) && !f.collapsed(&committed));
    let alias = row(901, committed.source());
    f.sync(&[committed.clone(), alias]);
    assert!(!f.long(&committed));
}

#[test]
fn byte_boundary_crlf_and_cluster_never_resume_prefix() {
    let source = format!(
        "{}{}x{}",
        "a".repeat(799),
        "e\u{301}".repeat(3000),
        "tail\n".repeat(100)
    );
    let p = preview(&source);
    assert!(p.long && source.starts_with(&p.text));
    assert!(p.text.len() <= 3200);
    let source = format!("{}\r\n{}", "a".repeat(799), "b".repeat(2000));
    let p = preview(&source);
    assert_eq!(p.text, format!("{}\r\n", "a".repeat(799)));
}
