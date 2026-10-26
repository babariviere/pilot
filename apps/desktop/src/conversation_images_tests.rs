use super::*;
use serde_json::json;

const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEElEQVR4AQEFAPr/AP8AAP8FAAH/+lyI0QAAAABJRU5ErkJggg==";
#[test]
fn inline_contract_budgets_and_no_external_loader() {
    let mut remaining = INLINE_CAP;
    let source = Source::read(
        2,
        &json!({"mimeType":"image/png","data":PNG}),
        &mut remaining,
    );
    assert_eq!(source.block, 2);
    assert_eq!(remaining, INLINE_CAP - PNG.len());
    let raster = source.decode(|| false).unwrap();
    assert_eq!((raster.width, raster.height), (1, 1));
    assert!(source.decode(|| true).is_err());
    for block in [
        json!({"mimeType":"image/png","url":"https://example.test/private.png"}),
        json!({"mimeType":"image/png","path":"/private/image.png"}),
        json!({"mimeType":"image/webp","data":"AAAA"}),
        json!({"mimeType":"image/svg+xml","data":"AAAA"}),
    ] {
        let image = Source::read(0, &block, &mut INLINE_CAP.clone());
        assert!(image.problem.is_some());
        assert!(image.data.is_none());
    }
    for cap in [0, PNG.len() - 1] {
        assert!(
            Source::read(
                0,
                &json!({"mimeType":"image/png","data":PNG}),
                &mut cap.clone()
            )
            .data
            .is_none()
        );
    }
    let broken = Source::read(
        0,
        &json!({"mimeType":"image/png","data":"https://example.test/a"}),
        &mut INLINE_CAP.clone(),
    );
    assert!(broken.decode(|| false).is_err());
    let oversize = Source::read(
        0,
        &json!({"mimeType":"image/png","data":"A".repeat(INLINE_CAP+1)}),
        &mut INLINE_CAP.clone(),
    );
    assert!(oversize.data.is_none());
    assert!(oversize.hash.is_none());
}

#[test]
fn exact_committed_model_blocks_survive_projection_without_paths_or_streaming_decode() {
    let mut model = crate::local_model::LiveTranscript::default();
    let entries: Vec<_> = ["user", "assistant", "toolResult"].iter().enumerate().map(|(ix, role)| json!({"id":ix+1,"kind":"pi.message","model":[{"role":role,"content":[{"type":"text","text":"Before"},{"type":"image","mimeType":"image/png","data":PNG},{"type":"image","mimeType":"image/webp","data":"AAAA"}]}]})).collect();
    model.apply(&json!({"type":"snapshot","entries":entries}));
    let rows = model.rows();
    let images: Vec<_> = rows.iter().filter(|r| r.image_data().is_some()).collect();
    assert_eq!(images.len(), 6);
    for (ix, row) in images.iter().enumerate() {
        assert_eq!(
            row.reader_key(),
            Some(crate::model::ReaderKey::model(
                (ix / 2 + 1) as u64,
                0,
                Some(ix % 2 + 1)
            ))
        );
        assert!(!row.source().contains(PNG));
    }
    let ids: std::collections::BTreeSet<_> = rows.iter().map(|r| r.id()).collect();
    assert_eq!(ids.len(), rows.len());
    let old = images[0].image_data().unwrap().clone();
    assert!(Arc::ptr_eq(
        &old,
        model.rows().iter().find_map(|r| r.image_data()).unwrap()
    ));
    model.apply(&json!({"type":"snapshot","entries":[],"generation":{"message":{"role":"assistant","content":[{"type":"image","mimeType":"image/png","data":PNG}]}}}));
    // A generation message is not a committed stored image.
    assert!(model.rows().iter().all(|r| r.image_data().is_none()));
}

#[test]
fn faux_reader_keeps_exact_hello_chat_entry_block_source_and_only_gets() {
    let server = fixture::Server::start(PNG.into());
    let capture = crate::local_client::read_local_capture(server.options.clone(), "owner").unwrap();
    let row = capture
        .state
        .rows
        .iter()
        .find(|row| row.image_data().is_some())
        .unwrap();
    assert_eq!(
        row.reader_key(),
        Some(crate::model::ReaderKey::model(1, 0, Some(1)))
    );
    let source = row.image_data().unwrap();
    let (host, chat) = source.owner.as_ref().unwrap();
    assert_eq!(host.daemon_id, "test-daemon");
    assert_eq!(host.lineage_id, "test-lineage");
    assert_eq!(chat, "owner");
    assert!(source.decode(|| false).is_ok());
    let requests = server.requests.lock().unwrap();
    assert!(requests.iter().all(|request| request.starts_with("GET ")));
    assert!(
        requests
            .iter()
            .any(|request| request == "GET /api/sessions/owner/ws HTTP/1.1")
    );
}
