//! Incremental `<think>` tag filtering for streamed model output.

#[derive(Debug, Default)]
pub struct ThinkTagFilter {
    in_think_block: bool,
    trailing_fragment: String,
    has_thinking: bool,
}

fn think_tag_partial_suffix_len(input: &str, tag: &str) -> usize {
    let max_len = input.len().min(tag.len().saturating_sub(1));
    for len in (1..=max_len).rev() {
        if input.ends_with(&tag[..len]) {
            return len;
        }
    }
    0
}

impl ThinkTagFilter {
    pub fn push_visible(&mut self, delta: &str) -> String {
        if delta.is_empty() && self.trailing_fragment.is_empty() {
            return String::new();
        }

        let mut combined = std::mem::take(&mut self.trailing_fragment);
        combined.push_str(delta);

        const THINK_OPEN: &str = "<think";
        const THINK_CLOSE: &str = "</think>";

        let mut stripped = String::with_capacity(combined.len());
        let mut cursor = 0usize;

        loop {
            if cursor >= combined.len() {
                return stripped;
            }

            if self.in_think_block {
                if let Some(end_offset) = combined[cursor..].find(THINK_CLOSE) {
                    self.has_thinking |= !combined[cursor..cursor + end_offset].trim().is_empty();
                    cursor += end_offset + THINK_CLOSE.len();
                    self.in_think_block = false;
                    continue;
                }

                let remaining = &combined[cursor..];
                let suffix_len = think_tag_partial_suffix_len(remaining, THINK_CLOSE);
                self.has_thinking |= !remaining[..remaining.len() - suffix_len].trim().is_empty();
                if suffix_len > 0 {
                    self.trailing_fragment = remaining[remaining.len() - suffix_len..].to_string();
                }
                return stripped;
            }

            if let Some(start_offset) = combined[cursor..].find(THINK_OPEN) {
                let start = cursor + start_offset;
                stripped.push_str(&combined[cursor..start]);

                let after_tag = &combined[start + THINK_OPEN.len()..];
                if after_tag.is_empty() {
                    self.trailing_fragment = combined[start..].to_string();
                    return stripped;
                }
                let is_tag = after_tag.starts_with('>')
                    || after_tag.starts_with(|ch: char| ch.is_ascii_whitespace());
                if !is_tag {
                    stripped.push_str(THINK_OPEN);
                    cursor = start + THINK_OPEN.len();
                    continue;
                }

                if let Some(close_offset) = combined[start..].find('>') {
                    cursor = start + close_offset + 1;
                    self.in_think_block = true;
                    continue;
                }

                self.trailing_fragment = combined[start..].to_string();
                return stripped;
            }

            let remaining = &combined[cursor..];
            let suffix_len = think_tag_partial_suffix_len(remaining, THINK_OPEN);
            if suffix_len > 0 {
                let safe_len = remaining.len() - suffix_len;
                stripped.push_str(&remaining[..safe_len]);
                self.trailing_fragment = remaining[safe_len..].to_string();
            } else {
                stripped.push_str(remaining);
            }
            return stripped;
        }
    }

    pub fn has_thinking(&self) -> bool {
        self.has_thinking
    }

    pub fn finish_visible(&mut self) -> String {
        let trailing = std::mem::take(&mut self.trailing_fragment);
        if self.in_think_block {
            String::new()
        } else {
            trailing
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_think_tags_across_chunks() {
        let mut filter = ThinkTagFilter::default();
        assert_eq!(filter.push_visible("<thi"), "");
        assert_eq!(filter.push_visible("nk>abc</th"), "");
        assert_eq!(filter.push_visible("ink>OK"), "OK");
    }

    #[test]
    fn keeps_non_tag_think_prefix() {
        let mut filter = ThinkTagFilter::default();
        assert_eq!(filter.push_visible("thinking aloud"), "thinking aloud");
    }

    #[test]
    fn split_at_each_tag_boundary_never_exposes_reasoning() {
        let input = "<think>内部思考</think>OK";
        for split in (0..=input.len()).filter(|index| input.is_char_boundary(*index)) {
            let mut filter = ThinkTagFilter::default();
            let first = filter.push_visible(&input[..split]);
            let second = filter.push_visible(&input[split..]);
            assert_eq!(
                format!("{first}{second}{}", filter.finish_visible()),
                "OK",
                "split {split}"
            );
            assert!(filter.has_thinking());
        }
    }

    #[test]
    fn literal_partial_tag_is_flushed_at_completion() {
        let mut filter = ThinkTagFilter::default();
        assert_eq!(filter.push_visible("<think"), "");
        assert_eq!(filter.finish_visible(), "<think");
        assert!(!filter.has_thinking());
    }
}
