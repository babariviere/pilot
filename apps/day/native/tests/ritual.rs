//! Isolated disk/worker tests. No provider, live profile or native window.
use pilot_day_native::{
    contract::Home,
    host::{
        Error, NativeHost, Source,
        ritual::{DaySource, LocalDay},
    },
    model::{DayPart, Visit},
    ritual::{RitualAvailability, RitualKind, RitualMark, RitualVisit, RitualWrite},
};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

struct Fixture {
    root: PathBuf,
    source: Source,
    clock: Arc<Mutex<Result<LocalDay, Error>>>,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("day-ritual-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        Self {
            source: Source {
                profile: root.clone(),
                port: 1,
                home: Home {
                    daemon_id: "daemon-a".into(),
                    lineage_id: "lineage-a".into(),
                },
                project_id: "project-a".into(),
                project_path: root.to_str().unwrap().into(),
            },
            root,
            clock: Arc::new(Mutex::new(Ok(LocalDay {
                date: "2026-11-10".into(),
                time_zone: "Europe/Paris".into(),
                hour: 9,
                unix_ms: 1000,
            }))),
        }
    }
    fn open(&self) -> NativeHost {
        self.open_user(unsafe { libc::geteuid() })
    }
    fn open_user(&self, user_id: u32) -> NativeHost {
        let clock = self.clock.clone();
        NativeHost::open_day(
            self.source.clone(),
            self.root.join("native.ledger"),
            DaySource {
                user_id,
                clock: Arc::new(move || clock.lock().unwrap().clone()),
            },
        )
        .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
fn reply<T>(rx: async_channel::Receiver<Result<T, Error>>) -> Result<T, Error> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            tokio::time::timeout(Duration::from_secs(10), rx.recv())
                .await
                .expect("worker deadline")
                .map_err(|_| Error::Unknown)?
        })
}
fn write(host: &NativeHost, ritual: RitualKind, mark: RitualMark, step: u32) -> RitualWrite {
    let v = host.ritual_snapshot();
    RitualWrite {
        context: v.context,
        revision: v.revision,
        ritual,
        mark,
        step,
    }
}

#[test]
fn explicit_marks_resume_and_visits_survive_cold_reopen_but_reads_and_escape_do_not_write() {
    let f = Fixture::new();
    let h = f.open();
    reply(h.read_ritual()).unwrap();
    let first = h.ritual_snapshot();
    assert_eq!(first.availability, RitualAvailability::Available);
    assert_eq!(first.visit, Visit::Unknown);
    assert_eq!(h.snapshot().part, DayPart::Morning);
    assert_eq!(
        std::fs::metadata(f.root.join("native.ledger"))
            .unwrap()
            .len(),
        0,
        "read/Escape have no persistence effect"
    );
    reply(h.save_ritual(write(&h, RitualKind::Start, RitualMark::Unmarked, 2))).unwrap();
    let v = h.ritual_snapshot();
    reply(h.visit_day(RitualVisit {
        context: v.context,
        revision: v.revision,
    }))
    .unwrap();
    reply(h.close()).unwrap();
    let h = f.open();
    reply(h.read_ritual()).unwrap();
    let v = h.ritual_snapshot();
    assert_eq!(v.start.step, 2);
    assert_eq!(
        v.start.mark,
        RitualMark::Unmarked,
        "resume is not completion"
    );
    assert_eq!(v.visit, Visit::Returning);
    assert_eq!(v.last_looked_at, "1000");
    assert_ne!(
        v.context, first.context,
        "old window intents cannot target a reopened host"
    );
    reply(h.save_ritual(write(&h, RitualKind::Start, RitualMark::Done, 2))).unwrap();
    reply(h.save_ritual(write(&h, RitualKind::End, RitualMark::Skipped, 0))).unwrap();
    reply(h.close()).unwrap();
    let h = f.open();
    reply(h.read_ritual()).unwrap();
    assert_eq!(h.ritual_snapshot().start.mark, RitualMark::Done);
    assert_eq!(h.ritual_snapshot().end.mark, RitualMark::Skipped);
    reply(h.close()).unwrap();
}

#[test]
fn date_zone_profile_and_user_transitions_are_fenced() {
    let mut f = Fixture::new();
    let h = f.open();
    reply(h.read_ritual()).unwrap();
    let stale = write(&h, RitualKind::Start, RitualMark::Done, 2);
    reply(h.save_ritual(write(&h, RitualKind::Start, RitualMark::Skipped, 0))).unwrap();
    *f.clock.lock().unwrap() = Ok(LocalDay {
        date: "2026-11-11".into(),
        time_zone: "Europe/Paris".into(),
        hour: 17,
        unix_ms: 2000,
    });
    assert_eq!(reply(h.save_ritual(stale)), Err(Error::Stale));
    let v = h.ritual_snapshot();
    assert_eq!(v.start.mark, RitualMark::Unmarked);
    assert_eq!(v.part, DayPart::Evening);
    let stale = write(&h, RitualKind::Start, RitualMark::Done, 2);
    f.clock.lock().unwrap().as_mut().unwrap().time_zone = "America/New_York".into();
    assert_eq!(reply(h.save_ritual(stale)), Err(Error::Stale));
    reply(h.close()).unwrap();
    // Same ledger, new explicit profile. Neither visits nor marks cross identities.
    f.source.profile = f.root.join("other-profile");
    let h = f.open();
    reply(h.read_ritual()).unwrap();
    assert_eq!(h.ritual_snapshot().start.mark, RitualMark::Unmarked);
    assert_eq!(h.ritual_snapshot().visit, Visit::Unknown);
    reply(h.close()).unwrap();
    f.source.home.lineage_id = "another-lineage".into();
    let h = f.open();
    reply(h.read_ritual()).unwrap();
    assert_eq!(h.ritual_snapshot().start.mark, RitualMark::Unmarked);
    assert_eq!(h.ritual_snapshot().visit, Visit::Unknown);
    reply(h.close()).unwrap();
    let h = f.open_user(unsafe { libc::geteuid() }.wrapping_add(1));
    assert_eq!(reply(h.read_ritual()), Err(Error::Identity));
    assert_eq!(
        h.ritual_snapshot().availability,
        RitualAvailability::Unavailable
    );
    reply(h.close()).unwrap();
}

#[test]
fn unavailable_clock_offline_sources_and_lost_write_never_fabricate_persistence() {
    let f = Fixture::new();
    let h = f.open();
    reply(h.read_ritual()).unwrap();
    assert_eq!(
        h.ritual_snapshot().results_availability,
        RitualAvailability::Unavailable
    );
    assert!(
        reply(h.read_ritual_results()).is_err(),
        "no daemon is a known unavailable source, never empty success"
    );
    reply(h.save_ritual(write(&h, RitualKind::Start, RitualMark::Unmarked, 1))).unwrap();
    // Append behind the single writer to model a changed file/uncertain write boundary.
    use std::io::Write;
    std::fs::OpenOptions::new()
        .append(true)
        .open(f.root.join("native.ledger"))
        .unwrap()
        .write_all(b"\n")
        .unwrap();
    assert_eq!(
        reply(h.save_ritual(write(&h, RitualKind::Start, RitualMark::Done, 2))),
        Err(Error::Unknown)
    );
    assert_eq!(
        h.ritual_snapshot().availability,
        RitualAvailability::Unknown
    );
    assert_eq!(h.ritual_snapshot().start.mark, RitualMark::Unmarked);
    assert_eq!(
        reply(h.read_ritual()),
        Err(Error::Unknown),
        "same poisoned writer cannot convert RAM to saved"
    );
    assert_eq!(
        reply(h.close()),
        Err(Error::Storage),
        "safe close reports the unresolved storage failure"
    );
    let h = f.open();
    reply(h.read_ritual()).unwrap();
    assert_eq!(
        h.ritual_snapshot().start.mark,
        RitualMark::Unmarked,
        "cold lookup does not resend the lost Done"
    );
    assert_eq!(h.ritual_snapshot().start.step, 1);
    *f.clock.lock().unwrap() = Err(Error::Unavailable);
    assert_eq!(reply(h.read_ritual()), Err(Error::Unavailable));
    assert_eq!(h.ritual_snapshot().visit, Visit::Unknown);
    reply(h.close()).unwrap();
}

#[test]
fn an_admitted_local_save_drains_before_safe_close() {
    let f = Fixture::new();
    let h = f.open();
    reply(h.read_ritual()).unwrap();
    let save = h.save_ritual(write(&h, RitualKind::End, RitualMark::Done, 0));
    // A close may refuse not-yet-entered work; it must never claim that it was saved.
    let close = h.close();
    let result = reply(save);
    reply(close).unwrap();
    let h = f.open();
    reply(h.read_ritual()).unwrap();
    assert_eq!(
        h.ritual_snapshot().end.mark == RitualMark::Done,
        result.is_ok()
    );
    reply(h.close()).unwrap();
    assert_eq!(reply(h.read_ritual()), Err(Error::Closed));
}

#[test]
fn root_clock_tick_refreshes_an_idle_host_without_a_visit_or_write() {
    let f = Fixture::new();
    let h = f.open();
    // Wait for the initial automatic tick, not a request that could race it.
    let changes = h.changes();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            tokio::time::timeout(Duration::from_secs(10), async {
                while h.ritual_snapshot().availability != RitualAvailability::Available {
                    changes.recv().await.unwrap();
                }
            })
            .await
            .unwrap();
        });
    let context = h.ritual_snapshot().context;
    *f.clock.lock().unwrap() = Ok(LocalDay {
        date: "2026-11-11".into(),
        time_zone: "America/New_York".into(),
        hour: 19,
        unix_ms: 90_000_000,
    });
    let changes = h.changes();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            tokio::time::timeout(Duration::from_secs(40), async {
                while h.ritual_snapshot().context == context {
                    changes.recv().await.unwrap();
                }
            })
            .await
            .expect("native clock tick refreshes even without VM reads or focus events");
        });
    let now = h.ritual_snapshot();
    assert_eq!(now.date, "2026-11-11");
    assert_eq!(now.time_zone, "America/New_York");
    assert_eq!(now.part, DayPart::Evening);
    assert_eq!(
        std::fs::metadata(f.root.join("native.ledger"))
            .unwrap()
            .len(),
        0
    );
    reply(h.close()).unwrap();
}
