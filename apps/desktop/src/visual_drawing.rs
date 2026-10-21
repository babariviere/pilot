//! Hostile PD1 decoder. Structural validation is separate from native rendering budgets.
use crate::visual_wire::InvalidWire;
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Drawing {
    pub(crate) commands: usize,
    pub(crate) ops: Vec<f64>,
    pub(crate) strings: Vec<String>,
}
impl Drawing {
    pub(crate) fn checked(
        commands: usize,
        ops: Vec<f64>,
        strings: Vec<String>,
    ) -> Result<Self, InvalidWire> {
        if commands > 20_000
            || ops.len() > 2 * 1024 * 1024 / 8
            || strings.len() > 20_000
            || ops.iter().any(|n| !n.is_finite())
            || strings
                .iter()
                .map(|s| s.encode_utf16().count())
                .sum::<usize>()
                > 64 * 1024
        {
            return Err(InvalidWire);
        }
        if 24 + ops.len() * 8 + strings.iter().map(|s| s.len() + 4).sum::<usize>() > 2 * 1024 * 1024
        {
            return Err(InvalidWire);
        }
        let drawing = Self {
            commands,
            ops,
            strings,
        };
        drawing.validate()?;
        Ok(drawing)
    }
    pub(crate) fn decode(bytes: &[u8]) -> Result<Self, InvalidWire> {
        if bytes.len() < 24 || bytes.len() > 2 * 1024 * 1024 || &bytes[..4] != b"PD\x01\0" {
            return Err(InvalidWire);
        }
        let u32at = |i: usize| u32::from_le_bytes(bytes[i..i + 4].try_into().unwrap()) as usize;
        let commands = u32at(4);
        let count = u32at(8);
        let strings = u32at(12);
        let string_bytes = u32at(16);
        if u32at(20) != 0
            || commands > 20_000
            || strings > 20_000
            || count > (bytes.len() - 24) / 8
            || strings > string_bytes / 4
        {
            return Err(InvalidWire);
        }
        let end = 24 + count * 8;
        if string_bytes != bytes.len() - end {
            return Err(InvalidWire);
        }
        let ops = bytes[24..end]
            .as_chunks::<8>()
            .0
            .iter()
            .map(|b| f64::from_le_bytes(*b))
            .collect::<Vec<_>>();
        if ops.iter().any(|n| !n.is_finite()) {
            return Err(InvalidWire);
        }
        let mut pool = Vec::with_capacity(strings);
        let mut pos = end;
        let mut text = 0;
        for _ in 0..strings {
            let size = bytes.get(pos..pos + 4).ok_or(InvalidWire)?;
            let n = u32::from_le_bytes(size.try_into().unwrap()) as usize;
            pos += 4;
            let value = std::str::from_utf8(bytes.get(pos..pos + n).ok_or(InvalidWire)?)
                .map_err(|_| InvalidWire)?;
            pos += n;
            text += value.encode_utf16().count();
            if text > 64 * 1024 {
                return Err(InvalidWire);
            }
            pool.push(value.into());
        }
        if pos != bytes.len() {
            return Err(InvalidWire);
        }
        let result = Self {
            commands,
            ops,
            strings: pool,
        };
        result.validate()?;
        Ok(result)
    }
    fn validate(&self) -> Result<(), InvalidWire> {
        let mut r = Walk {
            ops: &self.ops,
            pos: 0,
        };
        let mut commands = 0;
        let mut depth = 0usize;
        let mut points = 0usize;
        while r.pos < r.ops.len() {
            commands += 1;
            if commands > self.commands {
                return Err(InvalidWire);
            }
            let op = r.take(1)?[0];
            match op {
                1. => {
                    depth += 1;
                    if depth > 64 {
                        return Err(InvalidWire);
                    }
                }
                2. => {
                    depth = depth.checked_sub(1).ok_or(InvalidWire)?;
                }
                3. | 5. => {
                    r.take(2)?;
                }
                4. => {
                    r.take(1)?;
                }
                6. => {
                    unit(r.take(1)?[0])?;
                }
                10. => {
                    let n = r.take(9)?;
                    paint(n)?;
                    if n[8] < 0. {
                        return Err(InvalidWire);
                    }
                }
                11. => {
                    let n = r.take(7)?;
                    paint(n)?;
                    if n[6] < 0. {
                        return Err(InvalidWire);
                    }
                }
                12. => {
                    paint(r.take(8)?)?;
                }
                13. => {
                    let n = r.take(6)?;
                    paint(n)?;
                    integer(n[4], 0, 1)?;
                    let count = integer(n[5], 0, 100_000)?;
                    points += count;
                    if points > 100_000 {
                        return Err(InvalidWire);
                    }
                    r.take(count * 2)?;
                }
                14. => {
                    let n = r.take(10)?;
                    paint(n)?;
                    if n[6] < 0. || n[7] < 0. || n[7] > n[6] {
                        return Err(InvalidWire);
                    }
                }
                20. => {
                    let n = r.take(10)?;
                    integer(n[0], 0, 12)?;
                    unit(n[1])?;
                    if self.strings.is_empty() {
                        return Err(InvalidWire);
                    }
                    integer(n[4], 0, self.strings.len() - 1)?;
                    integer(n[5], 0, 4)?;
                    if ![400., 500., 600., 700.].contains(&n[6]) {
                        return Err(InvalidWire);
                    }
                    integer(n[7], 0, 2)?;
                    integer(n[8], 0, 2)?;
                    integer(n[9], 0, 1)?;
                }
                _ => return Err(InvalidWire),
            }
        }
        if commands != self.commands {
            return Err(InvalidWire);
        }
        Ok(())
    }
}
fn integer(n: f64, min: usize, max: usize) -> Result<usize, InvalidWire> {
    if !n.is_finite() || n.fract() != 0. || n < min as f64 || n > max as f64 {
        return Err(InvalidWire);
    }
    Ok(n as usize)
}
fn unit(n: f64) -> Result<(), InvalidWire> {
    if !(0.0..=1.0).contains(&n) {
        return Err(InvalidWire);
    }
    Ok(())
}
fn paint(n: &[f64]) -> Result<(), InvalidWire> {
    integer(n[0], 1, 2)?;
    integer(n[1], 0, 12)?;
    unit(n[2])?;
    if n[3] < 0. || (n[0] == 1. && n[3] != 0.) {
        return Err(InvalidWire);
    }
    Ok(())
}
struct Walk<'a> {
    ops: &'a [f64],
    pos: usize,
}
impl<'a> Walk<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [f64], InvalidWire> {
        let end = self.pos.checked_add(n).ok_or(InvalidWire)?;
        let values = self.ops.get(self.pos..end).ok_or(InvalidWire)?;
        self.pos = end;
        Ok(values)
    }
}
#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    pub(crate) fn encode(commands: usize, ops: &[f64], strings: &[String]) -> Vec<u8> {
        let mut data = b"PD\x01\0".to_vec();
        let strings_bytes = strings.iter().map(|s| s.len() + 4).sum::<usize>();
        for n in [commands, ops.len(), strings.len(), strings_bytes, 0] {
            data.extend((n as u32).to_le_bytes());
        }
        for n in ops {
            data.extend(n.to_le_bytes());
        }
        for s in strings {
            data.extend((s.len() as u32).to_le_bytes());
            data.extend(s.as_bytes());
        }
        data
    }
    #[test]
    fn hostile_counts_utf8_numbers_commands_and_paint_are_rejected() {
        let valid = encode(1, &[11., 1., 2., 1., 0., 10., 20., 5.], &[]);
        assert!(Drawing::decode(&valid).is_ok());
        for size in 0..valid.len() {
            assert!(Drawing::decode(&valid[..size]).is_err());
        }
        for ops in [
            vec![99.],
            vec![2.],
            vec![6., f64::NAN],
            vec![6., 1.1],
            vec![11., 1., 1.5, 1., 0., 0., 0., 1.],
            vec![13., 1., 0., 1., 0., 0., 100_001.],
        ] {
            assert!(Drawing::decode(&encode(1, &ops, &[])).is_err());
        }
        let mut count = valid.clone();
        count[4..8].copy_from_slice(&0u32.to_le_bytes());
        assert!(Drawing::decode(&count).is_err());
        let mut reserved = valid.clone();
        reserved[20] = 1;
        assert!(Drawing::decode(&reserved).is_err());
        let mut utf8 = encode(0, &[], &["a".into()]);
        *utf8.last_mut().unwrap() = 255;
        assert!(Drawing::decode(&utf8).is_err());
    }
}
