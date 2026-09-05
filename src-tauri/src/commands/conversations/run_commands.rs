use crate::conversation_run::{
    ConversationRunSnapshot, ConversationRunUpdatedEvent, CONVERSATION_RUN_UPDATED_EVENT,
};

pub fn emit_conversation_run_updated(
    app: &tauri::AppHandle,
    conversation_id: &str,
    snapshot: Option<ConversationRunSnapshot>,
) {
    let revision = snapshot.as_ref().map(|item| item.revision).unwrap_or(0);
    let _ = app.emit(
        CONVERSATION_RUN_UPDATED_EVENT,
        ConversationRunUpdatedEvent {
            conversation_id: conversation_id.to_string(),
            revision,
            snapshot,
        },
    );
}

#[tauri::command]
pub async fn list_active_conversation_runs(
    state: State<'_, AppState>,
) -> Result<Vec<ConversationRunSnapshot>, String> {
    Ok(state.conversation_runs.list_active())
}

#[tauri::command]
pub async fn get_conversation_run_snapshot(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<Option<ConversationRunSnapshot>, String> {
    Ok(state.conversation_runs.snapshot(&conversation_id))
}
