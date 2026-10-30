use super::*;
use std::time::{Duration, Instant};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::TcpListener,
};

fn request(id: u64, chat: &str) -> Request {
    Request {
        id,
        scope: Scope {
            key: format!("chat:{chat}"),
            project: None,
            cwd: "/fixture".into(),
        },
        refresh: false,
        target: Some(Target {
            session: chat.into(),
            cwd: "/fixture".into(),
            model: Some("p/a".into()),
            thinking: Some("off".into()),
            failed_source: None,
        }),
    }
}

#[tokio::test]
async fn superseded_held_catalog_does_not_block_current_chat() {
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .unwrap();
    let options = LocalOptions::synthetic(listener.local_addr().unwrap().port());
    let (paths, seen) = async_channel::unbounded::<String>();
    let (release, held) = async_channel::bounded::<()>(1);
    let server = tokio::spawn(async move {
        let mut first = true;
        loop {
            let (stream, _) = listener.accept().await.unwrap();
            let paths = paths.clone();
            let held = held.clone();
            let hold = first;
            // Only the first catalog response is held, not the hello or summary.
            let mut reader = BufReader::new(stream);
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            let path = line.split_whitespace().nth(1).unwrap().to_string();
            loop {
                line.clear();
                reader.read_line(&mut line).await.unwrap();
                if line == "\r\n" {
                    break;
                }
            }
            let is_catalog = path.starts_with("/api/models?");
            if is_catalog && first {
                first = false;
            }
            tokio::spawn(async move {
                paths.send(path.clone()).await.unwrap();
                if is_catalog && hold {
                    let _ = held.recv().await;
                }
                let body = if path == "/api/hello" {
                    r#"{"daemonId":"test-daemon","lineageId":"test-lineage","protocolVersion":1,"minimumClientProtocolVersion":1,"capabilities":{"independentExecution":true}}"#.to_string()
                } else if is_catalog {
                    r#"{"models":[{"id":"p/a","name":"Test","provider":"p","thinkingLevels":["off"]}],"defaultModel":"p/a"}"#.to_string()
                } else {
                    let id = path.rsplit('/').next().unwrap();
                    format!(r#"{{"id":"{id}","cwd":"/fixture","model":"p/a","thinking":"off"}}"#)
                };
                let _ = reader.into_inner().write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await;
            });
        }
    });
    let (reader, updates) = Reader::start(options).unwrap();
    assert!(reader.request(request(1, "a")));
    let mut paths = Vec::new();
    loop {
        let p = tokio::time::timeout(Duration::from_secs(2), seen.recv())
            .await
            .unwrap()
            .unwrap();
        let catalog = p.starts_with("/api/models?");
        paths.push(p);
        if catalog {
            break;
        }
    }
    let start = Instant::now();
    assert!(reader.request(request(2, "b")));
    assert!(reader.request(request(3, "a")));
    let current = tokio::time::timeout(Duration::from_millis(500), updates.recv())
        .await
        .expect("current read must finish before held response is released")
        .unwrap();
    assert_eq!(current.id, 3);
    assert_eq!(current.scope.key, "chat:a");
    assert!(current.result.is_ok());
    let elapsed = start.elapsed();
    let _ = release.send(()).await;
    while let Ok(p) = seen.try_recv() {
        paths.push(p);
    }
    assert!(updates.try_recv().is_err());
    println!(
        "held catalog: current={:.3}ms, requests={paths:?}",
        elapsed.as_secs_f64() * 1000.0
    );
    server.abort();
}

#[tokio::test]
async fn same_directory_chat_switch_reuses_catalog() {
    use crate::chat_models_fixture::{Mode, Server};
    let server = Server::start(Mode::Accept);
    let (reader, updates) = Reader::start(server.options.clone()).unwrap();
    for (id, chat) in [(1, "a"), (2, "b"), (3, "a")] {
        let mut r = request(id, chat);
        r.scope.cwd = "/synthetic/project".into();
        r.target.as_mut().unwrap().session = "source".into();
        r.target.as_mut().unwrap().cwd = "/synthetic/project".into();
        assert!(reader.request(r));
        assert!(
            tokio::time::timeout(Duration::from_secs(2), updates.recv())
                .await
                .unwrap()
                .unwrap()
                .result
                .is_ok()
        );
    }
    let seen = server.seen.lock().unwrap();
    let models = seen
        .requests
        .iter()
        .filter(|(_, path, _)| path.starts_with("/api/models?"))
        .count();
    assert_eq!(models, 1, "same scope uses one catalog fetch");
}

#[tokio::test]
async fn cache_is_scoped_refreshable_and_identity_checked() {
    use crate::chat_models_fixture::{Mode, Server};
    let server = Server::start(Mode::Accept);
    let (reader, updates) = Reader::start(server.options.clone()).unwrap();
    async fn read(
        reader: &Reader,
        updates: &async_channel::Receiver<Update>,
        id: u64,
        project: Option<&str>,
        cwd: &str,
        refresh: bool,
    ) -> Result<(Catalog, Option<SessionModel>), Failure> {
        let mut r = request(id, "a");
        r.target = None;
        r.scope.project = project.map(str::to_string);
        r.scope.cwd = cwd.into();
        r.refresh = refresh;
        assert!(reader.request(r));
        tokio::time::timeout(Duration::from_secs(2), updates.recv())
            .await
            .unwrap()
            .unwrap()
            .result
    }
    let count = || {
        server
            .seen
            .lock()
            .unwrap()
            .requests
            .iter()
            .filter(|(_, p, _)| p.starts_with("/api/models?"))
            .count()
    };
    assert!(
        read(
            &reader,
            &updates,
            1,
            Some("p1"),
            "/synthetic/project",
            false
        )
        .await
        .is_ok()
    );
    assert!(
        read(
            &reader,
            &updates,
            2,
            Some("p1"),
            "/synthetic/project",
            false
        )
        .await
        .is_ok()
    );
    assert_eq!(count(), 1);
    assert!(
        read(
            &reader,
            &updates,
            3,
            Some("p2"),
            "/synthetic/project",
            false
        )
        .await
        .is_ok()
    );
    assert!(
        read(&reader, &updates, 4, Some("p1"), "/synthetic/other", false)
            .await
            .is_ok()
    );
    assert_eq!(count(), 3);
    server.seen.lock().unwrap().mode = Mode::Foreign;
    assert!(
        read(
            &reader,
            &updates,
            5,
            Some("p1"),
            "/synthetic/project",
            false
        )
        .await
        .is_err()
    );
    assert_eq!(
        count(),
        3,
        "identity failure must not fetch or return cached models"
    );
    server.seen.lock().unwrap().mode = Mode::Bad;
    assert!(
        read(&reader, &updates, 6, Some("p1"), "/synthetic/project", true)
            .await
            .is_err()
    );
    server.seen.lock().unwrap().mode = Mode::Accept;
    assert!(
        read(
            &reader,
            &updates,
            7,
            Some("p1"),
            "/synthetic/project",
            false
        )
        .await
        .is_ok()
    );
    assert_eq!(count(), 5, "failed refresh cannot become a cache hit");
    let (other, other_updates) = Reader::start(server.options.clone()).unwrap();
    assert!(
        read(
            &other,
            &other_updates,
            8,
            Some("p1"),
            "/synthetic/project",
            false
        )
        .await
        .is_ok()
    );
    assert_eq!(
        count(),
        6,
        "new identity-bound worker cannot inherit catalog"
    );
}
