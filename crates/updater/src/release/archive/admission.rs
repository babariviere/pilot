//! Admission only, not a ZIP decoder. Keep decompression/extra-field semantics in zip.
use crate::{Error, transport::Cancellation};
use std::{
    collections::BTreeSet,
    fs::File,
    io::{self, Read, Seek, SeekFrom},
};

pub(super) const MAX_ENTRIES: usize = 30_000;
const MAX_DIRECTORY: u64 = 64 * 1024 * 1024;
const EOCD: &[u8] = b"PK\x05\x06";
const EOCD64: &[u8] = b"PK\x06\x06";

fn u16_at(bytes: &[u8], at: usize) -> u16 {
    u16::from_le_bytes(bytes[at..at + 2].try_into().unwrap())
}
fn u32_at(bytes: &[u8], at: usize) -> u64 {
    u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap()).into()
}
fn u64_at(bytes: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(bytes[at..at + 8].try_into().unwrap())
}
fn read_at(file: &mut (impl Read + Seek), at: u64, bytes: &mut [u8]) -> Result<(), Error> {
    file.seek(SeekFrom::Start(at))
        .and_then(|_| file.read_exact(bytes))
        .map_err(|_| Error::Archive)
}

pub(super) fn index(mut file: File, cancel: &Cancellation) -> Result<zip::ZipArchive<File>, Error> {
    let (reader, count) = preflight(&mut file, cancel)?;
    let start = reader.start;
    let zip = zip::ZipArchive::with_config(
        zip::read::Config {
            archive_offset: zip::read::ArchiveOffset::Known(0),
        },
        reader,
    )
    .map_err(|_| cancel.check().err().unwrap_or(Error::Archive))?;
    cancel.check()?;
    if zip.len() as u64 != count || zip.central_directory_start() != start {
        return Err(Error::Archive);
    }
    // SAFETY: metadata was decoded by zip from an exact snapshot at its original
    // absolute offsets, with archive offset zero. The only changed bytes are the
    // unused archive comment length. The same open file supplies entry payloads.
    Ok(unsafe { zip::ZipArchive::unsafe_new_with_metadata(file, zip.metadata()) })
}

fn preflight<'a>(
    file: &mut (impl Read + Seek),
    cancel: &'a Cancellation,
) -> Result<(MetadataReader<'a>, u64), Error> {
    cancel.check()?;
    let length = file.seek(SeekFrom::End(0)).map_err(|_| Error::Archive)?;
    // A canonical single-disk archive ends with EOCD + its declared comment.
    // Do not let zip's permissive backwards search choose unadmitted older footers.
    let mut tail = vec![0; length.min(22 + u16::MAX as u64) as usize];
    read_at(file, length - tail.len() as u64, &mut tail)?;
    let end = tail.len().checked_sub(22).ok_or(Error::Archive)?;
    let at = (0..=end)
        .rev()
        .find(|&at| {
            &tail[at..at + 4] == EOCD && at + 22 + usize::from(u16_at(&tail, at + 20)) == tail.len()
        })
        .ok_or(Error::Archive)?;
    let footer = length - tail.len() as u64 + at as u64;
    let eocd = &tail[at..at + 22];
    if u16_at(eocd, 4) != 0 || u16_at(eocd, 6) != 0 {
        return Err(Error::Archive);
    }
    let mut count = u64::from(u16_at(eocd, 10));
    let mut bytes = u32_at(eocd, 12);
    let mut start = u32_at(eocd, 16);
    // Match zip9.1.3's Zip32CentralDirectoryEnd::may_be_zip64 exactly.
    // Its dispatch ignores the per-disk count; ZIP32 indexing then USES that
    // count. An adjacent locator alone must not authorize a different count.
    let zip64_dispatch =
        count == u16::MAX as u64 || bytes == u32::MAX as u64 || start == u32::MAX as u64;
    let mut directory_end = footer;
    let mut zip64_footer = None;
    let mut zip64_record = None;
    // ZIP64 may be used even for a small archive. Inspect the adjacent locator,
    // not just the 32-bit sentinel values. All offsets/counts must agree.
    let mut locator = [0; 20];
    if footer >= 20 {
        read_at(file, footer - 20, &mut locator)?;
    }
    if &locator[..4] == b"PK\x06\x07" {
        if u32_at(&locator, 4) != 0 || u32_at(&locator, 16) != 1 {
            return Err(Error::Archive);
        }
        let offset = u64_at(&locator, 8);
        let mut record = [0; 56];
        if offset.checked_add(56).is_none_or(|end| end > footer - 20) {
            return Err(Error::Archive);
        }
        read_at(file, offset, &mut record)?;
        let size = u64_at(&record, 4);
        if &record[..4] != EOCD64
            || !(44..=MAX_DIRECTORY).contains(&size)
            || offset.checked_add(12 + size) != Some(footer - 20)
            || u32_at(&record, 16) != 0
            || u32_at(&record, 20) != 0
            || u64_at(&record, 24) != u64_at(&record, 32)
        {
            return Err(Error::Archive);
        }
        count = u64_at(&record, 32);
        bytes = u64_at(&record, 40);
        start = u64_at(&record, 48);
        directory_end = offset;
        zip64_footer = Some(offset);
        zip64_record = Some(record);
        if (u16_at(eocd, 10) != u16::MAX && u64::from(u16_at(eocd, 10)) != count)
            || (u16_at(eocd, 8) != u16::MAX && u64::from(u16_at(eocd, 8)) != count)
            || (u32_at(eocd, 12) != u32::MAX as u64 && u32_at(eocd, 12) != bytes)
            || (u32_at(eocd, 16) != u32::MAX as u64 && u32_at(eocd, 16) != start)
        {
            return Err(Error::Archive);
        }
        if !zip64_dispatch && u64::from(u16_at(eocd, 8)) != count {
            return Err(Error::Archive);
        }
    } else if u16_at(eocd, 8) != u16_at(eocd, 10) {
        return Err(Error::Archive);
    }
    // Bound allocation and raw count BEFORE zip can reserve or deduplicate.
    if count == 0
        || count > MAX_ENTRIES as u64
        || bytes > MAX_DIRECTORY
        || bytes < count * 46
        || start.checked_add(bytes) != Some(directory_end)
        || footer - start > MAX_DIRECTORY + 76
    {
        return Err(Error::Archive);
    }
    cancel.check()?;
    let mut metadata = vec![0; (footer + 22 - start) as usize];
    // Snapshot the admitted directory so indexing sees exactly the checked bytes.
    // Read in cancellable chunks, without touching any compressed file payload.
    for (i, chunk) in metadata.chunks_mut(65536).enumerate() {
        cancel.check()?;
        read_at(file, start + (i * 65536) as u64, chunk)?;
    }
    // Do not index a footer changed between the small admission reads and snapshot.
    if &metadata[(footer - start) as usize..] != eocd {
        return Err(Error::Archive);
    }
    if let (Some(offset), Some(record)) = (zip64_footer, zip64_record)
        && (metadata[(offset - start) as usize..(offset - start) as usize + 56] != record
            || metadata[(footer - start - 20) as usize..(footer - start) as usize] != locator)
    {
        return Err(Error::Archive);
    }
    let mut cursor = 0;
    let mut names = BTreeSet::new();
    for _ in 0..count {
        cancel.check()?;
        let header = metadata
            .get(cursor..cursor + 46)
            .filter(|header| &header[..4] == b"PK\x01\x02")
            .ok_or(Error::Archive)?;
        let name_len = usize::from(u16_at(header, 28));
        let next = cursor
            + 46
            + name_len
            + usize::from(u16_at(header, 30))
            + usize::from(u16_at(header, 32));
        if name_len == 0 || name_len > 1024 || next as u64 > bytes {
            return Err(Error::Archive);
        }
        let name = &metadata[cursor + 46..cursor + 46 + name_len];
        // Also reject file/directory aliases; zip otherwise silently keeps the last
        // duplicate raw name. Unicode-extra-field aliases are checked after indexing.
        let name = name.strip_suffix(b"/").unwrap_or(name);
        if !names.insert(name.to_vec()) {
            return Err(Error::Archive);
        }
        cursor = next;
    }
    if cursor as u64 != bytes {
        return Err(Error::Archive);
    }
    // Comments are opaque. Hide only the EOCD comment from the indexing view so
    // embedded signatures cannot select an alternative footer. Payload is unchanged.
    let end = metadata.len();
    metadata[end - 2..].fill(0);
    let work = 4 * (metadata.len() as u64 + 65557);
    Ok((
        MetadataReader {
            bytes: metadata,
            start,
            footer,
            zip64_footer,
            position: 0,
            remaining: work,
            cancel,
        },
        count,
    ))
}

/// During indexing, expose only the admitted metadata and zero-filled payload.
/// zip9.1 may retry older EOCDs after a header error. Refuse those seeks BEFORE it
/// can reserve from an unchecked count; a byte budget also bounds failed searches.
struct MetadataReader<'a> {
    bytes: Vec<u8>,
    start: u64,
    footer: u64,
    zip64_footer: Option<u64>,
    position: u64,
    remaining: u64,
    cancel: &'a Cancellation,
}
impl Read for MetadataReader<'_> {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        self.cancel
            .check()
            .map_err(|_| io::Error::other("cancelled"))?;
        let length = self.start + self.bytes.len() as u64;
        let n = (length.saturating_sub(self.position)).min(output.len() as u64);
        self.remaining = self
            .remaining
            .checked_sub(n)
            .ok_or_else(|| io::Error::other("metadata work limit"))?;
        let n = n as usize;
        output[..n].fill(0);
        let begin = self.position.max(self.start);
        let end = self.position + n as u64;
        if begin < end {
            output[(begin - self.position) as usize..n].copy_from_slice(
                &self.bytes[(begin - self.start) as usize..(end - self.start) as usize],
            );
        }
        self.position = end;
        Ok(n)
    }
}
impl Seek for MetadataReader<'_> {
    fn seek(&mut self, from: SeekFrom) -> io::Result<u64> {
        self.cancel
            .check()
            .map_err(|_| io::Error::other("cancelled"))?;
        let position = match from {
            SeekFrom::Start(n) => Some(n),
            SeekFrom::End(n) => (self.start + self.bytes.len() as u64).checked_add_signed(n),
            SeekFrom::Current(n) => self.position.checked_add_signed(n),
        }
        .ok_or_else(|| io::Error::other("invalid metadata seek"))?;
        if position >= self.start {
            let sig = self
                .bytes
                .get((position - self.start) as usize..)
                .and_then(|bytes| bytes.get(..4));
            if (sig == Some(EOCD) && position != self.footer)
                || (sig == Some(EOCD64) && Some(position) != self.zip64_footer)
            {
                return Err(io::Error::other("unadmitted footer"));
            }
        }
        self.position = position;
        Ok(position)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    // Deliberately write RAW central records. ZipWriter refuses/deduplicates names,
    // which made the old test's purported duplicate coverage ineffective.
    fn raw_directory(count: usize, duplicates: bool, zip64: bool) -> Vec<u8> {
        raw_directory_at(count, duplicates, zip64, 31)
    }

    fn raw_directory_at(count: usize, duplicates: bool, zip64: bool, start: usize) -> Vec<u8> {
        let mut bytes = vec![0; start];
        bytes[..4].copy_from_slice(b"PK\x03\x04");
        bytes[26] = 1;
        bytes[30] = b'x';
        for i in 0..count {
            let name = format!(
                "Pilot Next.app/Contents/{:05}",
                if duplicates { 0 } else { i }
            );
            let mut header = [0; 46];
            header[..4].copy_from_slice(b"PK\x01\x02");
            header[4..6].copy_from_slice(&0x0314u16.to_le_bytes());
            header[28..30].copy_from_slice(&(name.len() as u16).to_le_bytes());
            bytes.extend(header);
            bytes.extend(name.as_bytes());
        }
        let directory_size = bytes.len() as u64 - start as u64;
        if zip64 {
            let offset = bytes.len() as u64;
            bytes.extend(EOCD64);
            bytes.extend(44u64.to_le_bytes());
            bytes.extend([45, 0, 45, 0]);
            bytes.extend([0; 8]);
            bytes.extend((count as u64).to_le_bytes());
            bytes.extend((count as u64).to_le_bytes());
            bytes.extend(directory_size.to_le_bytes());
            bytes.extend((start as u64).to_le_bytes());
            bytes.extend(b"PK\x06\x07");
            bytes.extend(0u32.to_le_bytes());
            bytes.extend(offset.to_le_bytes());
            bytes.extend(1u32.to_le_bytes());
        }
        bytes.extend(EOCD);
        bytes.extend([0; 4]);
        let n = if zip64 { u16::MAX } else { count as u16 };
        bytes.extend(n.to_le_bytes());
        bytes.extend(n.to_le_bytes());
        bytes.extend(
            if zip64 {
                u32::MAX
            } else {
                directory_size as u32
            }
            .to_le_bytes(),
        );
        bytes.extend(if zip64 { u32::MAX } else { start as u32 }.to_le_bytes());
        bytes.extend([0; 2]);
        bytes
    }

    struct Observed {
        bytes: Cursor<Vec<u8>>,
        read: usize,
        cancel_after: usize,
        cancel: Cancellation,
        change_before_snapshot: Option<(usize, Vec<u8>)>,
    }
    impl Read for Observed {
        fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
            let n = self.bytes.read(out)?;
            self.read += n;
            if self.read >= self.cancel_after {
                self.cancel.cancel();
            }
            Ok(n)
        }
    }
    impl Seek for Observed {
        fn seek(&mut self, from: SeekFrom) -> io::Result<u64> {
            if from == SeekFrom::Start(31)
                && let Some((at, replacement)) = self.change_before_snapshot.take()
            {
                self.bytes.get_mut()[at..at + replacement.len()].copy_from_slice(&replacement);
            }
            self.bytes.seek(from)
        }
    }
    fn observed(bytes: Vec<u8>) -> Observed {
        Observed {
            bytes: Cursor::new(bytes),
            read: 0,
            cancel_after: usize::MAX,
            cancel: Cancellation::default(),
            change_before_snapshot: None,
        }
    }

    // Bits: per-disk count, total count, directory size, directory offset.
    fn mixed_footer(mask: u8, zip64: bool) -> Vec<u8> {
        let mut bytes = raw_directory_at(1, false, zip64, 100_000);
        let end = bytes.len() - 22;
        let directory_end = end - if zip64 { 76 } else { 0 };
        for (bit, at) in [(1, 8), (2, 10)] {
            bytes[end + at..end + at + 2]
                .copy_from_slice(&if mask & bit != 0 { u16::MAX } else { 1 }.to_le_bytes());
        }
        for (bit, at, value) in [(4, 12, (directory_end - 100_000) as u32), (8, 16, 100_000)] {
            bytes[end + at..end + at + 4]
                .copy_from_slice(&if mask & bit != 0 { u32::MAX } else { value }.to_le_bytes());
        }
        bytes
    }

    struct HeaderReads<R> {
        source: R,
        positions: std::rc::Rc<std::cell::RefCell<Vec<u64>>>,
    }
    impl<R: Read + Seek> Read for HeaderReads<R> {
        fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
            if out.len() == 46 {
                self.positions
                    .borrow_mut()
                    .push(self.source.stream_position()?);
            }
            self.source.read(out)
        }
    }
    impl<R: Seek> Seek for HeaderReads<R> {
        fn seek(&mut self, from: SeekFrom) -> io::Result<u64> {
            self.source.seek(from)
        }
    }

    #[test]
    fn mixed_per_disk_sentinel_is_rejected_before_central_header_reads() {
        let cancel = Cancellation::default();
        // The small ZIP64 control is admitted. Mutating only its snapshot per-disk
        // field models exactly what the old preflight handed to the eager index.
        let (mut reader, count) =
            preflight(&mut Cursor::new(mixed_footer(0, true)), &cancel).unwrap();
        assert_eq!(count, 1);
        assert_eq!(reader.start, 100_000);
        assert!(reader.start >= u16::MAX as u64); // defeats zip's capacity-zero optimization
        let footer_at = (reader.footer - reader.start) as usize;
        reader.bytes[footer_at + 8..footer_at + 10].copy_from_slice(&u16::MAX.to_le_bytes());
        let positions = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
        assert!(
            zip::ZipArchive::with_config(
                zip::read::Config {
                    archive_offset: zip::read::ArchiveOffset::Known(0)
                },
                HeaderReads {
                    source: reader,
                    positions: positions.clone()
                },
            )
            .is_err()
        );
        // ZIP9 rejects this inconsistent count before central-header reads.
        // Admission still rejects it before snapshot/index allocation below.
        assert!(positions.borrow().is_empty());
        let raw_positions = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
        assert!(
            zip::ZipArchive::with_config(
                zip::read::Config {
                    archive_offset: zip::read::ArchiveOffset::Known(0)
                },
                HeaderReads {
                    source: Cursor::new(mixed_footer(1, true)),
                    positions: raw_positions.clone()
                },
            )
            .is_err()
        );
        assert!(raw_positions.borrow().is_empty());
        let mut source = observed(mixed_footer(1, true));
        assert!(matches!(
            preflight(&mut source, &cancel),
            Err(Error::Archive)
        ));
        assert_eq!(source.read, 65557 + 20 + 56); // refused before snapshot/index allocation
    }

    #[test]
    fn all_footer_sentinel_combinations_match_actual_pinned_parser_dispatch() {
        for zip64 in [false, true] {
            for mask in 0..16 {
                let bytes = mixed_footer(mask, zip64);
                let cancel = Cancellation::default();
                // Without ZIP64, only ordinary agreeing ZIP32 fields are valid.
                // With ZIP64, the only unsafe combination is the per-disk-only
                // sentinel: none of zip's three ZIP64 dispatch fields is set.
                let admitted = if zip64 { mask != 1 } else { mask == 0 };
                let result = preflight(&mut Cursor::new(&bytes), &cancel);
                if !admitted {
                    assert!(
                        matches!(result, Err(Error::Archive)),
                        "zip64={zip64} mask={mask}"
                    );
                    continue;
                }
                let (reader, count) = result.unwrap();
                let positions = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
                let zip = zip::ZipArchive::with_config(
                    zip::read::Config {
                        archive_offset: zip::read::ArchiveOffset::Known(0),
                    },
                    HeaderReads {
                        source: reader,
                        positions: positions.clone(),
                    },
                )
                .unwrap_or_else(|error| panic!("zip64={zip64} mask={mask}: {error}"));
                assert_eq!(count, 1);
                assert_eq!(zip.len(), 1);
                assert_eq!(zip.central_directory_start(), 100_000);
                assert_eq!(*positions.borrow(), [100_000]);
                // Also exercise the real raw bytes, not only the indexing view.
                assert_eq!(zip::ZipArchive::new(Cursor::new(bytes)).unwrap().len(), 1);
            }
        }
    }

    #[test]
    fn raw_duplicates_are_real_and_rejected_before_indexing() {
        for count in [2, MAX_ENTRIES, MAX_ENTRIES + 1] {
            let bytes = raw_directory(count, true, false);
            // Establish the fixture really reproduces the pinned library's dedup.
            assert_eq!(zip::ZipArchive::new(Cursor::new(&bytes)).unwrap().len(), 1);
            assert!(matches!(
                preflight(&mut Cursor::new(bytes), &Cancellation::default()),
                Err(Error::Archive)
            ));
        }
    }

    #[test]
    fn file_directory_aliases_are_rejected_even_without_zip_deduplication() {
        let mut bytes = raw_directory(2, true, false);
        let name_len = usize::from(u16_at(&bytes, 31 + 28));
        let second = 31 + 46 + name_len;
        bytes[second + 28..second + 30].copy_from_slice(&((name_len + 1) as u16).to_le_bytes());
        bytes.insert(second + 46 + name_len, b'/');
        let end = bytes.len() - 22;
        bytes[end + 12..end + 16].copy_from_slice(&((end - 31) as u32).to_le_bytes());
        assert_eq!(zip::ZipArchive::new(Cursor::new(&bytes)).unwrap().len(), 2);
        assert!(matches!(
            preflight(&mut Cursor::new(bytes), &Cancellation::default()),
            Err(Error::Archive)
        ));
    }

    #[test]
    fn raw_count_boundary_and_underdeclared_records() {
        for zip64 in [false, true] {
            let bytes = raw_directory(MAX_ENTRIES, false, zip64);
            let cancel = Cancellation::default();
            let (reader, count) = preflight(&mut Cursor::new(bytes), &cancel).unwrap();
            assert_eq!(count, MAX_ENTRIES as u64);
            let zip = zip::ZipArchive::with_config(
                zip::read::Config {
                    archive_offset: zip::read::ArchiveOffset::Known(0),
                },
                reader,
            )
            .unwrap();
            assert_eq!(zip.len(), MAX_ENTRIES);
            let mut bytes = raw_directory(MAX_ENTRIES + 1, false, zip64);
            assert!(matches!(
                preflight(&mut Cursor::new(&bytes), &cancel),
                Err(Error::Archive)
            ));
            if !zip64 {
                let end = bytes.len() - 22;
                bytes[end + 8..end + 12].copy_from_slice(&[1, 0, 1, 0]);
                assert!(matches!(
                    preflight(&mut Cursor::new(bytes), &cancel),
                    Err(Error::Archive)
                ));
            }
        }
    }

    #[test]
    fn forged_zip64_counts_sizes_offsets_and_disk_fields_fail_before_directory_read() {
        let original = raw_directory(1, false, true);
        let record = original.len() - 22 - 20 - 56;
        for (at, value) in [
            (24, u64::MAX),
            (32, u64::MAX),
            (40, MAX_DIRECTORY + 1),
            (48, u64::MAX),
            (4, u64::MAX),
        ] {
            let mut bytes = original.clone();
            bytes[record + at..record + at + 8].copy_from_slice(&value.to_le_bytes());
            let mut source = observed(bytes);
            let cancel = source.cancel.clone();
            assert!(matches!(
                preflight(&mut source, &cancel),
                Err(Error::Archive)
            ));
            assert!(source.read <= original.len() + 20 + 56);
        }
        let mut bytes = raw_directory(1, false, false);
        let end = bytes.len() - 22;
        bytes[end + 8..end + 12].copy_from_slice(&[255; 4]);
        assert!(matches!(
            preflight(&mut Cursor::new(bytes), &Cancellation::default()),
            Err(Error::Archive)
        ));
    }

    #[test]
    fn malformed_raw_records_and_footer_disagreement_are_rejected() {
        let original = raw_directory(1, false, false);
        for (at, value) in [
            (31, 0),
            (31 + 29, 255),
            (31 + 31, 255),
            (original.len() - 22 + 4, 1),
            (original.len() - 22 + 8, 2),
        ] {
            let mut bytes = original.clone();
            bytes[at] = value;
            assert!(matches!(
                preflight(&mut Cursor::new(bytes), &Cancellation::default()),
                Err(Error::Archive)
            ));
        }
        for cut in [0, 3, 21, original.len() - 1] {
            assert!(matches!(
                preflight(&mut Cursor::new(&original[..cut]), &Cancellation::default()),
                Err(Error::Archive)
            ));
        }
    }

    #[test]
    fn cancellation_before_tail_during_snapshot_and_before_index_is_observed() {
        let bytes = raw_directory(2000, false, false);
        for after in [0, 65557, 65557 + 20 + 65536] {
            let mut source = observed(bytes.clone());
            source.cancel_after = after;
            let cancel = source.cancel.clone();
            if after == 0 {
                cancel.cancel();
            }
            assert!(matches!(
                preflight(&mut source, &cancel),
                Err(Error::Cancelled)
            ));
            if after == 0 {
                assert_eq!(source.read, 0);
            }
        }
        let cancel = Cancellation::default();
        let (reader, _) = preflight(&mut Cursor::new(bytes), &cancel).unwrap();
        cancel.cancel();
        assert!(zip::ZipArchive::new(reader).is_err());
    }

    #[test]
    fn footer_snapshot_must_match_the_admitted_counts() {
        for zip64 in [false, true] {
            let bytes = raw_directory(1, false, zip64);
            let end = bytes.len() - 22;
            let mut source = observed(bytes);
            let at = if zip64 { end - 20 - 56 + 32 } else { end + 10 };
            source.change_before_snapshot = Some((at, vec![255; if zip64 { 8 } else { 2 }]));
            let cancel = source.cancel.clone();
            assert!(matches!(
                preflight(&mut source, &cancel),
                Err(Error::Archive)
            ));
        }
    }

    #[test]
    fn metadata_reader_refuses_alternative_footers_and_bounds_search_work() {
        let cancel = Cancellation::default();
        let (mut reader, _) =
            preflight(&mut Cursor::new(raw_directory(1, false, false)), &cancel).unwrap();
        // Model an older footer hidden in metadata after the outer header fails.
        reader.bytes[50..54].copy_from_slice(EOCD);
        assert!(reader.seek(SeekFrom::Start(reader.start + 50)).is_err());
        reader.bytes[50..54].copy_from_slice(EOCD64);
        assert!(reader.seek(SeekFrom::Start(reader.start + 50)).is_err());
        reader.seek(SeekFrom::Start(reader.footer)).unwrap();
        reader.remaining = 3;
        assert!(reader.read(&mut [0; 4]).is_err());
    }
}
