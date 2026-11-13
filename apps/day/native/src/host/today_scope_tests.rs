use super::*;
use crate::{
    contract::{Dashboard, NeedsYouItem, Section},
    model::{Decision, HumanAction},
};

fn request(scope: &str, generation: u64) -> Request {
    Request {
        scope: scope.into(),
        generation,
    }
}

fn overview() -> DayOverview {
    DayOverview {
        version: 1,
        project_id: "one".into(),
        observed_at: 1000,
        complete: true,
        dashboard: Dashboard {
            needs_you: Some(Section::default()),
            ..Dashboard::default()
        },
        reports: Vec::new(),
        controls: Vec::new(),
    }
}

#[test]
fn scope_generation_fences_entered_and_queued_replies_without_retargeting() {
    let mut gate = Gate::default();
    let first = request("all", 1);
    first.select(&mut gate).unwrap();
    assert!(first.includes("one") && first.includes("two"));
    let later = request("two", 2);
    later.select(&mut gate).unwrap();
    assert!(later.includes("two") && !later.includes("one"));
    assert_eq!(first.current(&gate), Err(Error::Stale));
    assert_eq!(first.select(&mut gate), Err(Error::Stale));
    assert_eq!(request("one", 2).select(&mut gate), Err(Error::Stale));
    assert!(later.current(&gate).is_ok());
    gate.sealed = true;
    assert_eq!(later.current(&gate), Err(Error::Closed));
}

#[test]
fn scope_requests_reject_transport_or_unsafe_generations() {
    for (scope, generation) in [
        ("../two", 1),
        ("http://other", 1),
        ("all", 0),
        ("one", 9_007_199_254_740_992),
    ] {
        assert_eq!(request(scope, generation).validate(), Err(Error::Invalid));
    }
    assert!(
        serde_json::from_value::<Request>(json!({"scope":"one","generation":1,"port":123}))
            .is_err()
    );
}

#[test]
fn foreign_or_unreadable_attention_never_becomes_a_relabelled_empty_read() {
    let mut read = json!({"questions":[{"scope":{"projectId":"two","subject":{"kind":"question","sessionId":"chat","entryId":1},"contentDigest":"digest"},"session":{"id":"chat"}}],"actions":[]});
    assert_eq!(
        scoped_attention(read.clone(), "one", true),
        Err(Error::Identity)
    );
    read["questions"][0]["scope"]["projectId"] = json!("one");
    assert!(scoped_attention(read.clone(), "one", true).is_ok());
    read["questions"][0]["scope"]["contentDigest"] = Value::Null;
    assert_eq!(scoped_attention(read, "one", true), Err(Error::Invalid));
    let read = json!({"questions":[],"actions":[{"record":{"content":{"projectId":"two"}}}]});
    assert_eq!(scoped_attention(read, "one", true), Err(Error::Identity));
}

#[test]
fn outside_counts_never_turn_an_unknown_project_into_zero() {
    let mut rows = vec![
        json!({"selected":true,"needsYou":needs(Some(99))}),
        json!({"selected":false,"needsYou":needs(Some(2))}),
        json!({"selected":false,"needsYou":needs(Some(0))}),
    ];
    assert_eq!(outside(&rows), json!({"count":2,"complete":true}));
    rows[2]["needsYou"] = needs(None);
    assert_eq!(outside(&rows), json!({"count":null,"complete":false}));
    assert_eq!(outside(&rows[..1]), json!({"count":0,"complete":true}));
}

#[test]
fn needs_count_requires_complete_current_attention_and_host_problems() {
    let mut overview = overview();
    let mut read = json!({"current":true,"questions":[]});
    let today = Today {
        decisions: vec![Decision::default()],
        actions: vec![HumanAction::default()],
        ..Today::default()
    };
    assert_eq!(count(Some(&overview), Some(&read), &today, true), Some(2));
    assert_eq!(count(Some(&overview), Some(&read), &today, false), None);
    assert_eq!(count(Some(&overview), None, &today, true), None);
    read["current"] = json!(false);
    assert_eq!(count(Some(&overview), Some(&read), &today, true), None);
    read["current"] = json!(true);
    overview.dashboard.needs_you.as_mut().unwrap().total = 1;
    assert_eq!(count(Some(&overview), Some(&read), &today, true), None);
    overview.dashboard.needs_you = None;
    assert_eq!(count(Some(&overview), Some(&read), &today, true), None);
}

#[test]
fn question_cards_and_their_host_ask_are_one_need_other_failures_are_separate() {
    let mut overview = overview();
    let mut ask = NeedsYouItem {
        id: "ask".into(),
        session_id: Some("chat".into()),
        ..NeedsYouItem::default()
    };
    ask.attention_reason.kind = "asks".into();
    let mut failure = ask.clone();
    failure.id = "failed".into();
    failure.attention_reason.kind = "failure".into();
    overview.dashboard.needs_you = Some(Section {
        total: 2,
        items: vec![ask, failure],
    });
    let read = json!({"current":true,"questions":[{"session":{"id":"chat"}}]});
    let today = Today {
        decisions: vec![Decision::default()],
        ..Today::default()
    };
    assert_eq!(count(Some(&overview), Some(&read), &today, true), Some(2));
}

#[test]
fn project_labels_cover_each_section_without_fabricating_unavailable_sections() {
    let project = json!({"projectId":"two","name":"Second"});
    let mut row = json!({"today":{"moving":[{"id":"mission"}],"decisions":[{"id":"question"}],
        "intake":{"requests":[{"id":"request"}]}},"planning":{"plans":[{"missionId":"plan"}]},
        "intake":null,"results":null});
    label_sections(&mut row, &project);
    assert_eq!(row["today"]["moving"][0]["projectId"], "two");
    assert_eq!(row["today"]["decisions"][0]["projectName"], "Second");
    assert_eq!(row["today"]["intake"]["requests"][0]["projectId"], "two");
    assert_eq!(row["planning"]["plans"][0]["projectId"], "two");
    assert!(row["intake"].is_null() && row["results"].is_null());
}

#[test]
fn project_transport_shares_identity_but_never_retains_model_or_action_selection() {
    let source = Source {
        profile: "/synthetic-profile".into(),
        port: 1,
        home: crate::contract::Home {
            daemon_id: "daemon".into(),
            lineage_id: "lineage".into(),
        },
        project: Some(crate::host::Project {
            project_id: "one".into(),
            project_path: "/one".into(),
        }),
    };
    let mut root = Transport::new(source.clone()).unwrap();
    root.planning_model = Some("never-select-this".into());
    root.controls.store(true, Ordering::SeqCst);
    let selected =
        selected_transport(&root, &json!({"projectId":"two","projectPath":"/two"})).unwrap();
    assert_eq!(root.source, source, "scope cannot retarget the root");
    assert_eq!(selected.source.project().unwrap().project_id, "two");
    assert_eq!(selected.source.profile, source.profile);
    assert_eq!(selected.source.port, source.port);
    assert_eq!(selected.source.home, source.home);
    assert!(selected.planning_model.is_none());
    assert!(!selected.controls.load(Ordering::SeqCst));
    assert!(!same_project(&root.source, &selected.source));
}

/// A synthetic local HTTP peer, not a daemon, provider or integration.
struct Peer {
    path: std::path::PathBuf,
    transport: Transport,
    calls: Arc<Mutex<Vec<(String, Value)>>>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Peer {
    fn new(deny_two: bool, change_catalog: bool) -> Self {
        use std::{
            io::{BufRead, BufReader, Read, Write},
            os::unix::fs::OpenOptionsExt,
        };
        let path = std::env::temp_dir().join(format!("today-scope-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        std::fs::write(path.join("daemon-id"), "daemon").unwrap();
        std::fs::write(path.join("storage-lineage"), "lineage").unwrap();
        let mut token = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path.join("github-app-capability"))
            .unwrap();
        write!(
            token,
            "{}",
            json!({"daemonId":"daemon","lineageId":"lineage","token":"a".repeat(64)})
        )
        .unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let log = calls.clone();
        let thread = std::thread::spawn(move || {
            let mut inventories = 0;
            for stream in listener.incoming() {
                let mut stream = stream.unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut first = String::new();
                reader.read_line(&mut first).unwrap();
                let route = first.split_whitespace().nth(1).unwrap_or("").to_owned();
                if route == "/stop" {
                    break;
                }
                let mut size = 0;
                let mut authorized = false;
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" {
                        break;
                    }
                    let lower = line.to_lowercase();
                    if lower.starts_with("content-length:") {
                        size = line.split(':').nth(1).unwrap().trim().parse().unwrap();
                    }
                    if lower.starts_with("x-pilot-github-capability:") {
                        authorized = line.contains(&"a".repeat(64));
                    }
                }
                let mut body = vec![0; size];
                reader.read_exact(&mut body).unwrap();
                let body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
                log.lock().unwrap().push((
                    format!("{} {route}", first.split_whitespace().next().unwrap()),
                    body.clone(),
                ));
                let mut status = 200;
                let value = if !authorized {
                    status = 403;
                    json!({})
                } else if route == "/api/hello" {
                    json!({"daemonId":"daemon","lineageId":"lineage","minimumClientProtocolVersion":1,"protocolVersion":1,
                        "capabilities":{"independentExecution":true,"dayOverview":1,"nativeAttention":1}})
                } else if route == "/api/native-projects" {
                    inventories += 1;
                    json!({"version":1,"complete":true,"projects":[
                        {"projectId":"one","projectPath":"/one","name":"One","contextDigest":"a".repeat(64)},
                        {"projectId":"two","projectPath":"/two","name":if change_catalog && inventories>1 {"Changed"} else {"Two"},"contextDigest":"b".repeat(64)}]})
                } else if route == "/api/native-attention" {
                    assert_eq!(
                        body["kind"], "read",
                        "only passive native attention may POST"
                    );
                    json!({"ok":true,"value":{"version":1,"projectId":body["projectId"],"questions":[],"actions":[]}})
                } else {
                    let project = route.split('/').nth(3).unwrap_or("");
                    if deny_two && project == "two" {
                        status = 403;
                        json!({})
                    } else if route.ends_with("/planning-inventory") {
                        json!({"version":1,"status":"available","projectId":project,"limit":100,"total":0,"items":[]})
                    } else if route.ends_with("/day") {
                        let mut v = overview();
                        v.project_id = project.into();
                        v.dashboard.missions = Section {
                            total: 1,
                            items: vec![crate::contract::DashboardMission {
                                id: format!("mission-{project}"),
                                title: format!("Mission {project}"),
                                ..Default::default()
                            }],
                        };
                        let mut value = serde_json::to_value(v).unwrap();
                        value["dashboard"]["projectId"] = json!(project);
                        value
                    } else if route.ends_with("/intake") {
                        status = 503;
                        json!({})
                    } else if route.ends_with("/delivered-work") {
                        json!({"version":1,"projectId":project,"baseline":{"mode":"start_fresh","sourceSequence":5},
                            "sourceCursor":5,"complete":true,"more":false,"nextCursor":null,"currentness":"live","items":[]})
                    } else {
                        json!({"id":project,"path":format!("/{project}")})
                    }
                };
                let data = value.to_string();
                write!(stream,"HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{data}",data.len()).unwrap();
            }
        });
        let transport = Transport::new(Source {
            profile: path.clone(),
            port,
            home: crate::contract::Home {
                daemon_id: "daemon".into(),
                lineage_id: "lineage".into(),
            },
            project: Some(crate::host::Project {
                project_id: "one".into(),
                project_path: "/one".into(),
            }),
        })
        .unwrap();
        Self {
            path,
            transport,
            calls,
            thread: Some(thread),
        }
    }
}
impl Drop for Peer {
    fn drop(&mut self) {
        use std::io::Write;
        let mut socket =
            std::net::TcpStream::connect(("127.0.0.1", self.transport.source.port)).unwrap();
        write!(socket, "GET /stop HTTP/1.1\r\n\r\n").unwrap();
        self.thread.take().unwrap().join().unwrap();
        std::fs::remove_dir_all(&self.path).unwrap();
    }
}

#[tokio::test]
async fn scope_read_checks_configured_access_and_never_sends_work_or_changes_source() {
    let peer = Peer::new(false, false);
    let journal = Journal::open(peer.path.join("journal")).unwrap();
    let source = peer.transport.source.clone();
    let read = read_projects(&peer.transport, &journal, &request("one", 1), true, || {
        Ok(())
    })
    .await
    .unwrap();
    let projects = read["projects"].as_array().unwrap();
    assert_eq!(projects[0]["today"]["unreported"][0]["id"], "mission-one");
    assert_eq!(projects[0]["today"]["unreported"][0]["projectName"], "One");
    assert!(projects[1]["today"].is_null() && projects[1]["planning"].is_null());
    assert_eq!(read["outsideNeedsYou"]["count"], 0);
    assert!(!read["complete"].as_bool().unwrap());
    assert_eq!(projects[0]["results"]["complete"], true);
    assert_eq!(projects[0]["results"]["baseline"]["mode"], "start_fresh");
    assert_eq!(projects[0]["errors"]["intake"], "Unavailable");
    assert_eq!(peer.transport.source, source);
    assert_eq!(
        std::fs::metadata(peer.path.join("journal")).unwrap().len(),
        0
    );
    assert!(
        peer.calls
            .lock()
            .unwrap()
            .iter()
            .all(|(path, body)| path.starts_with("GET ")
                || (path == "POST /api/native-attention" && body["kind"] == "read"))
    );
    assert!(
        !peer
            .calls
            .lock()
            .unwrap()
            .iter()
            .any(|(path, _)| path == "GET /api/projects/two/intake")
    );
    let all = read_projects(&peer.transport, &journal, &request("all", 2), true, || {
        Ok(())
    })
    .await
    .unwrap();
    assert_eq!(
        all["projects"][1]["today"]["unreported"][0]["projectId"],
        "two"
    );
    let offline = read_projects(&peer.transport, &journal, &request("one", 3), false, || {
        Ok(())
    })
    .await
    .unwrap();
    assert!(offline["outsideNeedsYou"]["count"].is_null());
    let before = peer.calls.lock().unwrap().len();
    assert_eq!(
        read_projects(
            &peer.transport,
            &journal,
            &request("not-configured", 4),
            true,
            || Ok(())
        )
        .await,
        Err(Error::Invalid)
    );
    assert!(
        peer.calls.lock().unwrap()[before..]
            .iter()
            .all(|(path, _)| path == "GET /api/hello" || path == "GET /api/native-projects")
    );
    // A newer scope admitted while canonical reads were entered fences the
    // earlier reply before any rows can escape. No sleeps or timing race.
    let gate = Mutex::new(Gate::default());
    let first = request("all", 5);
    first.select(&mut gate.lock().unwrap()).unwrap();
    let checks = std::cell::Cell::new(0);
    let result = read_projects(&peer.transport, &journal, &first, true, || {
        checks.set(checks.get() + 1);
        let mut gate = gate.lock().unwrap();
        if checks.get() == 3 {
            request("two", 6).select(&mut gate)?;
        }
        first.current(&gate)
    })
    .await;
    assert_eq!(result, Err(Error::Stale));
}

#[tokio::test]
async fn global_startup_reads_catalog_without_choosing_a_project_or_model() {
    let mut peer = Peer::new(false, false);
    peer.transport.source.project = None;
    let source = peer.transport.source.clone();
    let journal = Journal::open(peer.path.join("journal")).unwrap();
    peer.transport.profile_gate().await.unwrap();
    assert_eq!(peer.transport.gate(false).await, Err(Error::Unavailable));
    assert_eq!(
        peer.transport.planning_profile().await,
        Err(Error::Unavailable)
    );
    let read = read_projects(&peer.transport, &journal, &request("all", 1), true, || {
        Ok(())
    })
    .await
    .unwrap();
    assert_eq!(
        read["projects"][0]["today"]["unreported"][0]["id"],
        "mission-one"
    );
    assert_eq!(
        read["projects"][1]["today"]["unreported"][0]["id"],
        "mission-two"
    );
    assert!(
        read["projects"]
            .as_array()
            .unwrap()
            .iter()
            .all(|p| p["selected"] == true && p["canAct"] == false)
    );
    assert_eq!(source, peer.transport.source);
    assert!(peer.transport.planning_model.is_none());
    assert!(
        peer.calls
            .lock()
            .unwrap()
            .iter()
            .all(|(path, body)| path.starts_with("GET ")
                || (path == "POST /api/native-attention" && body["kind"] == "read"))
    );
}

#[test]
fn optional_project_keeps_legacy_source_bytes_and_global_window_identity() {
    let old = json!({"profile":"/profile","port":1234,"home":{"daemonId":"daemon","lineageId":"lineage"},
        "project_id":"one","project_path":"/one"});
    let selected: Source = serde_json::from_value(old.clone()).unwrap();
    assert_eq!(serde_json::to_value(&selected).unwrap(), old);
    assert_eq!(
        serde_json::to_string(&selected).unwrap(),
        r#"{"profile":"/profile","port":1234,"home":{"daemonId":"daemon","lineageId":"lineage"},"project_id":"one","project_path":"/one"}"#,
        "existing saved-window hashes and operation sources must keep their bytes"
    );
    let mut global = selected.clone();
    global.project = None;
    let value = serde_json::to_value(&global).unwrap();
    assert!(value.get("project_id").is_none());
    assert_eq!(serde_json::from_value::<Source>(value).unwrap(), global);
    assert_eq!(global.project(), Err(Error::Unavailable));
    assert_ne!(
        super::super::window::SavedWindow::key(&global).unwrap(),
        super::super::window::SavedWindow::key(&selected).unwrap()
    );
}

#[tokio::test]
async fn global_saved_chat_results_follow_the_explicit_effect_project() {
    let peer = Peer::new(false, false);
    let mut global = peer.transport.source.clone();
    global.project = None;
    let draft = uuid::Uuid::new_v4().to_string();
    let mut record = super::super::planning::record(&global, draft.clone(), "b".repeat(64),
        json!({"purpose":"native-chat-create","draftId":draft,"projectId":"two","projectPath":"/two",
            "contextDigest":"b".repeat(64),"mode":"build","model":"faux/faux","thinking":"medium","message":"Draft"})).unwrap();
    // The subject projection only consumes these fields. Journal receipt
    // validation has its own exact-envelope coverage before production reads.
    record.receipt = Some(json!({"state":"accepted","result":{"sessionId":"global-chat"}}));
    let mut journal = Journal::open(peer.path.join("journal")).unwrap();
    journal.planning.insert(record.id().into(), record);
    let one = results(&peer.transport, &journal).await;
    assert_eq!(one["items"].as_array().unwrap().len(), 0);
    let two = selected_transport(
        &peer.transport,
        &json!({"projectId":"two","projectPath":"/two"}),
    )
    .unwrap();
    let two = results(&two, &journal).await;
    assert_eq!(
        two["items"][0]["subject"],
        json!({"kind":"chat","projectId":"two","sessionId":"global-chat"})
    );
    assert_eq!(
        two["complete"], false,
        "unreadable saved delivery is kept as unknown"
    );
    assert_eq!(two["items"][0]["currentness"], "unavailable");
}

#[tokio::test]
async fn denied_project_and_changed_catalog_never_publish_earlier_rows_as_current() {
    let peer = Peer::new(true, false);
    let journal = Journal::open(peer.path.join("journal")).unwrap();
    let read = read_projects(&peer.transport, &journal, &request("all", 1), true, || {
        Ok(())
    })
    .await
    .unwrap();
    assert!(read["projects"][1]["today"].is_null());
    assert!(read["projects"][1]["needsYou"]["count"].is_null());
    drop(journal);
    drop(peer);
    let peer = Peer::new(false, true);
    let journal = Journal::open(peer.path.join("journal")).unwrap();
    assert_eq!(
        read_projects(&peer.transport, &journal, &request("all", 1), true, || Ok(
            ()
        ))
        .await,
        Err(Error::Stale)
    );
}
