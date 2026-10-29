use super::*;

fn native(web: &str, workspaces: &[(&str, &str)]) -> Option<String> {
    let list = || {
        workspaces
            .iter()
            .map(|(id, host)| SlackWorkspace {
                id: (*id).into(),
                host: Some((*host).into()),
            })
            .collect()
    };
    url(&Url::parse(web).unwrap(), list)
}

#[test]
fn linear_keeps_issue_project_and_comment_destinations() {
    for (web, expected) in [
        (
            "https://linear.app/acme/issue/ENG-42/fix-export?view=all#comment-123",
            "linear://linear.app/acme/issue/ENG-42/fix-export?view=all#comment-123",
        ),
        (
            "http://linear.app/acme/project/api-v2-0123456789ab/overview",
            "linear://linear.app/acme/project/api-v2-0123456789ab/overview",
        ),
        (
            "https://LINEAR.app/acme/issue/ENG-42/a%20title",
            "linear://linear.app/acme/issue/ENG-42/a%20title",
        ),
    ] {
        assert_eq!(native(web, &[]).as_deref(), Some(expected), "{web}");
    }
}

#[test]
fn slack_keeps_channel_message_thread_and_workspace() {
    let workspaces = [
        ("T123", "acme.slack.com"),
        ("E456", "corp.enterprise.slack.com"),
    ];
    for (web, expected) in [
        (
            "https://acme.slack.com/archives/C123/p1791885305000001",
            "slack://channel?team=T123&id=C123&message=1791885305.000001",
        ),
        (
            "https://ACME.slack.com/archives/C123/p1791885305000001?thread_ts=1791885000.000002&cid=C123",
            "slack://channel?team=T123&id=C123&message=1791885305.000001&thread_ts=1791885000.000002",
        ),
        (
            "https://other.slack.com/archives/C123?thread_ts=1791885000.000002&team=T999",
            "slack://channel?team=T999&id=C123&message=1791885000.000002&thread_ts=1791885000.000002",
        ),
        (
            "https://corp.enterprise.slack.com/archives/G123",
            "slack://channel?team=E456&id=G123",
        ),
        (
            "https://app.slack.com/client/T123/D123/1791885305.000001",
            "slack://channel?team=T123&id=D123&message=1791885305.000001",
        ),
        (
            "https://app.slack.com/client/E123/C123",
            "slack://channel?team=E123&id=C123",
        ),
    ] {
        assert_eq!(native(web, &workspaces).as_deref(), Some(expected), "{web}");
    }
}

#[test]
fn slack_without_a_known_workspace_stays_in_the_browser() {
    let one = [("T123", "acme.slack.com")];
    let two = [("T123", "acme.slack.com"), ("T456", "beta.slack.com")];
    let bare = "https://slack.com/archives/C123/p1000001";
    assert_eq!(
        native(bare, &one).as_deref(),
        Some("slack://channel?team=T123&id=C123&message=1.000001")
    );
    assert_eq!(native(bare, &two), None);
    assert_eq!(native(bare, &[]), None);
    let unknown = "https://gamma.slack.com/archives/C123/p1791885305000001";
    assert_eq!(native(unknown, &two), None);
}

#[test]
fn team_in_the_link_skips_the_slack_state_read() {
    let web = Url::parse("https://slack.com/archives/C1?team=T1").unwrap();
    let read = || -> Vec<SlackWorkspace> { panic!("must not read Slack state") };
    assert_eq!(
        url(&web, read).as_deref(),
        Some("slack://channel?team=T1&id=C1")
    );
}

#[test]
fn reads_signed_in_workspaces_from_slack_state() {
    let json = br#"{"workspaces":{
      "T123":{"id":"T123","domain":"acme","url":"https://acme.slack.com/","name":"Acme"},
      "T456":{"id":"T456","domain":"Beta"},
      "bad":{"id":"not-an-id","url":"https://evil.slack.com/"}
    },"teams":{}}"#;
    assert_eq!(
        slack_root_state(json),
        [
            SlackWorkspace {
                id: "T123".into(),
                host: Some("acme.slack.com".into())
            },
            SlackWorkspace {
                id: "T456".into(),
                host: Some("beta.slack.com".into())
            },
        ]
    );
    assert!(slack_root_state(b"[]").is_empty());
}

#[test]
fn unrelated_unsafe_or_malformed_links_stay_web() {
    for web in [
        "https://linear.app/",
        "https://linear.app/login",
        "https://linear.app/features",
        "https://linear.app/acme/issue",
        "https://linear.app.evil.test/acme/issue/ENG-42",
        "https://linear.app@evil.test/acme/issue/ENG-42",
        "https://linear.app:8443/acme/issue/ENG-42",
        "https://slack.com/help",
        "https://acme.slack.com/signin",
        "https://notslack.com/archives/C123",
        "https://acme.slack.com.evil.test/archives/C123",
        "https://acme.slack.com/archives/random",
        "https://slack.com/archives/C123/p1",
        "https://slack.com/archives/C123/p1791885305oops01",
        "https://slack.com/archives/C123/p1791885305000001/more",
        "https://slack.com/archives/C123?team=not-an-id",
        "https://slack.com/archives/C123?thread_ts=bad",
        "https://app.slack.com/client/T123/C123/not-a-timestamp",
        "https://app.slack.com/client/not-a-team/C123",
        "https://example.test/client/T123/C123",
    ] {
        assert_eq!(native(web, &[("T123", "acme.slack.com")]), None, "{web}");
    }
}
