use sea_orm::*;
use serde_json;

use crate::entity::conversations;
use crate::error::{AQBotError, Result};
use crate::types::{Conversation, ConversationSearchResult, UpdateConversationInput};
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
        enabled_mcp_server_ids: parse_string_list(&m.enabled_mcp_server_ids),
        enabled_knowledge_base_ids: parse_string_list(&m.enabled_knowledge_base_ids),
        enabled_memory_namespace_ids: parse_string_list(&m.enabled_memory_namespace_ids),
        message_count: m.message_count as u32,
        is_pinned: m.is_pinned != 0,
        is_archived: m.is_archived != 0,
        created_at: m.created_at,
        updated_at: m.updated_at,
    }
}

fn parse_string_list(raw: &str) -> Vec<String> {
    serde_json::from_str(raw)
        .expect("conversation preference JSON is invalid; database contents are corrupted")
}

fn stringify_string_list(values: &[String]) -> String {
    serde_json::to_string(values)
        .expect("failed to serialize conversation preference JSON")
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
        am.system_prompt = Set(if sp.is_empty() { None } else { Some(sp.clone()) });
    }
    if let Some(temp) = input.temperature {
        am.temperature = Set(Some(temp));
    }
    if let Some(mt) = input.max_tokens {
        am.max_tokens = Set(Some(mt));
    }
    if let Some(tp) = input.top_p {
        am.top_p = Set(Some(tp));
    }
    if let Some(fp) = input.frequency_penalty {
        am.frequency_penalty = Set(Some(fp));
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
    if let Some(enabled_mcp_server_ids) = input.enabled_mcp_server_ids {
        am.enabled_mcp_server_ids = Set(stringify_string_list(&enabled_mcp_server_ids));
    }
    if let Some(enabled_knowledge_base_ids) = input.enabled_knowledge_base_ids {
        am.enabled_knowledge_base_ids = Set(stringify_string_list(&enabled_knowledge_base_ids));
    }
    if let Some(enabled_memory_namespace_ids) = input.enabled_memory_namespace_ids {
        am.enabled_memory_namespace_ids = Set(stringify_string_list(&enabled_memory_namespace_ids));
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
