//! Literal relative-path token capture. No filesystem or command semantics.
use std::ops::Range;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Token {
    pub(crate) range: Range<usize>,
    pub(crate) prefix: String,
    quote: Option<char>,
    dot: bool,
}
pub(crate) fn token(text: &str, selection: Range<usize>) -> Option<Token> {
    if !selection.is_empty() || !text.is_char_boundary(selection.start) {
        return None;
    }
    let mut start = 0;
    let mut quote = None;
    let mut escaped = false;
    for (i, c) in text.get(..selection.start)?.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if c == '\\' {
            escaped = true;
            continue;
        }
        if let Some(q) = quote {
            if c == q {
                quote = None;
                start = i + c.len_utf8();
            }
        } else if matches!(c, '\'' | '"' | '`') && i == start {
            quote = Some(c);
            start = i + c.len_utf8();
        } else if c.is_whitespace() {
            start = i + c.len_utf8();
        }
    }
    if start == selection.start || escaped {
        return None;
    }
    if let Some(c) = text.get(selection.start..)?.chars().next()
        && !quote.map_or_else(|| c.is_whitespace(), |q| c == q)
    {
        return None;
    }
    let mut prefix = String::new();
    let mut escape = false;
    for c in text[start..selection.start].chars() {
        if escape {
            prefix.push(c);
            escape = false;
        } else if c == '\\' {
            escape = true;
        } else {
            prefix.push(c);
        }
    }
    let dot = prefix.starts_with("./");
    if dot {
        prefix.drain(..2);
    }
    if !valid_prefix(&prefix) {
        return None;
    }
    Some(Token {
        range: start..selection.start,
        prefix,
        quote,
        dot,
    })
}
pub(crate) fn valid_prefix(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 1024
        && !s.starts_with(['/', '~'])
        && !s.contains("://")
        && !s.chars().any(|c| c.is_control() || c == '\\')
        && s.split('/')
            .enumerate()
            .all(|(i, p)| p != "." && p != ".." && (!p.is_empty() || i == s.split('/').count() - 1))
}
impl Token {
    pub(crate) fn replacement(&self, path: &str, directory: bool) -> Option<String> {
        if !valid_prefix(path) || !path.starts_with(&self.prefix) || path.len() > 2048 {
            return None;
        }
        let mut result = if self.dot {
            "./".to_owned()
        } else {
            String::new()
        };
        for c in path.chars() {
            if let Some(q) = self.quote {
                if c == q {
                    return None;
                }
            } else if c.is_whitespace() || "\\\"'`".contains(c) {
                result.push('\\');
            }
            result.push(c);
        }
        if directory {
            result.push('/');
        }
        Some(result)
    }
    pub(crate) fn utf16(&self, text: &str) -> Range<usize> {
        text[..self.range.start].encode_utf16().count()
            ..text[..self.range.end].encode_utf16().count()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Target {
    pub(crate) chat: String,
    pub(crate) cwd: String,
    pub(crate) generation: u64,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Capture {
    pub(crate) revision: u64,
    pub(crate) target: Target,
    pub(crate) key: String,
    pub(crate) intent: u64,
    pub(crate) text: String,
    pub(crate) selection: Range<usize>,
    pub(crate) token: Token,
}
#[cfg(test)]
#[path = "path_completion_tests.rs"]
mod tests;
