use chrono::TimeZone;
use regex::Regex;
use sea_orm::{sea_query::OnConflict, *};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

use crate::crypto::{decrypt_key, encrypt_key};
use crate::entity::{
    conversations, import_jobs, messages, models, provider_keys, providers, stored_files,
};
use crate::error::{AQBotError, Result};
use crate::file_store::FileStore;
use crate::repo::settings::get_settings;
use crate::types::{Attachment, ModelCapability, ModelParamOverrides, ModelType, ProviderType};
use crate::utils::{gen_id, now_ts};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ThirdPartyImportWarning {
    pub code: String,
    pub message: String,
    pub source_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ThirdPartyImportSummary {
    pub conversation_count: u32,
    pub message_count: u32,
    pub file_count: u32,
    pub importable_provider_count: u32,
    pub skipped_empty_topic_count: u32,
    pub duplicate_conversation_count: u32,
    pub warnings: Vec<ThirdPartyImportWarning>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ThirdPartyImportOptions {
    #[serde(default)]
    pub import_provider_keys: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ThirdPartyImportResult {
    pub imported_conversation_count: u32,
    pub imported_message_count: u32,
    pub imported_file_count: u32,
    pub imported_provider_count: u32,
    pub skipped_duplicate_conversation_count: u32,
    pub warnings: Vec<ThirdPartyImportWarning>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct KelivoChats {
    #[serde(default)]
    conversations: Vec<KelivoConversation>,
    #[serde(default)]
    messages: Vec<KelivoMessage>,
    #[serde(default, rename = "toolEvents")]
    tool_events: HashMap<String, Vec<Value>>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct KelivoConversation {
    id: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    updated_at: Option<String>,
    #[serde(default)]
    message_ids: Vec<String>,
    #[serde(default)]
    is_pinned: bool,
    #[serde(default)]
    version_selections: HashMap<String, i64>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct KelivoMessage {
    id: String,
    role: String,
    #[serde(default)]
    content: String,
    #[serde(default)]
    timestamp: Option<String>,
    #[serde(default)]
    model_id: Option<String>,
    #[serde(default)]
    provider_id: Option<String>,
    #[serde(default)]
    total_tokens: Option<i64>,
    conversation_id: String,
    #[serde(default)]
    reasoning_text: Option<String>,
    #[serde(default)]
    reasoning_segments_json: Option<String>,
    #[serde(default)]
    group_id: Option<String>,
    #[serde(default)]
    version: i64,
    #[serde(default)]
    prompt_tokens: Option<i64>,
    #[serde(default)]
    completion_tokens: Option<i64>,
    #[serde(default)]
    duration_ms: Option<i64>,
    #[serde(default)]
    translation: Option<String>,
    #[serde(default)]
    is_streaming: bool,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct KelivoProviderConfig {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    enabled: Option<bool>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    api_key: Option<String>,
    #[serde(default)]
    base_url: Option<String>,
    #[serde(default)]
    provider_type: Option<String>,
    #[serde(default)]
    use_response_api: Option<bool>,
    #[serde(default)]
    models: Vec<String>,
    #[serde(default)]
    model_overrides: HashMap<String, Value>,
    #[serde(default)]
    api_keys: Vec<KelivoApiKeyConfig>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct KelivoApiKeyConfig {
    #[serde(default)]
    key: String,
    #[serde(default)]
    is_enabled: Option<bool>,
}

#[derive(Debug, Clone)]
struct KelivoProvider {
    source_id: String,
    config: KelivoProviderConfig,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct KelivoAttachmentRef {
    raw_path: String,
    file_name: String,
    mime_type: String,
    source_message_id: String,
}

struct ParsedKelivoBackup {
    chats: KelivoChats,
    settings: Option<Value>,
    zip_entries: HashSet<String>,
    warnings: Vec<ThirdPartyImportWarning>,
}

#[derive(Debug, Clone)]
struct KelivoMessageImportPlan<'a> {
    message: &'a KelivoMessage,
    parent_message_id: Option<String>,
    version_index: i32,
    is_active: bool,
}

#[derive(Debug)]
struct KelivoTurn<'a> {
    user: Option<&'a KelivoMessage>,
    assistants: Vec<&'a KelivoMessage>,
}

pub async fn scan_kelivo_import_from_path(
    db: &DatabaseConnection,
    path: &Path,
) -> Result<ThirdPartyImportSummary> {
    let parsed = parse_kelivo_backup(path)?;
    summarize_kelivo_backup(db, &parsed).await
}

pub async fn import_kelivo_backup_from_path(
    db: &DatabaseConnection,
    master_key: &[u8; 32],
    path: &Path,
    options: ThirdPartyImportOptions,
) -> Result<ThirdPartyImportResult> {
    import_kelivo_backup_from_path_with_root(
        db,
        master_key,
        path,
        options,
        &crate::storage_paths::documents_root(),
    )
    .await
}

pub async fn import_kelivo_backup_from_path_with_root(
    db: &DatabaseConnection,
    master_key: &[u8; 32],
    path: &Path,
    options: ThirdPartyImportOptions,
    documents_root: &Path,
) -> Result<ThirdPartyImportResult> {
    let parsed = parse_kelivo_backup(path)?;
    let mut selection_warnings = Vec::new();
    let selected = selected_messages_by_conversation(&parsed.chats, &mut selection_warnings);
    let mut result = ThirdPartyImportResult {
        warnings: parsed.warnings.clone(),
        ..Default::default()
    };
    result.warnings.extend(selection_warnings);

    let settings = get_settings(db).await.unwrap_or_default();
    let fallback_provider_id = settings
        .default_provider_id
        .clone()
        .unwrap_or_else(|| "kelivo".to_string());
    let fallback_model_id = settings
        .default_model_id
        .clone()
        .unwrap_or_else(|| "unknown-model".to_string());
    let mut provider_map = HashMap::new();
    let file_store = FileStore::with_root(documents_root.to_path_buf());
    let mut archive = open_kelivo_zip(path)?;
    let _file_reference_guard = crate::repo::stored_file::lock_file_references().await;
    let txn = db.begin().await?;
    let mut created_paths = Vec::new();
    let operation = async {
        if options.import_provider_keys {
            for provider in kelivo_providers(parsed.settings.as_ref()) {
                match import_provider(&txn, master_key, &provider).await {
                    Ok(Some(imported_id)) => {
                        provider_map.insert(provider.source_id.clone(), imported_id);
                        result.imported_provider_count += 1;
                    }
                    Ok(None) => {}
                    Err(error) => result.warnings.push(warning(
                        "provider_import_failed",
                        format!(
                            "Failed to import Kelivo provider {}: {error}",
                            provider.source_id
                        ),
                        Some(provider.source_id.clone()),
                    )),
                }
            }
        }

        for conversation in &parsed.chats.conversations {
            let selected_messages = selected.get(&conversation.id).cloned().unwrap_or_default();
            let planned_messages =
                planned_messages_for_import(&selected_messages, &parsed.chats.tool_events);
            if planned_messages.is_empty() {
                continue;
            }
            if conversations::Entity::find_by_id(&conversation.id)
                .one(&txn)
                .await?
                .is_some()
            {
                result.skipped_duplicate_conversation_count += 1;
                continue;
            }

            let first_message = planned_messages.first().map(|plan| plan.message);
            let provider_message =
                planned_messages
                    .iter()
                    .map(|plan| plan.message)
                    .find(|message| {
                        message
                            .provider_id
                            .as_deref()
                            .is_some_and(|provider_id| provider_map.contains_key(provider_id))
                    });
            let source_provider_id =
                provider_message.and_then(|message| message.provider_id.clone());
            let imported_provider_id = source_provider_id
                .as_ref()
                .and_then(|source_id| provider_map.get(source_id))
                .cloned();
            let provider_id = imported_provider_id.unwrap_or_else(|| fallback_provider_id.clone());
            let model_message = provider_message.or_else(|| {
                planned_messages
                    .iter()
                    .map(|plan| plan.message)
                    .find(|message| {
                        message
                            .model_id
                            .as_deref()
                            .is_some_and(|model_id| !model_id.trim().is_empty())
                    })
            });
            let model_id = model_message
                .and_then(|message| message.model_id.clone())
                .filter(|model_id| !model_id.trim().is_empty())
                .unwrap_or_else(|| fallback_model_id.clone());
            let created_at = parse_kelivo_ts_opt(conversation.created_at.as_deref())
                .or_else(|| {
                    first_message
                        .and_then(|message| parse_kelivo_ts_opt(message.timestamp.as_deref()))
                })
                .unwrap_or_else(now_ts);
            let updated_at = parse_kelivo_ts_opt(conversation.updated_at.as_deref())
                .unwrap_or_else(|| {
                    selected_messages
                        .iter()
                        .filter_map(|message| parse_kelivo_ts_opt(message.timestamp.as_deref()))
                        .max()
                        .unwrap_or(created_at)
                });
            let title = if conversation.title.trim().is_empty() {
                "Kelivo Chat".to_string()
            } else {
                conversation.title.clone()
            };

            conversations::ActiveModel {
                id: Set(conversation.id.clone()),
                title: Set(title),
                model_id: Set(model_id.clone()),
                provider_id: Set(provider_id.clone()),
                system_prompt: Set(None),
                temperature: Set(None),
                max_tokens: Set(None),
                top_p: Set(None),
                frequency_penalty: Set(None),
                search_enabled: Set(0),
                search_provider_id: Set(None),
                thinking_budget: Set(None),
                thinking_level: Set(None),
                enabled_mcp_server_ids: Set("[]".to_string()),
                enabled_knowledge_base_ids: Set("[]".to_string()),
                enabled_memory_namespace_ids: Set("[]".to_string()),
                message_count: Set(planned_messages
                    .iter()
                    .filter(|plan| plan.is_active)
                    .count() as i32),
                created_at: Set(created_at),
                updated_at: Set(updated_at),
                is_pinned: Set(if conversation.is_pinned { 1 } else { 0 }),
                is_archived: Set(0),
                workspace_snapshot_json: Set("{}".to_string()),
                active_branch_id: Set(None),
                active_artifact_id: Set(None),
                research_mode: Set(0),
                context_compression: Set(0),
                category_id: Set(None),
                parent_conversation_id: Set(None),
                mode: Set("chat".to_string()),
            }
            .insert(&txn)
            .await?;
            result.imported_conversation_count += 1;

            for plan in planned_messages {
                let message = plan.message;
                if messages::Entity::find_by_id(&message.id)
                    .one(&txn)
                    .await?
                    .is_some()
                {
                    continue;
                }
                let materialized = materialize_message(
                    &txn,
                    &file_store,
                    &mut archive,
                    &parsed.zip_entries,
                    &parsed.chats.tool_events,
                    message,
                    &provider_map,
                    &provider_id,
                    &model_id,
                    &conversation.id,
                    &mut result,
                    &mut created_paths,
                )
                .await?;
                messages::ActiveModel {
                    id: Set(message.id.clone()),
                    conversation_id: Set(conversation.id.clone()),
                    role: Set(materialized.role),
                    content: Set(materialized.content),
                    provider_id: Set(Some(materialized.provider_id)),
                    model_id: Set(Some(materialized.model_id)),
                    token_count: Set(materialized.token_count),
                    prompt_tokens: Set(materialized.prompt_tokens),
                    completion_tokens: Set(materialized.completion_tokens),
                    attachments: Set(serde_json::to_string(&materialized.attachments).map_err(
                        |e| {
                            AQBotError::Validation(format!(
                                "Failed to serialize Kelivo attachments: {e}"
                            ))
                        },
                    )?),
                    thinking: Set(materialized.thinking),
                    created_at: Set(materialized.created_at),
                    branch_id: Set(None),
                    parent_message_id: Set(plan.parent_message_id),
                    version_index: Set(plan.version_index),
                    is_active: Set(if plan.is_active { 1 } else { 0 }),
                    tool_calls_json: Set(None),
                    tool_call_id: Set(None),
                    status: Set(materialized.status),
                    tokens_per_second: Set(materialized.tokens_per_second),
                    first_token_latency_ms: Set(None),
                }
                .insert(&txn)
                .await?;
                result.imported_message_count += 1;
            }
        }

        import_jobs::ActiveModel {
            id: Set(gen_id()),
            source_type: Set("kelivo".to_string()),
            status: Set("success".to_string()),
            summary_json: Set(Some(serde_json::to_string(&result).unwrap_or_default())),
            conflict_count: Set(result.skipped_duplicate_conversation_count as i32),
            created_at: Set(chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string()),
        }
        .insert(&txn)
        .await?;

        Ok::<(), AQBotError>(())
    }
    .await;
    if let Err(error) = operation {
        let rollback_error = txn.rollback().await.err();
        let cleanup_errors = cleanup_import_created_paths(db, &file_store, &created_paths).await;
        return Err(import_failure(error, rollback_error, cleanup_errors));
    }
    if let Err(error) = txn.commit().await {
        let cleanup_errors = cleanup_import_created_paths(db, &file_store, &created_paths).await;
        return Err(import_failure(error.into(), None, cleanup_errors));
    }
    Ok(result)
}

fn parse_kelivo_backup(path: &Path) -> Result<ParsedKelivoBackup> {
    if !path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("zip"))
    {
        return Err(AQBotError::Validation(
            "Kelivo import requires a zip backup file".into(),
        ));
    }

    let mut archive = open_kelivo_zip(path)?;
    let mut zip_entries = HashSet::new();
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|e| AQBotError::Validation(format!("Invalid Kelivo zip backup entry: {e}")))?;
        zip_entries.insert(entry.name().replace('\\', "/"));
    }

    let chats_bytes = read_zip_entry(&mut archive, "chats.json")
        .map_err(|_| AQBotError::Validation("Kelivo backup is missing chats.json".into()))?;
    let chats = serde_json::from_slice::<KelivoChats>(&chats_bytes)
        .map_err(|e| AQBotError::Validation(format!("Invalid Kelivo chats.json: {e}")))?;
    let settings =
        match read_zip_entry(&mut archive, "settings.json") {
            Ok(bytes) => Some(serde_json::from_slice::<Value>(&bytes).map_err(|e| {
                AQBotError::Validation(format!("Invalid Kelivo settings.json: {e}"))
            })?),
            Err(_) => None,
        };
    let mut warnings = Vec::new();
    if settings.is_none() {
        warnings.push(warning(
            "missing_settings",
            "Kelivo settings.json is missing; provider API keys cannot be imported.",
            None,
        ));
    }
    Ok(ParsedKelivoBackup {
        chats,
        settings,
        zip_entries,
        warnings,
    })
}

fn open_kelivo_zip(path: &Path) -> Result<zip::ZipArchive<File>> {
    let file = File::open(path)?;
    zip::ZipArchive::new(file)
        .map_err(|e| AQBotError::Validation(format!("Invalid Kelivo zip backup: {e}")))
}

fn read_zip_entry(archive: &mut zip::ZipArchive<File>, name: &str) -> Result<Vec<u8>> {
    let mut entry = archive
        .by_name(name)
        .map_err(|_| AQBotError::Validation(format!("Kelivo backup is missing {name}")))?;
    let mut data = Vec::new();
    entry.read_to_end(&mut data)?;
    Ok(data)
}

async fn summarize_kelivo_backup(
    db: &DatabaseConnection,
    parsed: &ParsedKelivoBackup,
) -> Result<ThirdPartyImportSummary> {
    let mut summary = ThirdPartyImportSummary {
        warnings: parsed.warnings.clone(),
        ..Default::default()
    };
    let selected = selected_messages_by_conversation(&parsed.chats, &mut summary.warnings);
    append_attachment_warnings(&selected, &parsed.zip_entries, &mut summary.warnings);

    for conversation in &parsed.chats.conversations {
        let selected_messages = selected.get(&conversation.id).cloned().unwrap_or_default();
        let planned_messages =
            planned_messages_for_import(&selected_messages, &parsed.chats.tool_events);
        if planned_messages.is_empty() {
            summary.skipped_empty_topic_count += 1;
            continue;
        }
        summary.conversation_count += 1;
        summary.message_count += planned_messages
            .iter()
            .filter(|plan| plan.is_active)
            .count() as u32;
        let planned_message_refs = planned_messages
            .iter()
            .map(|plan| plan.message)
            .collect::<Vec<_>>();
        summary.file_count += attachment_refs_for_messages(&planned_message_refs).len() as u32;
        if conversations::Entity::find_by_id(&conversation.id)
            .one(db)
            .await?
            .is_some()
        {
            summary.duplicate_conversation_count += 1;
        }
    }

    summary.importable_provider_count = kelivo_providers(parsed.settings.as_ref())
        .into_iter()
        .filter(|provider| !importable_keys(&provider.config).is_empty())
        .count() as u32;

    Ok(summary)
}

fn selected_messages_by_conversation<'a>(
    chats: &'a KelivoChats,
    _warnings: &mut Vec<ThirdPartyImportWarning>,
) -> HashMap<String, Vec<&'a KelivoMessage>> {
    let by_id = chats
        .messages
        .iter()
        .map(|message| (message.id.as_str(), message))
        .collect::<HashMap<_, _>>();
    let mut result = HashMap::new();

    for conversation in &chats.conversations {
        let ordered = if conversation.message_ids.is_empty() {
            chats
                .messages
                .iter()
                .filter(|message| message.conversation_id == conversation.id)
                .collect::<Vec<_>>()
        } else {
            conversation
                .message_ids
                .iter()
                .filter_map(|id| by_id.get(id.as_str()).copied())
                .collect::<Vec<_>>()
        };
        if ordered.is_empty() {
            result.insert(conversation.id.clone(), Vec::new());
            continue;
        }

        let mut groups: Vec<(String, Vec<&KelivoMessage>)> = Vec::new();
        let mut index_by_group = HashMap::<String, usize>::new();
        for message in ordered {
            let group_id = message
                .group_id
                .clone()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| message.id.clone());
            let index = match index_by_group.get(&group_id) {
                Some(index) => *index,
                None => {
                    groups.push((group_id.clone(), Vec::new()));
                    let next_index = groups.len() - 1;
                    index_by_group.insert(group_id, next_index);
                    next_index
                }
            };
            groups[index].1.push(message);
        }

        let mut selected = Vec::new();
        for (_group_id, mut versions) in groups {
            versions.sort_by_key(|message| message.version);
            let group_id = _group_id;
            let selected_version = conversation.version_selections.get(&group_id).copied();
            let mut picked = selected_version
                .and_then(|version| {
                    versions
                        .iter()
                        .find(|message| message.version == version)
                        .copied()
                })
                .unwrap_or_else(|| *versions.last().unwrap());
            if is_incomplete_streaming_message(picked, &chats.tool_events) {
                if let Some(fallback) = versions
                    .iter()
                    .rev()
                    .find(|message| {
                        !is_incomplete_streaming_message(message, &chats.tool_events)
                            && message_has_importable_payload(message, &chats.tool_events)
                    })
                    .copied()
                {
                    picked = fallback;
                }
            }
            selected.push(picked);
        }
        result.insert(conversation.id.clone(), selected);
    }

    result
}

fn planned_messages_for_import<'a>(
    selected_messages: &[&'a KelivoMessage],
    tool_events: &HashMap<String, Vec<Value>>,
) -> Vec<KelivoMessageImportPlan<'a>> {
    let turns = merge_retry_turns(build_turns(selected_messages, tool_events));
    let mut plans = Vec::new();
    let mut previous_active_id: Option<String> = None;

    for turn in turns {
        if let Some(user) = turn.user {
            plans.push(KelivoMessageImportPlan {
                message: user,
                parent_message_id: previous_active_id.clone(),
                version_index: 0,
                is_active: true,
            });
            previous_active_id = Some(user.id.clone());

            if let Some(active_index) = active_assistant_index(&turn.assistants) {
                for (index, assistant) in turn.assistants.iter().enumerate() {
                    let is_active = index == active_index;
                    plans.push(KelivoMessageImportPlan {
                        message: assistant,
                        parent_message_id: Some(user.id.clone()),
                        version_index: index as i32,
                        is_active,
                    });
                    if is_active {
                        previous_active_id = Some(assistant.id.clone());
                    }
                }
            }
            continue;
        }

        for assistant in turn.assistants {
            plans.push(KelivoMessageImportPlan {
                message: assistant,
                parent_message_id: previous_active_id.clone(),
                version_index: 0,
                is_active: true,
            });
            previous_active_id = Some(assistant.id.clone());
        }
    }

    plans
}

fn build_turns<'a>(
    selected_messages: &[&'a KelivoMessage],
    tool_events: &HashMap<String, Vec<Value>>,
) -> Vec<KelivoTurn<'a>> {
    let mut turns = Vec::new();
    let mut current: Option<KelivoTurn<'a>> = None;

    for message in selected_messages.iter().copied() {
        match message.role.as_str() {
            "user" => {
                if let Some(turn) = current.take() {
                    turns.push(turn);
                }
                current = Some(KelivoTurn {
                    user: Some(message),
                    assistants: Vec::new(),
                });
            }
            "assistant" => {
                if message.is_streaming && !message_has_importable_payload(message, tool_events) {
                    continue;
                }
                match current.as_mut() {
                    Some(turn) => turn.assistants.push(message),
                    None => turns.push(KelivoTurn {
                        user: None,
                        assistants: vec![message],
                    }),
                }
            }
            _ => {
                if let Some(turn) = current.take() {
                    turns.push(turn);
                }
                turns.push(KelivoTurn {
                    user: None,
                    assistants: vec![message],
                });
            }
        }
    }

    if let Some(turn) = current {
        turns.push(turn);
    }
    turns
}

fn merge_retry_turns<'a>(turns: Vec<KelivoTurn<'a>>) -> Vec<KelivoTurn<'a>> {
    let mut merged: Vec<KelivoTurn<'a>> = Vec::new();
    for turn in turns {
        let should_merge = merged
            .last()
            .is_some_and(|previous| should_merge_retry_turn(previous, &turn));
        if should_merge {
            if let Some(previous) = merged.last_mut() {
                previous.assistants.extend(turn.assistants);
            }
        } else {
            merged.push(turn);
        }
    }
    merged
}

fn should_merge_retry_turn(previous: &KelivoTurn<'_>, current: &KelivoTurn<'_>) -> bool {
    let Some(previous_user) = previous.user else {
        return false;
    };
    let Some(current_user) = current.user else {
        return false;
    };
    let previous_content = normalize_user_retry_content(&previous_user.content);
    !previous_content.is_empty()
        && previous_content == normalize_user_retry_content(&current_user.content)
        && (turn_has_kelivo_error(previous) || turn_has_kelivo_error(current))
}

fn normalize_user_retry_content(content: &str) -> String {
    strip_attachment_markers(content)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn turn_has_kelivo_error(turn: &KelivoTurn<'_>) -> bool {
    turn.assistants
        .iter()
        .any(|message| is_kelivo_error_content(&message.content))
}

fn active_assistant_index(messages: &[&KelivoMessage]) -> Option<usize> {
    messages
        .iter()
        .enumerate()
        .rev()
        .find(|(_, message)| !is_kelivo_error_content(&message.content))
        .map(|(index, _)| index)
        .or_else(|| messages.len().checked_sub(1))
}

fn is_incomplete_streaming_message(
    message: &KelivoMessage,
    tool_events: &HashMap<String, Vec<Value>>,
) -> bool {
    message.is_streaming && !message_has_importable_payload(message, tool_events)
}

fn message_has_importable_payload(
    message: &KelivoMessage,
    tool_events: &HashMap<String, Vec<Value>>,
) -> bool {
    !strip_attachment_markers(&message.content).trim().is_empty()
        || !attachment_refs_for_message(message).is_empty()
        || materialize_thinking(message).is_some()
        || message
            .translation
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
        || tool_events
            .get(&message.id)
            .is_some_and(|events| !events.is_empty())
}

fn kelivo_providers(settings: Option<&Value>) -> Vec<KelivoProvider> {
    let Some(settings) = settings else {
        return Vec::new();
    };
    let Some(raw) = settings.get("provider_configs_v1") else {
        return Vec::new();
    };
    let providers_value = match raw {
        Value::String(text) => serde_json::from_str::<Value>(text).ok(),
        value => Some(value.clone()),
    };
    let Some(Value::Object(map)) = providers_value else {
        return Vec::new();
    };
    map.into_iter()
        .filter_map(|(source_id, value)| {
            serde_json::from_value::<KelivoProviderConfig>(value)
                .ok()
                .map(|config| KelivoProvider {
                    source_id: config.id.clone().unwrap_or(source_id),
                    config,
                })
        })
        .collect()
}

async fn import_provider<C>(
    db: &C,
    master_key: &[u8; 32],
    provider: &KelivoProvider,
) -> Result<Option<String>>
where
    C: ConnectionTrait,
{
    let keys = importable_keys(&provider.config);
    if keys.is_empty() {
        return Ok(None);
    }
    let provider_type = map_provider_type(provider);
    let base_url = provider_base_url(provider, &provider_type);
    let (api_host, api_path) = split_api_url(&base_url);
    if api_host.trim().is_empty() {
        return Ok(None);
    }
    let name = provider_import_name(provider);

    let existing = providers::Entity::find()
        .filter(providers::Column::Name.eq(&name))
        .filter(providers::Column::ApiHost.eq(&api_host))
        .filter(providers::Column::ProviderType.eq(provider_type_storage(&provider_type)))
        .one(db)
        .await?;

    let provider_id = match existing {
        Some(row) => row.id,
        None => {
            let id = gen_id();
            let now = now_ts();
            providers::ActiveModel {
                id: Set(id.clone()),
                name: Set(name),
                provider_type: Set(provider_type_storage(&provider_type).to_string()),
                api_host: Set(api_host),
                api_path: Set(api_path),
                enabled: Set(if provider.config.enabled.unwrap_or(true) {
                    1
                } else {
                    0
                }),
                proxy_config: Set(None),
                custom_headers: Set(None),
                icon: Set(None),
                builtin_id: Set(None),
                sort_order: Set(0),
                created_at: Set(now),
                updated_at: Set(now),
            }
            .insert(db)
            .await?;
            id
        }
    };

    let existing_keys = provider_keys::Entity::find()
        .filter(provider_keys::Column::ProviderId.eq(&provider_id))
        .all(db)
        .await?;
    for raw_key in keys {
        let key_exists = existing_keys.iter().any(|key| {
            decrypt_key(&key.key_encrypted, master_key)
                .map(|value| value == raw_key)
                .unwrap_or(false)
        });
        if key_exists {
            continue;
        }
        let rotation_index = existing_keys
            .iter()
            .map(|key| key.rotation_index)
            .max()
            .unwrap_or(-1)
            + 1;
        provider_keys::ActiveModel {
            id: Set(gen_id()),
            provider_id: Set(provider_id.clone()),
            key_encrypted: Set(encrypt_key(&raw_key, master_key)?),
            key_prefix: Set(key_prefix(&raw_key)),
            enabled: Set(1),
            last_validated_at: Set(None),
            last_error: Set(None),
            rotation_index: Set(rotation_index),
            created_at: Set(now_ts()),
        }
        .insert(db)
        .await?;
    }

    for (model_id, name) in kelivo_models(&provider.config) {
        let model_type = ModelType::detect(&model_id);
        models::Entity::insert(models::ActiveModel {
            provider_id: Set(provider_id.clone()),
            model_id: Set(model_id),
            name: Set(name),
            group_name: Set(None),
            model_type: Set(model_type.to_string()),
            capabilities: Set(serde_json::to_string(&default_capabilities(&model_type)).unwrap()),
            max_tokens: Set(None),
            enabled: Set(1),
            param_overrides: Set(empty_param_overrides_for_import(&provider_type)
                .and_then(|value| serde_json::to_string(&value).ok())),
        })
        .on_conflict(
            OnConflict::columns([models::Column::ProviderId, models::Column::ModelId])
                .do_nothing()
                .to_owned(),
        )
        .exec(db)
        .await?;
    }

    Ok(Some(provider_id))
}

fn provider_import_name(provider: &KelivoProvider) -> String {
    let source_id = provider.source_id.trim();
    if !source_id.is_empty() {
        return source_id.to_string();
    }
    provider
        .config
        .name
        .clone()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "Kelivo Provider".to_string())
}

fn importable_keys(config: &KelivoProviderConfig) -> Vec<String> {
    let mut keys = Vec::new();
    if let Some(key) = config
        .api_key
        .as_deref()
        .filter(|value| is_importable_key(value))
    {
        keys.push(key.trim().to_string());
    }
    for key_config in &config.api_keys {
        if key_config.is_enabled == Some(false) {
            continue;
        }
        if is_importable_key(&key_config.key) {
            let key = key_config.key.trim().to_string();
            if !keys.contains(&key) {
                keys.push(key);
            }
        }
    }
    keys
}

fn kelivo_models(config: &KelivoProviderConfig) -> Vec<(String, String)> {
    let mut seen = HashSet::new();
    let mut models = Vec::new();
    for model in &config.models {
        let model_id = model.trim();
        if !model_id.is_empty() && seen.insert(model_id.to_string()) {
            models.push((model_id.to_string(), model_id.to_string()));
        }
    }
    for (logical_id, override_value) in &config.model_overrides {
        let api_model_id = override_value
            .get("apiModelId")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(logical_id);
        let model_id = api_model_id.trim();
        if model_id.is_empty() || !seen.insert(model_id.to_string()) {
            continue;
        }
        let name = override_value
            .get("name")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(model_id)
            .to_string();
        models.push((model_id.to_string(), name));
    }
    models
}

fn map_provider_type(provider: &KelivoProvider) -> ProviderType {
    let raw = provider
        .config
        .provider_type
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    match raw.as_str() {
        "openai" if provider.config.use_response_api == Some(true) => ProviderType::OpenAIResponses,
        "openai" => ProviderType::OpenAI,
        "claude" | "anthropic" => ProviderType::Anthropic,
        "google" | "gemini" => ProviderType::Gemini,
        _ => {
            let id = provider.source_id.to_ascii_lowercase();
            let name = provider
                .config
                .name
                .clone()
                .unwrap_or_default()
                .to_ascii_lowercase();
            if id.contains("claude") || name.contains("claude") || id.contains("anthropic") {
                ProviderType::Anthropic
            } else if id.contains("gemini") || name.contains("gemini") || id.contains("google") {
                ProviderType::Gemini
            } else {
                ProviderType::Custom
            }
        }
    }
}

fn provider_base_url(provider: &KelivoProvider, provider_type: &ProviderType) -> String {
    provider
        .config
        .base_url
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| match provider_type {
            ProviderType::Anthropic => "https://api.anthropic.com/v1".to_string(),
            ProviderType::Gemini => "https://generativelanguage.googleapis.com/v1beta".to_string(),
            _ => "https://api.openai.com/v1".to_string(),
        })
}

struct MaterializedMessage {
    role: String,
    content: String,
    provider_id: String,
    model_id: String,
    token_count: Option<i64>,
    prompt_tokens: Option<i64>,
    completion_tokens: Option<i64>,
    attachments: Vec<Attachment>,
    thinking: Option<String>,
    created_at: i64,
    tokens_per_second: Option<f64>,
    status: String,
}

#[allow(clippy::too_many_arguments)]
async fn materialize_message<C>(
    db: &C,
    file_store: &FileStore,
    archive: &mut zip::ZipArchive<File>,
    zip_entries: &HashSet<String>,
    tool_events: &HashMap<String, Vec<Value>>,
    message: &KelivoMessage,
    provider_map: &HashMap<String, String>,
    fallback_provider_id: &str,
    fallback_model_id: &str,
    conversation_id: &str,
    result: &mut ThirdPartyImportResult,
    created_paths: &mut Vec<String>,
) -> Result<MaterializedMessage>
where
    C: ConnectionTrait,
{
    let refs = attachment_refs_for_message(message);
    let attachments = import_attachments(
        db,
        file_store,
        archive,
        zip_entries,
        conversation_id,
        &refs,
        result,
        created_paths,
    )
    .await?;
    let mut content = strip_attachment_markers(&message.content);

    if let Some(translation) = message
        .translation
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        append_markdown_section(&mut content, "Kelivo translation", translation);
    }
    if let Some(events) = tool_events.get(&message.id) {
        for event in events {
            let name = event
                .get("name")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .unwrap_or("tool");
            let payload = serde_json::to_string(event).unwrap_or_else(|_| event.to_string());
            append_markdown_section(
                &mut content,
                &format!("Kelivo tool event: {name}"),
                &format!("```json\n{payload}\n```"),
            );
        }
    }

    let imported_provider_id = message
        .provider_id
        .as_ref()
        .and_then(|source_id| provider_map.get(source_id))
        .cloned();
    let provider_id = imported_provider_id.unwrap_or_else(|| fallback_provider_id.to_string());
    let model_id = message
        .model_id
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| fallback_model_id.to_string());
    let tokens_per_second = message.completion_tokens.and_then(|completion| {
        let elapsed_ms = message.duration_ms? as f64;
        (elapsed_ms > 0.0).then_some(completion as f64 / (elapsed_ms / 1000.0))
    });

    Ok(MaterializedMessage {
        role: map_message_role(&message.role),
        content,
        provider_id,
        model_id,
        token_count: message.total_tokens.or_else(|| {
            message
                .prompt_tokens
                .zip(message.completion_tokens)
                .map(|(prompt, completion)| prompt + completion)
        }),
        prompt_tokens: message.prompt_tokens,
        completion_tokens: message.completion_tokens,
        attachments,
        thinking: materialize_thinking(message),
        created_at: parse_kelivo_ts_opt(message.timestamp.as_deref()).unwrap_or_else(now_ts),
        tokens_per_second,
        status: materialize_message_status(message),
    })
}

fn materialize_message_status(message: &KelivoMessage) -> String {
    if is_kelivo_error_content(&message.content) {
        "error".to_string()
    } else if message.is_streaming {
        "partial".to_string()
    } else {
        "complete".to_string()
    }
}

fn is_kelivo_error_content(content: &str) -> bool {
    let trimmed = content.trim_start();
    trimmed.starts_with("HttpException:")
        || trimmed.starts_with("DioException:")
        || trimmed.starts_with("Exception: HTTP ")
}

async fn import_attachments<C>(
    db: &C,
    file_store: &FileStore,
    archive: &mut zip::ZipArchive<File>,
    zip_entries: &HashSet<String>,
    conversation_id: &str,
    refs: &[KelivoAttachmentRef],
    result: &mut ThirdPartyImportResult,
    created_paths: &mut Vec<String>,
) -> Result<Vec<Attachment>>
where
    C: ConnectionTrait,
{
    let mut attachments = Vec::new();
    for attachment_ref in refs {
        let matches = matching_zip_entries(zip_entries, &attachment_candidates(attachment_ref));
        let entry_name = match matches.as_slice() {
            [entry] => entry.clone(),
            [] => {
                result.warnings.push(warning(
                    "missing_attachment",
                    format!(
                        "Kelivo attachment '{}' is missing from the backup.",
                        attachment_ref.file_name
                    ),
                    Some(attachment_ref.source_message_id.clone()),
                ));
                continue;
            }
            _ => {
                result.warnings.push(warning(
                    "ambiguous_attachment",
                    format!(
                        "Kelivo attachment '{}' matched multiple files in the backup.",
                        attachment_ref.file_name
                    ),
                    Some(attachment_ref.source_message_id.clone()),
                ));
                continue;
            }
        };
        let bytes = read_zip_entry(archive, &entry_name)?;
        let saved =
            file_store.save_file(&bytes, &attachment_ref.file_name, &attachment_ref.mime_type)?;
        if saved.created {
            created_paths.push(saved.storage_path.clone());
        }
        let id = gen_id();
        stored_files::ActiveModel {
            id: Set(id.clone()),
            hash: Set(saved.hash),
            original_name: Set(attachment_ref.file_name.clone()),
            mime_type: Set(attachment_ref.mime_type.clone()),
            size_bytes: Set(saved.size_bytes),
            storage_path: Set(saved.storage_path.clone()),
            conversation_id: Set(Some(conversation_id.to_string())),
            created_at: Default::default(),
        }
        .insert(db)
        .await?;
        attachments.push(Attachment {
            id,
            file_type: attachment_ref.mime_type.clone(),
            file_name: attachment_ref.file_name.clone(),
            file_path: saved.storage_path,
            file_size: saved.size_bytes.max(0) as u64,
            data: None,
        });
        result.imported_file_count += 1;
    }
    Ok(attachments)
}

async fn cleanup_import_created_paths(
    db: &DatabaseConnection,
    file_store: &FileStore,
    paths: &[String],
) -> Vec<String> {
    let mut unique_paths = paths.to_vec();
    unique_paths.sort();
    unique_paths.dedup();
    let mut errors = Vec::new();
    for path in unique_paths {
        match crate::repo::stored_file::count_stored_files_with_storage_path(db, &path).await {
            Ok(0) => {
                if let Err(error) = file_store.delete_file(&path) {
                    errors.push(format!("failed to delete {path}: {error}"));
                }
            }
            Ok(_) => {}
            Err(error) => errors.push(format!("failed to inspect {path}: {error}")),
        }
    }
    errors
}

fn import_failure(
    primary: AQBotError,
    rollback: Option<sea_orm::DbErr>,
    cleanup: Vec<String>,
) -> AQBotError {
    if rollback.is_none() && cleanup.is_empty() {
        return primary;
    }
    AQBotError::Validation(format!(
        "{primary}; rollback error: {}; cleanup errors: {}",
        rollback
            .map(|error| error.to_string())
            .unwrap_or_else(|| "none".to_string()),
        if cleanup.is_empty() {
            "none".to_string()
        } else {
            cleanup.join(", ")
        }
    ))
}

fn attachment_refs_for_messages(messages: &[&KelivoMessage]) -> Vec<KelivoAttachmentRef> {
    let mut seen = HashSet::new();
    let mut refs = Vec::new();
    for message in messages {
        for attachment_ref in attachment_refs_for_message(message) {
            if seen.insert(attachment_ref.clone()) {
                refs.push(attachment_ref);
            }
        }
    }
    refs
}

fn attachment_refs_for_message(message: &KelivoMessage) -> Vec<KelivoAttachmentRef> {
    let mut refs = Vec::new();
    let image_re = Regex::new(r"\[image:(.+?)\]").unwrap();
    let file_re = Regex::new(r"\[file:(.+?)\|(.+?)\|(.+?)\]").unwrap();
    for capture in image_re.captures_iter(&message.content) {
        let raw_path = capture
            .get(1)
            .map(|value| value.as_str().trim())
            .unwrap_or_default();
        if raw_path.is_empty() {
            continue;
        }
        let file_name = basename(raw_path).unwrap_or_else(|| "image".to_string());
        refs.push(KelivoAttachmentRef {
            raw_path: raw_path.to_string(),
            mime_type: mime_from_name(&file_name, None),
            file_name,
            source_message_id: message.id.clone(),
        });
    }
    for capture in file_re.captures_iter(&message.content) {
        let raw_path = capture
            .get(1)
            .map(|value| value.as_str().trim())
            .unwrap_or_default();
        let file_name = capture
            .get(2)
            .map(|value| value.as_str().trim())
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .or_else(|| basename(raw_path))
            .unwrap_or_else(|| "file".to_string());
        let mime_type = capture
            .get(3)
            .map(|value| value.as_str().trim())
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| mime_from_name(&file_name, None));
        if raw_path.is_empty() {
            continue;
        }
        refs.push(KelivoAttachmentRef {
            raw_path: raw_path.to_string(),
            file_name,
            mime_type,
            source_message_id: message.id.clone(),
        });
    }
    refs
}

fn append_attachment_warnings(
    selected: &HashMap<String, Vec<&KelivoMessage>>,
    zip_entries: &HashSet<String>,
    warnings: &mut Vec<ThirdPartyImportWarning>,
) {
    let mut seen = HashSet::new();
    for messages in selected.values() {
        for attachment_ref in attachment_refs_for_messages(messages) {
            if !seen.insert(attachment_ref.clone()) {
                continue;
            }
            let matches =
                matching_zip_entries(zip_entries, &attachment_candidates(&attachment_ref));
            match matches.len() {
                0 => warnings.push(warning(
                    "missing_attachment",
                    format!(
                        "Kelivo attachment '{}' is missing from the backup.",
                        attachment_ref.file_name
                    ),
                    Some(attachment_ref.source_message_id),
                )),
                1 => {}
                _ => warnings.push(warning(
                    "ambiguous_attachment",
                    format!(
                        "Kelivo attachment '{}' matched multiple files in the backup.",
                        attachment_ref.file_name
                    ),
                    Some(attachment_ref.source_message_id),
                )),
            }
        }
    }
}

fn attachment_candidates(attachment_ref: &KelivoAttachmentRef) -> HashSet<String> {
    let mut candidates = HashSet::new();
    let normalized = attachment_ref
        .raw_path
        .trim()
        .trim_start_matches("file://")
        .replace('\\', "/");
    let without_leading = normalized.trim_start_matches('/').to_string();
    if !without_leading.is_empty() {
        candidates.insert(without_leading);
    }
    for root in ["upload", "images", "avatars"] {
        if let Some(index) = normalized.find(&format!("/{root}/")) {
            candidates.insert(normalized[index + 1..].to_string());
        }
        if normalized.starts_with(&format!("{root}/")) {
            candidates.insert(normalized.clone());
        }
        candidates.insert(format!("{root}/{}", attachment_ref.file_name));
        if let Some(base) = basename(&attachment_ref.raw_path) {
            candidates.insert(format!("{root}/{base}"));
        }
    }
    candidates
}

fn matching_zip_entries(
    zip_entries: &HashSet<String>,
    candidates: &HashSet<String>,
) -> Vec<String> {
    let mut matches = zip_entries
        .iter()
        .filter(|entry| candidates.contains(*entry))
        .cloned()
        .collect::<Vec<_>>();
    matches.sort();
    matches.dedup();
    matches
}

fn strip_attachment_markers(content: &str) -> String {
    let image_re = Regex::new(r"\[image:(.+?)\]").unwrap();
    let file_re = Regex::new(r"\[file:(.+?)\|(.+?)\|(.+?)\]").unwrap();
    let without_images = image_re.replace_all(content, "");
    let without_files = file_re.replace_all(&without_images, "");
    without_files
        .lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

fn materialize_thinking(message: &KelivoMessage) -> Option<String> {
    message
        .reasoning_text
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| thinking_from_segments(message.reasoning_segments_json.as_deref()))
}

fn thinking_from_segments(raw: Option<&str>) -> Option<String> {
    let raw = raw?.trim();
    if raw.is_empty() {
        return None;
    }
    let decoded = serde_json::from_str::<Value>(raw).ok()?;
    let segments = match decoded {
        Value::Array(items) => items,
        Value::Object(map) => map.get("segments")?.as_array()?.clone(),
        _ => return None,
    };
    let parts = segments
        .iter()
        .filter_map(|item| item.get("text").and_then(Value::as_str))
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    (!parts.is_empty()).then(|| parts.join("\n"))
}

fn append_markdown_section(content: &mut String, title: &str, body: &str) {
    if !content.trim().is_empty() {
        content.push_str("\n\n");
    }
    content.push_str("### ");
    content.push_str(title);
    content.push('\n');
    content.push_str(body);
}

fn map_message_role(role: &str) -> String {
    match role {
        "system" => "system".to_string(),
        "user" => "user".to_string(),
        "tool" => "tool".to_string(),
        _ => "assistant".to_string(),
    }
}

fn provider_type_storage(provider_type: &ProviderType) -> &'static str {
    match provider_type {
        ProviderType::OpenAI => "openai",
        ProviderType::OpenAIResponses => "openai_responses",
        ProviderType::DeepSeek => "deepseek",
        ProviderType::XAI => "xai",
        ProviderType::GLM => "glm",
        ProviderType::SiliconFlow => "siliconflow",
        ProviderType::Anthropic => "anthropic",
        ProviderType::Gemini => "gemini",
        ProviderType::Jina => "jina",
        ProviderType::Cohere => "cohere",
        ProviderType::Voyage => "voyage",
        ProviderType::Custom => "custom",
    }
}

fn split_api_url(value: &str) -> (String, Option<String>) {
    let trimmed = value.trim().trim_end_matches('/');
    let Ok(parsed) = reqwest::Url::parse(trimmed) else {
        return (trimmed.to_string(), None);
    };
    let Some(host) = parsed.host_str() else {
        return (trimmed.to_string(), None);
    };
    let mut host_part = format!("{}://{}", parsed.scheme(), host);
    if let Some(port) = parsed.port() {
        host_part = format!("{host_part}:{port}");
    }
    let path = parsed.path().trim_end_matches('/');
    let api_path = (!path.is_empty() && path != "/").then(|| path.to_string());
    (host_part, api_path)
}

fn is_importable_key(value: &str) -> bool {
    let trimmed = value.trim();
    !trimmed.is_empty() && !trimmed.contains('*')
}

fn key_prefix(raw_key: &str) -> String {
    if raw_key.len() >= 8 {
        format!("{}...", &raw_key[..8])
    } else {
        raw_key.to_string()
    }
}

fn default_capabilities(model_type: &ModelType) -> Vec<ModelCapability> {
    match model_type {
        ModelType::Chat => vec![ModelCapability::TextChat],
        _ => Vec::new(),
    }
}

fn empty_param_overrides_for_import(provider_type: &ProviderType) -> Option<ModelParamOverrides> {
    let reasoning_profile = match provider_type {
        ProviderType::OpenAIResponses => Some("openai_responses_reasoning".to_string()),
        ProviderType::OpenAI | ProviderType::Custom => Some("openai_reasoning_effort".to_string()),
        ProviderType::Anthropic => Some("anthropic_adaptive".to_string()),
        ProviderType::Gemini => Some("gemini_thinking_level".to_string()),
        _ => None,
    };

    reasoning_profile.map(|profile| ModelParamOverrides {
        temperature: None,
        max_tokens: None,
        top_p: None,
        frequency_penalty: None,
        use_max_completion_tokens: None,
        no_system_role: None,
        force_max_tokens: None,
        thinking_param_style: None,
        reasoning_profile: Some(profile),
        reasoning_options: None,
        reasoning_default: None,
        extra_body: None,
    })
}

fn parse_kelivo_ts_opt(value: Option<&str>) -> Option<i64> {
    let raw = value?.trim();
    if raw.is_empty() {
        return None;
    }
    if let Ok(number) = raw.parse::<i64>() {
        return Some(if number > 10_000_000_000 {
            number / 1000
        } else {
            number
        });
    }
    chrono::DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|value| value.timestamp())
        .or_else(|| {
            chrono::NaiveDateTime::parse_from_str(raw, "%Y-%m-%dT%H:%M:%S%.f")
                .ok()
                .and_then(|naive| match chrono::Local.from_local_datetime(&naive) {
                    chrono::LocalResult::Single(value) => Some(value.timestamp()),
                    chrono::LocalResult::Ambiguous(earliest, _) => Some(earliest.timestamp()),
                    chrono::LocalResult::None => None,
                })
        })
}

fn mime_from_name(name: &str, ext: Option<&str>) -> String {
    let extension = ext
        .map(|value| value.trim_start_matches('.').to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            PathBuf::from(name)
                .extension()
                .and_then(|value| value.to_str())
                .map(|value| value.to_ascii_lowercase())
        })
        .unwrap_or_default();
    match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "csv" => "text/csv",
        "txt" => "text/plain",
        "md" => "text/markdown",
        "json" => "application/json",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        _ => "application/octet-stream",
    }
    .to_string()
}

fn basename(value: &str) -> Option<String> {
    value
        .replace('\\', "/")
        .rsplit('/')
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn warning(
    code: impl Into<String>,
    message: impl Into<String>,
    source_id: Option<String>,
) -> ThirdPartyImportWarning {
    ThirdPartyImportWarning {
        code: code.into(),
        message: message.into(),
        source_id,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::decrypt_key;
    use crate::db::create_test_pool;
    use crate::entity::{conversations, messages, stored_files};
    use crate::repo::message as message_repo;
    use crate::repo::provider;
    use crate::types::{Attachment, ProviderType};
    use chrono::TimeZone;
    use sea_orm::{ColumnTrait, ConnectionTrait, DbBackend, EntityTrait, QueryFilter, Statement};
    use serde_json::json;
    use std::fs::File;
    use std::io::Write;
    use std::path::Path;
    use tempfile::tempdir;
    use zip::write::SimpleFileOptions;

    fn write_kelivo_zip(
        path: &Path,
        settings: Option<serde_json::Value>,
        chats: serde_json::Value,
        files: &[(&str, &[u8])],
    ) {
        let file = File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = SimpleFileOptions::default();
        if let Some(settings) = settings {
            zip.start_file("settings.json", options).unwrap();
            zip.write_all(serde_json::to_string(&settings).unwrap().as_bytes())
                .unwrap();
        }
        zip.start_file("chats.json", options).unwrap();
        zip.write_all(serde_json::to_string(&chats).unwrap().as_bytes())
            .unwrap();
        for (name, bytes) in files {
            zip.start_file(name, options).unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.finish().unwrap();
    }

    fn sample_settings_json() -> serde_json::Value {
        json!({
            "provider_configs_v1": serde_json::to_string(&json!({
                "openai-main": {
                    "id": "openai-main",
                    "enabled": true,
                    "name": "Kelivo OpenAI",
                    "apiKey": "sk-kelivo-main",
                    "baseUrl": "https://api.example.com/v1",
                    "providerType": "openai",
                    "useResponseApi": true,
                    "models": ["gpt-5-chat"],
                    "modelOverrides": {
                        "logical-fast": {
                            "apiModelId": "gpt-4o-mini",
                            "name": "Fast logical"
                        }
                    },
                    "apiKeys": [
                        {"id": "key-a", "key": "sk-kelivo-2", "name": "secondary", "isEnabled": true},
                        {"id": "key-mask", "key": "sk-****", "isEnabled": true}
                    ]
                },
                "unused-provider": {
                    "id": "unused-provider",
                    "enabled": true,
                    "name": "Unused",
                    "apiKey": "sk-unused",
                    "baseUrl": "https://unused.example.com/v1",
                    "providerType": "openai"
                }
            })).unwrap()
        })
    }

    fn sample_chats_json() -> serde_json::Value {
        json!({
            "version": 1,
            "conversations": [{
                "id": "kelivo-conv-1",
                "title": "Kelivo imported chat",
                "createdAt": "2026-05-28T01:02:03.000Z",
                "updatedAt": "2026-05-28T01:04:05.000Z",
                "messageIds": ["msg-user-1", "msg-assistant-v0", "msg-assistant-v1"],
                "isPinned": true,
                "mcpServerIds": ["mcp-a"],
                "assistantId": "assistant-1",
                "truncateIndex": -1,
                "versionSelections": {"assistant-group": 1},
                "summary": "short summary",
                "lastSummarizedMessageCount": 3,
                "chatSuggestions": ["next"]
            }, {
                "id": "empty-conv",
                "title": "Empty",
                "createdAt": "2026-05-28T01:00:00.000Z",
                "updatedAt": "2026-05-28T01:00:00.000Z",
                "messageIds": []
            }],
            "messages": [
                {
                    "id": "msg-user-1",
                    "role": "user",
                    "content": "hello\n[image:/Users/test/Library/Kelivo/images/photo.png]\n[file:/Users/test/Library/Kelivo/upload/doc.pdf|doc.pdf|application/pdf]",
                    "timestamp": "2026-05-28T01:02:03.000Z",
                    "modelId": null,
                    "providerId": null,
                    "totalTokens": 5,
                    "conversationId": "kelivo-conv-1",
                    "isStreaming": false,
                    "promptTokens": 2,
                    "completionTokens": 3,
                    "durationMs": 2000
                },
                {
                    "id": "msg-assistant-v0",
                    "role": "assistant",
                    "content": "old answer",
                    "timestamp": "2026-05-28T01:03:00.000Z",
                    "modelId": "gpt-5-chat",
                    "providerId": "openai-main",
                    "totalTokens": 7,
                    "conversationId": "kelivo-conv-1",
                    "groupId": "assistant-group",
                    "version": 0,
                    "reasoningSegmentsJson": "{\"segments\":[{\"text\":\"old thinking\"}]}"
                },
                {
                    "id": "msg-assistant-v1",
                    "role": "assistant",
                    "content": "new answer",
                    "timestamp": "2026-05-28T01:04:00.000Z",
                    "modelId": "gpt-5-chat",
                    "providerId": "openai-main",
                    "totalTokens": 11,
                    "conversationId": "kelivo-conv-1",
                    "groupId": "assistant-group",
                    "version": 1,
                    "reasoningText": "selected thinking",
                    "translation": "translated answer",
                    "promptTokens": 4,
                    "completionTokens": 7,
                    "durationMs": 1000
                }
            ],
            "toolEvents": {
                "msg-assistant-v1": [{
                    "id": "call-1",
                    "name": "fetch",
                    "arguments": {"url": "https://example.com"},
                    "content": "tool result"
                }]
            },
            "geminiThoughtSigs": {
                "msg-assistant-v1": "internal"
            }
        })
    }

    #[tokio::test]
    async fn scan_kelivo_zip_summarizes_importable_data() {
        let dir = tempdir().unwrap();
        let zip_path = dir.path().join("kelivo.zip");
        write_kelivo_zip(
            &zip_path,
            Some(sample_settings_json()),
            sample_chats_json(),
            &[
                ("images/photo.png", b"pngdata"),
                ("upload/doc.pdf", b"pdfdata"),
            ],
        );
        let db = create_test_pool().await.unwrap();

        let summary = scan_kelivo_import_from_path(&db.conn, &zip_path)
            .await
            .unwrap();

        assert_eq!(summary.conversation_count, 1);
        assert_eq!(summary.message_count, 2);
        assert_eq!(summary.file_count, 2);
        assert_eq!(summary.importable_provider_count, 2);
        assert_eq!(summary.skipped_empty_topic_count, 1);
        assert_eq!(summary.duplicate_conversation_count, 0);
        assert!(summary.warnings.is_empty());
    }

    #[tokio::test]
    async fn import_kelivo_zip_materializes_history_files_thinking_and_providers() {
        let dir = tempdir().unwrap();
        let zip_path = dir.path().join("kelivo.zip");
        let docs_root = dir.path().join("aqbot-docs");
        write_kelivo_zip(
            &zip_path,
            Some(sample_settings_json()),
            sample_chats_json(),
            &[
                ("images/photo.png", b"pngdata"),
                ("upload/doc.pdf", b"pdfdata"),
            ],
        );
        let db = create_test_pool().await.unwrap();
        let master_key = [11u8; 32];

        let result = import_kelivo_backup_from_path_with_root(
            &db.conn,
            &master_key,
            &zip_path,
            ThirdPartyImportOptions {
                import_provider_keys: true,
            },
            &docs_root,
        )
        .await
        .unwrap();

        assert_eq!(result.imported_conversation_count, 1);
        assert_eq!(result.imported_message_count, 2);
        assert_eq!(result.imported_file_count, 2);
        assert_eq!(result.imported_provider_count, 2);

        let conversation = conversations::Entity::find_by_id("kelivo-conv-1")
            .one(&db.conn)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(conversation.title, "Kelivo imported chat");
        assert_eq!(conversation.message_count, 2);
        assert_eq!(conversation.is_pinned, 1);

        let imported_messages = messages::Entity::find()
            .filter(messages::Column::ConversationId.eq("kelivo-conv-1"))
            .all(&db.conn)
            .await
            .unwrap();
        assert_eq!(imported_messages.len(), 2);
        assert!(imported_messages
            .iter()
            .all(|message| message.id != "msg-assistant-v0"));

        let user = imported_messages
            .iter()
            .find(|message| message.id == "msg-user-1")
            .unwrap();
        assert_eq!(user.content, "hello");
        let attachments: Vec<Attachment> = serde_json::from_str(&user.attachments).unwrap();
        assert_eq!(attachments.len(), 2);
        assert!(attachments
            .iter()
            .any(|attachment| attachment.file_name == "photo.png"));
        assert!(attachments
            .iter()
            .any(|attachment| attachment.file_name == "doc.pdf"));

        let assistant = imported_messages
            .iter()
            .find(|message| message.id == "msg-assistant-v1")
            .unwrap();
        assert!(assistant.content.contains("new answer"));
        assert!(assistant.content.contains("### Kelivo translation"));
        assert!(assistant.content.contains("### Kelivo tool event: fetch"));
        assert_eq!(assistant.thinking.as_deref(), Some("selected thinking"));
        assert_eq!(assistant.prompt_tokens, Some(4));
        assert_eq!(assistant.completion_tokens, Some(7));
        assert_eq!(assistant.token_count, Some(11));
        assert_eq!(assistant.parent_message_id.as_deref(), Some("msg-user-1"));

        let stored = stored_files::Entity::find()
            .filter(stored_files::Column::OriginalName.eq("doc.pdf"))
            .one(&db.conn)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(stored.conversation_id.as_deref(), Some("kelivo-conv-1"));
        assert!(docs_root.join(&stored.storage_path).exists());
        assert!(stored.storage_path.starts_with("files/"));

        let providers = provider::list_providers(&db.conn).await.unwrap();
        let imported_provider = providers
            .iter()
            .find(|provider| provider.name == "openai-main")
            .unwrap();
        assert!(providers
            .iter()
            .any(|provider| provider.name == "unused-provider"));
        assert_eq!(conversation.provider_id, imported_provider.id);
        assert_eq!(conversation.model_id, "gpt-5-chat");
        assert_eq!(
            imported_provider.provider_type,
            ProviderType::OpenAIResponses
        );
        assert_eq!(imported_provider.api_host, "https://api.example.com");
        assert_eq!(imported_provider.api_path.as_deref(), Some("/v1"));
        assert_eq!(imported_provider.keys.len(), 2);
        let keys = imported_provider
            .keys
            .iter()
            .map(|key| decrypt_key(&key.key_encrypted, &master_key).unwrap())
            .collect::<Vec<_>>();
        assert!(keys.contains(&"sk-kelivo-main".to_string()));
        assert!(keys.contains(&"sk-kelivo-2".to_string()));
        assert!(imported_provider
            .models
            .iter()
            .any(|model| model.model_id == "gpt-5-chat"));
        assert!(imported_provider
            .models
            .iter()
            .any(|model| model.model_id == "gpt-4o-mini" && model.name == "Fast logical"));

        let duplicate = import_kelivo_backup_from_path_with_root(
            &db.conn,
            &master_key,
            &zip_path,
            ThirdPartyImportOptions {
                import_provider_keys: true,
            },
            &docs_root,
        )
        .await
        .unwrap();
        assert_eq!(duplicate.imported_conversation_count, 0);
        assert_eq!(duplicate.skipped_duplicate_conversation_count, 1);
    }

    #[tokio::test]
    async fn import_failure_rolls_back_rows_and_removes_new_physical_files() {
        let dir = tempdir().unwrap();
        let zip_path = dir.path().join("kelivo.zip");
        let docs_root = dir.path().join("aqbot-docs");
        write_kelivo_zip(
            &zip_path,
            Some(sample_settings_json()),
            sample_chats_json(),
            &[
                ("images/photo.png", b"pngdata"),
                ("upload/doc.pdf", b"pdfdata"),
            ],
        );
        let db = create_test_pool().await.unwrap();
        db.conn
            .execute(Statement::from_string(
                DbBackend::Sqlite,
                "CREATE TRIGGER fail_kelivo_message BEFORE INSERT ON messages \
                 BEGIN SELECT RAISE(ABORT, 'forced message insert failure'); END"
                    .to_string(),
            ))
            .await
            .unwrap();

        let result = import_kelivo_backup_from_path_with_root(
            &db.conn,
            &[11u8; 32],
            &zip_path,
            ThirdPartyImportOptions {
                import_provider_keys: false,
            },
            &docs_root,
        )
        .await;

        assert!(result.is_err());
        assert!(conversations::Entity::find()
            .all(&db.conn)
            .await
            .unwrap()
            .is_empty());
        assert!(messages::Entity::find()
            .all(&db.conn)
            .await
            .unwrap()
            .is_empty());
        assert!(stored_files::Entity::find()
            .all(&db.conn)
            .await
            .unwrap()
            .is_empty());
        for (name, mime, bytes) in [
            ("photo.png", "image/png", b"pngdata".as_slice()),
            ("doc.pdf", "application/pdf", b"pdfdata".as_slice()),
        ] {
            let hash = FileStore::hash_bytes(bytes);
            let path = crate::storage_paths::build_relative_path(name, mime, &hash);
            assert!(!docs_root.join(path).exists());
        }
    }

    #[tokio::test]
    async fn import_kelivo_provider_keys_is_opt_in() {
        let dir = tempdir().unwrap();
        let zip_path = dir.path().join("kelivo.zip");
        write_kelivo_zip(
            &zip_path,
            Some(sample_settings_json()),
            sample_chats_json(),
            &[
                ("images/photo.png", b"pngdata"),
                ("upload/doc.pdf", b"pdfdata"),
            ],
        );
        let db = create_test_pool().await.unwrap();

        let result = import_kelivo_backup_from_path_with_root(
            &db.conn,
            &[12u8; 32],
            &zip_path,
            ThirdPartyImportOptions {
                import_provider_keys: false,
            },
            &dir.path().join("docs"),
        )
        .await
        .unwrap();

        assert_eq!(result.imported_conversation_count, 1);
        assert_eq!(result.imported_provider_count, 0);
        assert!(provider::list_providers(&db.conn).await.unwrap().is_empty());

        let conversation = conversations::Entity::find_by_id("kelivo-conv-1")
            .one(&db.conn)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(conversation.provider_id, "kelivo");
        assert_eq!(conversation.model_id, "gpt-5-chat");
    }

    #[tokio::test]
    async fn selected_streaming_empty_version_falls_back_to_latest_complete_variant() {
        let dir = tempdir().unwrap();
        let zip_path = dir.path().join("kelivo.zip");
        let chats = json!({
            "version": 1,
            "conversations": [{
                "id": "kelivo-streaming-conv",
                "title": "Streaming selected",
                "createdAt": "2026-05-29T21:20:33.872903",
                "updatedAt": "2026-05-29T21:23:58.355921",
                "messageIds": ["stream-user", "stream-v0", "stream-v1", "stream-v2"],
                "isPinned": false,
                "versionSelections": {"stream-group": 2}
            }],
            "messages": [
                {
                    "id": "stream-user",
                    "role": "user",
                    "content": "hello",
                    "timestamp": "2026-05-29T21:22:32.558343",
                    "conversationId": "kelivo-streaming-conv",
                    "version": 0
                },
                {
                    "id": "stream-v0",
                    "role": "assistant",
                    "content": "old complete answer",
                    "timestamp": "2026-05-29T21:22:49.526091",
                    "modelId": "deepseek-chat",
                    "providerId": "openai-main",
                    "conversationId": "kelivo-streaming-conv",
                    "groupId": "stream-group",
                    "version": 0,
                    "isStreaming": false
                },
                {
                    "id": "stream-v1",
                    "role": "assistant",
                    "content": "latest complete answer",
                    "timestamp": "2026-05-29T21:23:45.478438",
                    "modelId": "gpt-5-chat",
                    "providerId": "openai-main",
                    "conversationId": "kelivo-streaming-conv",
                    "groupId": "stream-group",
                    "version": 1,
                    "isStreaming": false
                },
                {
                    "id": "stream-v2",
                    "role": "assistant",
                    "content": "",
                    "timestamp": "2026-05-29T21:23:58.355921",
                    "modelId": "qwen3-30b-a3b",
                    "providerId": "openai-main",
                    "conversationId": "kelivo-streaming-conv",
                    "groupId": "stream-group",
                    "version": 2,
                    "isStreaming": true
                }
            ],
            "toolEvents": {},
            "geminiThoughtSigs": {}
        });
        write_kelivo_zip(&zip_path, Some(sample_settings_json()), chats, &[]);
        let db = create_test_pool().await.unwrap();

        let summary = scan_kelivo_import_from_path(&db.conn, &zip_path)
            .await
            .unwrap();
        assert_eq!(summary.conversation_count, 1);
        assert_eq!(summary.message_count, 2);
        assert!(summary.warnings.is_empty());

        let result = import_kelivo_backup_from_path_with_root(
            &db.conn,
            &[13u8; 32],
            &zip_path,
            ThirdPartyImportOptions {
                import_provider_keys: true,
            },
            &dir.path().join("docs"),
        )
        .await
        .unwrap();
        assert!(result.warnings.is_empty());

        let imported_messages = messages::Entity::find()
            .filter(messages::Column::ConversationId.eq("kelivo-streaming-conv"))
            .all(&db.conn)
            .await
            .unwrap();
        assert!(imported_messages.iter().any(
            |message| message.id == "stream-v1" && message.content == "latest complete answer"
        ));
        assert!(imported_messages
            .iter()
            .all(|message| message.id != "stream-v2"));

        let conversation = conversations::Entity::find_by_id("kelivo-streaming-conv")
            .one(&db.conn)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(conversation.model_id, "gpt-5-chat");
    }

    #[tokio::test]
    async fn repeated_kelivo_error_retries_import_as_assistant_versions() {
        let dir = tempdir().unwrap();
        let zip_path = dir.path().join("kelivo.zip");
        let chats = json!({
            "version": 1,
            "conversations": [{
                "id": "kelivo-retry-conv",
                "title": "Retry conversation",
                "createdAt": "2026-05-29T21:20:33.872903",
                "updatedAt": "2026-05-29T21:23:58.355921",
                "messageIds": ["hello-user", "hello-assistant", "retry-user-1", "retry-a-1", "retry-user-2", "retry-a-2", "retry-user-3", "retry-a-3"],
                "isPinned": false,
                "versionSelections": {}
            }],
            "messages": [
                {
                    "id": "hello-user",
                    "role": "user",
                    "content": "你好",
                    "timestamp": "2026-05-29T21:22:32.558343",
                    "conversationId": "kelivo-retry-conv",
                    "version": 0
                },
                {
                    "id": "hello-assistant",
                    "role": "assistant",
                    "content": "你好，我可以帮助你什么？",
                    "timestamp": "2026-05-29T21:22:32.559448",
                    "modelId": "deepseek-chat",
                    "providerId": "openai-main",
                    "conversationId": "kelivo-retry-conv",
                    "groupId": "hello-assistant",
                    "version": 0
                },
                {
                    "id": "retry-user-1",
                    "role": "user",
                    "content": "给我一个好看的hello world",
                    "timestamp": "2026-05-29T21:22:49.524178",
                    "conversationId": "kelivo-retry-conv",
                    "version": 0
                },
                {
                    "id": "retry-a-1",
                    "role": "assistant",
                    "content": "HttpException: HTTP 402: insufficient balance",
                    "timestamp": "2026-05-29T21:22:49.526091",
                    "modelId": "deepseek-chat",
                    "providerId": "openai-main",
                    "conversationId": "kelivo-retry-conv",
                    "groupId": "retry-a-1",
                    "version": 0
                },
                {
                    "id": "retry-user-2",
                    "role": "user",
                    "content": "给我一个好看的hello world",
                    "timestamp": "2026-05-29T21:22:59.526337",
                    "conversationId": "kelivo-retry-conv",
                    "version": 0
                },
                {
                    "id": "retry-a-2",
                    "role": "assistant",
                    "content": "HttpException: HTTP 402: insufficient balance again",
                    "timestamp": "2026-05-29T21:22:59.528925",
                    "modelId": "deepseek-chat",
                    "providerId": "openai-main",
                    "conversationId": "kelivo-retry-conv",
                    "groupId": "retry-a-2",
                    "version": 0
                },
                {
                    "id": "retry-user-3",
                    "role": "user",
                    "content": "给我一个好看的hello world",
                    "timestamp": "2026-05-29T21:23:06.506617",
                    "conversationId": "kelivo-retry-conv",
                    "version": 0
                },
                {
                    "id": "retry-a-3",
                    "role": "assistant",
                    "content": "HttpException: HTTP 403: token quota is not enough",
                    "timestamp": "2026-05-29T21:23:45.478438",
                    "modelId": "gpt-5.5",
                    "providerId": "openai-main",
                    "conversationId": "kelivo-retry-conv",
                    "groupId": "retry-a-3",
                    "version": 0
                }
            ],
            "toolEvents": {},
            "geminiThoughtSigs": {}
        });
        write_kelivo_zip(&zip_path, Some(sample_settings_json()), chats, &[]);
        let db = create_test_pool().await.unwrap();

        let summary = scan_kelivo_import_from_path(&db.conn, &zip_path)
            .await
            .unwrap();
        assert_eq!(summary.message_count, 4);

        let result = import_kelivo_backup_from_path_with_root(
            &db.conn,
            &[14u8; 32],
            &zip_path,
            ThirdPartyImportOptions {
                import_provider_keys: false,
            },
            &dir.path().join("docs"),
        )
        .await
        .unwrap();
        assert_eq!(result.imported_message_count, 6);

        let visible_messages = message_repo::list_messages(&db.conn, "kelivo-retry-conv")
            .await
            .unwrap();
        assert_eq!(visible_messages.len(), 4);
        assert!(visible_messages
            .iter()
            .any(|message| message.id == "retry-user-1"));
        assert!(visible_messages
            .iter()
            .all(|message| message.id != "retry-user-2"));
        assert!(visible_messages
            .iter()
            .all(|message| message.id != "retry-user-3"));

        let versions =
            message_repo::list_message_versions(&db.conn, "kelivo-retry-conv", "retry-user-1")
                .await
                .unwrap();
        assert_eq!(versions.len(), 3);
        assert!(versions.iter().all(|message| message.status == "error"));
        assert_eq!(
            versions[0].parent_message_id.as_deref(),
            Some("retry-user-1")
        );
        assert_eq!(versions[0].version_index, 0);
        assert_eq!(versions[1].version_index, 1);
        assert_eq!(versions[2].version_index, 2);
        assert_eq!(
            versions.iter().filter(|message| message.is_active).count(),
            1
        );
        assert_eq!(
            versions
                .iter()
                .find(|message| message.is_active)
                .unwrap()
                .id,
            "retry-a-3"
        );

        let conversation = conversations::Entity::find_by_id("kelivo-retry-conv")
            .one(&db.conn)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(conversation.message_count, 4);
        assert_eq!(conversation.model_id, "deepseek-chat");
    }

    #[test]
    fn parses_kelivo_naive_local_timestamp() {
        let raw = "2026-05-29T21:22:32.558343";
        let naive = chrono::NaiveDateTime::parse_from_str(raw, "%Y-%m-%dT%H:%M:%S%.f").unwrap();
        let expected = chrono::Local
            .from_local_datetime(&naive)
            .single()
            .unwrap()
            .timestamp();

        assert_eq!(parse_kelivo_ts_opt(Some(raw)), Some(expected));
    }

    #[tokio::test]
    async fn scan_kelivo_zip_requires_chats_json_and_warns_for_missing_settings_and_files() {
        let dir = tempdir().unwrap();
        let missing_chats = dir.path().join("missing-chats.zip");
        let file = File::create(&missing_chats).unwrap();
        zip::ZipWriter::new(file).finish().unwrap();
        let db = create_test_pool().await.unwrap();

        let err = scan_kelivo_import_from_path(&db.conn, &missing_chats)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("chats.json"));

        let missing_files = dir.path().join("missing-files.zip");
        write_kelivo_zip(&missing_files, None, sample_chats_json(), &[]);
        let summary = scan_kelivo_import_from_path(&db.conn, &missing_files)
            .await
            .unwrap();
        assert!(summary
            .warnings
            .iter()
            .any(|warning| warning.code == "missing_settings"));
        assert!(summary
            .warnings
            .iter()
            .any(|warning| warning.code == "missing_attachment"));
    }
}
