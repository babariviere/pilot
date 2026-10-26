use super::*;
use crate::{mission_browser_fixture as f, mission_inspector::Link};
use gpui_kit::{AppContext, TestAppContext};
use serde_json::json;
fn source() -> Source {
    Source {
        home: f::key("mission-A").home,
        chat: "chat-A".into(),
        project: "project-A".into(),
        mission: "mission-A".into(),
        selection: 1,
    }
}
fn input(source: Option<Source>) -> Input {
    let mut metadata = Arc::new(Metadata::default());
    Metadata::accept(
        &mut metadata,
        &json!({"type":"sessions","sessions":[{"id":"chat-A","missionId":"mission-A","projectId":"project-A"},{"id":"chat-B","missionId":"mission-A","projectId":"project-A"}]}),
    );
    Input {
        source,
        availability: "Unknown",
        metadata,
        chats: Arc::new(
            ["chat-A", "chat-B"]
                .iter()
                .map(|id| {
                    crate::local_model::chat(&json!({"id":id,"projectId":"project-A"})).unwrap()
                })
                .collect(),
        ),
        online: true,
        active: true,
    }
}
fn detail() -> Data {
    let d = Arc::new(
        crate::mission_browser::detail(&f::key("mission-A"), &f::detail("mission-A")).unwrap(),
    );
    let m = Arc::new(crate::mission_browser::members(&d, &f::members("mission-A")).unwrap());
    Data::Detail(d, Ok(m))
}
#[gpui_kit::test]
fn stale_identity_visibility_generation_and_offline_never_enable_links(cx: &mut TestAppContext) {
    let p = cx.new(Pane::new);
    p.update(cx, |p, cx| {
        p.sync(input(Some(source())), cx);
        p.visible = true;
        p.generation = 8;
        p.route = Some(Route::Detail(source().key()));
        p.accept(
            mission_reader::Response {
                generation: 7,
                route: Route::Detail(source().key()),
                result: Ok(detail()),
            },
            cx,
        );
        assert!(p.detail.is_none());
        p.accept(
            mission_reader::Response {
                generation: 8,
                route: Route::Detail(source().key()),
                result: Ok(detail()),
            },
            cx,
        );
        assert!(p.link_ready(&source(), "chat-B", 8));
        assert!(!p.link_ready(&source(), "chat-B", 7));
        assert!(!p.link_ready(&source(), "not-loaded", 8));
        p.accept(
            mission_reader::Response {
                generation: 8,
                route: Route::Detail(source().key()),
                result: Err("failed"),
            },
            cx,
        );
        assert!(p.detail.is_some());
        assert!(!p.link_ready(&source(), "chat-B", 8));
        let mut i = input(Some(source()));
        i.online = false;
        p.sync(i, cx);
        assert!(p.detail.is_some());
        assert!(!p.busy);
        let mut s = source();
        s.mission = "mission-B".into();
        p.sync(input(Some(s)), cx);
        assert!(p.detail.is_none());
        p.accept(
            mission_reader::Response {
                generation: 8,
                route: Route::Detail(source().key()),
                result: Ok(detail()),
            },
            cx,
        );
        assert!(p.detail.is_none());
        p.sync(input(None), cx);
        assert!(p.source.is_none());
        p.hide(cx);
        assert!(!p.visible);
    });
}
#[gpui_kit::test]
fn member_metadata_and_reader_lane_changes_fail_closed(cx: &mut TestAppContext) {
    let p = cx.new(Pane::new);
    p.update(cx, |p, cx| {
        p.sync(input(Some(source())), cx);
        p.visible = true;
        p.generation = 3;
        p.route = Some(Route::Detail(source().key()));
        p.accept(
            mission_reader::Response {
                generation: 3,
                route: Route::Detail(source().key()),
                result: Ok(detail()),
            },
            cx,
        );
        assert!(p.link_ready(&source(), "chat-B", 3));
        let mut i = input(Some(source()));
        Metadata::accept(
            &mut i.metadata,
            &json!({"type":"session","session":{"id":"chat-B"}}),
        );
        assert_eq!(i.metadata.link("chat-B"), &Link::Unlinked);
        p.sync(i, cx);
        assert!(!p.link_ready(&source(), "chat-B", 3));
        let old = p.lane;
        p.cancel();
        p.stopped(old, cx);
        assert!(p.error.is_none());
        p.stopped(p.lane, cx);
        assert!(p.error.unwrap().contains("reader stopped"));
        assert!(!p.busy);
        assert!(p.detail.is_some());
    });
}
