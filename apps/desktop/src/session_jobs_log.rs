//! Read-only tail of a running job's local log, the daemon-reported outputPath.
//! The app never writes, truncates or follows anything else; the window is bounded.
use std::{
    io::{Read, Seek, SeekFrom},
    path::Path,
    sync::Arc,
};

/// Bytes of log kept and shown: the newest part of the file.
pub(crate) const WINDOW: usize = 256 * 1024;

/// One read: bytes [start, end) of the file as it is now.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Chunk {
    pub(crate) bytes: Vec<u8>,
    pub(crate) start: u64,
    pub(crate) end: u64,
    /// The file is shorter than what was read before: it was replaced or truncated.
    pub(crate) reset: bool,
}

/// Reads what was appended after offset, at most window bytes (the newest).
pub(crate) fn read(path: &Path, offset: u64, window: usize) -> Result<Chunk, &'static str> {
    if !path.is_absolute() {
        return Err("The log path isn't absolute.");
    }
    let mut file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err("No log file yet.");
        }
        Err(_) => return Err("The log can't be read."),
    };
    let meta = file.metadata().map_err(|_| "The log can't be read.")?;
    if !meta.is_file() {
        return Err("The log path isn't a regular file.");
    }
    let len = meta.len();
    let reset = len < offset;
    let from = if reset { 0 } else { offset };
    let start = from.max(len.saturating_sub(window as u64));
    file.seek(SeekFrom::Start(start))
        .map_err(|_| "The log can't be read.")?;
    let mut bytes = Vec::with_capacity((len - start) as usize);
    file.take(len - start)
        .read_to_end(&mut bytes)
        .map_err(|_| "The log can't be read.")?;
    let end = start + bytes.len() as u64;
    Ok(Chunk {
        bytes,
        start,
        end,
        reset,
    })
}

/// The newest window of a log and its display lines.
#[derive(Clone, Default)]
pub(crate) struct Tail {
    bytes: Vec<u8>,
    /// File offset after the last byte read.
    pub(crate) offset: u64,
    /// Older output isn't shown (window limit, gap or a replaced file).
    pub(crate) clipped: bool,
    pub(crate) lines: Arc<Vec<String>>,
    /// Index of the longest line, which sizes the horizontal scroll width.
    pub(crate) widest: usize,
}
impl Tail {
    /// Appends a chunk. False when nothing changed.
    pub(crate) fn apply(&mut self, chunk: Chunk) -> bool {
        // Bytes before this chunk were skipped or dropped: begin at a whole line.
        let mut cut = chunk.start != 0 && (chunk.reset || chunk.start != self.offset);
        if chunk.reset || chunk.start != self.offset {
            self.clipped |= chunk.start != 0 || !self.bytes.is_empty();
            self.bytes.clear();
        }
        if chunk.bytes.is_empty() && !chunk.reset {
            self.offset = chunk.end;
            return false;
        }
        self.bytes.extend_from_slice(&chunk.bytes);
        self.offset = chunk.end;
        if self.bytes.len() > WINDOW {
            let excess = self.bytes.len() - WINDOW;
            self.bytes.drain(..excess);
            self.clipped = true;
            cut = true;
        }
        if cut {
            // Start at a whole line, never mid-character.
            if let Some(newline) = self.bytes.iter().position(|b| *b == b'\n')
                && newline + 1 < self.bytes.len()
            {
                self.bytes.drain(..=newline);
            }
        }
        self.lines = Arc::new(lines(&String::from_utf8_lossy(&self.bytes)));
        self.widest = self
            .lines
            .iter()
            .enumerate()
            .max_by_key(|(_, line)| line.chars().count())
            .map_or(0, |(ix, _)| ix);
        true
    }
    pub(crate) fn text(&self) -> String {
        self.lines.join("\n")
    }
}

/// Terminal output as plain lines: ANSI escapes and controls dropped, CRLF as a
/// newline, and a lone CR overwriting its line (progress bars keep their last state).
pub(crate) fn lines(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut line = String::new();
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\n' => out.push(std::mem::take(&mut line)),
            '\r' if chars.peek() == Some(&'\n') => {}
            '\r' => line.clear(),
            '\u{1b}' => match chars.next() {
                Some('[') => {
                    for c in chars.by_ref() {
                        if ('\u{40}'..='\u{7e}').contains(&c) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    while let Some(c) = chars.next() {
                        if c == '\u{7}' || (c == '\u{1b}' && chars.next_if_eq(&'\\').is_some()) {
                            break;
                        }
                    }
                }
                _ => {}
            },
            '\t' => line.push_str("    "),
            c if c.is_control() => {}
            c => line.push(c),
        }
    }
    if !line.is_empty() || out.is_empty() && !text.is_empty() {
        out.push(line);
    }
    out
}

#[cfg(test)]
#[path = "session_jobs_log_tests.rs"]
mod tests;
