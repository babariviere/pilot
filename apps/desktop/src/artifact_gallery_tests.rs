use super::*;
use serde_json::json;

pub(super) fn reference(ix: usize) -> Reference {
    Reference {
        session: "owner".into(),
        id: format!("image-{ix}"),
        revision: 1,
        kind: "image".into(),
        title: "同じ名前 🧪".into(),
    }
}
fn row(ix: usize) -> Value {
    let r = reference(ix);
    json!({"sessionId":r.session,"id":r.id,"revision":r.revision,"kind":r.kind,"title":r.title})
}
#[test]
fn metadata_pending_empty_invalid_retention_and_exact_limit_are_distinct() {
    let mut state = Metadata::default();
    assert!(!state.is_received());
    assert!(state.accept(&Value::Null, "owner").is_none());
    assert!(!state.is_received());
    assert!(state.problem().is_some());
    assert!(state.accept(&json!([]), "owner").unwrap().is_empty());
    assert!(state.is_received() && !state.is_limited() && state.problem().is_none());
    state.mark_stale();
    assert!(state.is_stale() && state.is_received());
    state.accept(&json!([]), "owner").unwrap();
    assert!(!state.is_stale());
    let full = Value::Array((0..64).map(row).collect());
    assert_eq!(state.accept(&full, "owner").unwrap().len(), 64);
    assert!(!state.is_limited());
    let larger = Value::Array((0..128).map(row).collect());
    assert_eq!(state.accept(&larger, "owner").unwrap().len(), 64);
    assert!(state.is_limited());
    assert!(state.accept(&json!([row(1), row(1)]), "owner").is_none());
    assert!(state.is_received() && state.is_limited() && state.problem().is_some());
    assert!(state.accept(&json!([row(0)]), "different-owner").is_none());
}
#[test]
fn keys_are_exact_and_titles_are_not_identity() {
    let a = reference(0);
    let mut b = a.clone();
    b.title = "renamed".into();
    assert_eq!(Key::new(&a), Key::new(&b));
    assert_ne!(Key::new(&a), Key::new(&reference(1)));
    b.revision += 1;
    assert_ne!(Key::new(&a).element_id(), Key::new(&b).element_id());
    b = a.clone();
    b.kind = "visual".into();
    assert_ne!(Key::new(&a), Key::new(&b));
    b = a.clone();
    b.session = "different-owner".into();
    assert_ne!(Key::new(&a), Key::new(&b));
}
#[test]
fn geometry_is_mounted_width_and_rem_derived_with_bounded_overscan() {
    assert_eq!(columns(656., 14., 12.), 2);
    assert_eq!(columns(1076., 14., 12.), 3);
    assert_eq!(columns(656., 18., 12.), 1);
    assert_eq!(columns(3000., 14., 12.), 4);
    assert_eq!(columns(f32::NAN, 14., 12.), 1);
    assert_eq!(visible_rows(-400., 400., 200., 32), 2..5);
    assert_eq!(visible_rows(20., 0., 200., 32), 0..0);
    assert_eq!(visible_rows(-10000., 400., 200., 32), 32..32);
}
#[test]
fn requests_are_lazy_image_only_capped_and_target_first_without_title_collisions() {
    let mut items: Vec<_> = (0..64).map(reference).collect();
    items[20].kind = "visual".into();
    let key = Key::new(&items[30]);
    let visible = requests(&items, 5..10, 4, Some(&key));
    assert_eq!(visible.len(), REQUEST_CAP);
    assert_eq!(visible[0].id, "image-30");
    assert!(
        visible
            .iter()
            .all(|r| r.kind == "image" && items[20..40].contains(r))
    );
    assert_eq!(requests(&items, 0..1, 2, None).len(), 2);
    assert!(requests(&items, 32..32, 2, None).is_empty());
}
fn raster(width: u32, height: u32) -> crate::artifact_image::Raster {
    crate::artifact_image::Raster {
        image: Arc::new(RenderImage::new(vec![image::Frame::new(
            image::RgbaImage::from_pixel(width, height, image::Rgba([17, 29, 43, 255])),
        )])),
        width,
        height,
        mime: "image/png",
        encoded_bytes: 0,
        source_hash: "synthetic".into(),
        first_frame: false,
    }
}
#[test]
fn thumbnails_borrow_full_pixels_and_publish_only_bounded_bgra() {
    let full = raster(1024, 640);
    let weak = Arc::downgrade(&full.image);
    let thumb = Thumbnail::from_raster(&full, || false).unwrap();
    assert_eq!(thumb.bytes(), THUMB_BYTES);
    assert_eq!(&thumb.image().as_bytes(0).unwrap()[..4], &[17, 29, 43, 255]);
    drop(full);
    assert!(
        weak.upgrade().is_none(),
        "thumbnail must not retain its full input raster"
    );
    assert!(Thumbnail::from_raster(&raster(4, 4), || true).is_err());
}
#[test]
fn cache_bounds_lru_revision_eviction_and_clear_return_explicit_retirements() {
    let full = raster(512, 320);
    let mut cache = Cache::default();
    for ix in 0..CACHE_ENTRIES {
        assert!(
            cache
                .insert(
                    Key::new(&reference(ix)),
                    Thumbnail::from_raster(&full, || false).unwrap()
                )
                .is_empty()
        );
    }
    assert_eq!(cache.usage(), (12, 12 * THUMB_BYTES));
    assert!(cache.usage().1 <= CACHE_BYTES);
    cache.touch(&[Key::new(&reference(0))]);
    let retired = cache.insert(
        Key::new(&reference(12)),
        Thumbnail::from_raster(&full, || false).unwrap(),
    );
    assert_eq!(retired.len(), 1);
    assert!(cache.get(&Key::new(&reference(0))).is_some());
    assert!(cache.get(&Key::new(&reference(1))).is_none());
    drop(retired);
    let keep = BTreeSet::from([Key::new(&reference(0))]);
    assert_eq!(cache.retain(&keep).len(), 11);
    assert_eq!(cache.usage(), (1, THUMB_BYTES));
    let image = cache.get(&Key::new(&reference(0))).unwrap().image();
    let weak = Arc::downgrade(&image);
    drop(image);
    let retired = cache.clear();
    assert_eq!(retired.len(), 1);
    assert_eq!(cache.usage(), (0, 0));
    drop(retired);
    assert!(weak.upgrade().is_none());
}
