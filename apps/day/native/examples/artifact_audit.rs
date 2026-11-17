//! Runs every saved NSH artifact revision under a sessions folder through the publish-time check
//! (`artifact_check`: headless, Day's kit, policy and limits) and prints the result. Reads only.
//! Usage: cargo run --release --locked --example artifact_audit -- ~/.local/share/pilot/sessions
//! Use --release: a debug build's interpreter frames are larger, so big mocks overflow its stack.
use pilot_day_native::{artifact_check, artifact_source::compile_source};

fn main() {
    let root = std::env::args().nth(1).expect("sessions folder");
    let mut files = Vec::new();
    for session in std::fs::read_dir(&root).expect("sessions folder").flatten() {
        let Ok(artifacts) = std::fs::read_dir(session.path().join("artifacts")) else {
            continue;
        };
        for artifact in artifacts.flatten() {
            let Ok(revisions) = std::fs::read_dir(artifact.path()) else {
                continue;
            };
            for revision in revisions.flatten() {
                let name = revision.file_name().to_string_lossy().to_string();
                if name.ends_with(".json") && name != "latest.json" {
                    files.push(revision.path());
                }
            }
        }
    }
    files.sort();
    for path in files {
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        if value["kind"] != "nsh" {
            continue;
        }
        let source = value["source"].as_str().unwrap_or_default();
        let outcome = compile_source(source, "Artifact.tsx")
            .and_then(artifact_check::run)
            .map_or_else(
                |error| format!("FAIL {error}"),
                |shown| match shown.no_room_count {
                    0 => format!("OK {} texts", shown.texts),
                    n => format!(
                        "NO ROOM {n} of {} texts: {:?}",
                        n + shown.texts,
                        shown.no_room
                    ),
                },
            );
        println!(
            "{} r{} {:?}\n    {outcome}",
            value["id"].as_str().unwrap_or_default(),
            value["revision"],
            value["title"].as_str().unwrap_or_default()
        );
    }
}
