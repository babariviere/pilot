//! Private text rules shared by otherwise independent features.

/// ECMAScript WhiteSpace + LineTerminator, not Rust White_Space.
pub(crate) fn is_ecmascript_whitespace(ch: char) -> bool {
    matches!(ch,
        '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' |
        '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' |
        '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// Mirrors daemon TrimString normalization. FEFF is removed; U+0085 stays.
pub(crate) fn trim_text(value: &str) -> &str {
    value.trim_matches(is_ecmascript_whitespace)
}

pub(crate) fn truncate_with_ellipsis(text: &str, cap: usize) -> String {
    if text.len() <= cap {
        return text.into();
    }
    let mut end = cap.saturating_sub(3);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &text[..end])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncation_keeps_byte_and_utf8_quirks() {
        for (text, cap, expected) in [
            ("", 0, ""),
            ("abc", 3, "abc"),
            ("abcd", 3, "…"),
            ("abcdef", 5, "ab…"),
            ("ééé", 5, "é…"),
            ("私私", 5, "…"),
            ("👩‍💻", 7, "👩…"),
            ("éxy", 4, "e…"),
            // Existing behavior: ellipsis can exceed a cap below three bytes.
            ("abc", 0, "…"),
            ("abc", 1, "…"),
            ("abc", 2, "…"),
        ] {
            assert_eq!(truncate_with_ellipsis(text, cap), expected);
        }
    }
}

#[cfg(test)]
mod whitespace_tests {
    use super::*;
    #[test]
    fn every_unicode_scalar_matches_the_independent_ecmascript_trim_oracle() {
        let oracle: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/ecmascript-trim.json")).unwrap();
        let points: Vec<u32> = oracle["trimmedCodePoints"]
            .as_array()
            .unwrap()
            .iter()
            .map(|n| n.as_u64().unwrap() as u32)
            .collect();
        assert_eq!(points.len(), 25);
        assert!(points.windows(2).all(|p| p[0] < p[1]));
        for codepoint in 0..=0x10ffff {
            if let Some(ch) = char::from_u32(codepoint) {
                assert_eq!(
                    is_ecmascript_whitespace(ch),
                    points.binary_search(&codepoint).is_ok()
                );
                let mut bytes = [0; 4];
                assert_eq!(
                    trim_text(ch.encode_utf8(&mut bytes)).is_empty(),
                    points.binary_search(&codepoint).is_ok(),
                    "U+{codepoint:04X}"
                );
            }
        }
        for case in oracle["cases"].as_array().unwrap() {
            assert_eq!(
                trim_text(case["input"].as_str().unwrap()),
                case["expected"].as_str().unwrap()
            );
        }
    }
}
