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
fn accept_latest(v: &mut Browser, route: Route, data: Data, cx: &mut Context<Browser>) {
    v.generation += 1;
    v.route = Some(route.clone());
    v.accept(
        Response {
            generation: v.generation,
            route,
            result: Ok(data),
        },
        cx,
    );
}
fn mission_association_catalog(title: Option<&str>, truncated: bool) -> Data {
    let mut c = model::catalog(&f::catalog()).unwrap();
    c.truncated = truncated;
    match title {
        Some(title) => c
            .rows
            .iter_mut()
            .filter(|r| r.key == f::key("mission-A"))
            .for_each(|r| r.title = title.into()),
        // The foreign replica with the same mission ID stays in the catalog.
        None => c.rows.retain(|r| r.key != f::key("mission-A")),
    }
    Data::Catalog(Arc::new(c))
}
#[gpui_kit::test]
fn mission_association_name_follows_the_latest_accepted_exact_key_snapshot(
    cx: &mut TestAppContext,
) {
    cx.update(gpui_kit::init);
    let pane = cx.new(Browser::new);
    pane.update(cx, |v, cx| {
        v.options(LocalOptions::synthetic(1));
        v.online = true;
        fn label(v: &Browser) -> Option<(&str, bool)> {
            v.sidebar_mission_name("mission-A")
        }
        assert_eq!(label(v), None);
        accept_latest(
            v,
            Route::Catalog,
            mission_association_catalog(Some("Catalog first"), false),
            cx,
        );
        assert_eq!(label(v), Some(("Catalog first", true)));
        // A newer exact-key detail wins over the older catalog.
        let mut d = model::detail(&f::key("mission-A"), &f::detail("mission-A")).unwrap();
        d.title = "Detail rename".into();
        let d = Arc::new(d);
        let m = model::members(&d, &f::members("mission-A")).map(Arc::new);
        accept_latest(
            v,
            Route::Detail(f::key("mission-A")),
            Data::Detail(d, m),
            cx,
        );
        assert_eq!(label(v), Some(("Detail rename", true)));
        // A newer catalog wins over the retained detail.
        accept_latest(
            v,
            Route::Catalog,
            mission_association_catalog(Some("Catalog rename"), false),
            cx,
        );
        assert!(v.detail.is_some());
        assert_eq!(label(v), Some(("Catalog rename", true)));
        // A newer complete catalog without the Local mission never revives the
        // retained name, nor borrows the foreign replica's.
        accept_latest(
            v,
            Route::Catalog,
            mission_association_catalog(None, false),
            cx,
        );
        assert_eq!(label(v), None);
        // A truncated catalog may omit it, so the retained exact-key name remains.
        accept_latest(
            v,
            Route::Catalog,
            mission_association_catalog(None, true),
            cx,
        );
        assert_eq!(label(v), Some(("Detail rename", true)));
        // Offline keeps the last known name; reconnect restores the current label.
        v.online = false;
        assert_eq!(label(v), Some(("Detail rename", false)));
        v.online = true;
        assert_eq!(label(v), Some(("Detail rename", true)));
    });
}

#[gpui_kit::test]
fn chat_mission_jump_opens_only_a_listed_exact_key_or_says_it_is_missing(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let pane = cx.new(Browser::new);
    let opened = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
    cx.update(|cx| {
        let opened = opened.clone();
        cx.subscribe(&pane, move |_, e: &Event, _| {
            if let Event::Open { key, generation } = e {
                opened.borrow_mut().push((key.clone(), *generation));
            }
        })
        .detach();
    });
    let catalog = || Data::Catalog(Arc::new(model::catalog(&f::catalog()).unwrap()));
    pane.update(cx, |v, cx| {
        v.options(LocalOptions::synthetic(1));
        v.online = true;
        v.loaded = true;
        v.route = Some(Route::Catalog);
        v.generation = 3;
        v.busy = true;
        // Waits for the list while it loads.
        v.open_when_listed(f::key("mission-A"), cx);
        assert_eq!(v.jump, Some(f::key("mission-A")));
        v.busy = false;
        v.accept(
            Response {
                generation: 3,
                route: Route::Catalog,
                result: Ok(catalog()),
            },
            cx,
        );
        assert!(v.jump.is_none() && v.jump_note.is_none());
    });
    cx.run_until_parked();
    assert_eq!(*opened.borrow(), vec![(f::key("mission-A"), 3)]);
    pane.update(cx, |v, cx| {
        // A current list without the mission says so, with no request or guess.
        v.open_when_listed(f::key("mission-Z"), cx);
        assert!(v.jump.is_none());
        assert!(v.jump_note.is_some());
        // A failed read drops the pending jump; the error speaks for itself.
        v.generation = 4;
        v.busy = true;
        v.open_when_listed(f::key("mission-A"), cx);
        v.accept(
            Response {
                generation: 4,
                route: Route::Catalog,
                result: Err("Missions aren't available right now. Refresh to try again."),
            },
            cx,
        );
        assert!(v.jump.is_none() && v.jump_note.is_none());
    });
    cx.run_until_parked();
    assert_eq!(opened.borrow().len(), 1);
}
/// The displayed mission's coordinatorSessionId, exactly: a distinct member, a
/// role-like decoy title or a retained mission never stands in for it.
#[gpui_kit::test]
fn coordinator_jump_opens_only_the_displayed_missions_exact_coordinator(cx: &mut TestAppContext) {
    use serde_json::json;
    cx.update(gpui_kit::init);
    let pane = cx.new(Browser::new);
    let opened = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
    cx.update(|cx| {
        let opened = opened.clone();
        cx.subscribe(&pane, move |_, e: &Event, _| {
            if let Event::Chat {
                key,
                id,
                generation,
            } = e
            {
                opened
                    .borrow_mut()
                    .push((key.clone(), id.clone(), *generation));
            }
        })
        .detach();
    });
    let chat = |id: &str, title: &str, extra: serde_json::Value| {
        let mut v =
            json!({"id":id,"title":title,"projectId":"project-A","state":"idle","mode":"ask"});
        v.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        crate::local_model::chat(&v).unwrap()
    };
    let local = Arc::new(vec![
        chat("chat-M", "Member work", json!({"missionId":"mission-A"})),
        chat(
            "chat-C",
            "Plan the mission",
            json!({"missionId":"mission-A","missionCoordinator":true}),
        ),
        // A role-like title and a stale role flag are never the coordinator.
        chat(
            "chat-X",
            "Mission coordinator",
            json!({"missionCoordinator":true}),
        ),
    ]);
    let detail = |coordinator: serde_json::Value| {
        let mut v = f::detail("mission-A");
        v["mission"]["coordinatorSessionId"] = coordinator;
        let d = Arc::new(model::detail(&f::key("mission-A"), &v).unwrap());
        let m = model::members(
            &d,
            &json!([
                {"id":"chat-M","title":"Member work","missionId":"mission-A","projectId":"project-A"},
                {"id":"chat-C","title":"Plan the mission","missionId":"mission-A","projectId":"project-A"},
            ]),
        )
        .map(Arc::new);
        Data::Detail(d, m)
    };
    pane.update(cx, |v, cx| {
        v.options(LocalOptions::synthetic(1));
        v.online = true;
        v.loaded = true;
        v.chats = local.clone();
        accept_latest(
            v,
            Route::Detail(f::key("mission-A")),
            detail(json!("chat-C")),
            cx,
        );
        let g = v.generation;
        let c = v.coordinator().expect("assigned coordinator");
        assert_eq!(
            (c.key.clone(), c.id.as_str()),
            (f::key("mission-A"), "chat-C")
        );
        assert_eq!(c.title.as_deref(), Some("Plan the mission"));
        assert!(c.available);
        // A member, a decoy or an old generation never opens as the coordinator.
        assert!(!v.open_coordinator(&f::key("mission-A"), "chat-M", g, cx));
        assert!(!v.open_coordinator(&f::key("mission-A"), "chat-X", g, cx));
        assert!(!v.open_coordinator(&f::key("mission-A"), "chat-C", g - 1, cx));
        assert!(!v.open_coordinator(&f::key("mission-B"), "chat-C", g, cx));
        assert!(v.open_coordinator(&f::key("mission-A"), "chat-C", g, cx));
        // Offline or outside the Local chat list: known but unavailable.
        v.online = false;
        assert!(!v.coordinator().unwrap().available);
        assert!(!v.open_coordinator(&f::key("mission-A"), "chat-C", g, cx));
        v.online = true;
        v.chats = Arc::new(local.iter().filter(|c| c.id != "chat-C").cloned().collect());
        let c = v.coordinator().unwrap();
        assert!(!c.available && c.id == "chat-C");
        assert_eq!(
            c.title.as_deref(),
            Some("Plan the mission"),
            "member title remains"
        );
        assert!(!v.open_coordinator(&f::key("mission-A"), "chat-C", g, cx));
        v.chats = local.clone();
        // A coordinator the member list doesn't confirm stays unavailable.
        accept_latest(
            v,
            Route::Detail(f::key("mission-A")),
            detail(json!("chat-Z")),
            cx,
        );
        let c = v.coordinator().unwrap();
        assert!(!c.available && c.id == "chat-Z" && c.title.is_none());
        assert!(!v.open_coordinator(&f::key("mission-A"), "chat-Z", v.generation, cx));
        // None assigned: no target, and the role-flagged decoy is not one.
        accept_latest(
            v,
            Route::Detail(f::key("mission-A")),
            detail(json!(null)),
            cx,
        );
        assert!(v.coordinator().is_none());
        assert!(!v.open_coordinator(&f::key("mission-A"), "chat-X", v.generation, cx));
        // Switching missions retires the previous mission's coordinator at once.
        accept_latest(
            v,
            Route::Detail(f::key("mission-A")),
            detail(json!("chat-C")),
            cx,
        );
        let old = v.generation;
        v.generation += 1;
        v.route = Some(Route::Detail(f::key("mission-B")));
        assert!(
            v.detail.is_some(),
            "retained detail of the previous mission"
        );
        assert!(v.coordinator().is_none());
        assert!(!v.open_coordinator(&f::key("mission-A"), "chat-C", old, cx));
        assert!(!v.open_coordinator(&f::key("mission-A"), "chat-C", v.generation, cx));
    });
    cx.run_until_parked();
    assert_eq!(
        *opened.borrow(),
        vec![(f::key("mission-A"), "chat-C".to_owned(), 1)]
    );
}
