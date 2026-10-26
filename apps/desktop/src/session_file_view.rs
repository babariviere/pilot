//! Bounded exact-text projection of the existing session files contract.
use serde_json::Value;
pub(crate) const WIRE_CAP: usize = 4 * 1024 * 1024;
pub(crate) const TEXT_CAP: usize = 32 * 1024;
pub(crate) const LINE_CAP: usize = 300;
pub(crate) const LINE_BYTES: usize = 1024;
pub(crate) fn valid_path(path: &str) -> bool {
    !path.is_empty()
        && path.encode_utf16().count() <= 4096
        && !path.starts_with('/')
        && !path.contains(['\0', '\\'])
        && path
            .split('/')
            .all(|s| !s.is_empty() && s != "." && s != "..")
}
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Content {
    Text { shown: String, truncated: bool },
    Unsupported,
    Binary,
}
impl Content {
    pub(crate) fn parse(value: Value, path: &str) -> Result<Self, &'static str> {
        if !valid_path(path) || value["path"].as_str() != Some(path) {
            return Err(
                "File path did not match the requested Changes row. No fallback attempted.",
            );
        }
        let binary = value["binary"]
            .as_bool()
            .ok_or("File format state unavailable.")?;
        let truncated = value["truncated"]
            .as_bool()
            .ok_or("File completeness unavailable.")?;
        let text = value["text"].as_str().ok_or("File text unavailable.")?;
        if binary {
            return Ok(Self::Binary);
        }
        // The server decodes with Buffer.toString(utf8), not a strict decoder.
        // U+FFFD is ambiguous (genuine text or lost bytes). Never present it as exact text.
        if text
            .chars()
            .any(|c| c == '\u{fffd}' || (c.is_control() && !matches!(c, '\r' | '\n' | '\t')))
        {
            return Ok(Self::Unsupported);
        }
        let mut end = 0;
        let mut lines = 1;
        let mut line_bytes = 0;
        for (ix, c) in text.char_indices() {
            if ix + c.len_utf8() > TEXT_CAP || line_bytes + c.len_utf8() > LINE_BYTES {
                break;
            }
            end = ix + c.len_utf8();
            if c == '\n' {
                lines += 1;
                line_bytes = 0;
                if lines > LINE_CAP {
                    break;
                }
            } else {
                line_bytes += c.len_utf8();
            }
        }
        Ok(Self::Text {
            shown: text[..end].to_owned(),
            truncated: truncated || end < text.len(),
        })
    }
}
#[derive(Default)]
pub(crate) struct State {
    pub(crate) serial: u64,
    pub(crate) busy: bool,
    pub(crate) content: Option<Content>,
    pub(crate) error: Option<&'static str>,
}
impl State {
    pub(crate) fn begin(&mut self) -> u64 {
        self.serial += 1;
        self.busy = true;
        self.error = None;
        self.serial
    }
    pub(crate) fn cancel(&mut self) {
        self.serial += 1;
        self.busy = false;
    }
    pub(crate) fn accept(&mut self, serial: u64, result: Result<Content, &'static str>) -> bool {
        if serial != self.serial {
            return false;
        }
        self.busy = false;
        match result {
            Ok(c) => {
                self.content = Some(c);
                self.error = None;
            }
            Err(e) => self.error = Some(e),
        }
        true
    }
}
#[cfg(test)]
#[path = "session_file_view_tests.rs"]
mod tests;
