use sea_orm::*;
use sea_orm::sea_query::Expr;
use serde_json;
use std::collections::HashSet;

use crate::entity::{
    conversation_categories, conversation_summaries, conversations, messages, stored_files,
};
use crate::error::{AQBotError, Result};
use crate::types::{
    Attachment, ContextStrategy, Conversation, ConversationSearchResult, ConversationSummary,
    Message, MultiModelContinuationMode, MultiModelDisplayMode, MultiModelTarget,
    UpdateConversationInput,
};
use crate::utils::{gen_id, now_ts};

fn persisted_nonnegative_u32(field: &str, value: Option<i32>) -> Result<Option<u32>> {
    value
        .map(|value| {
            u32::try_from(value).map_err(|_| {
                AQBotError::Validation(format!(
                    "Invalid negative {field} value in the conversations table: {value}"
                ))
            })
        })
        .transpose()
}

fn validated_i32_override(field: &str, value: i64, max: i64) -> Result<i32> {
    if !(0..=max).contains(&value) {
        return Err(AQBotError::Validation(format!(
            "{field} must be an integer between 0 and {max}"
        )));
    }
    i32::try_from(value).map_err(|_| {
        AQBotError::Validation(format!("{field} must be an integer between 0 and {max}"))
    })
}

fn conversation_from_entity(m: conversations::Model) -> Result<Conversation> {
    let context_strategy_override = m
        .context_strategy_override
        .as_deref()
        .map(str::parse::<ContextStrategy>)
        .transpose()
        .map_err(AQBotError::Validation)?;
    let context_message_limit =
        persisted_nonnegative_u32("context_message_limit", m.context_message_limit)?;
    let compression_keep_last_n =
        persisted_nonnegative_u32("compression_keep_last_n", m.compression_keep_last_n)?;
    let multi_model_display_mode_override = m
        .multi_model_display_mode_override
        .as_deref()
        .map(str::parse::<MultiModelDisplayMode>)
        .transpose()
        .map_err(AQBotError::Validation)?;
    let multi_model_targets = parse_multi_model_targets(&m.multi_model_targets_json)?;
    let multi_model_continuation_mode = m
        .multi_model_continuation_mode
        .parse::<MultiModelContinuationMode>()
        .map_err(AQBotError::Validation)?;

    Ok(Conversation {
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
        context_strategy_override,
        context_message_limit,
        compression_keep_last_n,
        multi_model_display_mode_override,
        multi_model_targets,
        multi_model_continuation_mode,
        category_id: m.category_id,
        parent_conversation_id: m.parent_conversation_id,
        sort_order: m.sort_order,
        mode: m.mode,
        tab_pin_order: m.tab_pin_order,
        created_at: m.created_at,
        updated_at: m.updated_at,
    })
}

fn parse_string_list(raw: &str) -> Vec<String> {
    serde_json::from_str(raw)
        .expect("conversation preference JSON is invalid; database contents are corrupted")
}

fn stringify_string_list(values: &[String]) -> String {
    serde_json::to_string(values).expect("failed to serialize conversation preference JSON")
}

fn parse_multi_model_targets(raw: &str) -> Result<Vec<MultiModelTarget>> {
    let targets: Vec<MultiModelTarget> = serde_json::from_str(raw).map_err(|error| {
        AQBotError::Validation(format!(
            "Invalid multi_model_targets_json in the conversations table: {error}"
        ))
    })?;
    crate::types::validate_multi_model_targets(&targets).map_err(AQBotError::Validation)?;
    Ok(targets)
}

fn stringify_multi_model_targets(targets: &[MultiModelTarget]) -> Result<String> {
    crate::types::validate_multi_model_targets(targets).map_err(AQBotError::Validation)?;
    serde_json::to_string(targets)
        .map_err(|error| AQBotError::Validation(format!("failed to serialize multi_model_targets: {error}")))
}

fn transaction_failure(primary: AQBotError, rollback: Option<DbErr>) -> AQBotError {
    match rollback {
        None => primary,
        Some(rollback) => AQBotError::Validation(format!(
            "{primary}; transaction rollback failed: {rollback}"
        )),
    }
}

async fn ensure_category_exists<C>(db: &C, category_id: &str) -> Result<()>
where
    C: ConnectionTrait,
{
    if conversation_categories::Entity::find_by_id(category_id)
        .one(db)
        .await?
        .is_none()
    {
        return Err(AQBotError::NotFound(format!(
            "ConversationCategory {category_id}"
        )));
    }
    Ok(())
}

async fn ordered_active_roots<C>(
    db: &C,
    category_id: Option<&str>,
    pinned: bool,
    excluded_ids: &[String],
) -> Result<Vec<(String, i32)>>
where
    C: ConnectionTrait,
{
    let mut query = conversations::Entity::find()
        .filter(conversations::Column::IsArchived.eq(0))
        .filter(conversations::Column::ParentConversationId.is_null());
    query = match category_id {
        Some(category_id) => query.filter(conversations::Column::CategoryId.eq(category_id)),
        None => query
            .filter(conversations::Column::CategoryId.is_null())
            .filter(conversations::Column::IsPinned.eq(if pinned { 1 } else { 0 })),
    };
    if !excluded_ids.is_empty() {
        query = query.filter(conversations::Column::Id.is_not_in(excluded_ids.iter().cloned()));
    }
    Ok(query
        .order_by_asc(conversations::Column::SortOrder)
        .order_by_desc(conversations::Column::UpdatedAt)
        .order_by_asc(conversations::Column::Id)
        .all(db)
        .await?
        .into_iter()
        .map(|row| (row.id, row.sort_order))
        .collect())
}

async fn write_sort_orders<C>(db: &C, ids: &[String], start: i32) -> Result<()>
where
    C: ConnectionTrait,
{
    for (offset, id) in ids.iter().enumerate() {
        let offset = i32::try_from(offset).map_err(|_| {
            AQBotError::Validation("Too many conversations to assign sort order".to_string())
        })?;
        let order = start.checked_add(offset).ok_or_else(|| {
            AQBotError::Validation("Too many conversations to assign sort order".to_string())
        })?;
        let result = conversations::Entity::update_many()
            .col_expr(conversations::Column::SortOrder, Expr::value(order))
            .filter(conversations::Column::Id.eq(id))
            .exec(db)
            .await?;
        if result.rows_affected != 1 {
            return Err(AQBotError::NotFound(format!("Conversation {id}")));
        }
    }
    Ok(())
}

async fn prepare_new_root_at_top<C>(db: &C, category_id: Option<&str>, pinned: bool) -> Result<i32>
where
    C: ConnectionTrait,
{
    let peers = ordered_active_roots(db, category_id, pinned, &[]).await?;
    let Some((_, minimum_order)) = peers.first() else {
        return Ok(0);
    };
    if let Some(order) = minimum_order.checked_sub(1) {
        return Ok(order);
    }

    let peer_ids = peers.into_iter().map(|(id, _)| id).collect::<Vec<_>>();
    write_sort_orders(db, &peer_ids, 1).await?;
    Ok(0)
}

pub(crate) async fn place_existing_roots_at_top<C>(
    db: &C,
    category_id: Option<&str>,
    pinned: bool,
    conversation_ids: &[String],
) -> Result<()>
where
    C: ConnectionTrait,
{
    if conversation_ids.is_empty() {
        return Ok(());
    }
    let unique = conversation_ids.iter().collect::<HashSet<_>>();
    if unique.len() != conversation_ids.len() {
        return Err(AQBotError::Validation(
            "Conversation order contains duplicate IDs".to_string(),
        ));
    }
    let peers = ordered_active_roots(db, category_id, pinned, conversation_ids).await?;
    let moved_count = i32::try_from(conversation_ids.len()).map_err(|_| {
        AQBotError::Validation("Too many conversations to assign sort order".to_string())
    })?;
    if let Some(start) = peers
        .first()
        .map(|(_, minimum_order)| minimum_order.checked_sub(moved_count))
        .unwrap_or(Some(0))
    {
        return write_sort_orders(db, conversation_ids, start).await;
    }

    write_sort_orders(db, conversation_ids, 0).await?;
    let peer_ids = peers.into_iter().map(|(id, _)| id).collect::<Vec<_>>();
    write_sort_orders(db, &peer_ids, moved_count).await
}

pub async fn list_conversations(db: &DatabaseConnection) -> Result<Vec<Conversation>> {
    let rows = conversations::Entity::find()
        .filter(conversations::Column::IsArchived.eq(0))
        .order_by_desc(conversations::Column::IsPinned)
        .order_by_desc(conversations::Column::UpdatedAt)
        .all(db)
        .await?;

    rows.into_iter().map(conversation_from_entity).collect()
}

/// Most recently updated non-archived conversations for tray / quick switchers.
/// Pinning does not affect order — strictly `updated_at` DESC.
pub async fn list_recent_conversations(
    db: &DatabaseConnection,
    limit: u64,
) -> Result<Vec<Conversation>> {
    let rows = conversations::Entity::find()
        .filter(conversations::Column::IsArchived.eq(0))
        .order_by_desc(conversations::Column::UpdatedAt)
        .limit(limit)
        .all(db)
        .await?;

    rows.into_iter().map(conversation_from_entity).collect()
}

/// Provider/model pair of the most recently updated non-archived conversation.
/// Unlike [`list_conversations`], pinning does not affect the ordering — this
/// is strictly "the model the user chatted with last".
pub async fn most_recent_conversation_model(
    db: &DatabaseConnection,
) -> Result<Option<(String, String)>> {
    let row = conversations::Entity::find()
        .filter(conversations::Column::IsArchived.eq(0))
        .order_by_desc(conversations::Column::UpdatedAt)
        .one(db)
        .await?;

    Ok(row.map(|conversation| (conversation.provider_id, conversation.model_id)))
}

pub async fn list_archived_conversations(db: &DatabaseConnection) -> Result<Vec<Conversation>> {
    let rows = conversations::Entity::find()
        .filter(conversations::Column::IsArchived.ne(0))
        .order_by_desc(conversations::Column::UpdatedAt)
        .all(db)
        .await?;

    rows.into_iter().map(conversation_from_entity).collect()
}

pub async fn get_conversation(db: &DatabaseConnection, id: &str) -> Result<Conversation> {
    let row = conversations::Entity::find_by_id(id)
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("Conversation {}", id)))?;

    conversation_from_entity(row)
}

/// Persist the complete order of all active root conversations in one category
/// (or in the uncategorized container). The validation and writes are atomic,
/// and the operation intentionally leaves `updated_at` unchanged.
pub async fn reorder_conversations(
    db: &DatabaseConnection,
    category_id: Option<&str>,
    conversation_ids: &[String],
) -> Result<()> {
    let txn = db.begin().await?;
    let operation = async {
        if let Some(category_id) = category_id {
            ensure_category_exists(&txn, category_id).await?;
        }

        let mut query = conversations::Entity::find()
            .filter(conversations::Column::IsArchived.eq(0))
            .filter(conversations::Column::ParentConversationId.is_null());
        query = match category_id {
            Some(category_id) => query.filter(conversations::Column::CategoryId.eq(category_id)),
            None => query.filter(conversations::Column::CategoryId.is_null()),
        };
        let expected_ids = query
            .all(&txn)
            .await?
            .into_iter()
            .map(|row| row.id)
            .collect::<HashSet<_>>();
        let provided_ids = conversation_ids.iter().cloned().collect::<HashSet<_>>();
        if provided_ids.len() != conversation_ids.len() {
            return Err(AQBotError::Validation(
                "Conversation order contains duplicate IDs".to_string(),
            ));
        }
        if expected_ids != provided_ids {
            return Err(AQBotError::Validation(
                "Conversation order must contain every active root conversation in the target container exactly once"
                    .to_string(),
            ));
        }

        write_sort_orders(&txn, conversation_ids, 0).await
    }
    .await;
    if let Err(error) = operation {
        let rollback = txn.rollback().await.err();
        return Err(transaction_failure(error, rollback));
    }
    txn.commit().await?;
    Ok(())
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

    let txn = db.begin().await?;
    let operation = async {
        let sort_order = prepare_new_root_at_top(&txn, None, false).await?;
        conversations::ActiveModel {
            id: Set(id.clone()),
            title: Set(title.to_string()),
            model_id: Set(model_id.to_string()),
            provider_id: Set(provider_id.to_string()),
            system_prompt: Set(system_prompt.map(str::to_string)),
            message_count: Set(0),
            is_pinned: Set(0),
            sort_order: Set(sort_order),
            created_at: Set(now),
            updated_at: Set(now),
            ..Default::default()
        }
        .insert(&txn)
        .await?;
        Ok(())
    }
    .await;
    if let Err(error) = operation {
        let rollback = txn.rollback().await.err();
        return Err(transaction_failure(error, rollback));
    }
    txn.commit().await?;

    get_conversation(db, &id).await
}

pub async fn update_conversation(
    db: &DatabaseConnection,
    id: &str,
    input: UpdateConversationInput,
) -> Result<Conversation> {
    let inherited_context_strategy = if input.context_strategy_override == Some(None) {
        Some(
            crate::repo::settings::get_settings(db)
                .await?
                .default_context_strategy,
        )
    } else {
        None
    };
    let txn = db.begin().await?;
    let row = conversations::Entity::find_by_id(id)
        .one(&txn)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("Conversation {}", id)))?;

    let now = now_ts();
    let existing = conversation_from_entity(row.clone())?;
    let target_category_id = input
        .category_id
        .clone()
        .unwrap_or_else(|| row.category_id.clone());
    let target_parent_id = input
        .parent_conversation_id
        .clone()
        .unwrap_or_else(|| row.parent_conversation_id.clone());
    let target_is_pinned = input.is_pinned.unwrap_or(row.is_pinned != 0);
    let target_is_archived = input.is_archived.unwrap_or(row.is_archived != 0);
    let category_changed = target_category_id != row.category_id;
    let enters_active_root = !target_is_archived
        && target_parent_id.is_none()
        && (category_changed
            || row.is_archived != 0
            || row.parent_conversation_id.is_some()
            || (target_category_id.is_none() && target_is_pinned != (row.is_pinned != 0)));

    let context_message_limit = input
        .context_message_limit
        .map(|value| {
            value
                .map(|value| {
                    validated_i32_override("context_message_limit", value, i32::MAX as i64)
                })
                .transpose()
        })
        .transpose()?;
    let compression_keep_last_n = input
        .compression_keep_last_n
        .map(|value| {
            value
                .map(|value| {
                    validated_i32_override(
                        "compression_keep_last_n",
                        value,
                        crate::types::MAX_COMPRESSION_KEEP_LAST_N as i64,
                    )
                })
                .transpose()
        })
        .transpose()?;

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
    if is_archived {
        am.tab_pin_order = Set(None);
    }
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
    if let Some(context_strategy_override) = input.context_strategy_override {
        let legacy_strategy = match context_strategy_override {
            Some(strategy) => strategy,
            None => inherited_context_strategy.ok_or_else(|| {
                AQBotError::Validation(
                    "Inherited context strategy was not loaded before update".to_string(),
                )
            })?,
        };
        am.context_strategy_override =
            Set(context_strategy_override.map(|strategy| strategy.as_str().to_string()));
        am.context_compression = Set(if legacy_strategy == ContextStrategy::SmartSummary {
            1
        } else {
            0
        });
    } else if let Some(context_compression) = input.context_compression {
        let strategy = if context_compression {
            ContextStrategy::SmartSummary
        } else {
            ContextStrategy::RawTruncate
        };
        am.context_compression = Set(if context_compression { 1 } else { 0 });
        am.context_strategy_override = Set(Some(strategy.as_str().to_string()));
    }
    if let Some(context_message_limit) = context_message_limit {
        am.context_message_limit = Set(context_message_limit);
    }
    if let Some(compression_keep_last_n) = compression_keep_last_n {
        am.compression_keep_last_n = Set(compression_keep_last_n);
    }
    if let Some(multi_model_display_mode_override) = input.multi_model_display_mode_override {
        am.multi_model_display_mode_override =
            Set(multi_model_display_mode_override.map(|mode| mode.as_str().to_string()));
    }
    if let Some(multi_model_targets) = input.multi_model_targets {
        am.multi_model_targets_json = Set(stringify_multi_model_targets(&multi_model_targets)?);
    }
    if let Some(multi_model_continuation_mode) = input.multi_model_continuation_mode {
        am.multi_model_continuation_mode =
            Set(multi_model_continuation_mode.as_str().to_string());
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

    let operation = async {
        if category_changed {
            if let Some(category_id) = target_category_id.as_deref() {
                ensure_category_exists(&txn, category_id).await?;
            }
        }
        if enters_active_root {
            place_existing_roots_at_top(
                &txn,
                target_category_id.as_deref(),
                target_is_pinned,
                &[id.to_string()],
            )
            .await?;
        }
        am.update(&txn).await?;
        Ok(())
    }
    .await;
    if let Err(error) = operation {
        let rollback = txn.rollback().await.err();
        return Err(transaction_failure(error, rollback));
    }
    txn.commit().await?;

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
    let txn = db.begin().await?;
    let row = conversations::Entity::find_by_id(id)
        .one(&txn)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("Conversation {}", id)))?;

    let new_pinned = if row.is_pinned != 0 { 0 } else { 1 };
    let now = now_ts();
    let move_to_group_top =
        row.category_id.is_none() && row.parent_conversation_id.is_none() && row.is_archived == 0;

    let mut am: conversations::ActiveModel = row.into();
    am.is_pinned = Set(new_pinned);
    am.updated_at = Set(now);
    let operation = async {
        if move_to_group_top {
            place_existing_roots_at_top(&txn, None, new_pinned != 0, &[id.to_string()]).await?;
        }
        am.update(&txn).await?;
        Ok(())
    }
    .await;
    if let Err(error) = operation {
        let rollback = txn.rollback().await.err();
        return Err(transaction_failure(error, rollback));
    }
    txn.commit().await?;

    get_conversation(db, id).await
}

pub async fn set_conversation_tab_pinned(
    db: &DatabaseConnection,
    id: &str,
    pinned: bool,
) -> Result<Conversation> {
    let txn = db.begin().await?;
    let row = conversations::Entity::find_by_id(id)
        .one(&txn)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("Conversation {}", id)))?;

    if pinned && row.is_archived != 0 {
        let rollback = txn.rollback().await.err();
        return Err(transaction_failure(
            AQBotError::Validation("Cannot pin an archived conversation to the tab bar".into()),
            rollback,
        ));
    }

    let already_pinned = row.tab_pin_order.is_some();
    if pinned == already_pinned {
        txn.commit().await?;
        return get_conversation(db, id).await;
    }

    let next_order = if pinned {
        let current_max = conversations::Entity::find()
            .filter(conversations::Column::TabPinOrder.is_not_null())
            .order_by_desc(conversations::Column::TabPinOrder)
            .one(&txn)
            .await?
            .and_then(|conversation| conversation.tab_pin_order);
        Some(current_max.unwrap_or(0).saturating_add(1))
    } else {
        None
    };

    let mut am: conversations::ActiveModel = row.into();
    am.tab_pin_order = Set(next_order);
    let operation = async {
        am.update(&txn).await?;
        Ok(())
    }
    .await;
    if let Err(error) = operation {
        let rollback = txn.rollback().await.err();
        return Err(transaction_failure(error, rollback));
    }
    txn.commit().await?;
    get_conversation(db, id).await
}

pub async fn toggle_archive(db: &DatabaseConnection, id: &str) -> Result<Conversation> {
    let txn = db.begin().await?;
    let row = conversations::Entity::find_by_id(id)
        .one(&txn)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("Conversation {}", id)))?;

    let new_archived = if row.is_archived != 0 { 0 } else { 1 };
    let now = now_ts();
    let category_id = row.category_id.clone();
    let is_pinned = row.is_pinned != 0;
    let move_to_container_top = new_archived == 0 && row.parent_conversation_id.is_none();

    let mut am: conversations::ActiveModel = row.into();
    am.is_archived = Set(new_archived);
    if new_archived != 0 {
        am.tab_pin_order = Set(None);
    }
    am.updated_at = Set(now);
    let operation = async {
        if move_to_container_top {
            place_existing_roots_at_top(&txn, category_id.as_deref(), is_pinned, &[id.to_string()])
                .await?;
        }
        am.update(&txn).await?;
        Ok(())
    }
    .await;
    if let Err(error) = operation {
        let rollback = txn.rollback().await.err();
        return Err(transaction_failure(error, rollback));
    }
    txn.commit().await?;

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
    let _file_reference_guard = crate::repo::stored_file::lock_file_references().await;
    let txn = db.begin().await?;

    // 1. Load source conversation and its messages from the same transaction
    // snapshot used to create the branch.
    let source = conversations::Entity::find_by_id(conversation_id)
        .one(&txn)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("Conversation {}", conversation_id)))?;
    if let Some(category_id) = source.category_id.as_deref() {
        ensure_category_exists(&txn, category_id).await?;
    }

    // 2. Load all active messages ordered by created_at
    let all_msgs = messages::Entity::find()
        .filter(messages::Column::ConversationId.eq(conversation_id))
        .filter(messages::Column::IsActive.eq(1))
        .order_by_asc(messages::Column::CreatedAt)
        .order_by(Expr::cust("rowid"), Order::Asc)
        .all(&txn)
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
            .one(&txn)
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

    let sort_order = if parent_id.is_none() {
        prepare_new_root_at_top(&txn, source.category_id.as_deref(), false).await?
    } else {
        0
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
        context_strategy_override: Set(source.context_strategy_override.clone()),
        context_message_limit: Set(source.context_message_limit),
        compression_keep_last_n: Set(source.compression_keep_last_n),
        multi_model_display_mode_override: Set(source.multi_model_display_mode_override.clone()),
        multi_model_targets_json: Set(source.multi_model_targets_json.clone()),
        multi_model_continuation_mode: Set(source.multi_model_continuation_mode.clone()),
        category_id: Set(source.category_id.clone()),
        parent_conversation_id: Set(parent_id),
        sort_order: Set(sort_order),
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

/// Escape user input for FTS5 MATCH so special operators cannot break the query.
/// Uses a quoted phrase so multi-word and CJK queries work as substring-like search.
fn sanitize_fts_query(query: &str) -> Option<String> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return None;
    }
    // FTS5 phrase: double-quote wrapping; internal " doubled
    let escaped = trimmed.replace('"', "\"\"");
    Some(format!("\"{escaped}\""))
}

const SEARCH_RESULT_LIMIT: usize = 50;

pub async fn search_conversations(
    db: &DatabaseConnection,
    query: &str,
) -> Result<Vec<ConversationSearchResult>> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(vec![]);
    }

    #[derive(Debug, FromQueryResult)]
    struct FtsRow {
        message_id: String,
        conversation_id: String,
        preview: String,
    }

    let mut results: Vec<ConversationSearchResult> = Vec::new();
    let mut seen_conversations = HashSet::new();

    // 1) Title matches (non-archived)
    let like_pattern = format!("%{}%", trimmed.to_lowercase());
    let title_rows = conversations::Entity::find()
        .filter(conversations::Column::IsArchived.eq(0))
        .filter(Expr::cust_with_values(
            "LOWER(title) LIKE ?",
            [like_pattern.clone()],
        ))
        .order_by_desc(conversations::Column::UpdatedAt)
        .limit(SEARCH_RESULT_LIMIT as u64)
        .all(db)
        .await?;

    for row in title_rows {
        if !seen_conversations.insert(row.id.clone()) {
            continue;
        }
        results.push(ConversationSearchResult {
            conversation: conversation_from_entity(row)?,
            matched_message_preview: None,
        });
    }

    // 2) Content matches via FTS (prefer preview when conversation already title-matched)
    if let Some(fts_query) = sanitize_fts_query(trimmed) {
        let fts_rows = match FtsRow::find_by_statement(Statement::from_sql_and_values(
            DatabaseBackend::Sqlite,
            "SELECT m.id as message_id, m.conversation_id, \
                    snippet(messages_fts, 0, '', '', '...', 32) as preview \
             FROM messages_fts \
             JOIN messages m ON m.rowid = messages_fts.rowid \
             JOIN conversations c ON c.id = m.conversation_id \
             WHERE messages_fts MATCH ? AND c.is_archived = 0 \
             ORDER BY rank \
             LIMIT ?",
            [fts_query.into(), (SEARCH_RESULT_LIMIT as i64).into()],
        ))
        .all(db)
        .await
        {
            Ok(rows) => rows,
            // Malformed FTS input after sanitize should be rare; treat as no content hits
            Err(_) => Vec::new(),
        };

        for fts in fts_rows {
            if crate::inline_media::contains_inline_image_data(&fts.preview) {
                return Err(AQBotError::Validation(format!(
                    "Message {} cannot be returned in search results: unresolved inline media remains in preview",
                    fts.message_id
                )));
            }
            if let Some(existing) = results
                .iter_mut()
                .find(|r| r.conversation.id == fts.conversation_id)
            {
                // Enrich title-only hit with content preview
                if existing.matched_message_preview.is_none() {
                    existing.matched_message_preview = Some(fts.preview);
                }
                continue;
            }
            if !seen_conversations.insert(fts.conversation_id.clone()) {
                continue;
            }
            if let Ok(conv) = get_conversation(db, &fts.conversation_id).await {
                if conv.is_archived {
                    continue;
                }
                results.push(ConversationSearchResult {
                    conversation: conv,
                    matched_message_preview: Some(fts.preview),
                });
                if results.len() >= SEARCH_RESULT_LIMIT {
                    break;
                }
            }
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
        source_text: m.source_text,
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

fn validate_summary_text(summary_text: &str) -> Result<()> {
    if summary_text.trim().is_empty() {
        return Err(AQBotError::Validation(
            "Conversation summary must not be empty".to_string(),
        ));
    }
    Ok(())
}

async fn upsert_summary_record<C>(
    db: &C,
    conversation_id: &str,
    summary_text: &str,
    compressed_until_message_id: Option<&str>,
    token_count: Option<u32>,
    model_used: Option<&str>,
    source_text: Option<&str>,
) -> Result<()>
where
    C: ConnectionTrait,
{
    validate_summary_text(summary_text)?;
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
            am.token_count = Set(token_count.map(i64::from));
            am.model_used = Set(model_used.map(str::to_string));
            if let Some(source) = source_text {
                am.source_text = Set(Some(source.to_string()));
            }
            am.updated_at = Set(now);
            am.update(db).await?;
        }
        None => {
            conversation_summaries::ActiveModel {
                id: Set(gen_id()),
                conversation_id: Set(conversation_id.to_string()),
                summary_text: Set(summary_text.to_string()),
                compressed_until_message_id: Set(compressed_until_message_id.map(str::to_string)),
                source_text: Set(source_text.map(str::to_string)),
                token_count: Set(token_count.map(i64::from)),
                model_used: Set(model_used.map(str::to_string)),
                created_at: Set(now),
                updated_at: Set(now),
            }
            .insert(db)
            .await?;
        }
    }

    Ok(())
}

pub async fn upsert_summary(
    db: &DatabaseConnection,
    conversation_id: &str,
    summary_text: &str,
    compressed_until_message_id: Option<&str>,
    token_count: Option<u32>,
    model_used: Option<&str>,
    source_text: Option<&str>,
) -> Result<ConversationSummary> {
    upsert_summary_record(
        db,
        conversation_id,
        summary_text,
        compressed_until_message_id,
        token_count,
        model_used,
        source_text,
    )
    .await?;

    get_summary(db, conversation_id).await?.ok_or_else(|| {
        AQBotError::Database(sea_orm::DbErr::Custom(
            "Failed to read back upserted summary".into(),
        ))
    })
}

/// Atomically upsert a conversation summary and insert its system boundary marker.
pub async fn upsert_summary_with_marker(
    db: &DatabaseConnection,
    conversation_id: &str,
    summary_text: &str,
    compressed_until_message_id: Option<&str>,
    token_count: Option<u32>,
    model_used: Option<&str>,
    source_text: Option<&str>,
    marker_content: &str,
) -> Result<(ConversationSummary, Message)> {
    if marker_content.is_empty() {
        return Err(AQBotError::Validation(
            "Compression marker content must not be empty".to_string(),
        ));
    }

    let marker_id = gen_id();
    let txn = db.begin().await?;
    upsert_summary_record(
        &txn,
        conversation_id,
        summary_text,
        compressed_until_message_id,
        token_count,
        model_used,
        source_text,
    )
    .await?;
    messages::ActiveModel {
        id: Set(marker_id.clone()),
        conversation_id: Set(conversation_id.to_string()),
        role: Set("system".to_string()),
        content: Set(marker_content.to_string()),
        attachments: Set("[]".to_string()),
        created_at: Set(now_ts()),
        version_index: Set(0),
        is_active: Set(1),
        ..Default::default()
    }
    .insert(&txn)
    .await?;
    txn.commit().await?;

    let summary = get_summary(db, conversation_id).await?.ok_or_else(|| {
        AQBotError::Database(sea_orm::DbErr::Custom(
            "Failed to read back upserted summary".into(),
        ))
    })?;
    let marker = crate::repo::message::get_message(db, &marker_id).await?;
    Ok((summary, marker))
}

/// Update only the summary text/metadata after a retry, preserving boundary and source.
pub async fn update_summary_text(
    db: &DatabaseConnection,
    conversation_id: &str,
    summary_text: &str,
    token_count: Option<u32>,
    model_used: Option<&str>,
) -> Result<ConversationSummary> {
    validate_summary_text(summary_text)?;
    let now = now_ts();
    let existing = conversation_summaries::Entity::find()
        .filter(conversation_summaries::Column::ConversationId.eq(conversation_id))
        .one(db)
        .await?
        .ok_or_else(|| {
            AQBotError::NotFound(format!("Summary for conversation {}", conversation_id))
        })?;

    let mut am: conversation_summaries::ActiveModel = existing.into();
    am.summary_text = Set(summary_text.to_string());
    am.token_count = Set(token_count.map(i64::from));
    am.model_used = Set(model_used.map(str::to_string));
    am.updated_at = Set(now);
    am.update(db).await?;

    get_summary(db, conversation_id).await?.ok_or_else(|| {
        AQBotError::Database(sea_orm::DbErr::Custom(
            "Failed to read back updated summary".into(),
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

/// Atomically delete a conversation summary and all matching system markers.
pub async fn delete_summary_and_markers(
    db: &DatabaseConnection,
    conversation_id: &str,
    marker_content: &str,
) -> Result<()> {
    if marker_content.is_empty() {
        return Err(AQBotError::Validation(
            "Compression marker content must not be empty".to_string(),
        ));
    }

    let txn = db.begin().await?;
    conversation_summaries::Entity::delete_many()
        .filter(conversation_summaries::Column::ConversationId.eq(conversation_id))
        .exec(&txn)
        .await?;
    messages::Entity::delete_many()
        .filter(messages::Column::ConversationId.eq(conversation_id))
        .filter(messages::Column::Role.eq("system"))
        .filter(messages::Column::Content.eq(marker_content))
        .exec(&txn)
        .await?;
    txn.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::create_test_pool;
    use crate::repo::message;
    use crate::types::{
        ContextStrategy, MessageRole, MultiModelContinuationMode, UpdateConversationInput,
    };

    fn update_input(value: serde_json::Value) -> UpdateConversationInput {
        serde_json::from_value(value).expect("deserialize conversation update")
    }

    async fn insert_test_category(db: &DatabaseConnection, id: &str) {
        conversation_categories::ActiveModel {
            id: Set(id.to_string()),
            name: Set(id.to_string()),
            sort_order: Set(0),
            is_collapsed: Set(0),
            created_at: Set(1),
            updated_at: Set(1),
            ..Default::default()
        }
        .insert(db)
        .await
        .unwrap();
    }

    async fn conversation_orders(db: &DatabaseConnection, ids: &[&str]) -> Vec<(String, i32, i64)> {
        let mut values = Vec::new();
        for id in ids {
            let conversation = get_conversation(db, id).await.unwrap();
            values.push((
                conversation.id,
                conversation.sort_order,
                conversation.updated_at,
            ));
        }
        values
    }

    #[tokio::test]
    async fn reorder_conversations_is_atomic_and_preserves_updated_at() {
        let h = create_test_pool().await.unwrap();
        let db = &h.conn;
        let first = create_conversation(db, "First", "model", "provider", None)
            .await
            .unwrap();
        let second = create_conversation(db, "Second", "model", "provider", None)
            .await
            .unwrap();
        let third = create_conversation(db, "Third", "model", "provider", None)
            .await
            .unwrap();
        for (id, sentinel) in [(&first.id, 101_i64), (&second.id, 202), (&third.id, 303)] {
            conversations::Entity::update_many()
                .col_expr(conversations::Column::UpdatedAt, Expr::value(sentinel))
                .filter(conversations::Column::Id.eq(id))
                .exec(db)
                .await
                .unwrap();
        }
        let order = vec![first.id.clone(), third.id.clone(), second.id.clone()];
        let before = conversation_orders(db, &[&first.id, &third.id, &second.id]).await;

        reorder_conversations(db, None, &order).await.unwrap();

        let after = conversation_orders(db, &[&first.id, &third.id, &second.id]).await;
        assert_eq!(
            after.iter().map(|value| value.1).collect::<Vec<_>>(),
            vec![0, 1, 2]
        );
        assert_eq!(
            after.iter().map(|value| value.2).collect::<Vec<_>>(),
            before.iter().map(|value| value.2).collect::<Vec<_>>()
        );

        let stable = conversation_orders(db, &[&first.id, &third.id, &second.id]).await;
        let missing = vec![first.id.clone(), third.id.clone()];
        assert!(reorder_conversations(db, None, &missing).await.is_err());
        assert_eq!(
            conversation_orders(db, &[&first.id, &third.id, &second.id]).await,
            stable
        );
        let duplicate = vec![
            first.id.clone(),
            first.id.clone(),
            second.id.clone(),
            third.id.clone(),
        ];
        let duplicate_error = reorder_conversations(db, None, &duplicate)
            .await
            .unwrap_err();
        assert!(duplicate_error.to_string().contains("duplicate"));
        assert_eq!(
            conversation_orders(db, &[&first.id, &third.id, &second.id]).await,
            stable
        );
    }

    #[tokio::test]
    async fn reorder_conversations_rolls_back_prior_writes_on_database_failure() {
        let h = create_test_pool().await.unwrap();
        let db = &h.conn;
        let first = create_conversation(db, "First", "model", "provider", None)
            .await
            .unwrap();
        let second = create_conversation(db, "Second", "model", "provider", None)
            .await
            .unwrap();
        let third = create_conversation(db, "Third", "model", "provider", None)
            .await
            .unwrap();
        let before = conversation_orders(db, &[&first.id, &second.id, &third.id]).await;
        db.execute_unprepared(
            "CREATE TRIGGER fail_conversation_sort \
             BEFORE UPDATE OF sort_order ON conversations \
             WHEN OLD.title = 'Second' \
             BEGIN SELECT RAISE(FAIL, 'forced reorder failure'); END;",
        )
        .await
        .unwrap();

        let result = reorder_conversations(
            db,
            None,
            &[third.id.clone(), second.id.clone(), first.id.clone()],
        )
        .await;

        assert!(result.is_err());
        assert_eq!(
            conversation_orders(db, &[&first.id, &second.id, &third.id]).await,
            before
        );
    }

    #[tokio::test]
    async fn reorder_conversations_rejects_wrong_container_children_and_archived_rows() {
        let h = create_test_pool().await.unwrap();
        let db = &h.conn;
        insert_test_category(db, "category").await;
        let root = create_conversation(db, "Root", "model", "provider", None)
            .await
            .unwrap();
        let child = create_conversation(db, "Child", "model", "provider", None)
            .await
            .unwrap();
        update_conversation(
            db,
            &child.id,
            update_input(serde_json::json!({"parent_conversation_id": root.id})),
        )
        .await
        .unwrap();
        let archived = create_conversation(db, "Archived", "model", "provider", None)
            .await
            .unwrap();
        toggle_archive(db, &archived.id).await.unwrap();
        let categorized = create_conversation(db, "Categorized", "model", "provider", None)
            .await
            .unwrap();
        update_conversation(
            db,
            &categorized.id,
            update_input(serde_json::json!({"category_id": "category"})),
        )
        .await
        .unwrap();
        let categorized_second =
            create_conversation(db, "Categorized second", "model", "provider", None)
                .await
                .unwrap();
        update_conversation(
            db,
            &categorized_second.id,
            update_input(serde_json::json!({"category_id": "category"})),
        )
        .await
        .unwrap();

        for invalid in [
            vec![root.id.clone(), child.id.clone()],
            vec![root.id.clone(), archived.id.clone()],
            vec![root.id.clone(), categorized.id.clone()],
        ] {
            assert!(reorder_conversations(db, None, &invalid).await.is_err());
        }
        assert!(reorder_conversations(db, Some("missing"), &[])
            .await
            .is_err());
        reorder_conversations(
            db,
            Some("category"),
            &[categorized.id.clone(), categorized_second.id.clone()],
        )
        .await
        .unwrap();
        assert_eq!(
            get_conversation(db, &categorized.id)
                .await
                .unwrap()
                .sort_order,
            0
        );
        assert_eq!(
            get_conversation(db, &categorized_second.id)
                .await
                .unwrap()
                .sort_order,
            1
        );
    }

    #[tokio::test]
    async fn conversation_container_transitions_assign_top_sort_order() {
        let h = create_test_pool().await.unwrap();
        let db = &h.conn;
        insert_test_category(db, "category").await;
        let first = create_conversation(db, "First", "model", "provider", None)
            .await
            .unwrap();
        let second = create_conversation(db, "Second", "model", "provider", None)
            .await
            .unwrap();
        assert_eq!(
            get_conversation(db, &second.id).await.unwrap().sort_order,
            -1
        );
        assert_eq!(get_conversation(db, &first.id).await.unwrap().sort_order, 0);

        update_conversation(
            db,
            &first.id,
            update_input(serde_json::json!({"category_id": "category"})),
        )
        .await
        .unwrap();
        update_conversation(
            db,
            &second.id,
            update_input(serde_json::json!({"category_id": "category"})),
        )
        .await
        .unwrap();
        assert_eq!(
            get_conversation(db, &second.id).await.unwrap().sort_order,
            -1
        );
        assert_eq!(get_conversation(db, &first.id).await.unwrap().sort_order, 0);

        toggle_archive(db, &first.id).await.unwrap();
        toggle_archive(db, &first.id).await.unwrap();
        assert_eq!(
            get_conversation(db, &first.id).await.unwrap().sort_order,
            -2
        );
        assert_eq!(
            get_conversation(db, &second.id).await.unwrap().sort_order,
            -1
        );

        update_conversation(
            db,
            &first.id,
            update_input(serde_json::json!({"category_id": null})),
        )
        .await
        .unwrap();
        update_conversation(
            db,
            &second.id,
            update_input(serde_json::json!({"category_id": null})),
        )
        .await
        .unwrap();
        toggle_pin(db, &first.id).await.unwrap();
        toggle_pin(db, &second.id).await.unwrap();
        assert_eq!(
            get_conversation(db, &second.id).await.unwrap().sort_order,
            -1
        );
        assert_eq!(get_conversation(db, &first.id).await.unwrap().sort_order, 0);
    }

    #[tokio::test]
    async fn assigning_top_sort_order_renormalizes_at_i32_floor() {
        let h = create_test_pool().await.unwrap();
        let db = &h.conn;
        let first = create_conversation(db, "First", "model", "provider", None)
            .await
            .unwrap();
        conversations::Entity::update_many()
            .col_expr(conversations::Column::SortOrder, Expr::value(i32::MIN))
            .filter(conversations::Column::Id.eq(&first.id))
            .exec(db)
            .await
            .unwrap();

        let second = create_conversation(db, "Second", "model", "provider", None)
            .await
            .unwrap();

        assert_eq!(second.sort_order, 0);
        assert_eq!(get_conversation(db, &first.id).await.unwrap().sort_order, 1);
    }

    #[tokio::test]
    async fn deleting_category_moves_ordered_roots_to_uncategorized_top() {
        let h = create_test_pool().await.unwrap();
        let db = &h.conn;
        insert_test_category(db, "category").await;
        let existing = create_conversation(db, "Existing", "model", "provider", None)
            .await
            .unwrap();
        let first = create_conversation(db, "First", "model", "provider", None)
            .await
            .unwrap();
        let second = create_conversation(db, "Second", "model", "provider", None)
            .await
            .unwrap();
        for conversation in [&first, &second] {
            update_conversation(
                db,
                &conversation.id,
                update_input(serde_json::json!({"category_id": "category"})),
            )
            .await
            .unwrap();
        }
        reorder_conversations(db, Some("category"), &[first.id.clone(), second.id.clone()])
            .await
            .unwrap();

        crate::repo::conversation_category::delete_conversation_category(db, "category")
            .await
            .unwrap();

        let first = get_conversation(db, &first.id).await.unwrap();
        let second = get_conversation(db, &second.id).await.unwrap();
        let existing = get_conversation(db, &existing.id).await.unwrap();
        assert_eq!(first.category_id, None);
        assert_eq!(second.category_id, None);
        assert!(first.sort_order < second.sort_order);
        assert!(second.sort_order < existing.sort_order);
    }

    #[tokio::test]
    async fn context_strategy_override_and_legacy_flag_stay_compatible() {
        let h = create_test_pool().await.unwrap();
        let db = &h.conn;
        let conversation = create_conversation(db, "Strategy", "model", "provider", None)
            .await
            .unwrap();
        assert_eq!(conversation.context_strategy_override, None);

        let unrelated_update = update_conversation(
            db,
            &conversation.id,
            update_input(serde_json::json!({"title": "Renamed"})),
        )
        .await
        .unwrap();
        assert_eq!(unrelated_update.context_strategy_override, None);
        assert_eq!(unrelated_update.context_message_limit, None);
        assert_eq!(unrelated_update.compression_keep_last_n, None);

        let legacy_enabled = update_conversation(
            db,
            &conversation.id,
            update_input(serde_json::json!({"context_compression": true})),
        )
        .await
        .unwrap();
        assert!(legacy_enabled.context_compression);
        assert_eq!(
            legacy_enabled.context_strategy_override,
            Some(ContextStrategy::SmartSummary)
        );

        let strict = update_conversation(
            db,
            &conversation.id,
            update_input(serde_json::json!({
                "context_compression": true,
                "context_strategy_override": "raw_strict"
            })),
        )
        .await
        .unwrap();
        assert!(!strict.context_compression);
        assert_eq!(
            strict.context_strategy_override,
            Some(ContextStrategy::RawStrict)
        );

        let inherited = update_conversation(
            db,
            &conversation.id,
            update_input(serde_json::json!({"context_strategy_override": null})),
        )
        .await
        .unwrap();
        assert!(!inherited.context_compression);
        assert_eq!(inherited.context_strategy_override, None);

        let mut settings = crate::repo::settings::get_settings(db).await.unwrap();
        settings.default_context_strategy = ContextStrategy::SmartSummary;
        crate::repo::settings::save_settings(db, &settings)
            .await
            .unwrap();
        let inherited_smart_summary = update_conversation(
            db,
            &conversation.id,
            update_input(serde_json::json!({"context_strategy_override": null})),
        )
        .await
        .unwrap();
        assert!(inherited_smart_summary.context_compression);
        assert_eq!(inherited_smart_summary.context_strategy_override, None);

        let legacy_disabled = update_conversation(
            db,
            &conversation.id,
            update_input(serde_json::json!({"context_compression": false})),
        )
        .await
        .unwrap();
        assert_eq!(
            legacy_disabled.context_strategy_override,
            Some(ContextStrategy::RawTruncate)
        );
    }

    #[tokio::test]
    async fn multi_model_display_mode_override_is_a_nullable_conversation_preference() {
        let h = create_test_pool().await.unwrap();
        let db = &h.conn;
        let conversation = create_conversation(db, "Layout", "model", "provider", None)
            .await
            .unwrap();
        assert_eq!(
            serde_json::to_value(&conversation).unwrap().get("multi_model_display_mode_override"),
            Some(&serde_json::Value::Null)
        );

        let updated = update_conversation(
            db,
            &conversation.id,
            update_input(serde_json::json!({
                "multi_model_display_mode_override": "side-by-side"
            })),
        )
        .await
        .unwrap();
        assert_eq!(
            serde_json::to_value(&updated)
                .unwrap()
                .get("multi_model_display_mode_override")
                .and_then(serde_json::Value::as_str),
            Some("side-by-side")
        );

        let preserved = update_conversation(
            db,
            &conversation.id,
            update_input(serde_json::json!({"title": "Renamed"})),
        )
        .await
        .unwrap();
        assert_eq!(
            serde_json::to_value(&preserved)
                .unwrap()
                .get("multi_model_display_mode_override")
                .and_then(serde_json::Value::as_str),
            Some("side-by-side")
        );

        let cleared = update_conversation(
            db,
            &conversation.id,
            update_input(serde_json::json!({"multi_model_display_mode_override": null})),
        )
        .await
        .unwrap();
        assert_eq!(
            serde_json::to_value(&cleared).unwrap().get("multi_model_display_mode_override"),
            Some(&serde_json::Value::Null)
        );
    }

    #[test]
    fn invalid_multi_model_display_mode_override_input_is_rejected() {
        assert!(serde_json::from_value::<UpdateConversationInput>(serde_json::json!({
            "multi_model_display_mode_override": "grid"
        }))
        .is_err());
    }

    #[tokio::test]
    async fn invalid_persisted_multi_model_display_mode_override_is_rejected() {
        let h = create_test_pool().await.unwrap();
        let db = &h.conn;
        let conversation = create_conversation(db, "Invalid layout", "model", "provider", None)
            .await
            .unwrap();
        conversations::Entity::update_many()
            .col_expr(
                conversations::Column::MultiModelDisplayModeOverride,
                Expr::value("grid"),
            )
            .filter(conversations::Column::Id.eq(&conversation.id))
            .exec(db)
            .await
            .unwrap();

        let error = get_conversation(db, &conversation.id).await.unwrap_err();
        assert!(error
            .to_string()
            .contains("unsupported multi-model display mode: grid"));
    }

    #[tokio::test]
    async fn conversation_context_numeric_overrides_enforce_storage_bounds() {
        let h = create_test_pool().await.unwrap();
        let db = &h.conn;
        let conversation = create_conversation(db, "Bounds", "model", "provider", None)
            .await
            .unwrap();

        for value in [0_i64, 20, 21, 100, 200, 999, 1000] {
            let updated = update_conversation(
                db,
                &conversation.id,
                update_input(serde_json::json!({"compression_keep_last_n": value})),
            )
            .await
            .unwrap();
            assert_eq!(updated.compression_keep_last_n, Some(value as u32));
        }
        let cleared_keep_last = update_conversation(
            db,
            &conversation.id,
            update_input(serde_json::json!({"compression_keep_last_n": null})),
        )
        .await
        .unwrap();
        assert_eq!(cleared_keep_last.compression_keep_last_n, None);

        for value in [-1_i64, 1001, i64::MAX] {
            let error = update_conversation(
                db,
                &conversation.id,
                update_input(serde_json::json!({"compression_keep_last_n": value})),
            )
            .await
            .unwrap_err();
            assert!(error.to_string().contains("compression_keep_last_n"));
        }
        assert!(
            serde_json::from_value::<UpdateConversationInput>(serde_json::json!({
                "compression_keep_last_n": 1.5
            }))
            .is_err()
        );

        let max_limit = update_conversation(
            db,
            &conversation.id,
            update_input(serde_json::json!({"context_message_limit": i32::MAX as i64})),
        )
        .await
        .unwrap();
        assert_eq!(max_limit.context_message_limit, Some(i32::MAX as u32));
        let cleared_limit = update_conversation(
            db,
            &conversation.id,
            update_input(serde_json::json!({"context_message_limit": null})),
        )
        .await
        .unwrap();
        assert_eq!(cleared_limit.context_message_limit, None);
        for value in [-1_i64, i32::MAX as i64 + 1, i64::MAX] {
            let error = update_conversation(
                db,
                &conversation.id,
                update_input(serde_json::json!({"context_message_limit": value})),
            )
            .await
            .unwrap_err();
            assert!(error.to_string().contains("context_message_limit"));
        }
    }

    #[tokio::test]
    async fn branch_copies_context_strategy_override() {
        let h = create_test_pool().await.unwrap();
        let db = &h.conn;
        let source = create_conversation(db, "Source", "model", "provider", None)
            .await
            .unwrap();
        update_conversation(
            db,
            &source.id,
            update_input(serde_json::json!({"context_strategy_override": "raw_strict"})),
        )
        .await
        .unwrap();
        let source_message = message::create_message(
            db,
            &source.id,
            MessageRole::User,
            "branch here",
            &[],
            None,
            0,
        )
        .await
        .unwrap();

        let branch = branch_conversation(db, &source.id, &source_message.id, false, None)
            .await
            .unwrap();
        assert_eq!(
            branch.context_strategy_override,
            Some(ContextStrategy::RawStrict)
        );
        assert!(!branch.context_compression);
    }

    #[tokio::test]
    async fn multi_model_targets_and_continuation_mode_are_conversation_preferences() {
        let h = create_test_pool().await.unwrap();
        let db = &h.conn;
        let conversation = create_conversation(db, "Targets", "model", "provider", None)
            .await
            .unwrap();
        assert!(conversation.multi_model_targets.is_empty());
        assert_eq!(
            conversation.multi_model_continuation_mode,
            MultiModelContinuationMode::Selected
        );

        let updated = update_conversation(
            db,
            &conversation.id,
            update_input(serde_json::json!({
                "multi_model_targets": [
                    { "providerId": "provider-a", "modelId": "model-a" },
                    { "providerId": "provider-b", "modelId": "model-b" }
                ],
                "multi_model_continuation_mode": "per_model"
            })),
        )
        .await
        .unwrap();
        assert_eq!(
            updated.multi_model_targets,
            vec![
                crate::types::MultiModelTarget {
                    provider_id: "provider-a".into(),
                    model_id: "model-a".into(),
                    thinking_level: None,
                },
                crate::types::MultiModelTarget {
                    provider_id: "provider-b".into(),
                    model_id: "model-b".into(),
                    thinking_level: None,
                },
            ]
        );
        assert_eq!(
            updated.multi_model_continuation_mode,
            MultiModelContinuationMode::PerModel
        );

        let with_overrides = update_conversation(
            db,
            &conversation.id,
            update_input(serde_json::json!({
                "multi_model_targets": [
                    { "providerId": "provider-a", "modelId": "model-a", "thinkingLevel": "low" },
                    { "providerId": "provider-b", "modelId": "model-b", "thinkingLevel": null }
                ]
            })),
        )
        .await
        .unwrap();
        assert_eq!(
            with_overrides.multi_model_targets,
            vec![
                crate::types::MultiModelTarget {
                    provider_id: "provider-a".into(),
                    model_id: "model-a".into(),
                    thinking_level: Some(Some("low".into())),
                },
                crate::types::MultiModelTarget {
                    provider_id: "provider-b".into(),
                    model_id: "model-b".into(),
                    thinking_level: Some(None),
                },
            ]
        );

        let preserved = update_conversation(
            db,
            &conversation.id,
            update_input(serde_json::json!({"title": "Renamed"})),
        )
        .await
        .unwrap();
        assert_eq!(preserved.multi_model_targets, with_overrides.multi_model_targets);
        assert_eq!(
            preserved.multi_model_continuation_mode,
            MultiModelContinuationMode::PerModel
        );

        assert!(update_conversation(
            db,
            &conversation.id,
            update_input(serde_json::json!({
                "multi_model_targets": [
                    { "providerId": "provider-a", "modelId": "model-a" },
                    { "providerId": "provider-a", "modelId": "model-a" }
                ]
            })),
        )
        .await
        .is_err());
    }

    #[tokio::test]
    async fn branch_copies_multi_model_targets_and_continuation_mode() {
        let h = create_test_pool().await.unwrap();
        let db = &h.conn;
        let source = create_conversation(db, "Source", "model", "provider", None)
            .await
            .unwrap();
        update_conversation(
            db,
            &source.id,
            update_input(serde_json::json!({
                "multi_model_targets": [
                    { "providerId": "provider-a", "modelId": "model-a" }
                ],
                "multi_model_continuation_mode": "per_model"
            })),
        )
        .await
        .unwrap();
        let source_message = message::create_message(
            db,
            &source.id,
            MessageRole::User,
            "branch here",
            &[],
            None,
            0,
        )
        .await
        .unwrap();
        let branch = branch_conversation(db, &source.id, &source_message.id, false, None)
            .await
            .unwrap();
        assert_eq!(branch.multi_model_targets.len(), 1);
        assert_eq!(
            branch.multi_model_continuation_mode,
            MultiModelContinuationMode::PerModel
        );
    }

    #[tokio::test]
    async fn branch_copies_multi_model_display_mode_override() {
        let h = create_test_pool().await.unwrap();
        let db = &h.conn;
        let source = create_conversation(db, "Source", "model", "provider", None)
            .await
            .unwrap();
        update_conversation(
            db,
            &source.id,
            update_input(serde_json::json!({
                "multi_model_display_mode_override": "stacked"
            })),
        )
        .await
        .unwrap();
        let source_message = message::create_message(
            db,
            &source.id,
            MessageRole::User,
            "branch here",
            &[],
            None,
            0,
        )
        .await
        .unwrap();

        let branch = branch_conversation(db, &source.id, &source_message.id, false, None)
            .await
            .unwrap();
        assert_eq!(
            serde_json::to_value(&branch)
                .unwrap()
                .get("multi_model_display_mode_override")
                .and_then(serde_json::Value::as_str),
            Some("stacked")
        );
    }

    #[tokio::test]
    async fn summary_and_marker_upsert_rolls_back_when_marker_insert_fails() {
        let h = create_test_pool().await.unwrap();
        let db = &h.conn;
        let conversation = create_conversation(db, "Atomic", "model", "provider", None)
            .await
            .unwrap();
        db.execute_unprepared(
            "CREATE TRIGGER reject_test_marker \
             BEFORE INSERT ON messages \
             WHEN NEW.content = '<!-- fail-marker -->' \
             BEGIN SELECT RAISE(ABORT, 'marker rejected'); END;",
        )
        .await
        .unwrap();

        let error = upsert_summary_with_marker(
            db,
            &conversation.id,
            "summary",
            None,
            Some(2),
            Some("model"),
            Some("source"),
            "<!-- fail-marker -->",
        )
        .await
        .unwrap_err();

        assert!(error.to_string().contains("marker rejected"));
        assert!(get_summary(db, &conversation.id).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn summary_and_marker_delete_is_atomic() {
        const MARKER: &str = "<!-- delete-marker -->";

        let h = create_test_pool().await.unwrap();
        let db = &h.conn;
        let conversation = create_conversation(db, "Atomic delete", "model", "provider", None)
            .await
            .unwrap();
        let (summary, marker) = upsert_summary_with_marker(
            db,
            &conversation.id,
            "summary",
            None,
            Some(2),
            Some("model"),
            Some("source"),
            MARKER,
        )
        .await
        .unwrap();
        assert_eq!(summary.summary_text, "summary");
        assert_eq!(marker.role, MessageRole::System);

        db.execute_unprepared(
            "CREATE TRIGGER reject_test_marker_delete \
             BEFORE DELETE ON messages \
             WHEN OLD.content = '<!-- delete-marker -->' \
             BEGIN SELECT RAISE(ABORT, 'marker delete rejected'); END;",
        )
        .await
        .unwrap();
        let error = delete_summary_and_markers(db, &conversation.id, MARKER)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("marker delete rejected"));
        assert!(get_summary(db, &conversation.id).await.unwrap().is_some());
        assert_eq!(
            message::get_message(db, &marker.id).await.unwrap().content,
            MARKER
        );

        db.execute_unprepared("DROP TRIGGER reject_test_marker_delete")
            .await
            .unwrap();
        delete_summary_and_markers(db, &conversation.id, MARKER)
            .await
            .unwrap();
        assert!(get_summary(db, &conversation.id).await.unwrap().is_none());
        assert!(message::get_message(db, &marker.id).await.is_err());
    }

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
        assert!(branched.sort_order < get_conversation(db, &conv.id).await.unwrap().sort_order);
    }

    #[tokio::test]
    async fn new_conversations_are_not_tab_pinned() {
        let h = create_test_pool().await.unwrap();
        let conversation = create_conversation(&h.conn, "Tab", "model", "provider", None)
            .await
            .unwrap();
        assert_eq!(conversation.tab_pin_order, None);
    }

    #[tokio::test]
    async fn set_conversation_tab_pinned_assigns_stable_order_and_is_idempotent() {
        let h = create_test_pool().await.unwrap();
        let db = &h.conn;
        let first = create_conversation(db, "First", "model", "provider", None)
            .await
            .unwrap();
        let second = create_conversation(db, "Second", "model", "provider", None)
            .await
            .unwrap();
        let first_before = get_conversation(db, &first.id).await.unwrap();

        let first_pinned = set_conversation_tab_pinned(db, &first.id, true)
            .await
            .unwrap();
        let second_pinned = set_conversation_tab_pinned(db, &second.id, true)
            .await
            .unwrap();
        let first_again = set_conversation_tab_pinned(db, &first.id, true)
            .await
            .unwrap();

        assert_eq!(first_pinned.tab_pin_order, Some(1));
        assert_eq!(second_pinned.tab_pin_order, Some(2));
        assert_eq!(first_again.tab_pin_order, Some(1));
        assert_eq!(first_again.updated_at, first_before.updated_at);
        assert_eq!(first_again.sort_order, first_before.sort_order);
        assert_eq!(first_again.is_pinned, first_before.is_pinned);
    }

    #[tokio::test]
    async fn unpinning_then_pinning_appends_to_the_tab_pin_group() {
        let h = create_test_pool().await.unwrap();
        let db = &h.conn;
        let first = create_conversation(db, "First", "model", "provider", None)
            .await
            .unwrap();
        let second = create_conversation(db, "Second", "model", "provider", None)
            .await
            .unwrap();
        set_conversation_tab_pinned(db, &first.id, true)
            .await
            .unwrap();
        set_conversation_tab_pinned(db, &second.id, true)
            .await
            .unwrap();
        set_conversation_tab_pinned(db, &first.id, false)
            .await
            .unwrap();
        let first_re_pinned = set_conversation_tab_pinned(db, &first.id, true)
            .await
            .unwrap();
        assert_eq!(first_re_pinned.tab_pin_order, Some(3));
        assert_eq!(
            get_conversation(db, &second.id)
                .await
                .unwrap()
                .tab_pin_order,
            Some(2)
        );
    }

    #[tokio::test]
    async fn archiving_clears_tab_pin_order() {
        let h = create_test_pool().await.unwrap();
        let db = &h.conn;
        let conversation = create_conversation(db, "Pinned", "model", "provider", None)
            .await
            .unwrap();
        set_conversation_tab_pinned(db, &conversation.id, true)
            .await
            .unwrap();
        let archived = toggle_archive(db, &conversation.id).await.unwrap();
        assert!(archived.is_archived);
        assert_eq!(archived.tab_pin_order, None);
    }

    #[tokio::test]
    async fn pinning_an_archived_conversation_is_rejected() {
        let h = create_test_pool().await.unwrap();
        let db = &h.conn;
        let conversation = create_conversation(db, "Archived", "model", "provider", None)
            .await
            .unwrap();
        toggle_archive(db, &conversation.id).await.unwrap();
        let error = set_conversation_tab_pinned(db, &conversation.id, true)
            .await
            .expect_err("archived conversations cannot be tab-pinned");
        assert!(error.to_string().contains("archived"));
        assert_eq!(
            get_conversation(db, &conversation.id)
                .await
                .unwrap()
                .tab_pin_order,
            None
        );
    }

    #[tokio::test]
    async fn tab_pin_update_rolls_back_on_database_failure() {
        let h = create_test_pool().await.unwrap();
        let db = &h.conn;
        let conversation = create_conversation(db, "Rollback", "model", "provider", None)
            .await
            .unwrap();
        db.execute_unprepared(
            "CREATE TRIGGER fail_tab_pin \
             BEFORE UPDATE OF tab_pin_order ON conversations \
             WHEN NEW.tab_pin_order IS NOT NULL \
             BEGIN SELECT RAISE(FAIL, 'forced tab pin failure'); END;",
        )
        .await
        .unwrap();

        let result = set_conversation_tab_pinned(db, &conversation.id, true).await;
        assert!(result.is_err());
        assert_eq!(
            get_conversation(db, &conversation.id)
                .await
                .unwrap()
                .tab_pin_order,
            None
        );
    }
}
