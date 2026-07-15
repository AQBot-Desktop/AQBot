use sea_orm::*;
use sea_orm::sea_query::Expr;
use serde_json;
use std::collections::HashSet;

use crate::entity::{conversation_summaries, conversations, messages, stored_files};
use crate::error::{AQBotError, Result};
use crate::types::{
    Attachment, Conversation, ConversationSearchResult, ConversationSummary,
    UpdateConversationInput,
};
use crate::utils::{gen_id, now_ts};

fn conversation_from_entity(m: conversations::Model) -> Conversation {
    Conversation {
        id: m.id,
        title: m.title,
        model_id: m.model_id,
        provider_id: m.provider_id,
        system_prompt: m.system_prompt,
        temperature: m.temperature.map(|v| v as f32),
        max_tokens: m.max_tokens.map(|v| v as u32),
        top_p: m.top_p.map(|v| v as f32),
        frequency_penalty: m.frequency_penalty.map(|v| v as f32),
        search_enabled: m.search_enabled != 0,
        search_provider_id: m.search_provider_id,
        thinking_budget: m.thinking_budget,
        thinking_level: m.thinking_level,
        enabled_mcp_server_ids: parse_string_list(&m.enabled_mcp_server_ids),
        enabled_knowledge_base_ids: parse_string_list(&m.enabled_knowledge_base_ids),
        enabled_memory_namespace_ids: parse_string_list(&m.enabled_memory_namespace_ids),
        message_count: m.message_count as u32,
        is_pinned: m.is_pinned != 0,
        is_archived: m.is_archived != 0,
        context_compression: m.context_compression != 0,
        category_id: m.category_id,
        parent_conversation_id: m.parent_conversation_id,
        mode: m.mode,
        created_at: m.created_at,
        updated_at: m.updated_at,
    }
}

fn parse_string_list(raw: &str) -> Vec<String> {
    serde_json::from_str(raw)
        .expect("conversation preference JSON is invalid; database contents are corrupted")
}

fn stringify_string_list(values: &[String]) -> String {
    serde_json::to_string(values).expect("failed to serialize conversation preference JSON")
}

pub async fn list_conversations(db: &DatabaseConnection) -> Result<Vec<Conversation>> {
    let rows = conversations::Entity::find()
        .filter(conversations::Column::IsArchived.eq(0))
        .order_by_desc(conversations::Column::IsPinned)
        .order_by_desc(conversations::Column::UpdatedAt)
        .all(db)
        .await?;

    Ok(rows.into_iter().map(conversation_from_entity).collect())
}

pub async fn list_archived_conversations(db: &DatabaseConnection) -> Result<Vec<Conversation>> {
    let rows = conversations::Entity::find()
        .filter(conversations::Column::IsArchived.ne(0))
        .order_by_desc(conversations::Column::UpdatedAt)
        .all(db)
        .await?;

    Ok(rows.into_iter().map(conversation_from_entity).collect())
}

pub async fn get_conversation(db: &DatabaseConnection, id: &str) -> Result<Conversation> {
    let row = conversations::Entity::find_by_id(id)
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("Conversation {}", id)))?;

    Ok(conversation_from_entity(row))
}

pub async fn create_conversation(
    db: &DatabaseConnection,
    title: &str,
    model_id: &str,
    provider_id: &str,
    system_prompt: Option<&str>,
) -> Result<Conversation> {
    let id = gen_id();
    let now = now_ts();

    conversations::ActiveModel {
        id: Set(id.clone()),
        title: Set(title.to_string()),
        model_id: Set(model_id.to_string()),
        provider_id: Set(provider_id.to_string()),
        system_prompt: Set(system_prompt.map(|s| s.to_string())),
        message_count: Set(0),
        is_pinned: Set(0),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    }
    .insert(db)
    .await?;

    get_conversation(db, &id).await
}

pub async fn update_conversation(
    db: &DatabaseConnection,
    id: &str,
    input: UpdateConversationInput,
) -> Result<Conversation> {
    let row = conversations::Entity::find_by_id(id)
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("Conversation {}", id)))?;

    let now = now_ts();
    let existing = conversation_from_entity(row.clone());

    let title = input.title.unwrap_or(existing.title);
    let provider_id = input.provider_id.unwrap_or(existing.provider_id);
    let model_id = input.model_id.unwrap_or(existing.model_id);
    let is_pinned = input.is_pinned.unwrap_or(existing.is_pinned);
    let is_archived = input.is_archived.unwrap_or(existing.is_archived);

    let mut am: conversations::ActiveModel = row.into();
    am.title = Set(title);
    am.provider_id = Set(provider_id);
    am.model_id = Set(model_id);
    am.is_pinned = Set(if is_pinned { 1 } else { 0 });
    am.is_archived = Set(if is_archived { 1 } else { 0 });
    if let Some(ref sp) = input.system_prompt {
        am.system_prompt = Set(if sp.is_empty() {
            None
        } else {
            Some(sp.clone())
        });
    }
    if let Some(temperature) = input.temperature {
        am.temperature = Set(temperature);
    }
    if let Some(max_tokens) = input.max_tokens {
        am.max_tokens = Set(max_tokens);
    }
    if let Some(top_p) = input.top_p {
        am.top_p = Set(top_p);
    }
    if let Some(frequency_penalty) = input.frequency_penalty {
        am.frequency_penalty = Set(frequency_penalty);
    }
    if let Some(search_enabled) = input.search_enabled {
        am.search_enabled = Set(if search_enabled { 1 } else { 0 });
    }
    if let Some(search_provider_id) = input.search_provider_id {
        am.search_provider_id = Set(search_provider_id);
    }
    if let Some(thinking_budget) = input.thinking_budget {
        am.thinking_budget = Set(thinking_budget);
    }
    if let Some(thinking_level) = input.thinking_level {
        am.thinking_level = Set(thinking_level);
    }
    if let Some(enabled_mcp_server_ids) = input.enabled_mcp_server_ids {
        am.enabled_mcp_server_ids = Set(stringify_string_list(&enabled_mcp_server_ids));
    }
    if let Some(enabled_knowledge_base_ids) = input.enabled_knowledge_base_ids {
        am.enabled_knowledge_base_ids = Set(stringify_string_list(&enabled_knowledge_base_ids));
    }
    if let Some(enabled_memory_namespace_ids) = input.enabled_memory_namespace_ids {
        am.enabled_memory_namespace_ids = Set(stringify_string_list(&enabled_memory_namespace_ids));
    }
    if let Some(context_compression) = input.context_compression {
        am.context_compression = Set(if context_compression { 1 } else { 0 });
    }
    if let Some(category_id) = input.category_id {
        am.category_id = Set(category_id);
    }
    if let Some(parent_conversation_id) = input.parent_conversation_id {
        am.parent_conversation_id = Set(parent_conversation_id);
    }
    if let Some(mode) = input.mode {
        am.mode = Set(mode);
    }
    am.updated_at = Set(now);
    am.update(db).await?;

    get_conversation(db, id).await
}

pub async fn update_conversation_title(
    db: &DatabaseConnection,
    id: &str,
    title: &str,
) -> Result<()> {
    if let Some(row) = conversations::Entity::find_by_id(id).one(db).await? {
        let mut am: conversations::ActiveModel = row.into();
        am.title = Set(title.to_string());
        am.updated_at = Set(now_ts());
        am.update(db).await?;
    }
    Ok(())
}

pub async fn toggle_pin(db: &DatabaseConnection, id: &str) -> Result<Conversation> {
    let row = conversations::Entity::find_by_id(id)
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("Conversation {}", id)))?;

    let new_pinned = if row.is_pinned != 0 { 0 } else { 1 };
    let now = now_ts();

    let mut am: conversations::ActiveModel = row.into();
    am.is_pinned = Set(new_pinned);
    am.updated_at = Set(now);
    am.update(db).await?;

    get_conversation(db, id).await
}

pub async fn toggle_archive(db: &DatabaseConnection, id: &str) -> Result<Conversation> {
    let row = conversations::Entity::find_by_id(id)
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("Conversation {}", id)))?;

    let new_archived = if row.is_archived != 0 { 0 } else { 1 };
    let now = now_ts();

    let mut am: conversations::ActiveModel = row.into();
    am.is_archived = Set(new_archived);
    am.updated_at = Set(now);
    am.update(db).await?;

    get_conversation(db, id).await
}

pub async fn delete_conversation(db: &DatabaseConnection, id: &str) -> Result<()> {
    let result = conversations::Entity::delete_by_id(id).exec(db).await?;

    if result.rows_affected == 0 {
        return Err(AQBotError::NotFound(format!("Conversation {}", id)));
    }
    Ok(())
}

fn rewrite_stored_media_ids(
    content: &str,
    id_map: &std::collections::HashMap<String, String>,
) -> String {
    let mut rewritten = String::with_capacity(content.len());
    let mut offset = 0;
    for (id_start, id_end) in crate::repo::stored_file::stored_media_id_ranges(content) {
        rewritten.push_str(&content[offset..id_start]);
        let source_id = &content[id_start..id_end];
        rewritten.push_str(
            id_map
                .get(source_id)
                .map(String::as_str)
                .unwrap_or(source_id),
        );
        offset = id_end;
    }
    rewritten.push_str(&content[offset..]);
    rewritten
}

async fn clone_stored_file_for_branch(
    txn: &DatabaseTransaction,
    source_id: &str,
    branch_conversation_id: &str,
) -> Result<Option<String>> {
    let Some(source) = stored_files::Entity::find_by_id(source_id).one(txn).await? else {
        return Ok(None);
    };
    let branch_id = gen_id();
    stored_files::ActiveModel {
        id: Set(branch_id.clone()),
        hash: Set(source.hash),
        original_name: Set(source.original_name),
        mime_type: Set(source.mime_type),
        size_bytes: Set(source.size_bytes),
        storage_path: Set(source.storage_path),
        conversation_id: Set(Some(branch_conversation_id.to_string())),
        ..Default::default()
    }
    .insert(txn)
    .await?;
    Ok(Some(branch_id))
}

async fn clone_message_media_for_branch(
    txn: &DatabaseTransaction,
    branch_conversation_id: &str,
    content: &str,
    attachments_json: &str,
    id_map: &mut std::collections::HashMap<String, String>,
) -> Result<(String, String)> {
    let mut attachments: Vec<Attachment> =
        serde_json::from_str(attachments_json).map_err(|error| {
            AQBotError::Validation(format!("Invalid message attachments JSON: {error}"))
        })?;
    let mut referenced_ids: Vec<_> = crate::repo::stored_file::stored_media_ids(content)
        .into_iter()
        .collect();
    referenced_ids.extend(
        attachments
            .iter()
            .filter(|attachment| !attachment.id.is_empty())
            .map(|attachment| attachment.id.clone()),
    );
    referenced_ids.sort();
    referenced_ids.dedup();

    for source_id in referenced_ids {
        if id_map.contains_key(&source_id) {
            continue;
        }
        match clone_stored_file_for_branch(txn, &source_id, branch_conversation_id).await? {
            Some(branch_id) => {
                id_map.insert(source_id, branch_id);
            }
            None => {
                return Err(AQBotError::NotFound(format!(
                    "StoredFile {source_id} referenced by branched message"
                )));
            }
        }
    }

    for attachment in &mut attachments {
        if let Some(branch_id) = id_map.get(&attachment.id) {
            attachment.id.clone_from(branch_id);
        }
    }
    let attachments_json = serde_json::to_string(&attachments).map_err(|error| {
        AQBotError::Validation(format!("Failed to serialize branched attachments: {error}"))
    })?;
    Ok((rewrite_stored_media_ids(content, id_map), attachments_json))
}

/// Branch a conversation: copy settings + messages up to `until_message_id`.
/// If `as_child` is true, the new conversation is nested under the source (or its parent).
pub async fn branch_conversation(
    db: &DatabaseConnection,
    conversation_id: &str,
    until_message_id: &str,
    as_child: bool,
    custom_title: Option<&str>,
) -> Result<Conversation> {
    // 1. Load source conversation
    let source = conversations::Entity::find_by_id(conversation_id)
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("Conversation {}", conversation_id)))?;

    // 2. Load all active messages ordered by created_at
    let all_msgs = messages::Entity::find()
        .filter(messages::Column::ConversationId.eq(conversation_id))
        .filter(messages::Column::IsActive.eq(1))
        .order_by_asc(messages::Column::CreatedAt)
        .order_by(Expr::cust("rowid"), Order::Asc)
        .all(db)
        .await?;

    // 3. Build the branch candidate list. Normal branches target an active
    // message. Multi-model cards may target an inactive assistant version, in
    // which case the selected version replaces its active sibling for the
    // branch snapshot.
    let candidate_msgs: Vec<messages::Model> = if let Some(target_idx) = all_msgs
        .iter()
        .position(|m| m.id == until_message_id)
    {
        all_msgs[..=target_idx].to_vec()
    } else {
        let target = messages::Entity::find_by_id(until_message_id)
            .one(db)
            .await?
            .ok_or_else(|| {
                AQBotError::NotFound(format!("Message {} in conversation", until_message_id))
            })?;

        if target.conversation_id != conversation_id {
            return Err(AQBotError::NotFound(format!(
                "Message {} in conversation {}",
                until_message_id, conversation_id
            )));
        }

        let parent_message_id = target.parent_message_id.clone().ok_or_else(|| {
            AQBotError::NotFound(format!("Message {} in conversation", until_message_id))
        })?;
        if target.role != "assistant" {
            return Err(AQBotError::NotFound(format!(
                "Message {} in conversation",
                until_message_id
            )));
        }

        let parent_idx = all_msgs
            .iter()
            .position(|m| m.id == parent_message_id)
            .ok_or_else(|| {
                AQBotError::NotFound(format!("Message {} in conversation", until_message_id))
            })?;
        let mut selected_branch = all_msgs[..=parent_idx].to_vec();
        selected_branch.retain(|message| {
            message.role != "assistant"
                || message.parent_message_id.as_deref() != Some(parent_message_id.as_str())
        });
        selected_branch.push(target);
        selected_branch
    };

    // 4. Find last context-clear marker to determine effective start
    let start_idx = candidate_msgs
        .iter()
        .rposition(|m| {
            m.role == "system"
                && (m.content == "<!-- context-clear -->"
                    || m.content == "<!-- context-compressed -->")
        })
        .map(|idx| idx + 1) // skip the marker itself
        .unwrap_or(0);

    let effective_msgs = &candidate_msgs[start_idx..];

    // 5. Create new conversation with copied settings
    let new_id = gen_id();
    let now = now_ts();
    let branch_title = custom_title
        .map(|t| t.to_string())
        .unwrap_or_else(|| source.title.clone());

    // Determine parent_conversation_id
    let parent_id = if as_child {
        // If source already has a parent, new branch is a sibling (same parent)
        // Otherwise, source becomes the parent
        Some(
            source
                .parent_conversation_id
                .clone()
                .unwrap_or_else(|| source.id.clone()),
        )
    } else {
        None
    };

    let _file_reference_guard = crate::repo::stored_file::lock_file_references().await;
    let txn = db.begin().await?;
    conversations::ActiveModel {
        id: Set(new_id.clone()),
        title: Set(branch_title),
        model_id: Set(source.model_id.clone()),
        provider_id: Set(source.provider_id.clone()),
        system_prompt: Set(source.system_prompt.clone()),
        temperature: Set(source.temperature),
        max_tokens: Set(source.max_tokens),
        top_p: Set(source.top_p),
        frequency_penalty: Set(source.frequency_penalty),
        search_enabled: Set(source.search_enabled),
        search_provider_id: Set(source.search_provider_id.clone()),
        thinking_budget: Set(source.thinking_budget),
        thinking_level: Set(source.thinking_level.clone()),
        enabled_mcp_server_ids: Set(source.enabled_mcp_server_ids.clone()),
        enabled_knowledge_base_ids: Set(source.enabled_knowledge_base_ids.clone()),
        enabled_memory_namespace_ids: Set(source.enabled_memory_namespace_ids.clone()),
        message_count: Set(effective_msgs.len() as i32),
        is_pinned: Set(0),
        is_archived: Set(0),
        context_compression: Set(source.context_compression),
        category_id: Set(source.category_id.clone()),
        parent_conversation_id: Set(parent_id),
        research_mode: Set(source.research_mode),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    }
    .insert(&txn)
    .await?;

    // 6. Copy messages and give every stored-media reference branch-owned IDs.
    // Physical files remain shared by storage_path/hash and are removed only
    // after the final stored_files reference is deleted.
    let mut message_id_map = std::collections::HashMap::new();
    let mut stored_file_id_map = std::collections::HashMap::new();
    let mut last_created_at = None;
    for msg in effective_msgs {
        let new_msg_id = gen_id();
        message_id_map.insert(msg.id.clone(), new_msg_id.clone());

        let new_parent = msg
            .parent_message_id
            .as_ref()
            .and_then(|pid| message_id_map.get(pid))
            .cloned();
        let (content, attachments) = clone_message_media_for_branch(
            &txn,
            &new_id,
            &msg.content,
            &msg.attachments,
            &mut stored_file_id_map,
        )
        .await?;
        let created_at = last_created_at
            .map(|previous| msg.created_at.max(previous + 1))
            .unwrap_or(msg.created_at);
        last_created_at = Some(created_at);

        messages::ActiveModel {
            id: Set(new_msg_id),
            conversation_id: Set(new_id.clone()),
            role: Set(msg.role.clone()),
            content: Set(content),
            provider_id: Set(msg.provider_id.clone()),
            model_id: Set(msg.model_id.clone()),
            token_count: Set(msg.token_count),
            prompt_tokens: Set(msg.prompt_tokens),
            completion_tokens: Set(msg.completion_tokens),
            attachments: Set(attachments),
            thinking: Set(msg.thinking.clone()),
            created_at: Set(created_at),
            parent_message_id: Set(new_parent),
            version_index: Set(msg.version_index),
            is_active: Set(1),
            tool_calls_json: Set(msg.tool_calls_json.clone()),
            tool_call_id: Set(msg.tool_call_id.clone()),
            status: Set(msg.status.clone()),
            tokens_per_second: Set(msg.tokens_per_second),
            first_token_latency_ms: Set(msg.first_token_latency_ms),
            ..Default::default()
        }
        .insert(&txn)
        .await?;
    }
    txn.commit().await?;

    get_conversation(db, &new_id).await
}

pub async fn search_conversations(
    db: &DatabaseConnection,
    query: &str,
) -> Result<Vec<ConversationSearchResult>> {
    #[derive(Debug, FromQueryResult)]
    struct FtsRow {
        message_id: String,
        conversation_id: String,
        preview: String,
    }

    let fts_rows = FtsRow::find_by_statement(Statement::from_sql_and_values(
        DatabaseBackend::Sqlite,
        "SELECT m.id as message_id, m.conversation_id, snippet(messages_fts, 0, '', '', '...', 32) as preview \
         FROM messages_fts \
         JOIN messages m ON m.rowid = messages_fts.rowid \
         WHERE messages_fts MATCH ? \
         ORDER BY rank",
        [query.into()],
    ))
    .all(db)
    .await?;

    let mut results = Vec::with_capacity(fts_rows.len());
    let mut seen_conversations = HashSet::new();
    for fts in fts_rows {
        if crate::inline_media::contains_inline_image_data(&fts.preview) {
            return Err(AQBotError::Validation(format!(
                "Message {} cannot be returned in search results: unresolved inline media remains in preview",
                fts.message_id
            )));
        }
        if !seen_conversations.insert(fts.conversation_id.clone()) {
            continue;
        }
        if let Ok(conv) = get_conversation(db, &fts.conversation_id).await {
            results.push(ConversationSearchResult {
                conversation: conv,
                matched_message_preview: Some(fts.preview),
            });
        }
    }
    Ok(results)
}

pub async fn increment_message_count(db: &DatabaseConnection, conversation_id: &str) -> Result<()> {
    db.execute(Statement::from_sql_and_values(
        DatabaseBackend::Sqlite,
        "UPDATE conversations SET message_count = message_count + 1, updated_at = ? WHERE id = ?",
        [now_ts().into(), conversation_id.into()],
    ))
    .await?;
    Ok(())
}

pub async fn decrement_message_count(db: &DatabaseConnection, conversation_id: &str) -> Result<()> {
    db.execute(Statement::from_sql_and_values(
        DatabaseBackend::Sqlite,
        "UPDATE conversations SET message_count = MAX(0, message_count - 1), updated_at = ? WHERE id = ?",
        [now_ts().into(), conversation_id.into()],
    ))
    .await?;
    Ok(())
}

// ── Conversation summaries ──────────────────────────────────────────────

fn summary_from_entity(m: conversation_summaries::Model) -> ConversationSummary {
    ConversationSummary {
        id: m.id,
        conversation_id: m.conversation_id,
        summary_text: m.summary_text,
        compressed_until_message_id: m.compressed_until_message_id,
        token_count: m.token_count.map(|v| v as u32),
        model_used: m.model_used,
        created_at: m.created_at,
        updated_at: m.updated_at,
    }
}

pub async fn get_summary(
    db: &DatabaseConnection,
    conversation_id: &str,
) -> Result<Option<ConversationSummary>> {
    let row = conversation_summaries::Entity::find()
        .filter(conversation_summaries::Column::ConversationId.eq(conversation_id))
        .order_by_desc(conversation_summaries::Column::UpdatedAt)
        .one(db)
        .await?;

    Ok(row.map(summary_from_entity))
}

pub async fn upsert_summary(
    db: &DatabaseConnection,
    conversation_id: &str,
    summary_text: &str,
    compressed_until_message_id: Option<&str>,
    token_count: Option<u32>,
    model_used: Option<&str>,
) -> Result<ConversationSummary> {
    let now = now_ts();

    let existing = conversation_summaries::Entity::find()
        .filter(conversation_summaries::Column::ConversationId.eq(conversation_id))
        .one(db)
        .await?;

    match existing {
        Some(row) => {
            let mut am: conversation_summaries::ActiveModel = row.into();
            am.summary_text = Set(summary_text.to_string());
            am.compressed_until_message_id =
                Set(compressed_until_message_id.map(|s| s.to_string()));
            am.token_count = Set(token_count.map(|v| v as i64));
            am.model_used = Set(model_used.map(|s| s.to_string()));
            am.updated_at = Set(now);
            am.update(db).await?;
        }
        None => {
            let id = gen_id();
            conversation_summaries::ActiveModel {
                id: Set(id),
                conversation_id: Set(conversation_id.to_string()),
                summary_text: Set(summary_text.to_string()),
                compressed_until_message_id: Set(
                    compressed_until_message_id.map(|s| s.to_string()),
                ),
                token_count: Set(token_count.map(|v| v as i64)),
                model_used: Set(model_used.map(|s| s.to_string())),
                created_at: Set(now),
                updated_at: Set(now),
            }
            .insert(db)
            .await?;
        }
    }

    get_summary(db, conversation_id).await?.ok_or_else(|| {
        AQBotError::Database(sea_orm::DbErr::Custom(
            "Failed to read back upserted summary".into(),
        ))
    })
}

pub async fn delete_summary(db: &DatabaseConnection, conversation_id: &str) -> Result<()> {
    conversation_summaries::Entity::delete_many()
        .filter(conversation_summaries::Column::ConversationId.eq(conversation_id))
        .exec(db)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::create_test_pool;
    use crate::repo::message;
    use crate::types::MessageRole;

    #[test]
    fn stored_media_rewrite_respects_overlapping_id_boundaries() {
        let id_map = std::collections::HashMap::from([
            ("abc".to_string(), "branch-one".to_string()),
            ("abc-2".to_string(), "branch-two".to_string()),
        ]);

        let rewritten = rewrite_stored_media_ids(
            "aqbot-media://stored/abc aqbot-media://stored/abc-2",
            &id_map,
        );

        assert_eq!(
            rewritten,
            "aqbot-media://stored/branch-one aqbot-media://stored/branch-two"
        );
    }

    #[test]
    fn stored_media_rewrite_stops_before_protocol_unsafe_punctuation() {
        let id_map = std::collections::HashMap::from([
            ("id_1".to_string(), "branch-one".to_string()),
            ("id-2".to_string(), "branch-two".to_string()),
        ]);

        let rewritten = rewrite_stored_media_ids(
            "aqbot-media://stored/id_1. https://aqbot-media.localhost/stored/id-2~",
            &id_map,
        );

        assert_eq!(
            rewritten,
            "aqbot-media://stored/branch-one. https://aqbot-media.localhost/stored/branch-two~"
        );
    }

    #[test]
    fn stored_media_rewrite_supports_native_and_windows_protocol_urls() {
        let id_map = std::collections::HashMap::from([
            ("native-id".to_string(), "native-branch".to_string()),
            ("windows-id".to_string(), "windows-branch".to_string()),
            ("https-id".to_string(), "https-branch".to_string()),
        ]);
        let content = concat!(
            "aqbot-media://stored/native-id ",
            "http://AQBOT-MEDIA.LOCALHOST/stored/windows-id ",
            "https://aqbot-media.localhost/stored/https-id"
        );

        let ids = crate::repo::stored_file::stored_media_ids(content);
        let rewritten = rewrite_stored_media_ids(content, &id_map);

        assert_eq!(
            ids,
            std::collections::HashSet::from([
                "native-id".to_string(),
                "windows-id".to_string(),
                "https-id".to_string(),
            ])
        );
        assert_eq!(
            rewritten,
            concat!(
                "aqbot-media://stored/native-branch ",
                "http://AQBOT-MEDIA.LOCALHOST/stored/windows-branch ",
                "https://aqbot-media.localhost/stored/https-branch"
            )
        );
    }

    #[tokio::test]
    async fn branch_with_missing_stored_media_rolls_back_all_branch_rows() {
        let h = create_test_pool().await.unwrap();
        let db = &h.conn;
        let source = create_conversation(db, "Broken media", "model-a", "provider-a", None)
            .await
            .unwrap();
        let source_message = message::create_message(
            db,
            &source.id,
            MessageRole::Assistant,
            "![missing](aqbot-media://stored/missing-file)",
            &[],
            None,
            0,
        )
        .await
        .unwrap();

        let error = branch_conversation(db, &source.id, &source_message.id, false, None)
            .await
            .unwrap_err();

        assert!(error.to_string().contains("StoredFile missing-file"));
        assert_eq!(list_conversations(db).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn branch_clones_and_rewrites_windows_stored_media_reference() {
        let h = create_test_pool().await.unwrap();
        let db = &h.conn;
        let source = create_conversation(db, "Windows media", "model-a", "provider-a", None)
            .await
            .unwrap();
        crate::repo::stored_file::create_stored_file(
            db,
            "source-file",
            "hash",
            "preview.png",
            "image/png",
            8,
            "images/preview.png",
            Some(&source.id),
        )
        .await
        .unwrap();
        let source_message = message::create_message(
            db,
            &source.id,
            MessageRole::Assistant,
            "![preview](http://AQBOT-MEDIA.LOCALHOST/stored/source-file)",
            &[],
            None,
            0,
        )
        .await
        .unwrap();

        let branch = branch_conversation(db, &source.id, &source_message.id, false, None)
            .await
            .unwrap();
        let branch_files = crate::repo::stored_file::list_stored_files_by_conversation(
            db,
            &branch.id,
        )
        .await
        .unwrap();
        let branch_messages = message::list_messages(db, &branch.id).await.unwrap();

        assert_eq!(branch_files.len(), 1);
        assert_ne!(branch_files[0].id, "source-file");
        assert_eq!(
            branch_messages[0].content,
            format!(
                "![preview](http://AQBOT-MEDIA.LOCALHOST/stored/{})",
                branch_files[0].id
            )
        );
    }

    #[tokio::test]
    async fn conversation_search_fails_closed_with_message_id_for_inline_data_preview() {
        let h = create_test_pool().await.unwrap();
        let db = &h.conn;
        let conversation =
            create_conversation(db, "Unsafe search", "model-a", "provider-a", None)
                .await
                .unwrap();
        let message = message::create_message(
            db,
            &conversation.id,
            MessageRole::Assistant,
            "findme data:image/png;base64,SEARCH_SECRET",
            &[],
            None,
            0,
        )
        .await
        .unwrap();

        let error = search_conversations(db, "findme").await.unwrap_err();

        assert!(error.to_string().contains(&message.id));
        assert!(!error.to_string().contains("SEARCH_SECRET"));
    }

    #[tokio::test]
    async fn branch_conversation_from_inactive_assistant_version_uses_selected_version() {
        let h = create_test_pool().await.unwrap();
        let db = &h.conn;

        let conv = create_conversation(db, "Branch Source", "model-a", "provider-a", None)
            .await
            .unwrap();

        let user = message::create_message(
            db,
            &conv.id,
            MessageRole::User,
            "Compare answers",
            &[],
            None,
            0,
        )
        .await
        .unwrap();
        let active = message::create_message(
            db,
            &conv.id,
            MessageRole::Assistant,
            "Active answer",
            &[],
            Some(&user.id),
            0,
        )
        .await
        .unwrap();
        let inactive = message::create_message(
            db,
            &conv.id,
            MessageRole::Assistant,
            "Inactive answer",
            &[],
            Some(&user.id),
            1,
        )
        .await
        .unwrap();
        message::set_active_version(db, &conv.id, &user.id, &active.id)
            .await
            .unwrap();

        let branched = branch_conversation(
            db,
            &conv.id,
            &inactive.id,
            false,
            Some("Branched from inactive"),
        )
        .await
        .unwrap();

        let branched_messages = message::list_messages(db, &branched.id).await.unwrap();
        assert_eq!(branched_messages.len(), 2);
        assert_eq!(branched_messages[0].content, "Compare answers");
        assert_eq!(branched_messages[1].content, "Inactive answer");
        assert!(branched_messages[1].is_active);
    }
}
