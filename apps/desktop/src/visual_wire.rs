//! Hostile PV replies, never trusted because they came from a sandboxed engine.
use serde_json::{Map, Number, Value};
const CAP: usize = 2 * 1024 * 1024;
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct InvalidWire;
pub(crate) fn decode(bytes: &[u8]) -> Result<Value, InvalidWire> {
    if bytes.len() > CAP || !bytes.starts_with(b"PV\x01") {
        return Err(InvalidWire);
    }
    let mut r = Reader {
        bytes,
        index: 3,
        strings: Vec::new(),
        values: 0,
        expanded: 0,
    };
    let value = r.value(0)?;
    if r.index != bytes.len() {
        return Err(InvalidWire);
    }
    Ok(value)
}
struct Reader<'a> {
    bytes: &'a [u8],
    index: usize,
    strings: Vec<String>,
    values: usize,
    expanded: usize,
}
impl Reader<'_> {
    fn byte(&mut self) -> Result<u8, InvalidWire> {
        let value = *self.bytes.get(self.index).ok_or(InvalidWire)?;
        self.index += 1;
        Ok(value)
    }
    fn varint(&mut self) -> Result<u64, InvalidWire> {
        let mut result = 0;
        for i in 0..10 {
            let b = self.byte()?;
            if i == 9 && b > 1 {
                return Err(InvalidWire);
            }
            result |= u64::from(b & 127) << (i * 7);
            if b & 128 == 0 {
                if i > 0 && b == 0 {
                    return Err(InvalidWire);
                }
                return Ok(result);
            }
        }
        Err(InvalidWire)
    }
    fn count(&mut self) -> Result<usize, InvalidWire> {
        let n = usize::try_from(self.varint()?).map_err(|_| InvalidWire)?;
        if n > self.bytes.len() - self.index || n > 100_000 {
            return Err(InvalidWire);
        }
        Ok(n)
    }
    fn string(&mut self) -> Result<String, InvalidWire> {
        let tag = self.varint()?;
        let value = if tag & 1 == 0 {
            self.strings
                .get((tag >> 1) as usize)
                .ok_or(InvalidWire)?
                .clone()
        } else {
            let n = usize::try_from(tag >> 1).map_err(|_| InvalidWire)?;
            let end = self.index.checked_add(n).ok_or(InvalidWire)?;
            let text = std::str::from_utf8(self.bytes.get(self.index..end).ok_or(InvalidWire)?)
                .map_err(|_| InvalidWire)?
                .to_owned();
            self.index = end;
            if n <= 64 && self.strings.len() < 4096 {
                self.strings.push(text.clone());
            }
            text
        };
        self.expanded = self.expanded.checked_add(value.len()).ok_or(InvalidWire)?;
        if self.expanded > 4 * 1024 * 1024 {
            return Err(InvalidWire);
        }
        Ok(value)
    }
    fn value(&mut self, depth: usize) -> Result<Value, InvalidWire> {
        self.values += 1;
        if depth > 64 || self.values > 100_000 {
            return Err(InvalidWire);
        }
        Ok(match self.byte()? {
            0 => Value::Null,
            1 => Value::Bool(false),
            2 => Value::Bool(true),
            3 => {
                let x = self.varint()?;
                let n = ((x >> 1) as i64) ^ (-((x & 1) as i64));
                if !(-9_007_199_254_740_992..=9_007_199_254_740_992).contains(&n) {
                    return Err(InvalidWire);
                }
                Value::Number(n.into())
            }
            4 => {
                let end = self.index.checked_add(8).ok_or(InvalidWire)?;
                let raw = self.bytes.get(self.index..end).ok_or(InvalidWire)?;
                let number = f64::from_le_bytes(raw.try_into().map_err(|_| InvalidWire)?);
                self.index = end;
                Value::Number(Number::from_f64(number).ok_or(InvalidWire)?)
            }
            5 => Value::String(self.string()?),
            6 => {
                let n = self.count()?;
                let mut out = Vec::with_capacity(n);
                for _ in 0..n {
                    out.push(self.value(depth + 1)?);
                }
                Value::Array(out)
            }
            7 => {
                let n = self.count()?;
                let mut out = Map::new();
                for _ in 0..n {
                    let k = self.string()?;
                    let v = self.value(depth + 1)?;
                    if out.insert(k, v).is_some() {
                        return Err(InvalidWire);
                    }
                }
                Value::Object(out)
            }
            _ => return Err(InvalidWire),
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn valid_interns_numbers_and_bad_utf8_duplicates_truncation_overflow() {
        assert_eq!(
            decode(b"PV\x01\x06\x03\x05\x03a\x05\x00\x03\x03").unwrap(),
            serde_json::json!(["a", "a", -2])
        );
        for data in [
            &b"PV\x01\x05\x03\xff"[..],
            &b"PV\x01\x07\x02\x03a\x00\x00\x00"[..],
            &b"PV\x01\x06\xff\xff\xff\xff\xff\xff\xff\xff\xff\x7f"[..],
            &b"PV\x01\x00\x00"[..],
        ] {
            assert!(decode(data).is_err());
        }
        let mut deep = b"PV\x01".to_vec();
        for _ in 0..66 {
            deep.extend([6, 1]);
        }
        deep.push(0);
        assert!(decode(&deep).is_err());
        let mut nan = b"PV\x01\x04".to_vec();
        nan.extend(f64::NAN.to_le_bytes());
        assert!(decode(&nan).is_err());
    }
}
