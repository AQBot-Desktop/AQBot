use std::io::Write;
use std::path::{Path, PathBuf};

use base64::Engine;

use crate::error::{AQBotError, Result};

const DATA_IMAGE_PREFIX: &[u8] = b"data:image/";
const PENDING_PLACEHOLDER: &str = "[图片接收中]";
const CODE_DATA_PLACEHOLDER: &str = "[图片数据已省略]";
const MAX_DECODED_IMAGE_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Debug, Default)]
pub struct InlineDataStreamFilter {
    pending: String,
    suppressing_data_uri: bool,
}

impl InlineDataStreamFilter {
    /// Filters a provider delta before it crosses the Tauri event boundary.
    /// A short suffix is retained so `data:image/` cannot evade detection by
    /// being split across adjacent provider chunks.
    pub fn push(&mut self, chunk: &str) -> String {
        self.pending.push_str(chunk);
        let mut output = String::new();

        loop {
            if self.suppressing_data_uri {
                if let Some((offset, delimiter)) = self
                    .pending
                    .char_indices()
                    .find(|(_, value)| matches!(value, ')' | '\'' | '"' | '>'))
                {
                    let consumed = offset + delimiter.len_utf8();
                    output.push(delimiter);
                    self.pending.drain(..consumed);
                    self.suppressing_data_uri = false;
                    continue;
                }
                self.pending.clear();
                break;
            }

            if let Some(offset) = find_data_image_prefix(&self.pending) {
                output.push_str(&self.pending[..offset]);
                self.pending.drain(..offset + DATA_IMAGE_PREFIX.len());
                output.push_str(PENDING_PLACEHOLDER);
                self.suppressing_data_uri = true;
                continue;
            }

            let retained = partial_prefix_suffix_len(self.pending.as_bytes());
            let emit_end = self.pending.len() - retained;
            output.push_str(&self.pending[..emit_end]);
            self.pending.drain(..emit_end);
            break;
        }

        output
    }

    /// Flushes ordinary retained text. An unterminated data URI remains
    /// suppressed, because emitting it would leak the payload over IPC.
    pub fn finish(&mut self) -> String {
        if self.suppressing_data_uri {
            self.pending.clear();
            self.suppressing_data_uri = false;
            return String::new();
        }
        std::mem::take(&mut self.pending)
    }
}

/// Filters a complete value before it is persisted or returned over IPC.
///
/// This is intentionally built on the streaming filter so complete values and
/// provider deltas have identical case-insensitive `data:image/` handling.
pub fn filter_complete_inline_data(value: &str) -> String {
    let mut filter = InlineDataStreamFilter::default();
    let mut filtered = filter.push(value);
    filtered.push_str(&filter.finish());
    filtered
}

/// Detects inline image data without copying the potentially multi-megabyte
/// value. IPC boundaries use this to fail closed when persistence did not
/// replace a data URI with a stored-media reference.
pub fn contains_inline_image_data(value: &str) -> bool {
    find_data_image_prefix(value).is_some()
}

fn find_data_image_prefix(value: &str) -> Option<usize> {
    value
        .as_bytes()
        .windows(DATA_IMAGE_PREFIX.len())
        .position(|window| window.eq_ignore_ascii_case(DATA_IMAGE_PREFIX))
}

fn partial_prefix_suffix_len(value: &[u8]) -> usize {
    let max_len = value.len().min(DATA_IMAGE_PREFIX.len() - 1);
    (1..=max_len)
        .rev()
        .find(|length| {
            value[value.len() - length..].eq_ignore_ascii_case(&DATA_IMAGE_PREFIX[..*length])
        })
        .unwrap_or(0)
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct InlineDataCaptureDelta {
    /// Safe text retained for eventual database persistence. Data URIs are
    /// represented by unique temporary tokens until they are committed.
    pub content: String,
    /// Safe text sent to the renderer. It contains only a fixed-size pending
    /// placeholder while image bytes are being received.
    pub event_content: String,
}

#[derive(Debug)]
pub struct CapturedInlineImage {
    token: String,
    mime_type: String,
    decoded_path: PathBuf,
}

impl CapturedInlineImage {
    pub fn token(&self) -> &str {
        &self.token
    }

    pub fn mime_type(&self) -> &str {
        &self.mime_type
    }

    pub fn decoded_path(&self) -> &Path {
        &self.decoded_path
    }
}

impl Drop for CapturedInlineImage {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.decoded_path);
    }
}

#[derive(Debug)]
enum CaptureState {
    Normal,
    Header {
        token: String,
        header: String,
    },
    Payload {
        token: String,
        mime_type: String,
        decoded_path: PathBuf,
        file: std::fs::File,
        encoded_carry: Vec<u8>,
        padding_seen: bool,
        decoded_bytes: u64,
    },
    CodeHeader {
        header_len: usize,
    },
    CodePayload,
    Failed,
}

#[derive(Debug, Default)]
struct MarkdownCodeTracker {
    fence: Option<(u8, usize)>,
    inline_ticks: Option<usize>,
    run_byte: Option<u8>,
    run_len: usize,
}

impl MarkdownCodeTracker {
    fn consume(&mut self, value: &str) {
        for byte in value.bytes() {
            if matches!(byte, b'`' | b'~') {
                if self.run_byte == Some(byte) {
                    self.run_len += 1;
                } else {
                    self.flush_run();
                    self.run_byte = Some(byte);
                    self.run_len = 1;
                }
            } else {
                self.flush_run();
            }
        }
    }

    fn inside_code(&mut self) -> bool {
        self.flush_run();
        self.fence.is_some() || self.inline_ticks.is_some()
    }

    fn flush_run(&mut self) {
        let Some(run_byte) = self.run_byte.take() else {
            return;
        };
        let run_len = std::mem::take(&mut self.run_len);
        if let Some((fence_byte, fence_len)) = self.fence {
            if run_byte == fence_byte && run_len >= fence_len {
                self.fence = None;
            }
            return;
        }
        if let Some(inline_ticks) = self.inline_ticks {
            if run_byte == b'`' && run_len == inline_ticks {
                self.inline_ticks = None;
            }
            return;
        }
        if run_len >= 3 {
            self.fence = Some((run_byte, run_len));
        } else if run_byte == b'`' {
            self.inline_ticks = Some(run_len);
        }
    }
}

/// Incrementally removes inline image data from a provider stream while
/// writing the base64 payload into `.migrating` files. This prevents the raw
/// payload from being retained in the response String or crossing IPC.
#[derive(Debug)]
pub struct InlineDataStreamCapture {
    pending: String,
    state: CaptureState,
    completed: Vec<CapturedInlineImage>,
    temp_dir: PathBuf,
    code_tracker: MarkdownCodeTracker,
}

impl Default for InlineDataStreamCapture {
    fn default() -> Self {
        Self::new(std::env::temp_dir().join("aqbot-inline-media"))
    }
}

impl InlineDataStreamCapture {
    pub fn new(temp_dir: PathBuf) -> Self {
        Self {
            pending: String::new(),
            state: CaptureState::Normal,
            completed: Vec::new(),
            temp_dir,
            code_tracker: MarkdownCodeTracker::default(),
        }
    }

    pub fn push(&mut self, chunk: &str) -> Result<InlineDataCaptureDelta> {
        if matches!(self.state, CaptureState::Failed) {
            return Err(AQBotError::Validation(
                "Inline media capture is already failed".to_string(),
            ));
        }
        self.pending.push_str(chunk);
        let mut delta = InlineDataCaptureDelta::default();

        loop {
            let state = std::mem::replace(&mut self.state, CaptureState::Normal);
            match state {
                CaptureState::Normal => {
                    if let Some(prefix_offset) = find_data_image_prefix(&self.pending) {
                        let ordinary = &self.pending[..prefix_offset];
                        delta.content.push_str(ordinary);
                        delta.event_content.push_str(ordinary);
                        self.code_tracker.consume(ordinary);
                        self.pending
                            .drain(..prefix_offset + DATA_IMAGE_PREFIX.len());
                        if self.code_tracker.inside_code() {
                            delta.content.push_str(CODE_DATA_PLACEHOLDER);
                            delta.event_content.push_str(CODE_DATA_PLACEHOLDER);
                            self.state = CaptureState::CodeHeader { header_len: 0 };
                            continue;
                        }
                        let token = format!("aqbot-inline://pending/{}", crate::utils::gen_id());
                        delta.content.push_str(&token);
                        delta.event_content.push_str(PENDING_PLACEHOLDER);
                        self.state = CaptureState::Header {
                            token,
                            header: String::new(),
                        };
                        continue;
                    }

                    let retained = partial_prefix_suffix_len(self.pending.as_bytes());
                    let emit_end = self.pending.len() - retained;
                    let ordinary = &self.pending[..emit_end];
                    delta.content.push_str(ordinary);
                    delta.event_content.push_str(ordinary);
                    self.code_tracker.consume(ordinary);
                    self.pending.drain(..emit_end);
                    self.state = CaptureState::Normal;
                    break;
                }
                CaptureState::Header { token, mut header } => {
                    if let Some(comma) = self.pending.find(',') {
                        header.push_str(&self.pending[..comma]);
                        self.pending.drain(..=comma);
                        let Some(mime_type) = mime_type_from_data_header(&header) else {
                            return self.fail(
                                CaptureState::Header { token, header },
                                "Unsupported inline image data URI header",
                            );
                        };
                        let (decoded_path, file) = self.create_decoded_staging_file()?;
                        self.state = CaptureState::Payload {
                            token,
                            mime_type: mime_type.to_string(),
                            decoded_path,
                            file,
                            encoded_carry: Vec::with_capacity(4),
                            padding_seen: false,
                            decoded_bytes: 0,
                        };
                        continue;
                    }
                    if header.len() + self.pending.len() > 32 {
                        return self.fail(
                            CaptureState::Header { token, header },
                            "Inline image data URI header is too long",
                        );
                    }
                    header.push_str(&self.pending);
                    self.pending.clear();
                    self.state = CaptureState::Header { token, header };
                    break;
                }
                CaptureState::Payload {
                    token,
                    mime_type,
                    decoded_path,
                    mut file,
                    mut encoded_carry,
                    mut padding_seen,
                    mut decoded_bytes,
                } => {
                    let payload_len = self
                        .pending
                        .as_bytes()
                        .iter()
                        .take_while(|byte| is_base64_byte(**byte))
                        .count();
                    if payload_len > 0 {
                        if let Err(error) = stage_base64_chunk(
                            &mut file,
                            &mut encoded_carry,
                            &mut padding_seen,
                            &mut decoded_bytes,
                            &self.pending.as_bytes()[..payload_len],
                        ) {
                            return self.fail(
                                CaptureState::Payload {
                                    token,
                                    mime_type,
                                    decoded_path,
                                    file,
                                    encoded_carry,
                                    padding_seen,
                                    decoded_bytes,
                                },
                                &error.to_string(),
                            );
                        }
                        self.pending.drain(..payload_len);
                    }
                    if self.pending.is_empty() {
                        self.state = CaptureState::Payload {
                            token,
                            mime_type,
                            decoded_path,
                            file,
                            encoded_carry,
                            padding_seen,
                            decoded_bytes,
                        };
                        break;
                    }
                    if decoded_bytes == 0 {
                        return self.fail(
                            CaptureState::Payload {
                                token,
                                mime_type,
                                decoded_path,
                                file,
                                encoded_carry,
                                padding_seen,
                                decoded_bytes,
                            },
                            "Inline image data URI has an empty payload",
                        );
                    }
                    if !encoded_carry.is_empty() {
                        return self.fail(
                            CaptureState::Payload {
                                token,
                                mime_type,
                                decoded_path,
                                file,
                                encoded_carry,
                                padding_seen,
                                decoded_bytes,
                            },
                            "Inline image base64 payload has an invalid length",
                        );
                    }
                    if let Err(error) = file.sync_all() {
                        return self.fail(
                            CaptureState::Payload {
                                token,
                                mime_type,
                                decoded_path,
                                file,
                                encoded_carry,
                                padding_seen,
                                decoded_bytes,
                            },
                            &format!("Failed to flush inline image staging file: {error}"),
                        );
                    }
                    drop(file);
                    self.completed.push(CapturedInlineImage {
                        token,
                        mime_type,
                        decoded_path,
                    });
                    self.state = CaptureState::Normal;
                    continue;
                }
                CaptureState::CodeHeader { mut header_len } => {
                    if let Some(comma) = self.pending.find(',') {
                        self.pending.drain(..=comma);
                        self.state = CaptureState::CodePayload;
                        continue;
                    }
                    if let Some(boundary) = self.pending.char_indices().find_map(|(offset, value)| {
                        (value.is_whitespace()
                            || matches!(value, ')' | '\'' | '"' | '>' | '`' | '~'))
                        .then_some(offset)
                    }) {
                        self.pending.drain(..boundary);
                        self.state = CaptureState::Normal;
                        continue;
                    }
                    header_len += self.pending.len();
                    self.pending.clear();
                    self.state = CaptureState::CodeHeader { header_len };
                    break;
                }
                CaptureState::CodePayload => {
                    let payload_len = self
                        .pending
                        .as_bytes()
                        .iter()
                        .take_while(|byte| is_base64_byte(**byte))
                        .count();
                    self.pending.drain(..payload_len);
                    if self.pending.is_empty() {
                        self.state = CaptureState::CodePayload;
                        break;
                    }
                    self.state = CaptureState::Normal;
                    continue;
                }
                CaptureState::Failed => {
                    self.state = CaptureState::Failed;
                    return Err(AQBotError::Validation(
                        "Inline media capture is already failed".to_string(),
                    ));
                }
            }
        }

        Ok(delta)
    }

    pub fn finish(&mut self) -> Result<InlineDataCaptureDelta> {
        let mut delta = InlineDataCaptureDelta::default();
        match std::mem::replace(&mut self.state, CaptureState::Normal) {
            CaptureState::Normal => {
                delta.content = std::mem::take(&mut self.pending);
                delta.event_content.clone_from(&delta.content);
                Ok(delta)
            }
            CaptureState::Payload {
                token,
                mime_type,
                decoded_path,
                mut file,
                mut encoded_carry,
                mut padding_seen,
                mut decoded_bytes,
            } => {
                if !self
                    .pending
                    .as_bytes()
                    .iter()
                    .all(|byte| is_base64_byte(*byte))
                {
                    return self.fail(
                        CaptureState::Payload {
                            token,
                            mime_type,
                            decoded_path,
                            file,
                            encoded_carry,
                            padding_seen,
                            decoded_bytes,
                        },
                        "Inline image data URI has an invalid payload",
                    );
                }
                if let Err(error) = stage_base64_chunk(
                    &mut file,
                    &mut encoded_carry,
                    &mut padding_seen,
                    &mut decoded_bytes,
                    self.pending.as_bytes(),
                ) {
                    return self.fail(
                        CaptureState::Payload {
                            token,
                            mime_type,
                            decoded_path,
                            file,
                            encoded_carry,
                            padding_seen,
                            decoded_bytes,
                        },
                        &error.to_string(),
                    );
                }
                self.pending.clear();
                if decoded_bytes == 0 || !encoded_carry.is_empty() {
                    return self.fail(
                        CaptureState::Payload {
                            token,
                            mime_type,
                            decoded_path,
                            file,
                            encoded_carry,
                            padding_seen,
                            decoded_bytes,
                        },
                        "Inline image data URI payload has an invalid size",
                    );
                }
                if let Err(error) = file.sync_all() {
                    return self.fail(
                        CaptureState::Payload {
                            token,
                            mime_type,
                            decoded_path,
                            file,
                            encoded_carry,
                            padding_seen,
                            decoded_bytes,
                        },
                        &format!("Failed to flush inline image staging file: {error}"),
                    );
                }
                drop(file);
                self.completed.push(CapturedInlineImage {
                    token,
                    mime_type,
                    decoded_path,
                });
                Ok(delta)
            }
            state @ CaptureState::Header { .. } => {
                self.fail(state, "Inline image data URI ended before its payload")
            }
            CaptureState::CodeHeader { .. } | CaptureState::CodePayload => {
                self.pending.clear();
                Ok(delta)
            }
            CaptureState::Failed => {
                self.state = CaptureState::Failed;
                Err(AQBotError::Validation(
                    "Inline media capture is already failed".to_string(),
                ))
            }
        }
    }

    pub fn take_images(&mut self) -> Vec<CapturedInlineImage> {
        std::mem::take(&mut self.completed)
    }

    fn create_decoded_staging_file(&self) -> Result<(PathBuf, std::fs::File)> {
        std::fs::create_dir_all(&self.temp_dir)?;
        let path = self
            .temp_dir
            .join(format!(".{}.migrating", crate::utils::gen_id()));
        let file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)?;
        Ok((path, file))
    }

    fn fail<T>(&mut self, state: CaptureState, message: &str) -> Result<T> {
        if let CaptureState::Payload { decoded_path, .. } = state {
            let _ = std::fs::remove_file(decoded_path);
        }
        self.pending.clear();
        self.completed.clear();
        self.state = CaptureState::Failed;
        Err(AQBotError::Validation(message.to_string()))
    }
}

impl Drop for InlineDataStreamCapture {
    fn drop(&mut self) {
        if let CaptureState::Payload { decoded_path, .. } = &self.state {
            let _ = std::fs::remove_file(decoded_path);
        }
    }
}

fn stage_base64_chunk(
    file: &mut std::fs::File,
    encoded_carry: &mut Vec<u8>,
    padding_seen: &mut bool,
    decoded_bytes: &mut u64,
    encoded: &[u8],
) -> Result<()> {
    if encoded.is_empty() {
        return Ok(());
    }
    if *padding_seen {
        return Err(AQBotError::Validation(
            "Inline image base64 data continues after padding".to_string(),
        ));
    }

    encoded_carry.extend_from_slice(encoded);
    let complete_len = encoded_carry.len() / 4 * 4;
    for (index, quartet) in encoded_carry[..complete_len].chunks_exact(4).enumerate() {
        let has_padding = quartet.contains(&b'=');
        if has_padding && (index + 1) * 4 != complete_len {
            return Err(AQBotError::Validation(
                "Inline image base64 padding is not terminal".to_string(),
            ));
        }
        let mut decoded = [0_u8; 3];
        let written = base64::engine::general_purpose::STANDARD
            .decode_slice(quartet, &mut decoded)
            .map_err(|_| {
                AQBotError::Validation("Inline image base64 payload is invalid".to_string())
            })?;
        file.write_all(&decoded[..written])?;
        *decoded_bytes = decoded_bytes.checked_add(written as u64).ok_or_else(|| {
            AQBotError::Validation("Inline image decoded size overflow".to_string())
        })?;
        if *decoded_bytes > MAX_DECODED_IMAGE_BYTES {
            return Err(AQBotError::Validation(
                "Inline image exceeds the 32 MiB limit".to_string(),
            ));
        }
        if has_padding {
            *padding_seen = true;
        }
    }
    encoded_carry.drain(..complete_len);
    Ok(())
}

fn mime_type_from_data_header(header: &str) -> Option<&'static str> {
    if header.eq_ignore_ascii_case("png;base64") {
        Some("image/png")
    } else if header.eq_ignore_ascii_case("jpeg;base64") {
        Some("image/jpeg")
    } else if header.eq_ignore_ascii_case("webp;base64") {
        Some("image/webp")
    } else if header.eq_ignore_ascii_case("gif;base64") {
        Some("image/gif")
    } else {
        None
    }
}

fn is_base64_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'=')
}

pub fn replace_pending_inline_media_tokens(value: &str, replacement: &str) -> String {
    const PREFIX: &str = "aqbot-inline://pending/";
    let mut output = String::with_capacity(value.len());
    let mut offset = 0;
    while let Some(relative) = value[offset..].find(PREFIX) {
        let token_start = offset + relative;
        let id_start = token_start + PREFIX.len();
        let id_len = value.as_bytes()[id_start..]
            .iter()
            .take_while(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
            .count();
        if id_len == 0 {
            break;
        }
        output.push_str(&value[offset..token_start]);
        output.push_str(replacement);
        offset = id_start + id_len;
    }
    output.push_str(&value[offset..]);
    output
}
