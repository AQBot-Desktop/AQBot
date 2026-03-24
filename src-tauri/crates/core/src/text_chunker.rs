/// A chunk of text with its position index.
#[derive(Debug, Clone)]
pub struct TextChunk {
    pub index: i32,
    pub content: String,
}

/// Default chunk size in characters (~500 tokens).
pub const DEFAULT_CHUNK_SIZE: usize = 2000;
/// Default overlap in characters (~50 tokens).
pub const DEFAULT_OVERLAP: usize = 200;

/// Split text into overlapping chunks, breaking at paragraph/sentence boundaries.
pub fn chunk_text(text: &str, chunk_size: usize, overlap: usize) -> Vec<TextChunk> {
    let text = text.trim();
    if text.is_empty() {
        return vec![];
    }
    if text.len() <= chunk_size {
        return vec![TextChunk { index: 0, content: text.to_string() }];
    }

    let mut chunks = Vec::new();
    let mut start = 0;

    while start < text.len() {
        let end = (start + chunk_size).min(text.len());

        // Find a good break point near `end`
        let actual_end = if end >= text.len() {
            text.len()
        } else {
            find_break_point(text, start, end)
        };

        let chunk_content = text[start..actual_end].trim();
        if !chunk_content.is_empty() {
            chunks.push(TextChunk {
                index: chunks.len() as i32,
                content: chunk_content.to_string(),
            });
        }

        // Move start forward by (chunk_size - overlap), but at least 1 char
        let advance = if actual_end - start > overlap {
            actual_end - start - overlap
        } else {
            actual_end - start
        };

        start += advance.max(1);

        // If remaining text is tiny, it's already covered by the last chunk's overlap
        if start >= text.len() || text.len() - start < overlap {
            break;
        }
    }

    chunks
}

/// Find a good break point near `target` position, searching backwards from target.
/// Prefers: paragraph break (\n\n) > line break (\n) > sentence end (. ! ?) > space
fn find_break_point(text: &str, start: usize, target: usize) -> usize {
    let search_range = &text[start..target];
    let min_chunk = (target - start) / 2; // Don't break before half the chunk

    // Try paragraph break
    if let Some(pos) = search_range.rfind("\n\n") {
        if pos >= min_chunk {
            return start + pos + 2; // After the double newline
        }
    }

    // Try line break
    if let Some(pos) = search_range.rfind('\n') {
        if pos >= min_chunk {
            return start + pos + 1;
        }
    }

    // Try sentence end
    let bytes = search_range.as_bytes();
    for i in (min_chunk..bytes.len()).rev() {
        if matches!(bytes[i], b'.' | b'!' | b'?') {
            // Check it's followed by a space or end
            if i + 1 >= bytes.len() || bytes[i + 1] == b' ' || bytes[i + 1] == b'\n' {
                return start + i + 1;
            }
        }
    }

    // Try word break (space)
    if let Some(pos) = search_range.rfind(' ') {
        if pos >= min_chunk {
            return start + pos + 1;
        }
    }

    // No good break found, just cut at target
    target
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_empty_text() {
        assert!(chunk_text("", 100, 20).is_empty());
    }

    #[test]
    fn test_short_text() {
        let chunks = chunk_text("Hello world", 100, 20);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].content, "Hello world");
    }

    #[test]
    fn test_chunking_preserves_content() {
        let text = "A".repeat(500);
        let chunks = chunk_text(&text, 200, 50);
        assert!(chunks.len() > 1);
        // First chunk should be roughly 200 chars
        assert!(chunks[0].content.len() <= 200);
    }
}
