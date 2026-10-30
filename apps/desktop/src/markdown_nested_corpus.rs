//! Small literal bodies, with an explicit byte map built while wrapping containers.
use std::ops::Range;

pub(super) const BODY: &str = "  <tag>&amp; \\ * _ e\u{301} 👩🏽‍💻 🇫🇷  \n\t日本語 next  \n\n  tail  \n";
pub(super) const AFTER: &str = "After **bold** &amp; \\*.\n";

pub(super) struct Case {
    pub name: &'static str,
    pub source: String,
    pub code: &'static str,
    pub segments: Vec<(Range<usize>, Range<usize>)>,
    pub separator: &'static str,
    pub before: &'static str,
    pub code_y: f32,
}

impl Case {
    pub fn selected(&self, source: Range<usize>) -> String {
        let mut text = String::new();
        for (raw, code) in &self.segments {
            let lo = raw.start.max(source.start);
            let hi = raw.end.min(source.end);
            if lo < hi {
                text.push_str(&self.code[code.start + lo - raw.start..code.start + hi - raw.start]);
            }
        }
        text
    }
}

pub(super) fn cases() -> Vec<Case> {
    [
        ("list-fenced", "- ```text\n", "  ", "  ```\n", true),
        ("quote-fenced", "> ```text\n", "> ", "> ```\n", true),
        ("list-indented", "- Before\n\n", "      ", "", false),
        ("quote-indented", ">\n", ">     ", "", false),
    ]
    .into_iter()
    .map(|(name, open, prefix, close, fenced)| {
        let code = if fenced {
            BODY
        } else {
            BODY.trim_end_matches('\n')
        };
        let mut source = open.to_string();
        let mut segments = Vec::new();
        let mut offset = 0;
        for line in code.split_inclusive('\n') {
            source.push_str(prefix);
            let start = source.len();
            source.push_str(line);
            segments.push((start..source.len(), offset..offset + line.len()));
            offset += line.len();
        }
        if fenced {
            source.push_str(prefix);
        }
        source.push('\n');
        source.push_str(close);
        Case {
            name,
            source,
            code,
            segments,
            separator: if name.starts_with("quote") {
                "\n\n"
            } else {
                "\n"
            },
            before: if name == "list-indented" {
                "Before\n"
            } else {
                ""
            },
            code_y: if fenced {
                38.
            } else if name == "list-indented" {
                48.
            } else {
                24.
            },
        }
    })
    .collect()
}
