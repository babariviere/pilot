use super::*;
use serde_json::json;

const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEElEQVR4AQEFAPr/AP8AAP8FAAH/+lyI0QAAAABJRU5ErkJggg==";
#[test]
fn inline_contract_and_no_external_loader() {
    let source = Source::read(2, &json!({"mimeType":"image/png","data":PNG}));
    assert_eq!(source.block, 2);
    assert_eq!(source.size, Some((1, 1)), "header size known before decode");
    assert_eq!(source.data.as_deref().unwrap().as_str(), PNG);
    let raster = source.decode(|| false).unwrap();
    assert_eq!((raster.width, raster.height), (1, 1));
    assert!(source.decode(|| true).is_err());
    for block in [
        json!({"mimeType":"image/png","url":"https://example.test/private.png"}),
        json!({"mimeType":"image/png","path":"/private/image.png"}),
        json!({"mimeType":"image/webp","data":"AAAA"}),
        json!({"mimeType":"image/svg+xml","data":"AAAA"}),
    ] {
        let image = Source::read(0, &block);
        assert!(image.problem.is_some());
        assert!(image.data.is_none());
    }
    let broken = Source::read(
        0,
        &json!({"mimeType":"image/png","data":"https://example.test/a"}),
    );
    assert!(broken.decode(|| false).is_err());
}

#[test]
fn large_inline_source_is_exact_and_codec_limits_remain_distinct() {
    let data = fixture::large_png();
    let source = Source::read(0, &json!({"mimeType":"image/png","data":data}));
    assert!(source.problem.is_none());
    assert_eq!(source.size, Some((640, 640)));
    assert_eq!(source.data.as_deref().unwrap().as_str(), data);
    let raster = source.decode(|| false).unwrap();
    assert_eq!((raster.width, raster.height), (640, 640));
    // Retention is independent of actual decoder admission, even over its bound.
    let oversize = "A".repeat(crate::artifact_image::SOURCE_CAP + 1);
    let source = Source::read(0, &json!({"mimeType":"image/png","data":oversize}));
    assert!(source.problem.is_none());
    assert_eq!(source.size, None);
    assert!(source.hash.is_some());
    assert_eq!(source.data.as_deref().unwrap().as_str(), oversize);
    assert_eq!(
        source.decode(|| false).err(),
        Some("Image exceeds the 16 MiB compressed preview limit (base64 envelope).")
    );
}

#[test]
fn source_bytes_survive_snapshot_prefix_history_reconnect_and_live_commit() {
    use crate::{local_model::LiveTranscript, model::ReaderKey};
    let data = fixture::large_png();
    let text = "Exact 日本語 🦀\n".repeat(80_000);
    assert!(text.len() > 1024 * 1024);
    let entry = |id, role| {
        json!({
            "id":id,"head":10,"kind":"pi.message",
            "model":[{"role":role,"content":[
                {"type":"text","text":text},
                {"type":"image","mimeType":"image/png","data":data},
                {"type":"image","mimeType":"image/png","data":data},
                {"type":"text","text":"exact suffix"}
            ]}]
        })
    };
    let assert_rows =
        |model: &mut LiveTranscript, ids: &[u64]| {
            let rows = model.rows();
            assert!(!model.limited);
            assert!(
                rows.iter()
                    .map(crate::model::Message::retained_bytes)
                    .sum::<usize>()
                    > 8 * 1024 * 1024
            );
            assert_eq!(
                rows.iter().filter(|r| r.image_data().is_some()).count(),
                ids.len() * 2
            );
            for id in ids {
                let images: Vec<_> = rows
                    .iter()
                    .filter_map(|row| match row.reader_key() {
                        Some(ReaderKey::Entry { entry, .. }) if entry == *id => row.image_data(),
                        _ => None,
                    })
                    .collect();
                for image in images {
                    assert!(image.problem.is_none());
                    assert_eq!(image.data.as_deref().unwrap().as_str(), data);
                    let expected =
                        Source::read(image.block, &json!({"mimeType":"image/png","data":data}));
                    assert_eq!(image.hash, expected.hash);
                }
                let text_rows: Vec<_> = rows.iter().filter(|row| {
                matches!(row.reader_key(), Some(ReaderKey::Entry {entry, ..}) if entry == *id)
                    && row.image_data().is_none()
            }).collect();
                let joined: String = text_rows.iter().map(|row| row.source()).collect();
                assert_eq!(joined, format!("{text}exact suffix"));
            }
        };
    let mut model = LiveTranscript::default();
    model.apply(&json!({"type":"snapshot","entries":[entry(10, "user")],"prefixPending":true}));
    model.apply(&json!({"type":"snapshot_prefix","entries":[entry(11, "assistant")]}));
    assert_rows(&mut model, &[10, 11]);
    model.page(10, &json!({"entries":[entry(8, "toolResult")],"more":true}));
    assert_rows(&mut model, &[8, 10, 11]);
    let identities: Vec<_> = model
        .rows()
        .iter()
        .map(|row| (row.id(), row.reader_key()))
        .collect();
    // Same-head reconnect must restore already loaded history above 8 MiB too.
    model
        .apply(&json!({"type":"snapshot","entries":[entry(11, "assistant")],"prefixPending":true}));
    model.apply(&json!({"type":"snapshot_prefix","entries":[entry(10, "user")]}));
    assert_rows(&mut model, &[8, 10, 11]);
    assert_eq!(
        identities,
        model
            .rows()
            .iter()
            .map(|row| (row.id(), row.reader_key()))
            .collect::<Vec<_>>()
    );
    model.apply(&json!({"type":"entry_appended","entry":entry(12, "user")}));
    model.apply(&json!({"type":"message_start","message":{"timestamp":42,"content":[{"type":"text","text":text}]}}));
    model.apply(&json!({"type":"message_update","changes":[{"type":"text_delta","contentIndex":0,"delta":"exact suffix"}]}));
    assert_eq!(
        model.rows().last().unwrap().source(),
        format!("{text}exact suffix")
    );
    model.apply(&json!({"type":"message_end","entry":entry(13, "assistant")}));
    assert_rows(&mut model, &[8, 10, 11, 12, 13]);
    assert!(
        model.has_capacity(),
        "source bytes must not stop history admission"
    );
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
            .any(|request| request == "GET /api/sessions/owner/ws?history=paged-v1 HTTP/1.1")
    );
}
