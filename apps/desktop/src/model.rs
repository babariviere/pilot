//! Deterministic fixture authority. No filesystem, environment, clock or transport.
use std::ops::Range;
use std::sync::Arc;

pub(crate) const REPLY: &str = include_str!("../fixtures/reply.md");
pub(crate) const PAGE: usize = 12;
const INITIAL: usize = 24;
const HISTORY: usize = 72;
const MAX_MESSAGES: usize = 128;
pub(crate) const CHUNK_CHARS: usize = 100;
pub(crate) const TICK_MS: u64 = 250;

/// Session-relative canonical identity. The Local reader/cache supplies owner
/// and generation qualification. Never derived from a presentation allocation.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum ReaderKey {
    Entry {
        entry: u64,
        model: Option<usize>,
        block: Option<usize>,
    },
    Tool(String),
}
impl ReaderKey {
    pub(crate) fn model(entry: u64, model: usize, block: Option<usize>) -> Self {
        Self::Entry {
            entry,
            model: Some(model),
            block,
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct Message {
    id: u64,
    reader: Option<ReaderKey>,
    label: String,
    source: Arc<String>,
    display: Option<Arc<String>>,
    work: Option<Arc<crate::tool_presentation::Work>>,
    tool_ids: Option<Arc<Vec<String>>>,
    work_note: bool,
    artifact: Option<Arc<crate::artifact_model::Reference>>,
    artifact_size: Option<crate::artifact_model::RasterSize>,
    image: Option<Arc<crate::conversation_images::Source>>,
    /// Delivery caption for user input not yet in canonical history (Sending, Queued).
    pending: Option<&'static str>,
    sent: Option<u64>,
    /// A historical ask_user record (pilot.question), shown as a disclosure.
    question: Option<Arc<crate::question_entry::Record>>,
}

impl Message {
    pub(crate) fn live(id: u64, label: String, source: String) -> Self {
        let plain = label.starts_with("You")
            || label.starts_with("Automatic input")
            || label.starts_with("toolResult")
            || label.starts_with("Tool");
        let display = plain.then(|| {
            let escaped = source
                .replace('&', "&amp;")
                .replace('<', "&lt;")
                .replace('>', "&gt;");
            Arc::new(format!("<pre>{escaped}</pre>"))
        });
        Self {
            id,
            reader: None,
            label,
            source: Arc::new(source),
            display,
            work: None,
            tool_ids: None,
            work_note: false,
            artifact: None,
            artifact_size: None,
            image: None,
            pending: None,
            sent: None,
            question: None,
        }
    }
    pub(crate) fn with_pending(mut self, status: &'static str) -> Self {
        self.pending = Some(status);
        self
    }
    pub(crate) fn pending(&self) -> Option<&'static str> {
        self.pending
    }
    pub(crate) fn id(&self) -> u64 {
        self.id
    }
    pub(crate) fn anchored(mut self, key: ReaderKey) -> Self {
        self.reader = Some(key);
        self
    }
    pub(crate) fn reader_key(&self) -> Option<ReaderKey> {
        self.reader.clone().or_else(|| {
            self.work.as_ref().and_then(|work| {
                work.calls()
                    .find(|tool| !tool.id.is_empty() && tool.id.len() <= 256)
                    .map(|tool| ReaderKey::Tool(tool.id.clone()))
                    .or_else(|| work.readers.first().cloned())
            })
        })
    }
    pub(crate) fn matches_reader(&self, key: &ReaderKey) -> bool {
        self.reader.as_ref() == Some(key)
            || self.work.as_ref().is_some_and(|work| {
                work.readers.contains(key)
                    || match key {
                        ReaderKey::Tool(id) => work.calls().any(|tool| &tool.id == id),
                        _ => false,
                    }
            })
    }
    pub(crate) fn label(&self) -> &str {
        &self.label
    }
    pub(crate) fn display_label(&self) -> &str {
        let label = self
            .label
            .rsplit_once(" · entry ")
            .filter(|(_, id)| id.parse::<u64>().is_ok())
            .map(|(label, _)| label)
            .unwrap_or(&self.label);
        if label == "assistant" {
            "Assistant"
        } else {
            label
        }
    }
    pub(crate) fn source(&self) -> &str {
        &self.source
    }
    pub(crate) fn shared_source(&self) -> Arc<String> {
        self.source.clone()
    }
    pub(crate) fn display_source(&self) -> &str {
        self.display.as_ref().unwrap_or(&self.source)
    }
    pub(crate) fn is_plain(&self) -> bool {
        self.display.is_some()
    }
    pub(crate) fn work_data(&self) -> Option<&Arc<crate::tool_presentation::Work>> {
        self.work.as_ref()
    }
    /// The message's own epoch-millisecond sent time, when it has a valid one.
    pub(crate) fn sent(&self) -> Option<u64> {
        self.sent
    }
    pub(crate) fn with_sent(mut self, sent: Option<u64>) -> Self {
        self.sent = sent;
        self
    }
    pub(crate) fn image_data(&self) -> Option<&Arc<crate::conversation_images::Source>> {
        self.image.as_ref()
    }
    /// A question record row: label "Agent asked", source its formatted Markdown.
    pub(crate) fn question(id: u64, record: crate::question_entry::Record) -> Self {
        let mut row = Self::live(id, "Agent asked".into(), record.source());
        row.question = Some(Arc::new(record));
        row
    }
    pub(crate) fn question_data(&self) -> Option<&Arc<crate::question_entry::Record>> {
        self.question.as_ref()
    }
    pub(crate) fn retained_bytes(&self) -> usize {
        self.source.len()
            + self
                .image
                .as_ref()
                .map_or(0, |image| image.retained_bytes())
    }
    pub(crate) fn image(id: u64, label: String, image: crate::conversation_images::Source) -> Self {
        let mut row = Self::live(
            id,
            label,
            format!("Stored image · block {}", image.block + 1),
        );
        row.image = Some(Arc::new(image));
        row
    }
    pub(crate) fn artifact_data(&self) -> Option<&Arc<crate::artifact_model::Reference>> {
        self.artifact.as_ref()
    }
    pub(crate) fn artifact(id: u64, reference: crate::artifact_model::Reference) -> Self {
        let mut row = Self::live(
            id,
            "Artifact".into(),
            format!("{} · r{}", reference.title, reference.revision),
        );
        row.artifact = Some(Arc::new(reference));
        row
    }
    /// The publication's raster size hint, reserved before the revision is read.
    pub(crate) fn with_artifact_size(
        mut self,
        size: Option<crate::artifact_model::RasterSize>,
    ) -> Self {
        self.artifact_size = size;
        self
    }
    pub(crate) fn artifact_size(&self) -> Option<crate::artifact_model::RasterSize> {
        self.artifact_size
    }
    pub(crate) fn tool_ids(&self) -> Option<&[String]> {
        self.tool_ids.as_ref().map(|ids| ids.as_slice())
    }
    pub(crate) fn is_assistant(&self) -> bool {
        self.label.starts_with("assistant") || self.label.starts_with("Assistant")
    }
    pub(crate) fn work_note(&self) -> bool {
        self.work_note
    }
    pub(crate) fn attach_tools(&mut self, ids: Vec<String>) {
        if !ids.is_empty() {
            self.tool_ids = Some(Arc::new(ids));
        }
    }
    pub(crate) fn tool_ref(id: u64, call_id: &str) -> Self {
        let mut row = Self::live(id, "assistant".into(), String::new());
        row.reader =
            (!call_id.is_empty() && call_id.len() <= 256).then(|| ReaderKey::Tool(call_id.into()));
        row.attach_tools(vec![call_id.into()]);
        row
    }
    pub(crate) fn work(work: Arc<crate::tool_presentation::Work>) -> Self {
        let mut row = Self::live(work.id, "Work".into(), work.title.clone());
        row.work = Some(work);
        row
    }
}

pub(crate) fn reader_index(messages: &[Message], key: &ReaderKey) -> Option<usize> {
    let mut found = None;
    for (ix, _) in messages
        .iter()
        .enumerate()
        .filter(|(_, row)| row.matches_reader(key))
    {
        if found.is_some() {
            return None;
        }
        found = Some(ix);
    }
    found
}

pub(crate) struct Transcript {
    messages: Vec<Message>,
    earlier: usize,
    next_id: u64,
    stream: Option<Stream>,
}

struct Stream {
    row: usize,
    target: String,
    cursor: usize,
}

impl Transcript {
    pub(crate) fn readonly() -> Self {
        Self {
            messages: Vec::new(),
            earlier: 0,
            next_id: 0,
            stream: None,
        }
    }

    pub(crate) fn replace_readonly(&mut self, messages: Vec<Message>) {
        self.messages = messages;
    }
    pub(crate) fn new() -> Self {
        let mut transcript = Self {
            messages: Vec::new(),
            earlier: HISTORY - INITIAL,
            next_id: (HISTORY + 1) as u64,
            stream: None,
        };
        transcript.messages = (HISTORY - INITIAL..HISTORY).map(history_message).collect();
        transcript
    }

    pub(crate) fn messages(&self) -> &[Message] {
        &self.messages
    }
    pub(crate) fn earlier(&self) -> usize {
        self.earlier
    }
    pub(crate) fn is_streaming(&self) -> bool {
        self.stream.is_some()
    }
    pub(crate) fn is_full(&self) -> bool {
        self.messages.len() + 2 > MAX_MESSAGES
    }

    pub(crate) fn prepend(&mut self) -> usize {
        if self.messages.len() + PAGE > MAX_MESSAGES {
            return 0;
        }
        let count = self.earlier.min(PAGE);
        let start = self.earlier - count;
        self.messages
            .splice(0..0, (start..self.earlier).map(history_message));
        self.earlier = start;
        if let Some(stream) = &mut self.stream {
            stream.row += count;
        }
        count
    }

    /// Refuse overlapping streams or exhausted fixture capacity, never evict rows.
    /// User text is displayed verbatim separately, never parsed as Markdown/URLs.
    pub(crate) fn submit(&mut self, input: &str) -> Option<Range<usize>> {
        if input.trim().is_empty() || self.is_streaming() || self.is_full() {
            return None;
        }
        let start = self.messages.len();
        self.push("You · local only", input.to_string());
        self.start_reply(format!(
            "Received {} characters locally.\n\n{REPLY}",
            input.chars().count()
        ));
        Some(start..self.messages.len())
    }

    pub(crate) fn demo(&mut self) -> bool {
        if self.is_streaming() || self.is_full() {
            return false;
        }
        self.start_reply(REPLY.to_string());
        true
    }

    fn start_reply(&mut self, target: String) {
        let row = self.messages.len();
        self.push("Assistant · synthetic", String::new());
        self.stream = Some(Stream {
            row,
            target,
            cursor: 0,
        });
    }

    fn push(&mut self, label: &str, source: String) {
        let id = self.next_id;
        self.next_id += 1;
        self.messages.push(Message {
            id,
            reader: None,
            label: label.to_string(),
            source: Arc::new(source),
            display: None,
            work: None,
            tool_ids: None,
            work_note: false,
            artifact: None,
            artifact_size: None,
            image: None,
            pending: None,
            sent: None,
            question: None,
        });
    }

    /// Advance by Unicode scalars, preserving UTF-8 (not a grapheme editing claim).
    pub(crate) fn tick(&mut self) -> Option<usize> {
        let stream = self.stream.as_mut()?;
        let rest = &stream.target[stream.cursor..];
        let bytes = rest
            .char_indices()
            .nth(CHUNK_CHARS)
            .map_or(rest.len(), |(ix, _)| ix);
        Arc::make_mut(&mut self.messages[stream.row].source).push_str(&rest[..bytes]);
        stream.cursor += bytes;
        let row = stream.row;
        if stream.cursor == stream.target.len() {
            self.stream = None;
        }
        Some(row)
    }

    pub(crate) fn stop(&mut self) {
        self.stream = None;
    }

    pub(crate) fn extra_fixture(&mut self, source: String) {
        self.push("Assistant · large fixture", source);
    }
}

/// Opt-in stress sources. Generation is outside the UI loop; rendering remains
/// deliberately unmodified so this proof does not hide Kit's giant-row cost.
pub fn giant_fixture() -> String {
    let mut source = String::with_capacity(1_048_576);
    for ix in 0..2000 {
        let size = 524 + usize::from(ix < 576);
        let mut paragraph = format!("Block {ix:04}: ");
        while paragraph.len() < size - 2 {
            paragraph.push('x');
        }
        source.push_str(&paragraph);
        source.push_str("\n\n");
    }
    source
}

pub fn fence_fixture() -> String {
    let mut source = String::from("```rust\n");
    for ix in 0..5000 {
        source.push_str(&format!("let line_{ix:04} = {ix}; // synthetic code\n"));
    }
    source.push_str("```\n");
    source
}

fn history_message(ix: usize) -> Message {
    let source = match ix % 4 {
        0 => format!(
            "### History {}\n\nA short synthetic paragraph with **emphasis** and `inline code`.\n",
            ix + 1
        ),
        1 => format!(
            "History {}\n\n- First item\n- Second item\n\n> A quotation for selection.\n",
            ix + 1
        ),
        2 => format!(
            "History {}\n\n```rust\nlet fixture_id = {};\nassert!(fixture_id > 0);\n```\n",
            ix + 1,
            ix + 1
        ),
        _ => format!(
            "History {}\n\n| Key | Value |\n| --- | --- |\n| Fixture | {} |\n| Unicode | 日本語 👨‍👩‍👧 |\n",
            ix + 1,
            ix + 1
        ),
    };
    Message {
        id: (ix + 1) as u64,
        reader: None,
        label: "Assistant · history fixture".into(),
        source: Arc::new(source),
        display: None,
        work: None,
        tool_ids: None,
        work_note: false,
        artifact: None,
        artifact_size: None,
        image: None,
        pending: None,
        sent: None,
        question: None,
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn display_author_keeps_structured_origin_and_removes_only_the_final_debug_suffix() {
        let row = super::Message::live(
            1,
            "Automatic input (Agent · entry planning) · entry 20".into(),
            "synthetic".into(),
        );
        assert_eq!(
            row.display_label(),
            "Automatic input (Agent · entry planning)"
        );
        assert_eq!(
            super::Message::live(2, "assistant · entry 21".into(), String::new()).display_label(),
            "Assistant"
        );
        assert_eq!(
            super::Message::live(3, "Origin · entry planning".into(), String::new())
                .display_label(),
            "Origin · entry planning"
        );
    }
    use super::*;

    #[test]
    fn stress_sources_are_exact_and_reproducible() {
        let giant = giant_fixture();
        assert_eq!(giant.len(), 1_048_576);
        assert_eq!(
            giant
                .split("\n\n")
                .filter(|block| !block.is_empty())
                .count(),
            2000
        );
        assert_eq!(fence_fixture().lines().count(), 5002);
    }

    #[test]
    fn fixtures_and_history_are_deterministic_with_stable_ids() {
        let mut transcript = Transcript::new();
        let before: Vec<_> = transcript
            .messages()
            .iter()
            .map(|row| (row.id(), row.source().to_string()))
            .collect();
        assert_eq!(transcript.prepend(), PAGE);
        assert_eq!(transcript.messages()[PAGE].id(), before[0].0);
        assert_eq!(transcript.messages()[PAGE].source(), before[0].1);
        while transcript.prepend() != 0 {}
        assert_eq!(transcript.earlier(), 0);
        assert_eq!(transcript.messages().len(), HISTORY);
        assert_eq!(
            transcript
                .messages()
                .iter()
                .map(Message::id)
                .collect::<Vec<_>>(),
            (1..=HISTORY as u64).collect::<Vec<_>>()
        );
    }

    #[test]
    fn stream_survives_prepend_and_commits_without_identity_change() {
        let mut transcript = Transcript::new();
        assert!(transcript.demo());
        let id = transcript.messages().last().unwrap().id();
        assert_eq!(transcript.tick(), Some(INITIAL));
        transcript.prepend();
        while transcript.tick().is_some() {}
        let last = transcript.messages().last().unwrap();
        assert_eq!(last.id(), id);
        assert_eq!(last.source(), REPLY);
        assert!(!transcript.is_streaming());
    }

    #[test]
    fn local_echo_keeps_verbatim_user_input_and_rejects_overlap() {
        let mut transcript = Transcript::new();
        assert!(transcript.submit(" \n ").is_none());
        let input = "👨‍👩‍👧 e\u{301} 日本語 ![x](https://invalid.example/x)";
        assert_eq!(transcript.submit(input), Some(INITIAL..INITIAL + 2));
        assert_eq!(transcript.messages()[INITIAL].source(), input);
        assert!(transcript.submit("second").is_none());
        while transcript.tick().is_some() {}
        assert_eq!(
            transcript.messages().last().unwrap().source(),
            format!(
                "Received {} characters locally.\n\n{REPLY}",
                input.chars().count()
            )
        );
    }

    #[test]
    fn stop_keeps_partial_content_and_capacity_is_bounded_without_eviction() {
        let mut transcript = Transcript::new();
        transcript.demo();
        transcript.tick();
        transcript.stop();
        let partial = transcript.messages().last().unwrap().source().to_string();
        assert!(transcript.tick().is_none());
        assert_eq!(transcript.messages().last().unwrap().source(), partial);
        while !transcript.is_full() {
            assert!(transcript.demo());
            transcript.stop();
        }
        assert!(!transcript.demo());
        assert!(transcript.submit("kept in composer").is_none());
        assert!(transcript.messages().len() <= MAX_MESSAGES);
    }
}
