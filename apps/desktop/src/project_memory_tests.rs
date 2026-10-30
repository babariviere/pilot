use crate::{
    mission_browser_fixture::{Reply, Server},
    project_memory::Range,
    project_memory_reader::path,
};
#[cfg(test)]
use crate::{
    project_memory::{State, Tree},
    project_memory_reader::{Reader, Request, fetch},
};
use serde_json::{Value, json};

pub(crate) fn note(i: u64) -> Value {
    let text = "Keep 日本語 👩‍💻 café and exact <source> unchanged. ".repeat(3);
    json!({"lo":i,"hi":i,"text":text,"entry":{"index":i,"id":format!("note-{i}"),"deviceId":"device-A","at":1730000000000u64,"sessionId":"chat-A","text":text,"sharedOrigin":{"host":{"hostId":"home-A","daemonId":"original-daemon","lineageId":"original-lineage"},"sessionId":"original-chat"}}})
}
pub(crate) fn root() -> Value {
    json!({"count":4,"nodes":[{"lo":0,"hi":3,"text":"Project conventions 日本語 and lasting choices."}],"truncated":false})
}
pub(crate) fn children() -> Value {
    json!({"count":4,"nodes":[note(3),note(2),note(1),note(0)],"truncated":false})
}
pub(crate) fn install(s: &Server) {
    s.reply(&path("project-A", None).unwrap(), Reply::json(200, root()));
    s.reply(
        &path("project-A", Some(Range { lo: 0, hi: 3 })).unwrap(),
        Reply::json(200, children()),
    );
}
#[test]
fn project_memory_filter_is_literal_unicode_loaded_text_only() {
    let tree = Tree::parse(children(), Some(Range { lo: 0, hi: 3 })).unwrap();
    let original: Vec<_> = tree.nodes.iter().map(|n| n.range).collect();
    for query in ["日本語", "👩‍💻", "café", "<source>", " "] {
        assert_eq!(tree.filtered(query).count(), 4, "{query}");
    }
    for query in [".*", "[", "CAfÉ", "cafe\u{301}", "note-3", "original-chat"] {
        assert_eq!(tree.filtered(query).count(), 0, "{query}");
    }
    assert_eq!(
        tree.filtered("").map(|n| n.range).collect::<Vec<_>>(),
        original
    );
    let root = Tree::parse(root(), None).unwrap();
    assert_eq!(root.filtered("日本語").count(), 1);
    assert_eq!(
        root.filtered("<source>").count(),
        0,
        "unopened notes are not searched"
    );
    let empty = Tree::parse(json!({"count":0,"nodes":[],"truncated":false}), None).unwrap();
    assert_eq!(empty.filtered("").count(), 0);
    let pending = Tree::parse(
        json!({"count":4,"nodes":[{"lo":0,"hi":3,"pending":true}],"truncated":false}),
        None,
    )
    .unwrap();
    assert_eq!(pending.filtered("").count(), 1);
    assert_eq!(pending.filtered("Summary").count(), 0);
    let mut mixed = children();
    mixed["nodes"][1]["text"] = "Only this note has 🧪[literal]".into();
    mixed["nodes"][1]["entry"]["text"] = mixed["nodes"][1]["text"].clone();
    let mixed = Tree::parse(mixed, Some(Range { lo: 0, hi: 3 })).unwrap();
    assert_eq!(
        mixed
            .filtered("🧪[literal]")
            .map(|n| n.range.lo)
            .collect::<Vec<_>>(),
        vec![2]
    );
    assert_eq!(mixed.filtered("").count(), 4);
}

#[test]
fn project_memory_validates_complete_exact_ranges_and_origin() {
    let tree = Tree::parse(children(), Some(Range { lo: 0, hi: 3 })).unwrap();
    assert_eq!(
        tree.nodes[0]
            .entry
            .as_ref()
            .unwrap()
            .shared_origin
            .as_ref()
            .unwrap()["sessionId"],
        "original-chat"
    );
    for value in [
        json!({"count":4,"nodes":[],"truncated":false}),
        json!({"count":4,"nodes":[note(0)],"truncated":true}),
    ] {
        assert!(Tree::parse(value, None).is_err());
    }
    let mut bad = children();
    bad["nodes"][0]["entry"]["index"] = 2.into();
    assert!(Tree::parse(bad, Some(Range { lo: 0, hi: 3 })).is_err());
    assert!(path("../project-B", None).is_err());
    assert!(path("project-A", Some(Range { lo: 1, hi: 4 })).is_err());
    assert!(Tree::parse(json!({"count":0,"nodes":[],"truncated":false}), None).is_ok());
}
#[test]
fn project_memory_generation_and_range_fence_retained_rows() {
    let mut state = State::default();
    let first = state.begin(None);
    state.accept(first, None, Ok(Tree::parse(root(), None).unwrap()));
    let child = Some(Range { lo: 0, hi: 3 });
    let second = state.begin(child);
    assert!(state.tree.is_none());
    let third = state.begin(None);
    assert!(!state.accept(first, None, Ok(Tree::parse(root(), None).unwrap())));
    assert!(!state.accept(second, child, Err("old error")));
    assert!(state.busy);
    assert!(state.accept(third, None, Ok(Tree::parse(root(), None).unwrap())));
    let fourth = state.begin(None);
    state.accept(fourth, None, Err("offline"));
    assert!(state.tree.is_some());
    assert_eq!(state.error, Some("offline"));
}
#[test]
fn project_memory_transport_is_tree_get_only_pinned_and_refuses_partial() {
    let s = Server::start();
    install(&s);
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    rt.block_on(async {
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        assert_eq!(
            fetch(&client, &s.options, "project-A", None)
                .await
                .unwrap()
                .count,
            4
        );
        let p = path("project-A", None).unwrap();
        for status in [302, 403, 404, 503] {
            s.reply(&p, Reply::json(status, json!({})));
            assert!(fetch(&client, &s.options, "project-A", None).await.is_err());
        }
        s.reply(
            &p,
            Reply::json(200, json!({"count":4,"nodes":[],"truncated":false})),
        );
        assert!(fetch(&client, &s.options, "project-A", None).await.is_err());
        s.reply(
            "/api/hello",
            Reply::json(200, json!({"daemonId":"other","lineageId":"test-lineage"})),
        );
        assert!(fetch(&client, &s.options, "project-A", None).await.is_err());
    });
    assert!(s.all_gets());
    assert!(
        s.state
            .lock()
            .unwrap()
            .seen
            .iter()
            .all(|(_, p)| p == "/api/hello" || p.contains("/memory/tree?depth=1"))
    );
}
#[test]
fn project_memory_reader_replacement_cancels_obsolete_range() {
    let s = Server::start();
    install(&s);
    let p = path("project-A", None).unwrap();
    let mut reply = Reply::json(200, root());
    reply.delay_ms = 600;
    s.reply(&p, reply);
    let (reader, events) = Reader::start(s.options.clone(), "project-A".into()).unwrap();
    reader.request(Request {
        generation: 1,
        target: None,
    });
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    while !s
        .state
        .lock()
        .unwrap()
        .seen
        .iter()
        .any(|(_, path)| path == &p)
    {
        assert!(std::time::Instant::now() < deadline);
        std::thread::yield_now();
    }
    let range = Some(Range { lo: 0, hi: 3 });
    reader.request(Request {
        generation: 2,
        target: range,
    });
    let result = events.recv_blocking().unwrap();
    assert_eq!(result.generation, 2);
    assert_eq!(result.range, range);
    assert_eq!(result.result.unwrap().nodes.len(), 4);
    drop(reader);
}

#[test]
fn project_memory_rechecks_hello_after_read_and_bounds_chunked_responses() {
    let s = Server::start();
    install(&s);
    let p = path("project-A", None).unwrap();
    let mut delayed = Reply::json(200, root());
    delayed.delay_ms = 150;
    s.reply(&p, delayed);
    let options = s.options.clone();
    let read = std::thread::spawn(move || {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let client = reqwest::Client::builder().no_proxy().build().unwrap();
                fetch(&client, &options, "project-A", None).await
            })
    });
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    while !s
        .state
        .lock()
        .unwrap()
        .seen
        .iter()
        .any(|(_, seen)| seen == &p)
    {
        assert!(std::time::Instant::now() < deadline);
        std::thread::yield_now();
    }
    s.reply(
        "/api/hello",
        Reply::json(200, json!({"daemonId":"other","lineageId":"test-lineage"})),
    );
    assert!(
        read.join().unwrap().is_err(),
        "a response cannot outlive its pinned Local identity"
    );
    s.reply(
        "/api/hello",
        Reply::json(200, crate::usage_overview_fixture::hello()),
    );
    s.reply(
        &p,
        Reply {
            status: 200,
            bytes: vec![b' '; 1024 * 4096 + 1],
            chunked: true,
            delay_ms: 0,
        },
    );
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    assert!(
        rt.block_on(fetch(
            &reqwest::Client::new(),
            &s.options,
            "project-A",
            None
        ))
        .unwrap_err()
        .contains("bounded")
    );
    assert!(s.all_gets());
}
