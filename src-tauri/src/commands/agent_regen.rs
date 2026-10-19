use aqbot_core::repo::message;
use aqbot_core::types::MessageRole;
use open_agent_sdk::ContentBlock;
use tauri::Emitter;

/// Create the assistant placeholder for a regeneration run: it becomes the
/// newest active version under the existing user message instead of a fresh
/// message, mirroring chat-mode regeneration.
pub(super) async fn create_agent_regen_placeholder(
    db: &sea_orm::DatabaseConnection,
    app: &tauri::AppHandle,
    conv_id: &str,
    user_msg_id: &str,
    run_id: &str,
    provider_id: &str,
    model_id: &str,
) -> Result<String, String> {
    let existing_versions = message::list_message_versions(db, conv_id, user_msg_id)
        .await
        .map_err(|e| e.to_string())?;
    let message_id = aqbot_core::utils::gen_id();
    super::conversations::persist_assistant_placeholder(
        db,
        super::conversations::AssistantPlaceholderPersistence {
            conversation_id: conv_id,
            message_id: &message_id,
            parent_message_id: user_msg_id,
            provider_id,
            model_id,
            content: "",
            version_index: existing_versions.len() as i32,
            created_at: existing_versions
                .first()
                .map(|version| version.created_at)
                .unwrap_or_else(aqbot_core::utils::now_ts),
            deactivate_existing_versions: true,
            increment_message_count: false,
            is_active: true,
        },
    )
    .await?;
    let _ = app.emit(
        "agent-message-id",
        serde_json::json!({
            "conversationId": conv_id,
            "assistantMessageId": message_id,
            "runId": run_id,
        }),
    );
    Ok(message_id)
}

/// A persisted SDK message is a user *prompt* only when it carries no tool
/// results: tool outputs are also stored with the `user` role.
fn is_agent_prompt_message(message: &open_agent_sdk::Message) -> bool {
    message.role == open_agent_sdk::MessageRole::User
        && !message
            .content
            .iter()
            .any(|block| matches!(block, ContentBlock::ToolResult { .. }))
}

/// Drop the stored SDK turn owned by the regenerated user message — and every
/// later turn — so the re-run re-appends the prompt instead of duplicating it.
/// `user_messages_after` counts the active user messages that follow the
/// regenerated one; assuming each of those was an agent turn, the target's own
/// prompt sits that many prompt-slots from the end of the history.
pub(super) fn truncate_agent_context_for_regen(
    prev_messages: &mut Vec<open_agent_sdk::Message>,
    user_messages_after: usize,
) {
    let prompt_indexes: Vec<usize> = prev_messages
        .iter()
        .enumerate()
        .filter(|(_, message)| is_agent_prompt_message(message))
        .map(|(index, _)| index)
        .collect();
    if user_messages_after < prompt_indexes.len() {
        let keep = prompt_indexes.len() - user_messages_after - 1;
        prev_messages.truncate(prompt_indexes[keep]);
    }
}

pub(super) async fn count_active_user_messages_after(
    db: &sea_orm::DatabaseConnection,
    target: &aqbot_core::types::Message,
) -> usize {
    let Ok(messages) = message::list_messages(db, &target.conversation_id).await else {
        return 0;
    };
    let user_ids: Vec<&str> = messages
        .iter()
        .filter(|entry| entry.role == MessageRole::User)
        .map(|entry| entry.id.as_str())
        .collect();
    user_ids
        .iter()
        .position(|id| *id == target.id)
        .map(|pos| user_ids.len() - pos - 1)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn regen_truncation_drops_the_target_turn_and_everything_after() {
        use open_agent_sdk::types::{
            Message as SdkMessage, MessageRole as SdkRole, ToolResultContentBlock,
        };

        let prompt = |text: &str| SdkMessage {
            role: SdkRole::User,
            content: vec![ContentBlock::Text { text: text.into() }],
        };
        let tool_results = || SdkMessage {
            role: SdkRole::User,
            content: vec![ContentBlock::ToolResult {
                tool_use_id: "t1".into(),
                content: vec![ToolResultContentBlock::Text { text: "ok".into() }],
                is_error: false,
            }],
        };
        let assistant = |text: &str| SdkMessage {
            role: SdkRole::Assistant,
            content: vec![ContentBlock::Text { text: text.into() }],
        };

        // p1 turn (with a tool round-trip) + p2 turn + p3 turn
        let history = vec![
            prompt("first"),
            assistant("answer-1"),
            tool_results(),
            assistant("more-1"),
            prompt("second"),
            assistant("answer-2"),
            prompt("third"),
            assistant("answer-3"),
        ];

        // Resend the last user message: only its own turn is dropped.
        let mut ctx = history.clone();
        truncate_agent_context_for_regen(&mut ctx, 0);
        assert_eq!(ctx.len(), 6);

        // Resend the middle user message: its turn and everything after go away.
        let mut ctx = history.clone();
        truncate_agent_context_for_regen(&mut ctx, 1);
        assert_eq!(ctx.len(), 4);

        // Resend the first user message: the agent starts with no memory.
        let mut ctx = history.clone();
        truncate_agent_context_for_regen(&mut ctx, 2);
        assert!(ctx.is_empty());

        // A user message that never reached the agent keeps the full history.
        let mut ctx = history.clone();
        truncate_agent_context_for_regen(&mut ctx, 3);
        assert_eq!(ctx.len(), history.len());
    }
}
