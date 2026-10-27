use super::*;
use crate::{mission_browser as model, mission_browser_fixture as f, mission_reader::Response};
use gpui_kit::{AppContext, TestAppContext};
#[gpui_kit::test]
fn closed_reader_clears_busy_preserves_snapshot_and_ignores_an_old_lane(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let pane = cx.new(Browser::new);
    pane.update(cx, |v, cx| {
        v.route = Some(Route::Catalog);
        v.catalog = Some(Arc::new(model::catalog(&f::catalog()).unwrap()));
        v.catalog_current = true;
        v.reader_lane = 2;
        v.busy = true;
        v.reader_stopped(1, cx);
        assert!(v.busy && v.error.is_none() && v.catalog_current);
        v.reader_stopped(2, cx);
        assert!(!v.busy);
        assert!(v.error.unwrap().contains("Couldn't load the mission"));
        assert!(!v.catalog_current);
        assert_eq!(v.catalog.as_ref().unwrap().rows.len(), 3);
        assert!(v.reader.is_none());
        v.error = Some("Foreign mission home is unavailable");
        v.reader_stopped(2, cx);
        assert_eq!(v.error, Some("Foreign mission home is unavailable"));
        v.route = None;
        v.error = None;
        v.reader_stopped(2, cx);
        assert!(v.error.is_none() && !v.busy);
    });
}
#[gpui_kit::test]
fn late_source_or_generation_never_relabels_a_page_or_enables_a_chat_link(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let pane = cx.new(Browser::new);
    pane.update(cx,|v,cx|{
        v.options(LocalOptions::synthetic(1));v.online=true;v.loaded=true;v.route=Some(Route::Catalog);v.generation=7;
        let catalog=Arc::new(model::catalog(&f::catalog()).unwrap());
        v.accept(Response{generation:6,route:Route::Catalog,result:Ok(Data::Catalog(catalog.clone()))},cx);assert!(v.catalog.is_none());
        v.accept(Response{generation:7,route:Route::Detail(f::key("mission-A")),result:Err("Late failure")},cx);assert!(v.error.is_none());
        v.accept(Response{generation:7,route:Route::Catalog,result:Ok(Data::Catalog(catalog))},cx);assert!(v.can_open(&f::key("mission-A"),7));assert!(!v.can_open(&f::key("mission-A"),6));
        v.filter=Some("project-B".into());assert!(!v.can_open(&f::key("mission-A"),7));assert!(v.can_open(&f::key("mission-B"),7));v.filter=None;
        v.online=false;assert!(!v.can_open(&f::key("mission-A"),7));assert_eq!(v.catalog.as_ref().unwrap().rows.len(),3);
        v.online=true;v.generation=8;v.route=Some(Route::Detail(f::key("mission-A")));
        let d=Arc::new(model::detail(&f::key("mission-A"),&f::detail("mission-A")).unwrap());let m=Arc::new(model::members(&d,&f::members("mission-A")).unwrap());
        v.chats=Arc::new(vec![crate::local_model::chat(&serde_json::json!({"id":"chat-A","projectId":"project-A","title":"Same chat title","state":"idle","mode":"ask"})).unwrap()]);
        v.accept(Response{generation:8,route:Route::Detail(f::key("mission-A")),result:Ok(Data::Detail(d.clone(),Ok(m.clone())))},cx);
        assert!(v.can_link(&d.key,"chat-A",8));assert!(!v.can_link(&d.key,"chat-A",7));assert!(!v.can_link(&d.key,"not-loaded",8));assert!(!v.can_link(&f::key("mission-B"),"chat-A",8));
        let mut metadata=(*v.chats).clone();metadata[0].title="Streaming metadata rename".into();metadata[0].busy=true;assert!(!v.link_availability_changed(&metadata));metadata[0].project_id=Some("project-B".into());assert!(v.link_availability_changed(&metadata));
        v.online=false;assert!(!v.can_link(&d.key,"chat-A",8));v.online=true;v.loaded=false;assert!(!v.can_link(&d.key,"chat-A",8));v.loaded=true;
        v.busy=true;assert!(!v.can_link(&d.key,"chat-A",8));v.busy=false;
        v.generation=9;v.route=Some(Route::Detail(f::key("mission-B")));v.accept(Response{generation:8,route:Route::Detail(d.key.clone()),result:Ok(Data::Detail(d,Ok(m)))},cx);
        assert!(!v.can_link(&f::key("mission-A"),"chat-A",8));
        v.generation=10;v.route=None;v.accept(Response{generation:9,route:Route::Detail(f::key("mission-B")),result:Err("obsolete")},cx);assert!(v.error.is_none());
    });
}
#[gpui_kit::test]
fn failed_refresh_keeps_snapshot_but_never_claims_empty_current_or_linkable(
    cx: &mut TestAppContext,
) {
    cx.update(gpui_kit::init);
    let pane = cx.new(Browser::new);
    pane.update(cx, |v, cx| {
        v.options(LocalOptions::synthetic(1));
        v.online = true;
        v.route = Some(Route::Catalog);
        v.generation = 1;
        v.accept(
            Response {
                generation: 1,
                route: Route::Catalog,
                result: Ok(Data::Catalog(Arc::new(
                    model::catalog(&f::catalog()).unwrap(),
                ))),
            },
            cx,
        );
        assert_eq!(v.snapshot_note(), None);
        for error in [
            "Unsupported mission catalog response.",
            "Mission response exceeds the viewer byte limit; no partial JSON was decoded.",
            "Malformed mission JSON; previous snapshot is not current.",
        ] {
            v.accept(
                Response {
                    generation: 1,
                    route: Route::Catalog,
                    result: Err(error),
                },
                cx,
            );
            assert_eq!(v.catalog.as_ref().unwrap().rows.len(), 3);
            assert!(!v.catalog_current);
            assert!(v.error.is_some());
            assert!(!v.can_open(&f::key("mission-A"), 1));
            assert_eq!(
                v.snapshot_note(),
                Some("Couldn't refresh · may be out of date")
            );
        }
    });
}
