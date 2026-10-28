use super::*;
use crate::{chat_links_fixture::Daemon, local_client::linked_chat};

#[test]
fn exact_identity_only_no_url_capabilities() {
    assert_eq!(target("pilot://chat/Exact-ID"), Ok("Exact-ID"));
    for url in [
        "pilot://chat/",
        "pilot://chat",
        "pilot://chat/../id",
        "pilot://chat/id/",
        "pilot://chat/id?host=other",
        "pilot://chat/id#title",
        "pilot://chat/%61",
        "pilot://user@chat/id",
        "pilot://chat:80/id",
        "pilot://mission/id",
        "https://chat/id",
        "pilot://chat/é",
    ] {
        assert!(target(url).is_err(), "{url}");
    }
}

#[tokio::test]
async fn pinned_existing_session_get_preserves_identity_and_project() {
    let d = Daemon::start().await;
    let c = linked_chat(&d.options, "unloaded-ID").await.unwrap();
    assert_eq!(c.id, "unloaded-ID");
    assert_eq!(c.project_id.as_deref(), Some("project"));
    let requests = &d.state.lock().unwrap().requests;
    assert_eq!(
        requests,
        &[
            "GET /api/hello HTTP/1.1",
            "GET /api/sessions/unloaded-ID HTTP/1.1",
            "GET /api/hello HTTP/1.1"
        ]
    );
}

#[tokio::test]
async fn unavailable_mismatched_and_changed_source_never_retarget() {
    let d = Daemon::start().await;
    assert!(linked_chat(&d.options, "../id").await.is_err());
    assert!(d.state.lock().unwrap().requests.is_empty());
    d.state.lock().unwrap().status = 404;
    assert!(
        linked_chat(&d.options, "unloaded-ID")
            .await
            .err()
            .unwrap()
            .contains("not found")
    );
    {
        let mut s = d.state.lock().unwrap();
        s.status = 200;
        s.chat["id"] = "different-ID".into();
    }
    assert!(
        linked_chat(&d.options, "unloaded-ID")
            .await
            .err()
            .unwrap()
            .contains("identity")
    );
    {
        let mut s = d.state.lock().unwrap();
        s.hello["daemonId"] = "different".into();
        s.requests.clear();
    }
    assert!(linked_chat(&d.options, "unloaded-ID").await.is_err());
    assert_eq!(d.state.lock().unwrap().requests.len(), 1);
}

#[tokio::test]
async fn identity_is_rechecked_after_the_session_read() {
    let d = Daemon::start().await;
    d.state.lock().unwrap().slow = true;
    let options = d.options.clone();
    let read = tokio::spawn(async move { linked_chat(&options, "unloaded-ID").await });
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while d.state.lock().unwrap().requests.len() < 2 {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    d.state.lock().unwrap().hello["lineageId"] = "changed-lineage".into();
    d.release.notify_one();
    assert!(read.await.unwrap().is_err());
    assert_eq!(d.state.lock().unwrap().requests.len(), 3);
}
