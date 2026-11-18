//! The screen agent's side in one Day window (docs/technical/day-screen-agent.md).
//!
//! The daemon keeps each request a screen agent chat makes of the window bound to it. A WS
//! notice names the window only. This host then reads the window's waiting requests, keeps
//! snapshot, query and act requests for TSX (`day.screen.take`), and answers picture requests
//! itself: it takes a picture of its own window and saves it in the attachment store, as
//! feedback images are. Bindings and requests live in memory only, here and in the daemon.
use super::{Error, NativeHost, Shared, Transport, valid_id};
use crate::bridge::{Command, Gate};
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex, Weak, atomic::Ordering},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

/// Most bytes of one answer, as the daemon accepts it.
pub(crate) const MAX_ANSWER: usize = 256 * 1024;
/// Most bytes of a refusal sentence.
const MAX_ERROR: usize = 2000;
/// Request IDs kept, so a second notice does not hand TSX or the camera the same request again.
const SEEN: usize = 256;
/// Most requests one read keeps.
const MOST: usize = 64;
/// Most chats whose last picture is kept.
const PICTURES: usize = 16;
/// How long the window may take to draw its picture. The daemon waits 5 s in all.
const DRAW: Duration = Duration::from_secs(3);
/// How long a closing window waits to remove its binding.
const UNBIND: Duration = Duration::from_secs(2);
/// The sentence the agent reads when the window cannot take its picture.
const NO_PICTURE: &str = "The window could not take a picture of itself.";

/// A PNG of the window's content and its size in pixels.
pub struct Picture {
    pub png: Vec<u8>,
    pub width: u32,
    pub height: u32,
}
/// Takes one picture of this window on the main thread and sends it back once. Native only.
pub type Taker = Arc<dyn Fn(async_channel::Sender<Result<Picture, Error>>) + Send + Sync>;

pub(super) struct State {
    /// This window's ID, once it bound a chat.
    window: Option<String>,
    /// Requests TSX has not taken yet.
    waiting: Vec<Value>,
    seen: VecDeque<String>,
    /// The last picture taken for each chat: (session ID, ScreenPicture).
    pictures: VecDeque<(String, Value)>,
    taker: Option<Taker>,
    notice: Option<Weak<dyn Fn() + Send + Sync>>,
    /// One pending wakeup from a WS notice. Bursts cost one read.
    wake: (async_channel::Sender<()>, async_channel::Receiver<()>),
}
impl Default for State {
    fn default() -> Self {
        Self {
            window: None,
            waiting: Vec::new(),
            seen: VecDeque::new(),
            pictures: VecDeque::new(),
            taker: None,
            notice: None,
            wake: async_channel::bounded(1),
        }
    }
}
impl State {
    fn seen(&mut self, id: &str) -> bool {
        if self.seen.iter().any(|s| s == id) {
            return true;
        }
        if self.seen.len() == SEEN {
            self.seen.pop_front();
        }
        self.seen.push_back(id.to_owned());
        false
    }
    fn keep_picture(&mut self, session: &str, picture: Value) {
        self.pictures.retain(|(s, _)| s != session);
        if self.pictures.len() == PICTURES {
            self.pictures.pop_front();
        }
        self.pictures.push_back((session.to_owned(), picture));
    }
    /// Hands TSX the requests still waiting and before their deadline, once.
    fn take(&mut self, now: u64) -> Value {
        Value::Array(
            std::mem::take(&mut self.waiting)
                .into_iter()
                .filter(|r| r["deadline"].as_u64().is_some_and(|d| d > now))
                .collect(),
        )
    }
    /// Wakes the reader for a notice naming this window. Bursts cost one read.
    fn notice(&self, frame: &Value) {
        if self
            .window
            .as_deref()
            .is_some_and(|w| frame["windowId"] == w)
        {
            let _ = self.wake.0.try_send(());
        }
    }
}

impl NativeHost {
    /// The bridge's `day.screen.requested` event. Held weakly: a closed bridge sends nothing.
    pub(crate) fn screen_notice(&self, notice: &Arc<dyn Fn() + Send + Sync>) {
        lock(&self.0.shared).notice = Some(Arc::downgrade(notice));
    }
    /// The native window owner's camera. Without one, picture requests are refused.
    pub(crate) fn set_screen_picture(&self, taker: Taker) {
        lock(&self.0.shared).taker = Some(taker);
    }
}

fn lock(shared: &Shared) -> std::sync::MutexGuard<'_, State> {
    shared.screen.lock().expect("native screen poisoned")
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// A ScreenAnswer: `{ok:true,value}` or `{ok:false,error}` with a short sentence.
pub(crate) fn valid_answer(answer: &Value) -> bool {
    let Some(o) = answer.as_object() else {
        return false;
    };
    o.len() == 2
        && match o.get("ok") {
            Some(Value::Bool(true)) => o.contains_key("value"),
            Some(Value::Bool(false)) => o["error"]
                .as_str()
                .is_some_and(|e| !e.trim().is_empty() && e.len() <= MAX_ERROR),
            _ => false,
        }
        && serde_json::to_vec(answer).is_ok_and(|b| b.len() <= MAX_ANSWER)
}

/// One request of `window` as the daemon sent it, or None.
fn request(v: &Value, window: &str) -> Option<String> {
    let o = v.as_object()?;
    let op = v["operation"]["op"].as_str()?;
    (o.len() == 5
        && v["id"].as_str().is_some_and(valid_id)
        && v["sessionId"].as_str().is_some_and(valid_id)
        && v["windowId"] == window
        && v["deadline"].is_u64()
        && matches!(op, "snapshot" | "query" | "act" | "screenshot"))
    .then(|| op.to_owned())
}

/// A WS `screen.requested` notice. Only one naming this window wakes the reader.
pub(super) fn requested(shared: &Shared, frame: &Value) {
    lock(shared).notice(frame);
}

/// Reads the window's requests on each notice, off the WS loop and the worker.
pub(super) async fn serve(source: super::Source, shared: Arc<Shared>) {
    let wake = lock(&shared).wake.1.clone();
    let Ok(t) = Transport::new(source) else {
        return;
    };
    while wake.recv().await.is_ok() {
        if shared.closed.load(Ordering::SeqCst) {
            return;
        }
        if let Err(error) = read(&t, &shared.screen).await {
            crate::day_log::event("screen.read_failed", json!({"error": error.to_string()}));
        }
    }
}

/// Reads this window's waiting requests. New snapshot, query and act requests wait for TSX,
/// which hears `day.screen.requested`. This host answers picture requests itself.
pub(super) async fn read(t: &Transport, state: &Mutex<State>) -> Result<(), Error> {
    let Some(window) = state.lock().expect("native screen poisoned").window.clone() else {
        return Ok(());
    };
    let v = t
        .get(&format!("/api/screen/requests?windowId={window}"))
        .await?;
    let requests = v["requests"].as_array().ok_or(Error::Invalid)?;
    let mut pictures = Vec::new();
    let notice = {
        let mut s = state.lock().expect("native screen poisoned");
        if s.window.as_deref() != Some(window.as_str()) {
            return Ok(());
        }
        let mut fresh = false;
        for r in requests.iter().take(MOST) {
            let Some(op) = request(r, &window) else {
                continue;
            };
            if s.seen(r["id"].as_str().unwrap_or_default()) {
                continue;
            }
            if op == "screenshot" {
                pictures.push(r.clone());
            } else {
                s.waiting.push(r.clone());
                fresh = true;
            }
        }
        if fresh {
            s.notice.as_ref().and_then(Weak::upgrade)
        } else {
            None
        }
    };
    if let Some(notice) = notice {
        notice();
    }
    for r in pictures {
        let session = r["sessionId"].as_str().unwrap_or_default();
        let answer = match picture(t, state, session).await {
            Ok(value) => json!({"ok":true,"value":value}),
            Err(_) => json!({"ok":false,"error":NO_PICTURE}),
        };
        // A late answer is the daemon's to drop. Nothing is sent again.
        let id = r["id"].as_str().unwrap_or_default();
        if let Err(error) = answer_once(t, &window, id, &answer).await {
            crate::day_log::event("screen.answer_failed", json!({"error": error.to_string()}));
        }
    }
    Ok(())
}

/// Takes a picture of this window, saves it in the attachment store and keeps it for the chat.
async fn picture(t: &Transport, state: &Mutex<State>, session: &str) -> Result<Value, Error> {
    let taker = state
        .lock()
        .expect("native screen poisoned")
        .taker
        .clone()
        .ok_or(Error::Unavailable)?;
    let (tx, rx) = async_channel::bounded(1);
    taker(tx);
    let shot = tokio::time::timeout(DRAW, rx.recv())
        .await
        .map_err(|_| Error::Unavailable)?
        .map_err(|_| Error::Unavailable)??;
    let reference =
        super::feedback::put_image(t, &uuid::Uuid::new_v4().to_string(), shot.png).await?;
    let value = json!({"attachment":reference,"width":shot.width,"height":shot.height,
        "mimeType":"image/png"});
    state
        .lock()
        .expect("native screen poisoned")
        .keep_picture(session, value.clone());
    Ok(value)
}

/// Sends one answer. 404: unknown or expired; 409: another window's request.
async fn answer_once(t: &Transport, window: &str, id: &str, answer: &Value) -> Result<(), Error> {
    if !valid_id(id) || !valid_answer(answer) {
        return Err(Error::Invalid);
    }
    let r = t
        .client
        .post(t.url(&format!("/api/screen/requests/{id}?windowId={window}")))
        .header("x-pilot-github-capability", t.local()?)
        .header("content-type", "application/json")
        .body(answer.to_string())
        .send()
        .await
        .map_err(|_| Error::Unknown)?;
    status(r.status().as_u16())
}

fn status(code: u16) -> Result<(), Error> {
    match code {
        200..=299 => Ok(()),
        401 | 403 => Err(Error::Identity),
        404 => Err(Error::Stale),
        413 => Err(Error::Capacity),
        _ => Err(Error::Invalid),
    }
}

/// PUT or DELETE one binding.
async fn bind(t: &Transport, window: &str, session: Option<&str>) -> Result<(), Error> {
    let request = match session {
        Some(session) => t
            .client
            .put(t.url("/api/screen/bindings"))
            .header("content-type", "application/json")
            .body(json!({"windowId":window,"sessionId":session}).to_string()),
        None => t
            .client
            .delete(t.url(&format!("/api/screen/bindings/{window}"))),
    };
    let r = request
        .header("x-pilot-github-capability", t.local()?)
        .send()
        .await
        .map_err(|_| Error::Offline)?;
    match status(r.status().as_u16()) {
        // The window's binding is already gone.
        Err(Error::Stale) if session.is_none() => Ok(()),
        result => result,
    }
}

/// The memory-only reads: what TSX must answer now, and a chat's last picture.
pub(super) fn cached(shared: &Shared, command: &Command) -> Value {
    let mut s = lock(shared);
    match command {
        Command::ScreenTake => s.take(now()),
        Command::ScreenPicture(session) => s
            .pictures
            .iter()
            .find(|(s, _)| s == session)
            .map_or(Value::Null, |(_, p)| p.clone()),
        _ => Value::Null,
    }
}

/// Bind, unbind and answer, on the worker.
pub(super) async fn handle(
    t: &Transport,
    shared: &Shared,
    command: &Command,
    gate: &Arc<Mutex<Gate>>,
    window: &str,
) -> Result<Value, Error> {
    let check = || {
        shared.open()?;
        command.admit(&gate.lock().expect("bridge gate poisoned"))
    };
    check()?;
    match command {
        Command::ScreenBind(session) => {
            bind(t, window, Some(session)).await?;
            check()?;
            let mut s = lock(shared);
            s.window = Some(window.to_owned());
            s.waiting.clear();
        }
        Command::ScreenUnbind => {
            bind(t, window, None).await?;
            let mut s = lock(shared);
            s.window = None;
            s.waiting.clear();
        }
        Command::ScreenAnswer { id, answer } => {
            lock(shared).waiting.retain(|r| r["id"] != id.as_str());
            answer_once(t, window, id, answer).await?;
        }
        _ => return Err(Error::Invalid),
    }
    Ok(json!({"snapshot":null,"outcome":null}))
}

/// The window closed: its chat no longer has a window. Best effort, briefly.
pub(super) async fn close(t: &Transport, shared: &Shared) {
    let window = lock(shared).window.take();
    if let Some(window) = window {
        let _ = tokio::time::timeout(UNBIND, bind(t, &window, None)).await;
    }
}

#[cfg(test)]
#[path = "screen_tests.rs"]
mod tests;
