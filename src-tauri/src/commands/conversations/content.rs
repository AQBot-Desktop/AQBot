// Thinking, display-tag, and provider message content transforms.

/// Strip `<think ...>...</think>` blocks from content (all variants).
/// Also used by the selection toolbar when copying an AI result.
pub(crate) fn strip_think_tags(content: &str) -> String {
    let mut s = content.to_string();
    loop {
        if let Some(start) = s.find("<think") {
            // Ensure it's a tag (next char is '>' or ' ')
            let after_tag = &s[start + 6..];
            let is_tag = after_tag.starts_with('>') || after_tag.starts_with(' ');
            if !is_tag {
                break;
            }
            if let Some(end_offset) = s[start..].find("</think>") {
                let end = start + end_offset + "</think>".len();
                let before = s[..start].trim_end_matches('\n');
                let after = s[end..].trim_start_matches('\n');
                s = format!("{}{}", before, after);
                continue;
            }
        }
        break;
    }
    s
}

fn extract_think_blocks(content: &str) -> Option<String> {
    let mut remaining = content;
    let mut blocks = Vec::new();

    while let Some(start) = remaining.find("<think") {
        let after_tag_name = &remaining[start + 6..];
        let is_tag = after_tag_name.starts_with('>') || after_tag_name.starts_with(' ');
        if !is_tag {
            break;
        }

        let Some(open_end_offset) = remaining[start..].find('>') else {
            break;
        };
        let content_start = start + open_end_offset + 1;
        let Some(close_offset) = remaining[content_start..].find("</think>") else {
            break;
        };

        let block = remaining[content_start..content_start + close_offset].trim();
        if !block.is_empty() {
            blocks.push(block.to_string());
        }
        remaining = &remaining[content_start + close_offset + "</think>".len()..];
    }

    if blocks.is_empty() {
        None
    } else {
        Some(blocks.join("\n\n"))
    }
}

type DisabledThinkingStripState = aqbot_core::think_tags::ThinkTagFilter;

fn strip_disabled_thinking_content(content: &str) -> String {
    strip_think_tags(content)
}

fn strip_disabled_thinking_delta(delta: &str, state: &mut DisabledThinkingStripState) -> String {
    state.push_visible(delta)
}

const SEARCH_MARKER_START: &str = "<!-- search:";
const SEARCH_MARKER_END: &str = " -->";
const SEARCH_SEPARATOR: &str = "\n---\n\n";

fn strip_search_enrichment(content: &str) -> String {
    let trimmed_start = content.trim_start();
    if !trimmed_start.starts_with(SEARCH_MARKER_START) {
        return content.to_string();
    }

    let Some(marker_end) = trimmed_start.find(SEARCH_MARKER_END) else {
        return content.to_string();
    };
    let after_marker = &trimmed_start[marker_end + SEARCH_MARKER_END.len()..];
    let Some(separator) = after_marker.find(SEARCH_SEPARATOR) else {
        return content.to_string();
    };

    after_marker[separator + SEARCH_SEPARATOR.len()..]
        .trim()
        .to_string()
}

fn strip_search_metadata_marker(content: &str) -> String {
    let trimmed_start = content.trim_start();
    if !trimmed_start.starts_with(SEARCH_MARKER_START) {
        return content.to_string();
    }

    let Some(marker_end) = trimmed_start.find(SEARCH_MARKER_END) else {
        return content.to_string();
    };

    trimmed_start[marker_end + SEARCH_MARKER_END.len()..]
        .trim_start_matches('\n')
        .to_string()
}

/// Strip display-only tags from assistant message content so they aren't sent to the AI.
/// Strips: `<web-search-query data-aqbot="1">`, `<web-search data-aqbot="1">`, `<knowledge-retrieval data-aqbot="1">`,
/// and `<memory-retrieval data-aqbot="1">` tags,
/// `:::mcp ... :::` fenced blocks, and `<think>...</think>` blocks.
fn strip_display_tags(content: &str) -> String {
    // Strip <think> blocks first
    let content = strip_think_tags(content);
    // Strip AQBot display tags with data-aqbot attribute
    let content = {
        let mut s = content.to_string();
        for tag_name in &[
            "web-search-query",
            "web-search",
            "knowledge-retrieval",
            "memory-retrieval",
        ] {
            let tag_start = format!("<{} ", tag_name);
            let tag_end = format!("</{}>", tag_name);
            while let Some(start_pos) = s.find(&tag_start) {
                let rest = &s[start_pos + tag_start.len()..];
                if rest.contains("data-aqbot=") {
                    if let Some(end_offset) = s[start_pos..].find(&tag_end) {
                        let after = &s[start_pos + end_offset + tag_end.len()..];
                        let before = &s[..start_pos];
                        s = format!(
                            "{}{}",
                            before.trim_end_matches('\n'),
                            after.trim_start_matches('\n')
                        );
                        continue;
                    }
                }
                break;
            }
        }
        s
    };

    // Strip :::mcp blocks
    let mut result = String::with_capacity(content.len());
    let mut remaining = content.as_str();
    while let Some(start) = remaining.find(":::mcp ") {
        // Only match at start of line
        let at_line_start = start == 0 || remaining.as_bytes().get(start - 1) == Some(&b'\n');
        if !at_line_start {
            result.push_str(&remaining[..start + 7]);
            remaining = &remaining[start + 7..];
            continue;
        }
        result.push_str(remaining[..start].trim_end_matches('\n'));
        // Find the closing :::
        if let Some(end_offset) = remaining[start..].find("\n:::\n") {
            remaining = &remaining[start + end_offset + 4..]; // skip past \n:::\n
        } else if remaining[start..].ends_with("\n:::") {
            remaining = "";
        } else {
            // No closing fence found — keep the content
            result.push_str(&remaining[start..]);
            remaining = "";
        }
    }
    result.push_str(remaining);
    let trimmed = result.trim().to_string();
    if trimmed.is_empty() && !content.trim().is_empty() {
        // If stripping removed everything, return empty (content was all display tags)
        String::new()
    } else {
        trimmed
    }
}

const DOCUMENT_ATTACHMENT_UNKNOWN_CONTEXT_CHAR_LIMIT: usize = 48_000;
const DOCUMENT_ATTACHMENT_MIN_CONTEXT_CHAR_LIMIT: usize = 12_000;
const DOCUMENT_ATTACHMENT_MAX_CONTEXT_CHAR_LIMIT: usize = 96_000;

fn build_message_content(
    file_store: &aqbot_core::file_store::FileStore,
    message: &Message,
    document_attachment_reading_enabled: bool,
    model_context_window: Option<u32>,
    preserve_user_search_context: bool,
) -> aqbot_core::error::Result<ChatContent> {
    let content = match message.role {
        MessageRole::Assistant => strip_display_tags(&message.content),
        MessageRole::User if preserve_user_search_context => {
            strip_search_metadata_marker(&message.content)
        }
        MessageRole::User if !preserve_user_search_context => {
            strip_search_enrichment(&message.content)
        }
        _ => message.content.clone(),
    };
    let content = append_document_attachment_context(
        file_store,
        &content,
        &message.attachments,
        document_attachment_reading_enabled,
        model_context_window,
    )?;

    let image_attachments = message
        .attachments
        .iter()
        .filter(|attachment| attachment.file_type.starts_with("image/"))
        .collect::<Vec<_>>();

    if image_attachments.is_empty() {
        return Ok(ChatContent::Text(content));
    }

    let mut parts = Vec::new();
    if !content.is_empty() {
        parts.push(ContentPart {
            r#type: "text".to_string(),
            text: Some(content.clone()),
            image_url: None,
        });
    }

    for attachment in image_attachments {
        let data_url = if attachment.file_path.is_empty() {
            let base64_data = attachment.data.as_ref().ok_or_else(|| {
                aqbot_core::error::AQBotError::Validation(format!(
                    "Attachment {} is missing both file_path and inline data",
                    attachment.file_name
                ))
            })?;
            format!("data:{};base64,{}", attachment.file_type, base64_data)
        } else {
            match file_store.read_file(&attachment.file_path) {
                Ok(data) => format!(
                    "data:{};base64,{}",
                    attachment.file_type,
                    base64::engine::general_purpose::STANDARD.encode(data)
                ),
                Err(_) => continue, // skip deleted/missing attachments
            }
        };
        parts.push(ContentPart {
            r#type: "image_url".to_string(),
            text: None,
            image_url: Some(ImageUrl { url: data_url }),
        });
    }

    // If only text part remains (all images were missing), simplify to Text
    if parts.len() <= 1 && parts.iter().all(|p| p.r#type == "text") {
        return Ok(ChatContent::Text(content));
    }

    Ok(ChatContent::Multipart(parts))
}

fn chat_message_from_message(
    file_store: &aqbot_core::file_store::FileStore,
    message: &Message,
    document_attachment_reading_enabled: bool,
    model_context_window: Option<u32>,
    preserve_user_search_context: bool,
) -> aqbot_core::error::Result<ChatMessage> {
    let tool_calls: Option<Vec<ToolCall>> = message
        .tool_calls_json
        .as_ref()
        .and_then(|s| serde_json::from_str(s).ok());

    Ok(ChatMessage {
        role: match message.role {
            MessageRole::User => "user",
            MessageRole::Assistant => "assistant",
            MessageRole::System => "system",
            MessageRole::Tool => "tool",
        }
        .to_string(),
        content: build_message_content(
            file_store,
            message,
            document_attachment_reading_enabled,
            model_context_window,
            preserve_user_search_context,
        )?,
        reasoning_content: if message.role == MessageRole::Assistant {
            extract_think_blocks(&message.content)
        } else {
            None
        },
        tool_calls,
        tool_call_id: message.tool_call_id.clone(),
    })
}

fn is_context_boundary_marker(message: &Message) -> bool {
    message.role == MessageRole::System
        && (message.content == "<!-- context-clear -->"
            || message.content == crate::context_manager::COMPRESSION_MARKER)
}

fn is_context_clear_marker(message: &Message) -> bool {
    message.role == MessageRole::System && message.content == "<!-- context-clear -->"
}

fn is_context_compression_marker(message: &Message) -> bool {
    message.role == MessageRole::System
        && message.content == crate::context_manager::COMPRESSION_MARKER
}
