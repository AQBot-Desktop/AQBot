use sea_orm::*;
use serde_json;

use crate::entity::{conversation_summaries, conversations, messages};
use crate::error::{AQBotError, Result};
use crate::types::{
    Conversation, ConversationSearchResult, ConversationSummary, UpdateConversationInput,
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
        .all(db)
        .await?;

    // 3. Find the target message index
    let target_idx = all_msgs
        .iter()
        .position(|m| m.id == until_message_id)
        .ok_or_else(|| {
            AQBotError::NotFound(format!("Message {} in conversation", until_message_id))
        })?;

    // 4. Slice messages up to (and including) the target
    let candidate_msgs = &all_msgs[..=target_idx];

    // 5. Find last context-clear marker to determine effective start
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

    // 6. Create new conversation with copied settings
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
    .insert(db)
    .await?;

    // 7. Copy messages — assign new IDs and remap parent_message_id references
    let mut id_map = std::collections::HashMap::new();
    for msg in effective_msgs {
        let new_msg_id = gen_id();
        id_map.insert(msg.id.clone(), new_msg_id.clone());

        let new_parent = msg
            .parent_message_id
            .as_ref()
            .and_then(|pid| id_map.get(pid))
            .cloned();

        messages::ActiveModel {
            id: Set(new_msg_id),
            conversation_id: Set(new_id.clone()),
            role: Set(msg.role.clone()),
            content: Set(msg.content.clone()),
            provider_id: Set(msg.provider_id.clone()),
            model_id: Set(msg.model_id.clone()),
            token_count: Set(msg.token_count),
            prompt_tokens: Set(msg.prompt_tokens),
            completion_tokens: Set(msg.completion_tokens),
            attachments: Set(msg.attachments.clone()),
            thinking: Set(msg.thinking.clone()),
            created_at: Set(msg.created_at),
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
        .insert(db)
        .await?;
    }

    get_conversation(db, &new_id).await
}

pub async fn search_conversations(
    db: &DatabaseConnection,
    query: &str,
) -> Result<Vec<ConversationSearchResult>> {
    #[derive(Debug, FromQueryResult)]
    struct FtsRow {
        conversation_id: String,
        preview: String,
    }

    let fts_rows = FtsRow::find_by_statement(Statement::from_sql_and_values(
        DatabaseBackend::Sqlite,
        "SELECT m.conversation_id, snippet(messages_fts, 0, '', '', '...', 32) as preview \
         FROM messages_fts \
         JOIN messages m ON m.rowid = messages_fts.rowid \
         WHERE messages_fts MATCH ? \
         GROUP BY m.conversation_id \
         ORDER BY rank",
        [query.into()],
    ))
    .all(db)
    .await?;

    let mut results = Vec::with_capacity(fts_rows.len());
    for fts in fts_rows {
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
