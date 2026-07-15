use std::ops::Range;

use crate::error::Result;

use super::{parse_data_image_uri, InlineImage};

pub(super) fn collect_image_occurrences(
    content: &str,
    protected_ranges: &[Range<usize>],
    occurrences: &mut Vec<(Range<usize>, InlineImage)>,
) -> Result<()> {
    let bytes = content.as_bytes();
    let mut cursor = 0;
    while cursor < bytes.len() {
        let Some(offset) = bytes[cursor..].iter().position(|byte| *byte == b'<') else {
            break;
        };
        let tag_start = cursor + offset;
        if let Some(protected) = protected_ranges
            .iter()
            .find(|range| range.start <= tag_start && tag_start < range.end)
        {
            cursor = protected.end;
            continue;
        }
        let name_start = tag_start + 1;
        let name_end = name_start.saturating_add(3);
        if name_end > bytes.len()
            || !bytes[name_start..name_end].eq_ignore_ascii_case(b"img")
            || bytes
                .get(name_end)
                .is_some_and(|byte| !byte.is_ascii_whitespace() && !matches!(byte, b'/' | b'>'))
        {
            cursor = name_start;
            continue;
        }
        let Some(tag_end) = tag_end(bytes, name_end) else {
            break;
        };
        if let Some(url_range) = src_range(bytes, name_end, tag_end) {
            if let Some(image) = parse_data_image_uri(&content[url_range.clone()])? {
                occurrences.push((url_range, image));
            }
        }
        cursor = tag_end + 1;
    }
    Ok(())
}

fn tag_end(bytes: &[u8], start: usize) -> Option<usize> {
    let mut quote = None;
    for (offset, byte) in bytes[start..].iter().enumerate() {
        match (quote, *byte) {
            (Some(active), value) if value == active => quote = None,
            (None, b'\'' | b'\"') => quote = Some(*byte),
            (None, b'>') => return Some(start + offset),
            _ => {}
        }
    }
    None
}

fn src_range(bytes: &[u8], start: usize, end: usize) -> Option<Range<usize>> {
    let mut cursor = start;
    while cursor < end {
        while cursor < end && (bytes[cursor].is_ascii_whitespace() || bytes[cursor] == b'/') {
            cursor += 1;
        }
        let name_start = cursor;
        while cursor < end
            && (bytes[cursor].is_ascii_alphanumeric()
                || matches!(bytes[cursor], b'-' | b'_' | b':' | b'.'))
        {
            cursor += 1;
        }
        if name_start == cursor {
            cursor += 1;
            continue;
        }
        let is_src = bytes[name_start..cursor].eq_ignore_ascii_case(b"src");
        while cursor < end && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        if cursor >= end || bytes[cursor] != b'=' {
            continue;
        }
        cursor += 1;
        while cursor < end && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        let (value_start, value_end) = match bytes.get(cursor).copied() {
            Some(quote @ (b'\'' | b'\"')) => {
                let value_start = cursor + 1;
                let value_end = bytes[value_start..end]
                    .iter()
                    .position(|byte| *byte == quote)
                    .map(|offset| value_start + offset)
                    .unwrap_or(end);
                cursor = value_end.saturating_add(1);
                (value_start, value_end)
            }
            Some(_) => {
                let value_start = cursor;
                while cursor < end && !bytes[cursor].is_ascii_whitespace() && bytes[cursor] != b'>'
                {
                    cursor += 1;
                }
                (value_start, cursor)
            }
            None => return None,
        };
        if is_src {
            return Some(value_start..value_end);
        }
    }
    None
}
