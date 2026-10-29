//! Bounded NDJSON pipes. Short reads must not wait for a full buffer or EOF.
use serde_json::Value;
#[cfg(any(test, target_os = "macos"))]
use serde_json::json;
use std::io::{self, Read, Write};

pub(crate) struct Frames<R> {
    input: R,
    buffer: Vec<u8>,
    limit: usize,
    line_limit: usize,
}
impl<R: Read> Frames<R> {
    pub fn new(input: R, limit: usize) -> Self {
        Self {
            input,
            buffer: Vec::new(),
            limit,
            line_limit: limit,
        }
    }
    pub fn line_limit(mut self, limit: usize) -> Self {
        self.line_limit = limit;
        self
    }
    pub fn next(&mut self) -> io::Result<Option<Value>> {
        loop {
            if let Some(end) = self.buffer.iter().position(|byte| *byte == b'\n') {
                if end > self.line_limit {
                    return Err(io::Error::other("oversized line"));
                }
                let value =
                    serde_json::from_slice(&self.buffer[..end]).map_err(io::Error::other)?;
                self.buffer.drain(..=end);
                return Ok(Some(value));
            }
            let mut bytes = [0; 4096];
            match self.input.read(&mut bytes) {
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(error),
                Ok(0) => {
                    return if self.buffer.is_empty() {
                        Ok(None)
                    } else {
                        Err(io::Error::other("truncated frame"))
                    };
                }
                Ok(count) => self.buffer.extend_from_slice(&bytes[..count]),
            }
            if self.buffer.len() > self.limit {
                return Err(io::Error::other("oversized frame"));
            }
        }
    }
}
#[cfg(any(test, target_os = "macos"))]
pub(crate) struct ReplyReader<R>(Frames<R>);
#[cfg(any(test, target_os = "macos"))]
impl<R: Read> ReplyReader<R> {
    pub fn new(input: R) -> Self {
        Self(Frames::new(input, 8192))
    }
    pub fn read_reply(&mut self) -> bool {
        matches!(self.0.next(), Ok(Some(value)) if value["ok"] == true)
    }
}
pub(crate) fn emit(output: &mut impl Write, value: &Value) -> io::Result<()> {
    serde_json::to_writer(&mut *output, value)?;
    output.write_all(b"\n")?;
    output.flush()
}
#[cfg(any(test, target_os = "macos"))]
pub(crate) fn reply(output: &mut impl Write, id: i64, ok: bool) {
    let _ = emit(output, &json!({"id":id,"ok":ok}));
}
