//! Helpers that keep the agent's streamed text authoritative.
//!
//! Deltas travel a best-effort event channel before reaching the agent loop.
//! These helpers re-serialize the SDK's final Assistant blocks the same way
//! the delta handlers accumulate them, so the persisted text can be repaired
//! when deltas were lost, and throttle mid-stream DB snapshots so persistence
//! cannot starve the event channel.

use aqbot_core::inline_media::InlineDataStreamCapture;
use open_agent_sdk::ContentBlock;
use std::time::{Duration, Instant};

/// Re-serialize an assistant turn exactly as the ThinkingDelta/TextDelta
/// handlers accumulate it (including injected <think> wrappers), so the
/// streamed span can be compared with the SDK's authoritative blocks.
/// Returns the serialized text and whether it ends inside a think block.
pub(crate) fn serialize_agent_turn_content(
    blocks: &[ContentBlock],
    had_prior_content: bool,
    started_in_think: bool,
) -> (String, bool) {
    let mut out = String::new();
    let mut in_think = started_in_think;
    for block in blocks {
        match block {
            ContentBlock::Thinking { thinking, .. } => {
                if !in_think {
                    if !out.is_empty() || had_prior_content {
                        out.push_str("\n\n");
                    }
                    out.push_str("<think data-aqbot=\"1\">\n");
                    in_think = true;
                }
                out.push_str(thinking);
            }
            ContentBlock::Text { text } => {
                if in_think {
                    out.push_str("\n</think>\n\n");
                    in_think = false;
                }
                out.push_str(text);
            }
            _ => {}
        }
    }
    (out, in_think)
}

/// When the authoritative Assistant message arrives, splice its content back
/// into `accumulated_text` if the streamed span diverged (e.g. dropped deltas).
pub(crate) fn reconcile_agent_streamed_turn(
    accumulated: &mut String,
    capture: &mut InlineDataStreamCapture,
    in_thinking_block: &mut bool,
    turn_base_len: usize,
    turn_base_in_think: bool,
    blocks: &[ContentBlock],
) {
    if accumulated.len() < turn_base_len {
        return;
    }
    let (expected, ended_in_think) =
        serialize_agent_turn_content(blocks, turn_base_len > 0, turn_base_in_think);
    let streamed = &accumulated[turn_base_len..];
    if *streamed == expected {
        return;
    }
    // Inline-image turns can never match: accumulated text holds
    // aqbot-inline://pending tokens where the blocks carry raw data URLs.
    if streamed.contains("aqbot-inline://") || expected.contains("data:image/") {
        return;
    }
    tracing::warn!(
        "[agent] Streamed deltas diverged from provider message ({} vs {} bytes); restoring authoritative content",
        streamed.len(),
        expected.len()
    );
    accumulated.truncate(turn_base_len);
    accumulated.push_str(&expected);
    *in_thinking_block = ended_in_think;
    // The capture's pending tail may still hold bytes that were part of the
    // replaced span; reset so they cannot be re-emitted by the next push.
    *capture = InlineDataStreamCapture::default();
}

/// Mid-stream snapshots exist for crash/refresh recovery only, so they are
/// throttled: a per-delta UPDATE forces the messages_fts trigger to reindex
/// the whole (growing) row on every token and starves the SDK event loop.
const AGENT_STREAM_SNAPSHOT_INTERVAL: Duration = Duration::from_millis(300);

pub(crate) fn agent_stream_snapshot_due(last: &mut Option<Instant>) -> bool {
    match *last {
        Some(t) if t.elapsed() < AGENT_STREAM_SNAPSHOT_INTERVAL => false,
        _ => {
            *last = Some(Instant::now());
            true
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text_block(text: &str) -> ContentBlock {
        ContentBlock::Text {
            text: text.to_string(),
        }
    }

    fn thinking_block(thinking: &str) -> ContentBlock {
        ContentBlock::Thinking {
            thinking: thinking.to_string(),
            signature: None,
        }
    }

    #[test]
    fn serialize_agent_turn_content_matches_delta_accumulation() {
        let blocks = vec![thinking_block("ponder"), text_block("answer")];

        let (text, in_think) = serialize_agent_turn_content(&blocks, false, false);
        assert_eq!(text, "<think data-aqbot=\"1\">\nponder\n</think>\n\nanswer");
        assert!(!in_think);

        // A turn opening with a think block still separates from prior text.
        let (text, _) = serialize_agent_turn_content(&blocks, true, false);
        assert_eq!(
            text,
            "\n\n<think data-aqbot=\"1\">\nponder\n</think>\n\nanswer"
        );
    }

    #[test]
    fn serialize_agent_turn_content_resumes_open_think_block() {
        // When the previous turn ended mid-think, the delta path continues
        // inside the open block instead of emitting a second opener.
        let (text, in_think) = serialize_agent_turn_content(&[thinking_block("more")], true, true);
        assert_eq!(text, "more");
        assert!(in_think);
    }

    #[test]
    fn reconcile_restores_content_lost_to_dropped_deltas() {
        let mut accumulated = String::from("header\n\n");
        let base = accumulated.len();
        accumulated.push_str("abcXYZ"); // "DEF" delta was dropped

        let mut capture = InlineDataStreamCapture::default();
        let mut in_think = false;
        reconcile_agent_streamed_turn(
            &mut accumulated,
            &mut capture,
            &mut in_think,
            base,
            false,
            &[text_block("abcDEFXYZ")],
        );

        assert_eq!(accumulated, "header\n\nabcDEFXYZ");
        assert!(!in_think);
    }

    #[test]
    fn reconcile_leaves_intact_streamed_text_untouched() {
        let mut accumulated = String::from("base");
        let base = accumulated.len();
        // The delta path injects "\n\n" before opening a think block when
        // accumulated text is non-empty, so an intact span contains it.
        accumulated.push_str("\n\n<think data-aqbot=\"1\">\nponder\n</think>\n\nanswer");

        let mut capture = InlineDataStreamCapture::default();
        let mut in_think = true; // simulate a stale flag; equal span keeps it
        reconcile_agent_streamed_turn(
            &mut accumulated,
            &mut capture,
            &mut in_think,
            base,
            false,
            &[thinking_block("ponder"), text_block("answer")],
        );

        assert_eq!(
            accumulated,
            "base\n\n<think data-aqbot=\"1\">\nponder\n</think>\n\nanswer"
        );
        assert!(in_think);
    }

    #[test]
    fn reconcile_repairs_missing_think_closer_and_updates_state() {
        let mut accumulated = String::from("base");
        let base = accumulated.len();
        accumulated.push_str("\n\n<think data-aqbot=\"1\">\nponder\n\nans");

        let mut capture = InlineDataStreamCapture::default();
        let mut in_think = true;
        reconcile_agent_streamed_turn(
            &mut accumulated,
            &mut capture,
            &mut in_think,
            base,
            false,
            &[thinking_block("ponder"), text_block("ans")],
        );

        assert_eq!(
            accumulated,
            "base\n\n<think data-aqbot=\"1\">\nponder\n</think>\n\nans"
        );
        assert!(!in_think);
    }

    #[test]
    fn reconcile_skips_turns_with_inline_images() {
        let mut accumulated = String::from("see aqbot-inline://pending-0 now");
        let base = 0;
        let mut capture = InlineDataStreamCapture::default();
        let mut in_think = false;
        reconcile_agent_streamed_turn(
            &mut accumulated,
            &mut capture,
            &mut in_think,
            base,
            false,
            &[text_block("see data:image/png;base64,AAAA now")],
        );

        // Replacing the span would orphan the captured image marker.
        assert_eq!(accumulated, "see aqbot-inline://pending-0 now");
    }

    #[test]
    fn agent_stream_snapshot_throttles_after_first_write() {
        let mut last = None;
        assert!(agent_stream_snapshot_due(&mut last));
        assert!(!agent_stream_snapshot_due(&mut last));

        last = Some(Instant::now() - AGENT_STREAM_SNAPSHOT_INTERVAL);
        assert!(agent_stream_snapshot_due(&mut last));
    }
}
