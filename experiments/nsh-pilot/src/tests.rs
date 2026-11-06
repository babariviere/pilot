use super::*;
use nsh_core::geometry::{Points, Size};
use nsh_engine::EngineConfig;
use nsh_testing::Headless;

fn app(width: f32) -> Headless {
    let mut config = EngineConfig::new(root());
    config.clock = nsh_core::time::Clock::manual(std::time::SystemTime::UNIX_EPOCH);
    config.viewport = Size::new(Points(width), Points(820.));
    let mut app = Headless::start(config).expect("synthetic workbench engine");
    app.wait_for("id:composer").unwrap();
    app
}

#[test]
fn native_components_keep_independent_unicode_drafts() {
    let mut app = app(1180.);
    let draft = "  日本語 👩🏽‍💻 cafe\u{301}\nnext line";
    app.type_text("id:composer", draft).unwrap();
    app.press("label:Open Keep drafts across navigation")
        .unwrap();
    assert_eq!(app.screen().input_text("id:composer").unwrap(), Some(""));
    app.type_text("id:composer", "another draft").unwrap();
    app.press("label:Open Native Shell chat and sidebar")
        .unwrap();
    assert_eq!(app.screen().input_text("id:composer").unwrap(), Some(draft));
    assert!(
        app.screen()
            .selected("label:Open Native Shell chat and sidebar")
            .unwrap()
    );
    app.press("label:Open Keep drafts across navigation")
        .unwrap();
    assert_eq!(
        app.screen().input_text("id:composer").unwrap(),
        Some("another draft")
    );
}

#[test]
fn search_and_project_filter_do_not_retarget_the_open_chat() {
    let mut app = app(680.);
    app.type_text("id:composer", "keep this draft").unwrap();
    app.press("label:Choose project").unwrap();
    app.press("label:Show Website").unwrap();
    assert!(
        !app.screen()
            .matches("label:Open Native Shell chat and sidebar")
            .unwrap()
    );
    assert!(
        app.screen()
            .matches("label:Open A clearer getting started page")
            .unwrap()
    );
    assert_eq!(
        app.screen().input_text("id:composer").unwrap(),
        Some("keep this draft")
    );
    app.type_text("id:chat-search", "日本語").unwrap();
    assert!(
        !app.screen()
            .matches("label:Open A clearer getting started page")
            .unwrap()
    );
    assert!(
        app.screen()
            .matches("label:Open 日本語の入力と下書き")
            .unwrap()
    );
    app.press("label:All chats").unwrap();
    assert!(
        app.screen()
            .matches("label:Open Native Shell chat and sidebar")
            .unwrap()
    );
}

#[test]
fn send_stop_and_navigation_use_the_chat_owner() {
    let mut app = app(1180.);
    assert!(!app.screen().enabled("label:Send message").unwrap());
    app.type_text("id:composer", "A synthetic message 👩🏽‍💻")
        .unwrap();
    app.press("label:Send message").unwrap();
    app.wait_for("label:Stop reply").unwrap();
    assert_eq!(app.screen().input_text("id:composer").unwrap(), Some(""));
    assert!(!app.screen().enabled("label:Send message").unwrap());
    app.press("label:Open Keep drafts across navigation")
        .unwrap();
    app.type_text("id:composer", "independent draft").unwrap();
    app.wait(Duration::from_millis(180)).unwrap();
    app.press("label:Open Native Shell chat and sidebar")
        .unwrap();
    app.wait_for("label:Stop reply").unwrap();
    app.press("label:Stop reply").unwrap();
    app.wait_for_gone("label:Stop reply", Duration::from_secs(2))
        .unwrap();
    app.wait(Duration::from_millis(100)).unwrap();
    app.press("label:Open Keep drafts across navigation")
        .unwrap();
    assert_eq!(
        app.screen().input_text("id:composer").unwrap(),
        Some("independent draft")
    );
}

#[test]
fn new_chat_is_empty_and_does_not_clear_an_existing_draft() {
    let mut app = app(680.);
    app.type_text("id:composer", "original draft").unwrap();
    app.press("label:New chat").unwrap();
    app.wait_for("What would you like to build?").unwrap();
    assert_eq!(app.screen().input_text("id:composer").unwrap(), Some(""));
    app.type_text("id:composer", "new draft").unwrap();
    app.submit("id:composer").unwrap();
    app.wait_for("label:Stop reply").unwrap();
    app.press("label:Stop reply").unwrap();
    app.press("label:Open Native Shell chat and sidebar")
        .unwrap();
    assert_eq!(
        app.screen().input_text("id:composer").unwrap(),
        Some("original draft")
    );
}
