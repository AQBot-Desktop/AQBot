use open_agent_sdk::{ContentBlock, Message, MessageRole};
use serde::{Deserialize, Serialize};

#[derive(Default)]
pub(super) struct AgentHistory {
    pub messages: Vec<Message>,
    pub prompt_ids: Vec<Option<String>>,
}

// Keep the existing JSON array format; the SDK ignores this application-only field.
// Legacy prompts remain untracked rather than guessing their identity from row counts.
#[derive(Serialize, Deserialize)]
struct StoredMessage<T> {
    #[serde(flatten)]
    message: T,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    aqbot_user_message_id: Option<String>,
}

fn is_prompt(message: &Message) -> bool {
    message.role == MessageRole::User
        && !message
            .content
            .iter()
            .any(|block| matches!(block, ContentBlock::ToolResult { .. }))
}

pub(super) fn load_history(json: Option<&str>) -> Result<AgentHistory, String> {
    let Some(json) = json else {
        return Ok(AgentHistory::default());
    };
    let stored: Vec<StoredMessage<Message>> = serde_json::from_str(json)
        .map_err(|error| format!("Failed to read Agent context: {error}"))?;
    let prompt_ids = stored
        .iter()
        .filter(|entry| is_prompt(&entry.message))
        .map(|entry| entry.aqbot_user_message_id.clone())
        .collect();
    Ok(AgentHistory {
        messages: stored.into_iter().map(|entry| entry.message).collect(),
        prompt_ids,
    })
}

pub(super) fn serialize_history(
    messages: &[Message],
    prompt_ids: Option<&[Option<String>]>,
) -> Result<String, String> {
    let Some(ids) = prompt_ids else {
        return serde_json::to_string(messages).map_err(|error| error.to_string());
    };
    if messages.iter().filter(|message| is_prompt(message)).count() != ids.len() {
        return Err("Agent context does not match its user message identifiers".into());
    }
    let mut ids = ids.iter();
    let stored: Vec<_> = messages
        .iter()
        .map(|message| StoredMessage {
            message,
            aqbot_user_message_id: if is_prompt(message) {
                ids.next().cloned().flatten()
            } else {
                None
            },
        })
        .collect();
    serde_json::to_string(&stored).map_err(|error| error.to_string())
}

/// Select complete SDK turns by their persisted user IDs, retaining tool results.
/// The database may still contain later turns, failed sends, or deleted messages.
pub(super) fn history_before_regeneration(
    history: AgentHistory,
    active_user_ids: &[String],
    target_id: &str,
) -> Result<AgentHistory, String> {
    let target_position = active_user_ids
        .iter()
        .position(|id| id == target_id)
        .ok_or_else(|| r#"{"code":"AGENT_REGEN_MESSAGE_MISSING"}"#.to_string())?;
    let tracked_target = history
        .prompt_ids
        .iter()
        .any(|id| id.as_deref() == Some(target_id));
    // The first user turn needs no preceding history, even for legacy sessions.
    // Otherwise an untracked target cannot be located safely after edits/deletions.
    if target_position > 0 && !tracked_target && history.prompt_ids.iter().any(Option::is_none) {
        return Err(r#"{"code":"AGENT_HISTORY_UNTRACKED"}"#.into());
    }
    let mut result = AgentHistory::default();
    let mut ids = history.prompt_ids.into_iter();
    let mut include_turn = false;
    for message in history.messages {
        if is_prompt(&message) {
            let id = ids.next().ok_or("Missing Agent prompt identifier")?;
            include_turn = match &id {
                Some(id) => active_user_ids
                    .iter()
                    .position(|candidate| candidate == id)
                    .is_some_and(|position| position < target_position),
                None => target_position > 0,
            };
            if include_turn {
                result.prompt_ids.push(id);
            }
        }
        if include_turn {
            result.messages.push(message);
        }
    }
    Ok(result)
}

#[cfg(test)]
#[path = "agent_history_tests.rs"]
mod tests;
