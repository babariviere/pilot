//! NSH presentation over the same literal scanner and paginated Local reader.
use super::ReaderKey;
use crate::local_client::Presentation;
use crate::transcript_view::transcript_find as scanner;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FindTarget {
    pub key: ReaderKey,
    pub source: Arc<String>,
    /// Exact UTF-8 source offsets, never rendered-text or UTF-16 offsets.
    pub range: std::ops::Range<usize>,
}
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FindSnapshot {
    pub open: bool,
    pub query: String,
    pub status: String,
    pub coverage: String,
    pub busy: bool,
    pub loading: bool,
    pub count: usize,
    pub active: usize,
    pub target: Option<FindTarget>,
    /// Changes only for an explicit query/navigation, not a data publication.
    pub navigation: u64,
}
struct Scan {
    revision: u64,
    rows: Vec<crate::model::Message>,
    query: String,
    cancel: Arc<AtomicBool>,
    navigate: bool,
}
pub(super) struct Reply {
    revision: u64,
    result: scanner::Results,
    navigate: bool,
}
pub(super) struct Find {
    pub open: bool,
    pub query: String,
    pub loading: bool,
    pub cancelled: bool,
    busy: bool,
    revision: u64,
    navigation: u64,
    active: usize,
    result: scanner::Results,
    sources: Vec<(crate::model::ReaderKey, Arc<String>)>,
    cancel: Arc<AtomicBool>,
    send: Option<async_channel::Sender<Scan>>,
    queued: async_channel::Receiver<Scan>,
}
impl Drop for Find {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Relaxed);
        self.send.take();
        self.queued.close();
    }
}
impl Find {
    pub fn new() -> (Self, async_channel::Receiver<Reply>) {
        let (send, queued) = async_channel::bounded::<Scan>(1);
        let worker = queued.clone();
        let (replies, receive) = async_channel::bounded(1);
        let discard = receive.clone();
        std::thread::spawn(move || {
            while let Ok(scan) = worker.recv_blocking() {
                let result = scanner::scan(scan.rows, &scan.query, &scan.cancel);
                if scan.cancel.load(Ordering::Relaxed) {
                    continue;
                }
                // Coalesce completed scans as well as queued work.
                let _ = discard.try_recv();
                let _ = replies.try_send(Reply {
                    revision: scan.revision,
                    result,
                    navigate: scan.navigate,
                });
            }
        });
        (
            Self {
                open: false,
                query: String::new(),
                loading: false,
                cancelled: false,
                busy: false,
                revision: 0,
                navigation: 0,
                active: 0,
                result: Default::default(),
                sources: Vec::new(),
                cancel: Arc::new(AtomicBool::new(false)),
                send: Some(send),
                queued,
            },
            receive,
        )
    }
    pub fn invalidate(&mut self) {
        self.cancel.store(true, Ordering::Relaxed);
        self.revision += 1;
        self.sources.clear();
        self.result = Default::default();
        self.busy = false;
        self.cancelled = self.loading;
        self.loading = false;
    }
    pub fn reset(&mut self) {
        self.invalidate();
        self.open = false;
        self.query.clear();
        self.cancelled = false;
    }
    pub fn refresh(&mut self, read: &Presentation, navigate: bool) {
        if !self.open {
            return;
        }
        let sources: Vec<_> = read
            .rows
            .iter()
            .filter(|r| scanner::eligible(r))
            .map(|r| (r.reader_key().unwrap(), r.shared_source()))
            .collect();
        if !navigate
            && sources.len() == self.sources.len()
            && sources
                .iter()
                .zip(&self.sources)
                .all(|((a, s), (b, t))| a == b && Arc::ptr_eq(s, t))
        {
            return;
        }
        self.sources = sources;
        self.cancel.store(true, Ordering::Relaxed);
        self.revision += 1;
        self.cancel = Arc::new(AtomicBool::new(false));
        self.busy = !self.query.is_empty() && self.query.len() <= scanner::QUERY_BYTES;
        if !self.busy {
            self.result = Default::default();
            return;
        }
        let _ = self.queued.try_recv();
        if self.send.as_ref().is_none_or(|s| {
            s.try_send(Scan {
                revision: self.revision,
                rows: read.rows.clone(),
                query: self.query.clone(),
                cancel: self.cancel.clone(),
                navigate,
            })
            .is_err()
        }) {
            self.busy = false;
        }
    }
    pub fn accept(&mut self, reply: Reply) {
        if !self.open || reply.revision != self.revision {
            return;
        }
        let previous = self.result.hits.get(self.active);
        self.active = if reply.navigate {
            0
        } else {
            previous
                .and_then(|h| reply.result.hits.iter().position(|n| n == h))
                .unwrap_or(0)
        };
        self.result = reply.result;
        self.busy = false;
        if reply.navigate {
            self.navigation += 1;
        }
    }
    pub fn step(&mut self, previous: bool) {
        if !self.open || self.busy {
            return;
        }
        self.active = scanner::step(self.active, self.result.hits.len(), previous);
        self.navigation += 1;
    }
    pub fn snapshot(&self, read: &Presentation, current: bool) -> FindSnapshot {
        let complete = !self.cancelled
            && current
            && read.loaded
            && read.cursor.is_none()
            && !read.limited
            && read.omitted == 0
            && !read.behind
            && !read.chat_issue
            && !read.page_error;
        let coverage = if !current || !read.loaded {
            "History loading…"
        } else if self.loading {
            "Loading full history…"
        } else if read.page_error || read.chat_issue {
            "Partial history · reader unavailable"
        } else if self.cancelled {
            "Loading cancelled · loaded messages only"
        } else if complete {
            "All messages · literal source"
        } else {
            "Loaded messages only · literal source"
        };
        let count = self.result.hits.len();
        FindSnapshot {
            open: self.open,
            query: self.query.clone(),
            status: if !self.query.is_empty() && (!current || !read.loaded) {
                "Waiting for history…".into()
            } else if self.query.len() > scanner::QUERY_BYTES {
                "Query exceeds 1 KiB".into()
            } else if self.busy {
                "Searching…".into()
            } else if self.query.is_empty() {
                String::new()
            } else if count == 0 {
                if complete {
                    "No matches"
                } else {
                    "No matches in loaded messages"
                }
                .into()
            } else {
                format!(
                    "{} of {}{}",
                    self.active + 1,
                    count,
                    if self.result.limited { "+ (limit)" } else { "" }
                )
            },
            coverage: coverage.into(),
            busy: self.busy,
            loading: self.loading,
            count,
            active: self.active,
            navigation: self.navigation,
            target: self.result.hits.get(self.active).map(|hit| FindTarget {
                key: ReaderKey(hit.key.clone()),
                source: hit.source.clone(),
                range: hit.range.clone(),
            }),
        }
    }
}
