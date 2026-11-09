//! Retained Changes on the native host worker. Reads never capture or grant authority.
use super::{Error, NativeHost, Shared, Source, Transport, journal::Journal, valid_id};
use crate::{
    changes::{AttentionAsk, AttentionIntent, ChangeList, ChangePage, ChangesAvailability},
    changes_contract as c,
    changes_project::{self as project, ChangeLocal, ListInputs, PageInputs},
    model::{Delivery, IntentOutcome, OutcomeStatus},
};
use async_channel::Receiver;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    sync::atomic::Ordering,
    time::{SystemTime, UNIX_EPOCH},
};

// Daemon inventories cap at 100 chats; each feed page has at most 20 rows.
// Refuse an incomplete inventory rather than calling oldest-first partial data complete.
const MAX_CHATS: usize = 100;
const MAX_PAGES: usize = 100;
const MAX_ROWS: usize = 2000;
const MAX_METADATA: usize = 8 * 1024 * 1024;

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

#[derive(Default)]
pub(super) struct State {
    epoch: Option<u64>,
    revision: u32,
    list: ChangeList,
    pages: Vec<c::ChangesPage>,
    requests: Vec<c::RequestEntry>,
    titles: HashMap<String, String>,
    rows: HashMap<String, c::ChangeRow>,
    local: HashMap<String, ChangeLocal>,
    page: Option<ChangePage>,
    failure: Option<String>,
    limited: bool,
}
impl State {
    fn list(&self, shared: &Shared) -> ChangeList {
        if self.epoch.is_none_or(|e| shared.current(e).is_err()) || self.failure.is_some() {
            return ChangeList {
                revision: self.revision,
                availability: ChangesAvailability::Unavailable,
                reason: self
                    .failure
                    .clone()
                    .unwrap_or_else(|| "Kept changes need a fresh native read.".into()),
                more: self.limited,
                ..ChangeList::default()
            };
        }
        let mut list = self.list.clone();
        list.revision = self.revision;
        list
    }
    fn local(&mut self, record: &Record, delivery: Delivery) {
        self.local.insert(
            record.snapshot().into(),
            ChangeLocal {
                delivery,
                asked: Some(record.ask()),
                operation: Some(record.id().into()),
            },
        );
        if let Some(page) = self
            .page
            .as_mut()
            .filter(|p| p.identity.snapshot_id == record.snapshot())
        {
            page.row.delivery = delivery;
            page.asked = Some(record.ask());
        }
        for row in self
            .list
            .waiting
            .iter_mut()
            .chain(&mut self.list.later)
            .chain(&mut self.list.earlier)
        {
            if row.snapshot_id == record.snapshot() {
                row.delivery = delivery;
            }
        }
        self.revision = self.revision.wrapping_add(1);
    }
}

pub(super) enum Work {
    Read,
    Open(String),
    Attention(AttentionIntent, AttentionAsk),
    Check(String),
}

impl NativeHost {
    /// Native-only complete retained inventory read. No capture or mutation.
    pub fn read_changes(&self) -> Receiver<Result<IntentOutcome, Error>> {
        self.request(super::Work::Changes(Work::Read))
    }
    /// A bounded, source-qualified projection. Stale/unreadable is never empty.
    pub fn changes_snapshot(&self) -> ChangeList {
        self.0
            .shared
            .changes
            .lock()
            .expect("native Changes poisoned")
            .list(&self.0.shared)
    }
    /// The exact reopened snapshot, only while its authority remains current.
    pub fn change_page(&self, snapshot: &str) -> Option<ChangePage> {
        let shared = &self.0.shared;
        let state = shared.changes.lock().expect("native Changes poisoned");
        state.epoch.filter(|e| shared.current(*e).is_ok())?;
        if state.failure.is_some() {
            return None;
        }
        state
            .page
            .as_ref()
            .filter(|p| p.identity.snapshot_id == snapshot)
            .cloned()
    }
    /// Reopen one exact snapshot already in the complete native inventory.
    pub fn open_change(&self, snapshot: String) -> Receiver<Result<IntentOutcome, Error>> {
        self.request(super::Work::Changes(Work::Open(snapshot)))
    }
    /// One explicit human attention transition, never feedback or approval.
    pub fn change_attention(
        &self,
        intent: AttentionIntent,
        ask: AttentionAsk,
    ) -> Receiver<Result<IntentOutcome, Error>> {
        self.request(super::Work::Changes(Work::Attention(intent, ask)))
    }
    /// GET of the saved exact operation only. Cold recovery never resends.
    pub fn check_change_attention(
        &self,
        snapshot: String,
    ) -> Receiver<Result<IntentOutcome, Error>> {
        self.request(super::Work::Changes(Work::Check(snapshot)))
    }
}

/// Append-only command and exact receipt. Its target is frozen before the send.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(super) struct Record {
    pub kind: String,
    pub version: u32,
    pub sequence: u64,
    pub source: Source,
    pub target: c::Target,
    pub action: String,
    pub command: Value,
    pub receipt: Option<Value>,
    pub not_sent: bool,
}
impl Record {
    pub fn id(&self) -> &str {
        self.command["operationId"].as_str().unwrap_or("")
    }
    pub fn snapshot(&self) -> &str {
        &self.target.snapshot_id
    }
    fn ask(&self) -> AttentionAsk {
        if self.action == "snooze" {
            AttentionAsk::Later
        } else {
            AttentionAsk::BringBack
        }
    }
    pub fn pending(&self) -> bool {
        !self.not_sent && self.receipt.is_none()
    }
    pub fn validate(&self) -> Result<(), Error> {
        if self.kind != "changes"
            || self.version != 1
            || self.sequence == 0
            || !valid_id(self.id())
            || !valid_id(self.snapshot())
            || !valid_id(&self.target.session_id)
            || self.target.project_id != self.source.project_id
            || !matches!(self.action.as_str(), "snooze" | "resume")
            || self.command["expectedRevision"]
                .as_u64()
                .is_none_or(|n| n == 0 || n >= u32::MAX as u64)
            || self.command["requestId"]
                .as_str()
                .is_none_or(|s| !valid_id(s))
            || self.command["reason"] != reason(self.ask())
            || self.command.as_object().is_none_or(|o| o.len() != 4)
        {
            return Err(Error::Storage);
        }
        if let Some(r) = &self.receipt {
            exact(r.clone(), self)?;
        }
        Ok(())
    }
}
fn reason(ask: AttentionAsk) -> &'static str {
    match ask {
        AttentionAsk::Later => "Later",
        AttentionAsk::BringBack => "Bring back",
    }
}
// serde_json's map order can change when NSH enables preserve_order. Sort explicitly.
fn canonical(v: &Value) -> String {
    match v {
        Value::Object(o) => {
            let mut keys: Vec<_> = o.keys().collect();
            keys.sort();
            format!(
                "{{{}}}",
                keys.into_iter()
                    .map(|k| format!("{}:{}", json!(k), canonical(&o[k])))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        Value::Array(a) => format!(
            "[{}]",
            a.iter().map(canonical).collect::<Vec<_>>().join(",")
        ),
        _ => v.to_string(),
    }
}
fn exact(receipt: Value, record: &Record) -> Result<Value, Error> {
    let mut payload = record.command.clone();
    payload["action"] = json!(record.action);
    let target: c::Target =
        serde_json::from_value(receipt["target"].clone()).map_err(|_| Error::Unknown)?;
    if receipt["operationId"] != record.id()
        || receipt["actor"] != json!({"kind":"native-user"})
        || receipt["payloadHash"] != project::sha256(&canonical(&payload))
        || receipt["requestId"] != record.command["requestId"]
        || receipt["revision"].as_u64()
            != record.command["expectedRevision"]
                .as_u64()
                .and_then(|n| n.checked_add(1))
        || receipt["state"]
            != if record.action == "snooze" {
                "snoozed"
            } else {
                "pending"
            }
        || target != record.target
    {
        return Err(Error::Unknown);
    }
    Ok(receipt)
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
struct Chat {
    id: String,
    title: String,
    #[serde(rename = "missionId")]
    mission_id: Option<String>,
}
#[derive(Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Inventory {
    project_id: String,
    chats: Vec<Chat>,
    more: bool,
}

async fn inventory(t: &Transport) -> Result<Inventory, Error> {
    let i: Inventory = serde_json::from_value(
        t.get(&format!("/api/projects/{}/review", t.source.project_id))
            .await?,
    )
    .map_err(|_| Error::Invalid)?;
    if i.project_id != t.source.project_id {
        return Err(Error::Identity);
    }
    if i.more || i.chats.len() > MAX_CHATS {
        return Err(Error::Busy);
    }
    let mut ids = HashSet::new();
    if i.chats
        .iter()
        .any(|c| !valid_id(&c.id) || !ids.insert(&c.id))
    {
        return Err(Error::Invalid);
    }
    Ok(i)
}
fn root(_t: &Transport, session: &str) -> String {
    format!("/api/sessions/{session}/review")
}
async fn history(t: &Transport, row: &c::ChangeRow) -> Result<c::History, Error> {
    let raw = t
        .get(&format!(
            "{}/{}/history?expectedProjectId={}",
            root(t, &row.target.session_id),
            row.target.snapshot_id,
            t.source.project_id
        ))
        .await?;
    let snapshot = &raw["snapshot"];
    let digest = project::sha256(&canonical(
        &json!({"snapshotId":snapshot["snapshotId"], "request":snapshot["request"], "diff":snapshot["diff"]}),
    ));
    if snapshot["workerId"] != row.target.session_id
        || snapshot["diff"]["sha256"] != row.target.diff_sha256
        || snapshot["request"]["scope"]["kind"] != row.target.layer
        || digest != row.target.comparison_digest
    {
        return Err(Error::Invalid);
    }
    let h: c::History = serde_json::from_value(raw).map_err(|_| Error::Invalid)?;
    // Projection validates full comparison identity; native scope adds project/session.
    if h.target != row.target || h.comparison != row.comparison {
        return Err(Error::Stale);
    }
    project::page(
        &row.target.snapshot_id,
        &PageInputs {
            history: &h,
            patch: Err("Not read".into()),
            row: Some(row),
            request: None,
            newer: None,
            titles: &HashMap::new(),
            local: None,
            now: now(),
            read_at: now(),
        },
    )
    .map_err(|_| Error::Invalid)?;
    Ok(h)
}
fn cursor(next: Option<u64>, after: u64) -> Result<Option<u64>, Error> {
    if next.is_some_and(|n| n <= after || n > 999_999_999_999_999) {
        return Err(Error::Invalid);
    }
    Ok(next)
}
fn budget(v: &Value, bytes: &mut usize, pages: &mut usize) -> Result<(), Error> {
    *bytes = bytes.saturating_add(v.to_string().len());
    *pages += 1;
    if *bytes > MAX_METADATA || *pages > MAX_PAGES {
        return Err(Error::Busy);
    }
    Ok(())
}
async fn read(t: &Transport, shared: &Shared, epoch: u64) -> Result<(), Error> {
    shared
        .changes
        .lock()
        .expect("native Changes poisoned")
        .epoch = None;
    let authority = t.local()?;
    t.gate(false).await?;
    let before = inventory(t).await?;
    let (mut pages, mut requests, mut rows, mut titles) =
        (Vec::new(), Vec::new(), HashMap::new(), HashMap::new());
    let (mut count, mut bytes) = (0, 0);
    let (mut pending, mut failed) = (0_u32, 0_u32);
    for chat in &before.chats {
        titles.insert(chat.id.clone(), chat.title.clone());
        let mut after = 0;
        loop {
            shared.current(epoch)?;
            if count >= MAX_PAGES {
                return Err(Error::Busy);
            }
            let v = t
                .get(&format!(
                    "{}?view=changes&expectedProjectId={}&after={after}",
                    root(t, &chat.id),
                    t.source.project_id
                ))
                .await?;
            budget(&v, &mut bytes, &mut count)?;
            let page: c::ChangesPage = serde_json::from_value(v).map_err(|_| Error::Invalid)?;
            if page.version != 1
                || page.scope != "retained-comparisons-only"
                || page.status != "available"
            {
                return Err(Error::Unavailable);
            }
            if page.changes.len() > 20 {
                return Err(Error::Invalid);
            }
            for entry in &page.changes {
                if let c::PageEntry::Row(r) = entry
                    && (r.target.project_id != t.source.project_id
                        || r.target.session_id != chat.id
                        || r.target.snapshot_id != r.comparison.snapshot_id
                        || !valid_id(&r.target.snapshot_id)
                        || rows
                            .insert(r.target.snapshot_id.clone(), *r.clone())
                            .is_some())
                {
                    return Err(Error::Invalid);
                }
            }
            if rows.len() > MAX_ROWS {
                return Err(Error::Busy);
            }
            let next = cursor(page.next, after)?;
            if next.is_none()
                && let Some(capture) = &page.capture
            {
                pending = pending.saturating_add(capture.pending);
                failed = failed.saturating_add(capture.failed);
            }
            pages.push(page);
            match next {
                Some(n) => after = n,
                None => break,
            }
        }
        let mut after = 0;
        loop {
            shared.current(epoch)?;
            if count >= MAX_PAGES {
                return Err(Error::Busy);
            }
            let v = t
                .get(&format!(
                    "/api/review/requests?sessionId={}&after={after}",
                    chat.id
                ))
                .await?;
            budget(&v, &mut bytes, &mut count)?;
            let page: c::RequestPage = serde_json::from_value(v).map_err(|_| Error::Invalid)?;
            if page.requests.len() > 20 {
                return Err(Error::Invalid);
            }
            for entry in &page.requests {
                if let c::RequestEntry::Row(r) = entry
                    && (r.session_id != chat.id || r.project_id != t.source.project_id)
                {
                    return Err(Error::Identity);
                }
                // An unavailable request must not silently turn a source into "no attention".
                if matches!(entry, c::RequestEntry::Unavailable(_)) {
                    return Err(Error::Unavailable);
                }
            }
            let next = cursor(page.next, after)?;
            requests.extend(page.requests);
            if requests.len() > MAX_ROWS {
                return Err(Error::Busy);
            }
            match next {
                Some(n) => after = n,
                None => break,
            }
        }
    }
    if pages.is_empty() {
        pages.push(c::ChangesPage {
            version: 1,
            scope: "retained-comparisons-only".into(),
            status: "available".into(),
            reason: None,
            capture: None,
            changes: vec![],
            next: None,
        });
    }
    if inventory(t).await? != before {
        return Err(Error::Stale);
    }
    t.gate(false).await?;
    if t.local()? != authority {
        return Err(Error::Identity);
    }
    shared.current(epoch)?;
    // Sorting, grouping and formatting stay on the I/O worker, not VM getters.
    let (local, revision) = {
        let state = shared.changes.lock().expect("native Changes poisoned");
        (state.local.clone(), state.revision.wrapping_add(1))
    };
    let mut list = project::list(
        &ListInputs {
            pages: &pages,
            requests: &requests,
            titles: &titles,
            local: &local,
            now: now(),
        },
        revision,
    );
    list.more = false;
    list.pending = pending;
    list.failed = failed;
    // Snapshot sequences are per session. Compare capture times across sessions.
    for group in [&mut list.waiting, &mut list.later, &mut list.earlier] {
        group.sort_by_key(|r| {
            std::cmp::Reverse((
                rows.get(&r.snapshot_id)
                    .map_or(0, |v| v.comparison.captured_at),
                r.snapshot_id.clone(),
            ))
        });
    }
    shared.current(epoch)?;
    let mut state = shared.changes.lock().expect("native Changes poisoned");
    state.list = list;
    state.pages = pages;
    state.requests = requests;
    state.rows = rows;
    state.titles = titles;
    state.page = None;
    state.epoch = Some(epoch);
    state.failure = None;
    state.limited = false;
    state.revision = state.revision.wrapping_add(1);
    drop(state);
    shared.change(|_| ());
    Ok(())
}
fn row(shared: &Shared, epoch: u64, snapshot: &str) -> Result<c::ChangeRow, Error> {
    if !valid_id(snapshot) {
        return Err(Error::Invalid);
    }
    shared.current(epoch)?;
    if !shared.connected.load(Ordering::SeqCst) {
        return Err(Error::Stale);
    }
    let s = shared.changes.lock().expect("native Changes poisoned");
    if s.epoch != Some(epoch) || s.failure.is_some() {
        return Err(Error::Stale);
    }
    s.rows.get(snapshot).cloned().ok_or(Error::Unavailable)
}
async fn open(t: &Transport, shared: &Shared, epoch: u64, snapshot: &str) -> Result<(), Error> {
    let authority = t.local()?;
    let row = row(shared, epoch, snapshot)?;
    t.gate(false).await?;
    let h = history(t, &row).await?;
    let patch = t
        .get(&format!(
            "{}/{snapshot}/patch?expectedProjectId={}",
            root(t, &row.target.session_id),
            t.source.project_id
        ))
        .await
        .and_then(|v| serde_json::from_value::<c::RetainedPatch>(v).map_err(|_| Error::Invalid));
    // Re-read history after the patch: an attention revision raced across the async read.
    if history(t, &row).await? != h {
        return Err(Error::Stale);
    }
    t.gate(false).await?;
    if authority != t.local()? {
        return Err(Error::Identity);
    }
    shared.current(epoch)?;
    let mut state = shared.changes.lock().expect("native Changes poisoned");
    let request = state.requests.iter().find_map(|r| match r {
        c::RequestEntry::Row(r) if r.comparison == h.comparison => Some(r.as_ref()),
        _ => None,
    });
    let page = project::page(
        snapshot,
        &PageInputs {
            history: &h,
            patch: patch.as_ref().map_err(|_| "Patch unavailable".into()),
            row: Some(&row),
            request,
            newer: project::newer(&state.pages, &h.comparison),
            titles: &state.titles,
            local: state.local.get(snapshot),
            now: now(),
            read_at: now(),
        },
    )
    .map_err(|_| Error::Invalid)?;
    state.page = Some(page);
    state.revision = state.revision.wrapping_add(1);
    drop(state);
    shared.change(|_| ());
    Ok(())
}
async fn qualify(
    t: &Transport,
    shared: &Shared,
    epoch: u64,
    row: &c::ChangeRow,
    intent: &AttentionIntent,
    ask: AttentionAsk,
) -> Result<(), Error> {
    if !shared.connected.load(Ordering::SeqCst) {
        return Err(Error::Stale);
    }
    t.gate(false).await?;
    let h = history(t, row).await?;
    let expected = if ask == AttentionAsk::Later {
        c::RequestState::Pending
    } else {
        c::RequestState::Snoozed
    };
    if !h.attention.complete
        || !h.attention.records.iter().any(|a| {
            a.request_id == intent.request_id
                && a.revision == intent.revision
                && a.state == expected
        })
    {
        return Err(Error::Stale);
    }
    t.gate(false).await?;
    shared.current(epoch)?;
    Ok(())
}
pub(super) fn restore(journal: &Journal, source: &Source, shared: &Shared) {
    let mut records: Vec<_> = journal
        .changes
        .values()
        .filter(|r| r.source == *source)
        .collect();
    records.sort_by_key(|r| r.sequence);
    let mut state = shared.changes.lock().expect("native Changes poisoned");
    for r in records {
        if !r.not_sent {
            state.local(
                r,
                if r.pending() {
                    Delivery::Unknown
                } else {
                    Delivery::Idle
                },
            );
        }
    }
}
fn publish(shared: &Shared, record: &Record, delivery: Delivery) {
    shared
        .changes
        .lock()
        .expect("native Changes poisoned")
        .local(record, delivery);
    shared.change(|_| ());
}
async fn send(t: &Transport, record: &Record) -> Result<Value, Error> {
    let token = t.local()?;
    let r = t
        .client
        .post(t.url(&format!("/api/review/requests/{}", record.action)))
        .header("x-pilot-github-capability", token.clone())
        .header("content-type", "application/json")
        .body(serde_json::to_vec(&record.command).map_err(|_| Error::Invalid)?)
        .send()
        .await
        .map_err(|_| Error::Unknown)?;
    let v = super::transport::body(r)
        .await
        .map_err(|_| Error::Unknown)?;
    if t.local().map_err(|_| Error::Unknown)? != token {
        return Err(Error::Unknown);
    }
    exact(v, record)
}
async fn execute(
    t: &Transport,
    journal: &mut Journal,
    shared: &Shared,
    epoch: u64,
    work: Work,
) -> Result<IntentOutcome, Error> {
    match work {
        Work::Read => read(t, shared, epoch).await?,
        Work::Open(snapshot) => open(t, shared, epoch, &snapshot).await?,
        Work::Attention(intent, ask) => {
            if journal.changes.values().any(|r| {
                r.source == t.source
                    && r.pending()
                    && (r.command["requestId"] == intent.request_id
                        || r.snapshot() == intent.snapshot_id)
            }) {
                return Err(Error::Unknown);
            }
            let row = row(shared, epoch, &intent.snapshot_id)?;
            // A fabricated VM request cannot choose an arbitrary project/request or revision.
            {
                let state = shared.changes.lock().expect("native Changes poisoned");
                let p = state
                    .page
                    .as_ref()
                    .filter(|p| p.identity.snapshot_id == intent.snapshot_id)
                    .ok_or(Error::Stale)?;
                if !p.request.as_ref().is_some_and(|r| {
                    r.request_id == intent.request_id && r.revision == intent.revision
                }) {
                    return Err(Error::Stale);
                }
            }
            let authority = t.local()?;
            qualify(t, shared, epoch, &row, &intent, ask).await?;
            let mut record = Record {
                kind: "changes".into(),
                version: 1,
                sequence: journal
                    .changes
                    .values()
                    .map(|r| r.sequence)
                    .max()
                    .unwrap_or(0)
                    .checked_add(1)
                    .ok_or(Error::Storage)?,
                source: t.source.clone(),
                target: row.target.clone(),
                action: if ask == AttentionAsk::Later {
                    "snooze"
                } else {
                    "resume"
                }
                .into(),
                command: json!({"operationId":uuid::Uuid::new_v4().to_string(), "requestId":intent.request_id,"expectedRevision":intent.revision,"reason":reason(ask)}),
                receipt: None,
                not_sent: false,
            };
            journal.save_changes(record.clone())?;
            publish(shared, &record, Delivery::Sending);
            let qualified = async {
                qualify(t, shared, epoch, &row, &intent, ask).await?;
                if t.local()? != authority {
                    return Err(Error::Identity);
                }
                shared.current(epoch)
            }
            .await;
            if let Err(e) = qualified {
                record.not_sent = true;
                journal.save_changes(record.clone())?;
                publish(shared, &record, Delivery::Idle);
                return Err(e);
            }
            match send(t, &record).await {
                Ok(receipt) => {
                    record.receipt = Some(receipt);
                    // Preserve a matched volatile ACK even if fsync fails; poison blocks future sends.
                    if journal.save_changes(record.clone()).is_err() {
                        journal.poison();
                        journal
                            .changes
                            .insert(record.id().to_owned(), record.clone());
                        publish(shared, &record, Delivery::Unknown);
                        return Err(Error::Unknown);
                    }
                    publish(shared, &record, Delivery::Idle);
                    if read(t, shared, epoch).await.is_err()
                        || open(t, shared, epoch, &intent.snapshot_id).await.is_err()
                    {
                        shared
                            .changes
                            .lock()
                            .expect("native Changes poisoned")
                            .epoch = None;
                    }
                }
                Err(_) => {
                    publish(shared, &record, Delivery::Unknown);
                    return Err(Error::Unknown);
                }
            }
        }
        Work::Check(snapshot) => {
            if !valid_id(&snapshot) {
                return Err(Error::Invalid);
            }
            let mut record = journal
                .changes
                .values()
                .filter(|r| r.source == t.source && r.snapshot() == snapshot && !r.not_sent)
                .max_by_key(|r| r.sequence)
                .cloned()
                .ok_or(Error::Unknown)?;
            let authority = t.local()?;
            t.gate(false).await?;
            let v = t
                .get(&format!("/api/review/requests/operations/{}", record.id()))
                .await?;
            let receipt = exact(v, &record)?;
            t.gate(false).await?;
            if authority != t.local()? {
                return Err(Error::Identity);
            }
            shared.open()?;
            if record.pending() {
                record.receipt = Some(receipt);
                if journal.save_changes(record.clone()).is_err() {
                    journal.poison();
                    journal
                        .changes
                        .insert(record.id().to_owned(), record.clone());
                    publish(shared, &record, Delivery::Unknown);
                    return Err(Error::Unknown);
                }
            } else if record.receipt != Some(receipt) {
                return Err(Error::Unknown);
            }
            publish(shared, &record, Delivery::Idle);
            // A receipt is historical, not a current revision or evidence of unchanged permission.
            shared
                .changes
                .lock()
                .expect("native Changes poisoned")
                .epoch = None;
        }
    }
    Ok(shared.outcome(OutcomeStatus::Accepted, ""))
}
pub(super) async fn handle(
    t: &Transport,
    journal: &mut Journal,
    shared: &Shared,
    epoch: u64,
    work: Work,
) -> Result<IntentOutcome, Error> {
    let lookup = matches!(work, Work::Check(_));
    let reading = matches!(work, Work::Read | Work::Open(_));
    let result = execute(t, journal, shared, epoch, work).await;
    if let Err(e) = result {
        if reading || e != Error::Unknown {
            let mut s = shared.changes.lock().expect("native Changes poisoned");
            s.epoch = None;
            s.page = None;
            s.limited = e == Error::Busy;
            s.failure = Some(if s.limited {"Kept changes exceed this read's limit. The feed is incomplete."} else {"Kept changes could not be read with current native access. Read again before acting."}.into());
        }
        shared.change(|_| ());
        if e == Error::Unknown || lookup {
            return Ok(shared.outcome(
                OutcomeStatus::Unknown,
                "No exact acknowledgement. Check the saved operation; nothing is resent.",
            ));
        }
        return Err(e);
    }
    result
}
