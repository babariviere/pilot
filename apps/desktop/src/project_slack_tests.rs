use super::*;

fn slack(raw: Value) -> Slack {
    parse(&raw, &mut 0).expect("supported")
}

#[test]
fn parse_keeps_canonical_ids_names_and_legacy_effects() {
    let s = slack(json!({
        "slackChannels": ["C0123ABCD", "bugs-legacy"],
        "slackChannelNames": {"C0123ABCD": "support-日本"},
        "slackMentionOnlyChannels": ["C0123ABCD"],
        "slackGroupHandles": ["oncall", "support"],
        "slackLabels": [
            {"name":"Payments 💳","description":"Billing","effect":"close"},
            {"name":"Legacy","description":"","hideFromInbox":true}
        ],
        "linearTeam": "T1"
    }));
    assert_eq!(s.channels[0].id, "C0123ABCD");
    assert_eq!(s.channels[0].display(), "#support-日本");
    assert!(s.channels[0].mention_only && !s.channels[1].mention_only);
    assert_eq!(
        s.channels[1].display(),
        "#bugs-legacy",
        "older configs hold names"
    );
    assert_eq!(s.groups, "@oncall, @support");
    assert_eq!(
        s.labels.iter().map(|l| l.effect).collect::<Vec<_>>(),
        [Effect::Close, Effect::Hide]
    );
    assert_ne!(s.labels[0].key, s.labels[1].key);
    assert_eq!(slack(Value::Null), Slack::default());
}

#[test]
fn unknown_shapes_are_read_only_rather_than_rewritten() {
    for raw in [
        json!({"slackChannels":["C1"],"mcp":{"server":"x"}}),
        json!({"slackChannels":"C1"}),
        json!({"slackChannels":["C1"],"slackLabels":[{"name":"a","effect":"archive"}]}),
        json!([]),
    ] {
        assert!(parse(&raw, &mut 0).is_none(), "{raw}");
    }
}

#[test]
fn body_resends_linear_verbatim_and_spells_slack_like_the_daemon() {
    let base = json!({
        "slackChannels": ["C1"],
        "linearTeam": "T1",
        "linearTeamName": "Platform",
        "linearStateMappings": {"T1": {"inProgress": {"id":"S1","name":"Doing"}}}
    });
    let mut s = slack(base.clone());
    s.channels.push(Channel {
        id: "C0123ABCD".into(),
        name: Some(" #Ünïcode ".into()),
        mention_only: true,
    });
    s.groups = " @Support,  oncall @support ".into();
    s.labels.push(Label {
        key: 9,
        name: "  Team\tA ".into(),
        description: " Owned by A ".into(),
        effect: Effect::Hide,
    });
    s.labels.push(Label {
        key: 10,
        name: " ".into(),
        description: String::new(),
        effect: Effect::Close,
    });
    let normal = s.normal();
    assert_eq!(
        body(&base, &normal),
        json!({
            "linearTeam": "T1",
            "linearTeamName": "Platform",
            "linearStateMappings": {"T1": {"inProgress": {"id":"S1","name":"Doing"}}},
            "slackChannels": ["C1", "C0123ABCD"],
            "slackChannelNames": {"C0123ABCD": "Ünïcode"},
            "slackMentionOnlyChannels": ["C0123ABCD"],
            "slackGroupHandles": ["support", "oncall"],
            "slackLabels": [{"name":"Team A","description":"Owned by A","effect":"hide"}]
        })
    );
    let saved = body(&base, &normal);
    assert!(stored(&saved, &base, &normal));
    let mut changed = saved.clone();
    changed["linearTeam"] = json!("T2");
    assert!(
        !stored(&changed, &base, &normal),
        "Linear must come back unchanged"
    );
    // Removing everything leaves only the required channel list.
    assert_eq!(
        body(&json!(null), &Slack::default().normal()),
        json!({"slackChannels": []})
    );
}

#[test]
fn validation_mirrors_daemon_limits() {
    let mut s = Slack::default();
    assert!(s.problem().is_none());
    s.groups = "@here".into();
    assert!(s.groups_problem().is_some());
    s.groups = "@sup port".into();
    assert!(s.groups_problem().is_none(), "spaces separate handles");
    s.groups = "@ops/team".into();
    assert!(s.groups_problem().is_some());
    s.groups.clear();
    s.labels = vec![
        Label {
            key: 1,
            name: "Bug".into(),
            description: String::new(),
            effect: Effect::None,
        },
        Label {
            key: 2,
            name: " Bug ".into(),
            description: String::new(),
            effect: Effect::None,
        },
        Label {
            key: 3,
            name: String::new(),
            description: "orphan".into(),
            effect: Effect::None,
        },
        Label {
            key: 4,
            name: "é".repeat(81),
            description: String::new(),
            effect: Effect::None,
        },
        Label {
            key: 5,
            name: "👩‍💻".repeat(11),
            description: String::new(),
            effect: Effect::None,
        },
    ];
    assert_eq!(s.label_problem(2), Some("Another label has this name."));
    assert_eq!(s.label_problem(3), Some("Name this label."));
    assert_eq!(s.label_problem(4), Some("Use a shorter name."));
    // 11 × 5 UTF-16 units = 55: within the daemon's JavaScript length limit.
    assert_eq!(s.label_problem(5), None);
    assert!(s.problem().is_some());
}

#[test]
fn source_and_lookup_read_only_this_project() {
    let list = json!([
        {"projectId":"other","kind":"slack","status":"error","error":"x"},
        {"projectId":"p","kind":"linear","status":"ok"},
        {"projectId":"p","kind":"slack","status":"sign_in_required","signInCommand":"pi mcp login slack",
         "channels":[{"id":"C1","status":"error","error":"not_in_channel\n"},{"id":"C2","status":"pending"}]}
    ]);
    let s = Source::read(&list, "p").unwrap();
    assert_eq!(s.status, "sign_in_required");
    assert_eq!(s.sign_in_command.as_deref(), Some("pi mcp login slack"));
    assert_eq!(
        s.channel("C1").unwrap().error.as_deref(),
        Some("not_in_channel")
    );
    assert_eq!(s.channel("C2").unwrap().status, "pending");
    assert!(Source::read(&list, "missing").is_none());

    assert_eq!(
        Lookup::read(
            &json!({"status":"ok","items":[{"id":"C9","name":"ops","private":true},{"id":"","name":"x"}],"more":true})
        ),
        Lookup::Found {
            items: vec![ChannelOption {
                id: "C9".into(),
                name: "ops".into(),
                private: true
            }],
            more: true
        }
    );
    assert_eq!(
        Lookup::read(&json!({"status":"sign_in_required","items":[]})),
        Lookup::SignIn
    );
    assert_eq!(
        Lookup::read(&json!({"status":"error","items":[]})),
        Lookup::Failed("Couldn't reach Slack.".into())
    );
}
