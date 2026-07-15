use std::ops::Range;

use base64::Engine;

use crate::error::{AQBotError, Result};

#[path = "inline_media_html.rs"]
mod html;
#[path = "inline_media_persistence.rs"]
mod persistence;
#[path = "inline_media_stream.rs"]
mod stream;
pub use persistence::{
    list_inline_media_diagnostics, matching_inline_media_diagnostic,
    materialize_inline_media_messages, materialize_message_inline_images,
    materialize_prepared_message_inline_images, materialize_streamed_inline_images,
    pending_inline_media_message_ids, record_inline_media_failure, InlineMediaDiagnostic,
    InlineMediaMigrationFailure, InlineMediaMigrationReport,
};
pub use stream::{
    contains_inline_image_data, filter_complete_inline_data, replace_pending_inline_media_tokens,
    CapturedInlineImage, InlineDataCaptureDelta, InlineDataStreamCapture, InlineDataStreamFilter,
};

const MAX_INLINE_IMAGE_BYTES: usize = 32 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InlineImage {
    pub mime_type: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct InlineImageDocument {
    source: String,
    url_ranges: Vec<Range<usize>>,
    images: Vec<InlineImage>,
}

pub struct PreparedInlineMedia {
    document: InlineImageDocument,
    safe_content: String,
}

impl PreparedInlineMedia {
    pub fn safe_content(&self) -> &str {
        &self.safe_content
    }

    pub(crate) fn document(&self) -> &InlineImageDocument {
        &self.document
    }
}

impl InlineImageDocument {
    pub fn images(&self) -> &[InlineImage] {
        // Occurrences intentionally remain one-to-one with replacement URLs.
        // Physical and database deduplication happen at persistence time.
        &self.images
    }

    pub fn rewrite(&self, urls: &[String]) -> Result<String> {
        if urls.len() != self.url_ranges.len() {
            return Err(AQBotError::Validation(format!(
                "Expected {} inline media URLs, got {}",
                self.url_ranges.len(),
                urls.len()
            )));
        }

        let mut rewritten = String::with_capacity(self.source.len());
        let mut cursor = 0;
        for (url_range, url) in self.url_ranges.iter().zip(urls) {
            rewritten.push_str(&self.source[cursor..url_range.start]);
            rewritten.push_str(url);
            cursor = url_range.end;
        }
        rewritten.push_str(&self.source[cursor..]);
        Ok(rewritten)
    }
}

pub fn prepare_message_inline_images(content: &str) -> Result<Option<PreparedInlineMedia>> {
    if !contains_inline_image_data(content) {
        return Ok(None);
    }

    let document = extract_inline_images(content)?;
    if document.images().is_empty() {
        if !contains_inline_image_data_outside_code(content) {
            return Ok(None);
        }
        return Err(AQBotError::Validation(
            "Inline image data must use Markdown image or HTML img syntax outside code blocks"
                .to_string(),
        ));
    }
    let placeholders = document
        .images()
        .iter()
        .map(|_| format!("aqbot-inline://pending/{}", crate::utils::gen_id()))
        .collect::<Vec<_>>();
    let safe_content = document.rewrite(&placeholders)?;
    if contains_inline_image_data_outside_code(&safe_content) {
        return Err(AQBotError::Validation(
            "Message contains inline image data outside supported Markdown image or HTML img syntax"
                .to_string(),
        ));
    }

    Ok(Some(PreparedInlineMedia {
        document,
        safe_content,
    }))
}

fn contains_inline_image_data_outside_code(content: &str) -> bool {
    const PREFIX: &[u8] = b"data:image/";
    let protected_ranges = code_ranges(content);
    content
        .as_bytes()
        .windows(PREFIX.len())
        .enumerate()
        .filter(|(_, window)| window.eq_ignore_ascii_case(PREFIX))
        .any(|(offset, _)| {
            !protected_ranges
                .iter()
                .any(|range| range.start <= offset && offset < range.end)
        })
}

pub fn extract_inline_images(content: &str) -> Result<InlineImageDocument> {
    let protected_ranges = code_ranges(content);
    let mut occurrences = Vec::new();
    let mut cursor = 0;
    while let Some(image_start) = content[cursor..].find("![") {
        let image_start = cursor + image_start;
        let preceding_backslashes = content.as_bytes()[..image_start]
            .iter()
            .rev()
            .take_while(|byte| **byte == b'\\')
            .count();
        if preceding_backslashes % 2 == 1 {
            cursor = image_start + 2;
            continue;
        }
        if let Some(protected) = protected_ranges
            .iter()
            .find(|range| range.start <= image_start && image_start < range.end)
        {
            cursor = protected.end;
            continue;
        }
        let Some(label_end_offset) = content[image_start + 2..].find("](") else {
            break;
        };
        let url_start = image_start + 2 + label_end_offset + 2;
        let Some(url_end_offset) = content[url_start..].find(')') else {
            break;
        };
        let url_end = url_start + url_end_offset;
        if let Some(image) = parse_data_image_uri(&content[url_start..url_end])? {
            occurrences.push((url_start..url_end, image));
        }
        cursor = url_end + 1;
    }

    html::collect_image_occurrences(content, &protected_ranges, &mut occurrences)?;
    occurrences.sort_by_key(|(range, _)| range.start);
    let (url_ranges, images) = occurrences.into_iter().unzip();

    Ok(InlineImageDocument {
        source: content.to_string(),
        url_ranges,
        images,
    })
}

fn code_ranges(content: &str) -> Vec<Range<usize>> {
    let bytes = content.as_bytes();
    let mut ranges = Vec::new();
    let mut fence: Option<(u8, usize, usize)> = None;
    let mut line_start = 0;

    while line_start < bytes.len() {
        let line_end = content[line_start..]
            .find('\n')
            .map(|offset| line_start + offset + 1)
            .unwrap_or(bytes.len());
        let content_end = if line_end > line_start && bytes[line_end - 1] == b'\n' {
            line_end - 1
        } else {
            line_end
        };
        let marker_start = line_start
            + bytes[line_start..content_end]
                .iter()
                .take(3)
                .take_while(|byte| **byte == b' ')
                .count();
        let marker = bytes.get(marker_start).copied();
        let marker_len = marker
            .filter(|value| matches!(value, b'`' | b'~'))
            .map(|value| {
                bytes[marker_start..content_end]
                    .iter()
                    .take_while(|byte| **byte == value)
                    .count()
            })
            .unwrap_or(0);

        match fence {
            Some((fence_marker, fence_len, fence_start)) => {
                let is_closer = marker == Some(fence_marker)
                    && marker_len >= fence_len
                    && bytes[marker_start + marker_len..content_end]
                        .iter()
                        .all(|byte| matches!(byte, b' ' | b'\t' | b'\r'));
                if is_closer {
                    ranges.push(fence_start..line_end);
                    fence = None;
                }
            }
            None if marker_len >= 3 => {
                fence = Some((marker.unwrap(), marker_len, line_start));
            }
            None => collect_inline_code_ranges(bytes, line_start, content_end, &mut ranges),
        }
        line_start = line_end;
    }

    if let Some((_, _, fence_start)) = fence {
        ranges.push(fence_start..content.len());
    }
    ranges
}

fn collect_inline_code_ranges(
    bytes: &[u8],
    line_start: usize,
    line_end: usize,
    ranges: &mut Vec<Range<usize>>,
) {
    let mut cursor = line_start;
    while cursor < line_end {
        if bytes[cursor] != b'`' {
            cursor += 1;
            continue;
        }
        let opener_len = bytes[cursor..line_end]
            .iter()
            .take_while(|byte| **byte == b'`')
            .count();
        let mut candidate = cursor + opener_len;
        let mut closer = None;
        while candidate < line_end {
            if bytes[candidate] != b'`' {
                candidate += 1;
                continue;
            }
            let run_len = bytes[candidate..line_end]
                .iter()
                .take_while(|byte| **byte == b'`')
                .count();
            if run_len == opener_len {
                closer = Some(candidate + run_len);
                break;
            }
            candidate += run_len;
        }
        if let Some(end) = closer {
            ranges.push(cursor..end);
            cursor = end;
        } else {
            cursor += opener_len;
        }
    }
}

fn parse_data_image_uri(value: &str) -> Result<Option<InlineImage>> {
    if value.len() < 5 || !value.as_bytes()[..5].eq_ignore_ascii_case(b"data:") {
        return Ok(None);
    }
    let rest = &value[5..];
    let Some((metadata, encoded)) = rest.split_once(',') else {
        return Err(AQBotError::Validation(
            "Invalid inline image data URI: missing comma".to_string(),
        ));
    };
    if metadata.len() < 7
        || !metadata.as_bytes()[metadata.len() - 7..].eq_ignore_ascii_case(b";base64")
    {
        return Err(AQBotError::Validation(
            "Inline images must use base64 encoding".to_string(),
        ));
    }
    let mime_type = metadata[..metadata.len() - 7].to_ascii_lowercase();
    if !matches!(
        mime_type.as_str(),
        "image/png" | "image/jpeg" | "image/webp" | "image/gif"
    ) {
        return Err(AQBotError::Validation(format!(
            "Unsupported inline image MIME type: {mime_type}"
        )));
    }
    let max_encoded_len = MAX_INLINE_IMAGE_BYTES.saturating_mul(4) / 3 + 4;
    if encoded.len() > max_encoded_len {
        return Err(AQBotError::Validation(format!(
            "Inline image exceeds the {} MiB limit",
            MAX_INLINE_IMAGE_BYTES / 1024 / 1024
        )));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|error| AQBotError::Validation(format!("Invalid inline image base64: {error}")))?;
    if bytes.len() > MAX_INLINE_IMAGE_BYTES {
        return Err(AQBotError::Validation(format!(
            "Inline image exceeds the {} MiB limit",
            MAX_INLINE_IMAGE_BYTES / 1024 / 1024
        )));
    }
    validate_image_bytes(&mime_type, &bytes)?;
    Ok(Some(InlineImage { mime_type, bytes }))
}

pub fn validate_image_bytes(mime_type: &str, bytes: &[u8]) -> Result<()> {
    let valid = match mime_type {
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "image/webp" => bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP",
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(AQBotError::Validation(format!(
            "Inline image bytes do not match declared MIME type {mime_type}"
        )))
    }
}
