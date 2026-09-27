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
/// A Normal-state suffix withheld as a `data:image/` prefix is part of this
/// turn: append it and clear it so a later push or finish cannot move it.
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
    // At most the `data:image/` prefix. Own it before appending so the
    // capture borrow does not overlap `accumulated`.
    let ordinary_pending = capture.ordinary_pending().to_string();
    let matches_with_ordinary_pending = {
        let streamed = &accumulated[turn_base_len..];
        expected.strip_prefix(streamed) == Some(ordinary_pending.as_str())
    };
    if matches_with_ordinary_pending {
        if !ordinary_pending.is_empty() {
            accumulated.push_str(&ordinary_pending);
            capture.clear_ordinary_pending();
        }
        return;
    }
    let streamed = &accumulated[turn_base_len..];
    // Inline-image turns can never match: accumulated text holds
    // aqbot-inline://pending tokens where the blocks carry raw data URLs.
    if streamed.contains("aqbot-inline://") || expected.contains("data:image/") {
        return;
    }
    let streamed_len = streamed.len();
    let expected_len = expected.len();
    tracing::warn!(
        "[agent] Streamed deltas diverged from provider message ({} vs {} bytes); restoring authoritative content",
        streamed_len,
        expected_len
    );
    accumulated.truncate(turn_base_len);
    accumulated.push_str(&expected);
    *in_thinking_block = ended_in_think;
    // The replaced span is now `expected`. Drop only a Normal-state tail so
    // the next push cannot emit it again; completed images stay in place.
    capture.clear_ordinary_pending();
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

    fn capture_prior_png(temp: &std::path::Path) -> (InlineDataStreamCapture, String) {
        let mut capture = InlineDataStreamCapture::new(temp.to_path_buf());
        let prior = capture
            .push("![one](data:image/png;base64,iVBORw0KGgo=)\n")
            .unwrap();
        assert!(prior.content.contains("aqbot-inline://pending/"));
        assert!(!prior.content.to_ascii_lowercase().contains("data:image/"));
        assert!(capture.ordinary_pending().is_empty());
        assert_eq!(std::fs::read_dir(temp).unwrap().count(), 1);
        (capture, prior.content)
    }

    fn assert_prior_png_kept(
        capture: &mut InlineDataStreamCapture,
        accumulated: &str,
        base: usize,
    ) {
        let images = capture.take_images();
        assert_eq!(images.len(), 1);
        assert!(accumulated[..base].contains(images[0].token()));
        assert!(!accumulated[base..].contains("aqbot-inline://"));
        assert_eq!(
            std::fs::read(images[0].decoded_path()).unwrap(),
            b"\x89PNG\r\n\x1a\n"
        );
        drop(images);
    }

    #[test]
    fn reconcile_does_not_rewrite_turn_ending_in_withheld_d() {
        let temp = tempfile::tempdir().unwrap();
        let (mut capture, prior) = capture_prior_png(temp.path());
        let mut accumulated = prior.clone();
        let base = accumulated.len();
        let delta = capture.push("answer ends with d").unwrap();
        assert_eq!(delta.content, "answer ends with ");
        assert_eq!(capture.ordinary_pending(), "d");
        accumulated.push_str(&delta.content);
        let mut in_think = true;

        reconcile_agent_streamed_turn(
            &mut accumulated,
            &mut capture,
            &mut in_think,
            base,
            false,
            &[text_block("answer ends with d")],
        );

        assert_eq!(accumulated, format!("{prior}answer ends with d"));
        assert!(in_think);
        assert!(capture.ordinary_pending().is_empty());
        let tail = capture.finish().unwrap();
        assert_eq!(tail.content, "");
        let next = capture.push(" next").unwrap();
        assert_eq!(next.content, " next");
        assert_prior_png_kept(&mut capture, &accumulated, base);
        drop(capture);
        temp.close().unwrap();
    }

    #[test]
    fn reconcile_restores_text_without_dropping_images_from_earlier_turns() {
        let temp = tempfile::tempdir().unwrap();
        let (mut capture, prior) = capture_prior_png(temp.path());
        let mut accumulated = prior.clone();
        let base = accumulated.len();
        let delta = capture.push("abcXYZd").unwrap();
        assert_eq!(delta.content, "abcXYZ");
        assert_eq!(capture.ordinary_pending(), "d");
        accumulated.push_str(&delta.content);
        assert!(!accumulated[base..].contains("aqbot-inline://"));
        let mut in_think = true;

        reconcile_agent_streamed_turn(
            &mut accumulated,
            &mut capture,
            &mut in_think,
            base,
            false,
            &[text_block("abcDEFXYZ")],
        );

        assert_eq!(accumulated, format!("{prior}abcDEFXYZ"));
        assert!(!in_think);
        assert!(capture.ordinary_pending().is_empty());
        let next = capture.push("!").unwrap();
        assert_eq!(next.content, "!");
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 1);
        assert_prior_png_kept(&mut capture, &accumulated, base);
        drop(capture);
        temp.close().unwrap();
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
