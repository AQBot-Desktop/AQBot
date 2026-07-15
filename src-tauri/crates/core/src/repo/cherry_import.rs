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
pub struct CherryStudioImportWarning {
    pub code: String,
    pub message: String,
    pub source_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CherryStudioImportSummary {
    pub conversation_count: u32,
    pub message_count: u32,
    pub file_count: u32,
    pub importable_provider_count: u32,
    pub skipped_empty_topic_count: u32,
    pub duplicate_conversation_count: u32,
    pub warnings: Vec<CherryStudioImportWarning>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CherryStudioImportOptions {
    #[serde(default)]
    pub import_provider_keys: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CherryStudioImportResult {
    pub imported_conversation_count: u32,
    pub imported_message_count: u32,
    pub imported_file_count: u32,
    pub imported_provider_count: u32,
    pub skipped_duplicate_conversation_count: u32,
    pub warnings: Vec<CherryStudioImportWarning>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct CherryBackup {
    #[serde(default, rename = "localStorage")]
    local_storage: HashMap<String, Value>,
    #[serde(default, rename = "indexedDB")]
    indexed_db: CherryIndexedDb,
}

#[derive(Debug, Clone, Deserialize, Default)]
struct CherryIndexedDb {
    #[serde(default)]
    topics: Vec<CherryTopic>,
    #[serde(default)]
    message_blocks: Vec<CherryMessageBlock>,
    #[serde(default)]
    files: Vec<CherryFile>,
}

#[derive(Debug, Clone, Deserialize, Default)]
struct CherryTopic {
    id: String,
    #[serde(default)]
    messages: Vec<CherryMessage>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct CherryMessage {
    id: String,
    role: Option<String>,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    blocks: Vec<String>,
    #[serde(default)]
    model_id: Option<String>,
    #[serde(default)]
    model: Option<CherryMessageModel>,
    #[serde(default)]
    usage: Option<CherryUsage>,
    #[serde(default)]
    metrics: Option<CherryMetrics>,
}

#[derive(Debug, Clone, Deserialize, Default)]
struct CherryMessageModel {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    provider: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
struct CherryUsage {
    prompt_tokens: Option<i64>,
    completion_tokens: Option<i64>,
    total_tokens: Option<i64>,
}

#[derive(Debug, Clone, Deserialize, Default)]
struct CherryMetrics {
    time_first_token_millsec: Option<i64>,
    time_completion_millsec: Option<i64>,
    completion_tokens: Option<i64>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct CherryMessageBlock {
    id: String,
    message_id: String,
    #[serde(rename = "type")]
    block_type: String,
    #[serde(default)]
    created_at: Option<String>,
    content: Option<Value>,
    #[serde(default)]
    error: Option<Value>,
    #[serde(default)]
    tool_name: Option<String>,
    #[serde(default)]
    tool_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
struct CherryFile {
    id: String,
    name: String,
    #[serde(default)]
    origin_name: Option<String>,
    #[serde(default)]
    ext: Option<String>,
    #[serde(default)]
    size: Option<i64>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct CherryProvider {
    id: String,
    name: Option<String>,
    #[serde(default, rename = "type")]
    provider_type: Option<String>,
    #[serde(default)]
    api_host: Option<String>,
    #[serde(default)]
    api_key: Option<String>,
    #[serde(default)]
    enabled: Option<bool>,
    #[serde(default)]
    models: Vec<CherryProviderModel>,
}

#[derive(Debug, Clone, Deserialize, Default)]
struct CherryProviderModel {
    id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    group: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct CherryAssistant {
    #[serde(default)]
    prompt: Option<String>,
    #[serde(default)]
    topics: Vec<CherryAssistantTopic>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct CherryAssistantTopic {
    id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    updated_at: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct TopicMeta {
    name: Option<String>,
    system_prompt: Option<String>,
    created_at: Option<i64>,
    updated_at: Option<i64>,
}

#[derive(Debug, Clone)]
struct ImportedFile {
    id: String,
    original_name: String,
    mime_type: String,
    size_bytes: i64,
    storage_path: String,
}

pub async fn scan_cherry_studio_import_from_path(
    db: &DatabaseConnection,
    path: &Path,
) -> Result<CherryStudioImportSummary> {
    let parsed = parse_cherry_backup(path)?;
    summarize_backup(db, &parsed.backup, &parsed.warnings).await
}

pub async fn import_cherry_studio_backup_from_path(
    db: &DatabaseConnection,
    master_key: &[u8; 32],
    path: &Path,
    options: CherryStudioImportOptions,
) -> Result<CherryStudioImportResult> {
    import_cherry_studio_backup_from_path_with_root(
        db,
        master_key,
        path,
        options,
        &crate::storage_paths::documents_root(),
    )
    .await
}

pub async fn import_cherry_studio_backup_from_path_with_root(
    db: &DatabaseConnection,
    master_key: &[u8; 32],
    path: &Path,
    options: CherryStudioImportOptions,
    documents_root: &Path,
) -> Result<CherryStudioImportResult> {
    let parsed = parse_cherry_backup(path)?;
    let backup = parsed.backup;
    let mut result = CherryStudioImportResult {
        warnings: parsed.warnings,
        ..Default::default()
    };

    let topic_meta = collect_topic_meta(&backup);
    let block_map = block_map(&backup.indexed_db.message_blocks);
    let used_provider_ids = referenced_provider_ids(&backup);
    let mut provider_map = HashMap::new();
    let settings = get_settings(db).await.unwrap_or_default();
    let fallback_provider_id = settings
        .default_provider_id
        .clone()
        .unwrap_or_else(|| "cherry-studio".to_string());
    let fallback_model_id = settings
        .default_model_id
        .clone()
        .unwrap_or_else(|| "unknown-model".to_string());
    let file_store = FileStore::with_root(documents_root.to_path_buf());
    let _file_reference_guard = crate::repo::stored_file::lock_file_references().await;
    let txn = db.begin().await?;
    let mut created_paths = Vec::new();
    let operation = async {
        if options.import_provider_keys {
            for provider in cherry_providers(&backup)? {
                if !used_provider_ids.contains(&provider.id) {
                    continue;
                }
                match import_provider(&txn, master_key, &provider).await {
                    Ok(Some(imported_id)) => {
                        provider_map.insert(provider.id.clone(), imported_id);
                        result.imported_provider_count += 1;
                    }
                    Ok(None) => {}
                    Err(error) => result.warnings.push(warning(
                        "provider_import_failed",
                        format!(
                            "Failed to import Cherry Studio provider {}: {error}",
                            provider.id
                        ),
                        Some(provider.id.clone()),
                    )),
                }
            }
        }

        let imported_files = import_files(
            &txn,
            &file_store,
            path,
            &backup,
            &mut result,
            &mut created_paths,
        )
        .await?;

        for topic in backup.indexed_db.topics.iter() {
            if topic.messages.is_empty() {
                continue;
            }
            if conversations::Entity::find_by_id(&topic.id)
                .one(&txn)
                .await?
                .is_some()
            {
                result.skipped_duplicate_conversation_count += 1;
                continue;
            }

            let meta = topic_meta.get(&topic.id).cloned().unwrap_or_default();
            let first_message = topic.messages.first();
            let source_provider_id = first_message
                .and_then(|message| message.model.as_ref())
                .and_then(|model| model.provider.as_ref())
                .cloned();
            let imported_provider_id = source_provider_id
                .as_ref()
                .and_then(|source_id| provider_map.get(source_id))
                .cloned();
            let use_cherry_model = imported_provider_id.is_some();
            let provider_id = imported_provider_id.unwrap_or_else(|| fallback_provider_id.clone());
            let model_id = if use_cherry_model {
                first_message
                    .and_then(|message| {
                        message
                            .model_id
                            .clone()
                            .or_else(|| message.model.as_ref()?.id.clone())
                    })
                    .unwrap_or_else(|| fallback_model_id.clone())
            } else {
                fallback_model_id.clone()
            };
            let created_at = meta
                .created_at
                .or_else(|| {
                    first_message
                        .and_then(|message| parse_cherry_ts_opt(message.created_at.as_deref()))
                })
                .unwrap_or_else(now_ts);
            let updated_at = meta.updated_at.unwrap_or_else(|| {
                topic
                    .messages
                    .iter()
                    .filter_map(|message| parse_cherry_ts_opt(message.created_at.as_deref()))
                    .max()
                    .unwrap_or(created_at)
            });
            let title = meta
                .name
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| "Cherry Studio Chat".to_string());

            conversations::ActiveModel {
                id: Set(topic.id.clone()),
                title: Set(title),
                model_id: Set(model_id.clone()),
                provider_id: Set(provider_id.clone()),
                system_prompt: Set(meta.system_prompt.filter(|value| !value.trim().is_empty())),
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
                message_count: Set(topic.messages.len() as i32),
                created_at: Set(created_at),
                updated_at: Set(updated_at),
                is_pinned: Set(0),
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

            let mut previous_message_id: Option<String> = None;
            for message in &topic.messages {
                if messages::Entity::find_by_id(&message.id)
                    .one(&txn)
                    .await?
                    .is_some()
                {
                    continue;
                }
                let materialized = materialize_message(
                    message,
                    ordered_blocks(
                        message,
                        block_map.get(&message.id).cloned().unwrap_or_default(),
                    ),
                    &imported_files,
                    &provider_map,
                    &provider_id,
                    &model_id,
                    &mut result.warnings,
                );
                messages::ActiveModel {
                    id: Set(message.id.clone()),
                    conversation_id: Set(topic.id.clone()),
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
                                "Failed to serialize Cherry attachments: {e}"
                            ))
                        },
                    )?),
                    thinking: Set(materialized.thinking),
                    created_at: Set(materialized.created_at),
                    branch_id: Set(None),
                    parent_message_id: Set(previous_message_id.clone()),
                    version_index: Set(0),
                    is_active: Set(1),
                    tool_calls_json: Set(None),
                    tool_call_id: Set(None),
                    status: Set(materialized.status),
                    tokens_per_second: Set(materialized.tokens_per_second),
                    first_token_latency_ms: Set(materialized.first_token_latency_ms),
                }
                .insert(&txn)
                .await?;
                previous_message_id = Some(message.id.clone());
                result.imported_message_count += 1;
            }
        }

        import_jobs::ActiveModel {
            id: Set(gen_id()),
            source_type: Set("cherry_studio".to_string()),
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

struct ParsedBackup {
    backup: CherryBackup,
    warnings: Vec<CherryStudioImportWarning>,
}

fn parse_cherry_backup(path: &Path) -> Result<ParsedBackup> {
    let bytes = if path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("zip"))
    {
        read_data_json_from_zip(path)?
    } else {
        std::fs::read(path)?
    };
    let backup = serde_json::from_slice::<CherryBackup>(&bytes).map_err(|e| {
        AQBotError::Validation(format!("Invalid Cherry Studio backup data.json: {e}"))
    })?;
    let mut warnings = Vec::new();
    collect_block_warnings(&backup, &mut warnings);
    Ok(ParsedBackup { backup, warnings })
}

fn read_data_json_from_zip(path: &Path) -> Result<Vec<u8>> {
    let file = File::open(path)?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| AQBotError::Validation(format!("Invalid Cherry Studio zip backup: {e}")))?;
    let mut entry = archive
        .by_name("data.json")
        .map_err(|_| AQBotError::Validation("Cherry Studio backup is missing data.json".into()))?;
    let mut data = Vec::new();
    entry.read_to_end(&mut data)?;
    Ok(data)
}

async fn summarize_backup(
    db: &DatabaseConnection,
    backup: &CherryBackup,
    base_warnings: &[CherryStudioImportWarning],
) -> Result<CherryStudioImportSummary> {
    let mut summary = CherryStudioImportSummary {
        file_count: backup.indexed_db.files.len() as u32,
        warnings: base_warnings.to_vec(),
        ..Default::default()
    };

    for topic in &backup.indexed_db.topics {
        if topic.messages.is_empty() {
            summary.skipped_empty_topic_count += 1;
            continue;
        }
        summary.conversation_count += 1;
        summary.message_count += topic.messages.len() as u32;
        if conversations::Entity::find_by_id(&topic.id)
            .one(db)
            .await?
            .is_some()
        {
            summary.duplicate_conversation_count += 1;
        }
    }

    let referenced = referenced_provider_ids(backup);
    summary.importable_provider_count = cherry_providers(backup)?
        .into_iter()
        .filter(|provider| referenced.contains(&provider.id))
        .filter(|provider| provider.api_key.as_deref().is_some_and(is_importable_key))
        .count() as u32;

    Ok(summary)
}

fn collect_block_warnings(backup: &CherryBackup, warnings: &mut Vec<CherryStudioImportWarning>) {
    let mut seen = HashSet::new();
    for block in &backup.indexed_db.message_blocks {
        if matches!(
            block.block_type.as_str(),
            "main_text" | "thinking" | "error"
        ) {
            continue;
        }
        if seen.insert(block.block_type.clone()) {
            warnings.push(warning(
                "unsupported_block_type",
                format!(
                    "Cherry Studio block type '{}' will be preserved as readable Markdown.",
                    block.block_type
                ),
                Some(block.id.clone()),
            ));
        }
    }
}

fn collect_topic_meta(backup: &CherryBackup) -> HashMap<String, TopicMeta> {
    let mut map = HashMap::new();
    let Some(assistants_value) = parse_persist_section(backup, "assistants") else {
        return map;
    };

    if let Some(default_assistant) = assistants_value
        .get("defaultAssistant")
        .and_then(|value| serde_json::from_value::<CherryAssistant>(value.clone()).ok())
    {
        collect_assistant_topics(default_assistant, &mut map);
    }

    if let Some(assistants) = assistants_value.get("assistants").and_then(Value::as_array) {
        for assistant_value in assistants {
            if let Ok(assistant) =
                serde_json::from_value::<CherryAssistant>(assistant_value.clone())
            {
                collect_assistant_topics(assistant, &mut map);
            }
        }
    }
    map
}

fn collect_assistant_topics(assistant: CherryAssistant, map: &mut HashMap<String, TopicMeta>) {
    for topic in assistant.topics {
        let entry = map.entry(topic.id.clone()).or_default();
        if entry.name.is_none() {
            entry.name = topic.name;
        }
        if entry.system_prompt.is_none() {
            entry.system_prompt = assistant.prompt.clone();
        }
        if entry.created_at.is_none() {
            entry.created_at = parse_cherry_ts_opt(topic.created_at.as_deref());
        }
        if entry.updated_at.is_none() {
            entry.updated_at = parse_cherry_ts_opt(topic.updated_at.as_deref());
        }
    }
}

fn block_map(blocks: &[CherryMessageBlock]) -> HashMap<String, Vec<&CherryMessageBlock>> {
    let mut map: HashMap<String, Vec<&CherryMessageBlock>> = HashMap::new();
    for block in blocks {
        map.entry(block.message_id.clone()).or_default().push(block);
    }
    for values in map.values_mut() {
        values.sort_by_key(|block| parse_cherry_ts_opt(block.created_at.as_deref()).unwrap_or(0));
    }
    map
}

fn ordered_blocks<'a>(
    message: &CherryMessage,
    fallback_blocks: Vec<&'a CherryMessageBlock>,
) -> Vec<&'a CherryMessageBlock> {
    if message.blocks.is_empty() {
        return fallback_blocks;
    }
    let by_id: HashMap<&str, &'a CherryMessageBlock> = fallback_blocks
        .iter()
        .map(|block| (block.id.as_str(), *block))
        .collect();
    let mut ordered = Vec::new();
    for block_id in &message.blocks {
        if let Some(block) = by_id.get(block_id.as_str()) {
            ordered.push(*block);
        }
    }
    if ordered.is_empty() {
        fallback_blocks
    } else {
        ordered
    }
}

fn referenced_provider_ids(backup: &CherryBackup) -> HashSet<String> {
    let mut ids = HashSet::new();
    for topic in &backup.indexed_db.topics {
        for message in &topic.messages {
            if let Some(provider_id) = message
                .model
                .as_ref()
                .and_then(|model| model.provider.clone())
            {
                ids.insert(provider_id);
            }
        }
    }
    ids
}

fn cherry_providers(backup: &CherryBackup) -> Result<Vec<CherryProvider>> {
    let Some(llm) = parse_persist_section(backup, "llm") else {
        return Ok(Vec::new());
    };
    let providers = llm
        .get("providers")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|value| serde_json::from_value::<CherryProvider>(value.clone()).ok())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok(providers)
}

fn parse_persist_section(backup: &CherryBackup, key: &str) -> Option<Value> {
    let root = backup.local_storage.get("persist:cherry-studio")?;
    let root = match root {
        Value::String(raw) => serde_json::from_str::<Value>(raw).ok()?,
        value => value.clone(),
    };
    let section = root.get(key)?;
    match section {
        Value::String(raw) => serde_json::from_str::<Value>(raw).ok(),
        value => Some(value.clone()),
    }
}

async fn import_provider<C>(
    db: &C,
    master_key: &[u8; 32],
    provider: &CherryProvider,
) -> Result<Option<String>>
where
    C: ConnectionTrait,
{
    let raw_key = provider.api_key.as_deref().unwrap_or("").trim();
    if !is_importable_key(raw_key) {
        return Ok(None);
    }
    let provider_type = map_provider_type(provider.provider_type.as_deref());
    let api_host = provider.api_host.as_deref().unwrap_or("").trim();
    if api_host.is_empty() {
        return Ok(None);
    }
    let (api_host, api_path) = split_api_url(api_host);
    let name = provider
        .name
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| provider.id.clone());

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
                enabled: Set(if provider.enabled.unwrap_or(true) {
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

    let encrypted = encrypt_key(raw_key, master_key)?;
    let existing_keys = provider_keys::Entity::find()
        .filter(provider_keys::Column::ProviderId.eq(&provider_id))
        .all(db)
        .await?;
    let key_exists = existing_keys.iter().any(|key| {
        decrypt_key(&key.key_encrypted, master_key)
            .map(|value| value == raw_key)
            .unwrap_or(false)
    });
    if !key_exists {
        let rotation_index = existing_keys
            .iter()
            .map(|key| key.rotation_index)
            .max()
            .unwrap_or(-1)
            + 1;
        provider_keys::ActiveModel {
            id: Set(gen_id()),
            provider_id: Set(provider_id.clone()),
            key_encrypted: Set(encrypted),
            key_prefix: Set(key_prefix(raw_key)),
            enabled: Set(1),
            last_validated_at: Set(None),
            last_error: Set(None),
            rotation_index: Set(rotation_index),
            created_at: Set(now_ts()),
        }
        .insert(db)
        .await?;
    }

    for model in &provider.models {
        if model.id.trim().is_empty() {
            continue;
        }
        let model_type = ModelType::detect(&model.id);
        models::Entity::insert(models::ActiveModel {
            provider_id: Set(provider_id.clone()),
            model_id: Set(model.id.clone()),
            name: Set(model.name.clone().unwrap_or_else(|| model.id.clone())),
            group_name: Set(model.group.clone()),
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

async fn import_files<C>(
    db: &C,
    file_store: &FileStore,
    backup_path: &Path,
    backup: &CherryBackup,
    result: &mut CherryStudioImportResult,
    created_paths: &mut Vec<String>,
) -> Result<Vec<ImportedFile>>
where
    C: ConnectionTrait,
{
    let zip_path = backup_path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("zip"))
        .then_some(backup_path.to_path_buf());
    let mut archive = match zip_path {
        Some(path) => Some(zip::ZipArchive::new(File::open(path)?).map_err(|e| {
            AQBotError::Validation(format!("Invalid Cherry Studio zip backup: {e}"))
        })?),
        None => None,
    };

    let mut imported = Vec::new();
    for file in &backup.indexed_db.files {
        if stored_files::Entity::find_by_id(&file.id)
            .one(db)
            .await?
            .is_some()
        {
            continue;
        }
        let mut bytes = Vec::new();
        if let Some(archive) = archive.as_mut() {
            let name = format!("Data/Files/{}", file.name);
            match archive.by_name(&name) {
                Ok(mut entry) => {
                    entry.read_to_end(&mut bytes)?;
                }
                Err(_) => {
                    result.warnings.push(warning(
                        "missing_file",
                        format!(
                            "Cherry Studio attachment '{}' is missing from the backup.",
                            file.name
                        ),
                        Some(file.id.clone()),
                    ));
                    continue;
                }
            }
        } else {
            result.warnings.push(warning(
                "missing_file",
                format!(
                    "Cherry Studio attachment '{}' is only available in zip backups.",
                    file.name
                ),
                Some(file.id.clone()),
            ));
            continue;
        }

        let original_name = file
            .origin_name
            .clone()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| file.name.clone());
        let mime_type = mime_from_name(&original_name, file.ext.as_deref());
        let saved = file_store.save_file(&bytes, &original_name, &mime_type)?;
        if saved.created {
            created_paths.push(saved.storage_path.clone());
        }
        let size_bytes = file.size.unwrap_or(saved.size_bytes).max(0);
        stored_files::ActiveModel {
            id: Set(file.id.clone()),
            hash: Set(saved.hash),
            original_name: Set(original_name.clone()),
            mime_type: Set(mime_type.clone()),
            size_bytes: Set(size_bytes),
            storage_path: Set(saved.storage_path.clone()),
            conversation_id: Set(None),
            created_at: Default::default(),
        }
        .insert(db)
        .await?;
        imported.push(ImportedFile {
            id: file.id.clone(),
            original_name,
            mime_type,
            size_bytes,
            storage_path: saved.storage_path,
        });
        result.imported_file_count += 1;
    }
    Ok(imported)
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
    status: String,
    tokens_per_second: Option<f64>,
    first_token_latency_ms: Option<i64>,
}

fn materialize_message(
    message: &CherryMessage,
    blocks: Vec<&CherryMessageBlock>,
    files: &[ImportedFile],
    provider_map: &HashMap<String, String>,
    fallback_provider_id: &str,
    fallback_model_id: &str,
    warnings: &mut Vec<CherryStudioImportWarning>,
) -> MaterializedMessage {
    let mut content_parts = Vec::new();
    let mut thinking_parts = Vec::new();
    let mut has_error = message.status.as_deref() == Some("error");

    for block in blocks {
        match block.block_type.as_str() {
            "main_text" => {
                if let Some(text) = value_to_string(block.content.as_ref()) {
                    if !text.is_empty() {
                        content_parts.push(text);
                    }
                }
            }
            "thinking" => {
                if let Some(text) = value_to_string(block.content.as_ref()) {
                    if !text.is_empty() {
                        thinking_parts.push(text);
                    }
                }
            }
            "error" => {
                has_error = true;
                let text = block
                    .error
                    .as_ref()
                    .and_then(extract_error_message)
                    .unwrap_or_else(|| "Cherry Studio message failed".to_string());
                content_parts.push(text);
            }
            other => {
                warnings.push(warning(
                    "unsupported_block_type",
                    format!("Cherry Studio block type '{other}' was preserved as Markdown."),
                    Some(block.id.clone()),
                ));
                content_parts.push(format_block_as_markdown(block));
            }
        }
    }

    let source_provider_id = message
        .model
        .as_ref()
        .and_then(|model| model.provider.as_ref())
        .cloned();
    let imported_provider_id = source_provider_id
        .as_ref()
        .and_then(|source_id| provider_map.get(source_id))
        .cloned();
    let use_cherry_model = imported_provider_id.is_some();
    let provider_id = imported_provider_id.unwrap_or_else(|| fallback_provider_id.to_string());
    let model_id = if use_cherry_model {
        message
            .model_id
            .clone()
            .or_else(|| message.model.as_ref().and_then(|model| model.id.clone()))
            .unwrap_or_else(|| fallback_model_id.to_string())
    } else {
        fallback_model_id.to_string()
    };
    let prompt_tokens = message.usage.as_ref().and_then(|usage| usage.prompt_tokens);
    let completion_tokens = message
        .usage
        .as_ref()
        .and_then(|usage| usage.completion_tokens);
    let token_count = message
        .usage
        .as_ref()
        .and_then(|usage| usage.total_tokens)
        .or_else(|| prompt_tokens.zip(completion_tokens).map(|(p, c)| p + c));
    let tokens_per_second = message.metrics.as_ref().and_then(|metrics| {
        let completion = metrics.completion_tokens.or(completion_tokens)? as f64;
        let elapsed_ms = metrics.time_completion_millsec? as f64;
        (elapsed_ms > 0.0).then_some(completion / (elapsed_ms / 1000.0))
    });
    let searchable_message = format!("{message:?}");
    let attachments = files
        .iter()
        .filter(|file| {
            searchable_message.contains(&file.id)
                || searchable_message.contains(&file.original_name)
        })
        .map(|file| Attachment {
            id: file.id.clone(),
            file_type: file.mime_type.clone(),
            file_name: file.original_name.clone(),
            file_path: file.storage_path.clone(),
            file_size: file.size_bytes.max(0) as u64,
            data: None,
        })
        .collect();

    MaterializedMessage {
        role: map_message_role(message.role.as_deref()),
        content: content_parts.join("\n\n"),
        provider_id,
        model_id,
        token_count,
        prompt_tokens,
        completion_tokens,
        attachments,
        thinking: (!thinking_parts.is_empty()).then(|| thinking_parts.join("\n\n")),
        created_at: parse_cherry_ts_opt(message.created_at.as_deref()).unwrap_or_else(now_ts),
        status: if has_error { "error" } else { "complete" }.to_string(),
        tokens_per_second,
        first_token_latency_ms: message
            .metrics
            .as_ref()
            .and_then(|metrics| metrics.time_first_token_millsec),
    }
}

fn format_block_as_markdown(block: &CherryMessageBlock) -> String {
    let title = block
        .tool_name
        .as_deref()
        .or(block.tool_id.as_deref())
        .unwrap_or(block.block_type.as_str());
    let payload = block
        .content
        .as_ref()
        .map(|value| serde_json::to_string(value).unwrap_or_else(|_| value.to_string()))
        .unwrap_or_default();
    format!(
        "### Cherry Studio {} block: {}\n```json\n{}\n```",
        block.block_type, title, payload
    )
}

fn value_to_string(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(text) => Some(text.clone()),
        Value::Null => None,
        other => Some(other.to_string()),
    }
}

fn extract_error_message(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Object(map) => map
            .get("message")
            .and_then(Value::as_str)
            .or_else(|| map.get("error").and_then(Value::as_str))
            .map(str::to_string)
            .or_else(|| Some(value.to_string())),
        _ => Some(value.to_string()),
    }
}

fn map_message_role(role: Option<&str>) -> String {
    match role {
        Some("system") => "system".to_string(),
        Some("user") => "user".to_string(),
        Some("tool") => "tool".to_string(),
        _ => "assistant".to_string(),
    }
}

fn map_provider_type(value: Option<&str>) -> ProviderType {
    match value.unwrap_or("").trim() {
        "openai-response" | "openai_responses" | "openai-responses" => {
            ProviderType::OpenAIResponses
        }
        "anthropic" => ProviderType::Anthropic,
        "gemini" => ProviderType::Gemini,
        "openai" => ProviderType::OpenAI,
        _ => ProviderType::Custom,
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

fn parse_cherry_ts_opt(value: Option<&str>) -> Option<i64> {
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

fn warning(
    code: impl Into<String>,
    message: impl Into<String>,
    source_id: Option<String>,
) -> CherryStudioImportWarning {
    CherryStudioImportWarning {
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
    use crate::repo::provider;
    use crate::types::ProviderType;
    use sea_orm::{ColumnTrait, ConnectionTrait, DbBackend, EntityTrait, QueryFilter, Statement};
    use serde_json::json;
    use std::fs::File;
    use std::io::Write;
    use std::path::{Path, PathBuf};
    use tempfile::tempdir;
    use zip::write::SimpleFileOptions;

    fn write_cherry_zip(path: &Path, data: serde_json::Value, files: &[(&str, &[u8])]) {
        let file = File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = SimpleFileOptions::default();
        zip.start_file("data.json", options).unwrap();
        zip.write_all(serde_json::to_string(&data).unwrap().as_bytes())
            .unwrap();
        for (name, bytes) in files {
            zip.start_file(format!("Data/Files/{name}"), options)
                .unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.finish().unwrap();
    }

    fn encoded_persist(value: serde_json::Value) -> String {
        serde_json::to_string(&value).unwrap()
    }

    fn sample_backup_json() -> serde_json::Value {
        json!({
            "version": 3,
            "time": 1780000000000i64,
            "localStorage": {
                "persist:cherry-studio": encoded_persist(json!({
                    "assistants": encoded_persist(json!({
                        "defaultAssistant": {
                            "id": "default",
                            "name": "Default Assistant",
                            "prompt": "system prompt",
                            "topics": [{
                                "id": "topic-1",
                                "assistantId": "default",
                                "name": "Imported topic",
                                "createdAt": "2026-05-28T01:02:03.000Z",
                                "updatedAt": "2026-05-28T01:04:05.000Z",
                                "messages": []
                            }]
                        },
                        "assistants": []
                    })),
                    "llm": encoded_persist(json!({
                        "providers": [{
                            "id": "prov-openai",
                            "name": "Cherry OpenAI",
                            "type": "openai",
                            "enabled": true,
                            "apiHost": "https://api.example.com/v1",
                            "apiKey": "sk-cherry",
                            "models": [{
                                "id": "gpt-4o",
                                "name": "GPT-4o",
                                "provider": "prov-openai",
                                "group": "OpenAI"
                            }]
                        }],
                        "defaultModel": {
                            "id": "gpt-4o",
                            "provider": "prov-openai"
                        }
                    }))
                }))
            },
            "indexedDB": {
                "topics": [{
                    "id": "topic-1",
                    "messages": [
                        {
                            "id": "msg-user-1",
                            "role": "user",
                            "topicId": "topic-1",
                            "createdAt": "2026-05-28T01:02:03.000Z",
                            "status": "success",
                            "blocks": ["block-user-1"],
                            "modelId": "gpt-4o",
                            "model": {"id": "gpt-4o", "provider": "prov-openai", "name": "GPT-4o"},
                            "usage": {"prompt_tokens": 2, "completion_tokens": 3, "total_tokens": 5}
                        },
                        {
                            "id": "msg-assistant-1",
                            "role": "assistant",
                            "topicId": "topic-1",
                            "createdAt": "2026-05-28T01:03:03.000Z",
                            "status": "success",
                            "blocks": ["block-thinking-1", "block-assistant-1", "block-tool-1"],
                            "modelId": "gpt-4o",
                            "model": {"id": "gpt-4o", "provider": "prov-openai", "name": "GPT-4o"},
                            "usage": {"prompt_tokens": 7, "completion_tokens": 11, "total_tokens": 18},
                            "metrics": {"time_first_token_millsec": 123, "time_completion_millsec": 2000, "completion_tokens": 11}
                        },
                        {
                            "id": "msg-error-1",
                            "role": "assistant",
                            "topicId": "topic-1",
                            "createdAt": "2026-05-28T01:04:03.000Z",
                            "status": "error",
                            "blocks": ["block-error-1"],
                            "modelId": "gpt-4o",
                            "model": {"id": "gpt-4o", "provider": "prov-openai", "name": "GPT-4o"}
                        }
                    ]
                }],
                "message_blocks": [
                    {
                        "id": "block-user-1",
                        "messageId": "msg-user-1",
                        "type": "main_text",
                        "status": "success",
                        "createdAt": "2026-05-28T01:02:03.000Z",
                        "content": "hello"
                    },
                    {
                        "id": "block-thinking-1",
                        "messageId": "msg-assistant-1",
                        "type": "thinking",
                        "status": "success",
                        "createdAt": "2026-05-28T01:03:03.000Z",
                        "content": "think step"
                    },
                    {
                        "id": "block-assistant-1",
                        "messageId": "msg-assistant-1",
                        "type": "main_text",
                        "status": "success",
                        "createdAt": "2026-05-28T01:03:04.000Z",
                        "content": "world"
                    },
                    {
                        "id": "block-tool-1",
                        "messageId": "msg-assistant-1",
                        "type": "tool",
                        "status": "success",
                        "createdAt": "2026-05-28T01:03:05.000Z",
                        "toolName": "fetch_html",
                        "toolId": "tool-1",
                        "content": {"ok": true}
                    },
                    {
                        "id": "block-error-1",
                        "messageId": "msg-error-1",
                        "type": "error",
                        "status": "success",
                        "createdAt": "2026-05-28T01:04:03.000Z",
                        "error": {"message": "upstream failed"}
                    }
                ],
                "files": [{
                    "id": "file-1",
                    "name": "file-1.pdf",
                    "origin_name": "source.pdf",
                    "path": "/Users/test/Library/Application Support/CherryStudio/Data/Files/file-1.pdf",
                    "type": "document",
                    "ext": ".pdf",
                    "size": 7
                }],
                "settings": [],
                "knowledge_notes": [],
                "translate_history": [],
                "quick_phrases": []
            }
        })
    }

    #[tokio::test]
    async fn scan_cherry_studio_zip_summarizes_importable_data() {
        let dir = tempdir().unwrap();
        let zip_path = dir.path().join("cherry.zip");
        write_cherry_zip(
            &zip_path,
            sample_backup_json(),
            &[("file-1.pdf", b"pdfdata")],
        );
        let db = create_test_pool().await.unwrap();

        let summary = scan_cherry_studio_import_from_path(&db.conn, &zip_path)
            .await
            .unwrap();

        assert_eq!(summary.conversation_count, 1);
        assert_eq!(summary.message_count, 3);
        assert_eq!(summary.file_count, 1);
        assert_eq!(summary.importable_provider_count, 1);
        assert_eq!(summary.skipped_empty_topic_count, 0);
        assert!(summary.duplicate_conversation_count == 0);
        assert!(summary
            .warnings
            .iter()
            .any(|warning| warning.code == "unsupported_block_type"));
    }

    #[tokio::test]
    async fn import_cherry_studio_zip_materializes_readable_history_files_and_providers() {
        let dir = tempdir().unwrap();
        let zip_path = dir.path().join("cherry.zip");
        let docs_root = dir.path().join("aqbot-docs");
        write_cherry_zip(
            &zip_path,
            sample_backup_json(),
            &[("file-1.pdf", b"pdfdata")],
        );
        let db = create_test_pool().await.unwrap();
        let master_key = [8u8; 32];

        let result = import_cherry_studio_backup_from_path_with_root(
            &db.conn,
            &master_key,
            &zip_path,
            CherryStudioImportOptions {
                import_provider_keys: true,
            },
            &docs_root,
        )
        .await
        .unwrap();

        assert_eq!(result.imported_conversation_count, 1);
        assert_eq!(result.imported_message_count, 3);
        assert_eq!(result.imported_file_count, 1);
        assert_eq!(result.imported_provider_count, 1);

        let conversation = conversations::Entity::find_by_id("topic-1")
            .one(&db.conn)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(conversation.title, "Imported topic");
        assert_eq!(conversation.system_prompt.as_deref(), Some("system prompt"));
        assert_eq!(conversation.message_count, 3);

        let imported_messages = messages::Entity::find()
            .filter(messages::Column::ConversationId.eq("topic-1"))
            .all(&db.conn)
            .await
            .unwrap();
        assert_eq!(imported_messages.len(), 3);
        let assistant = imported_messages
            .iter()
            .find(|message| message.id == "msg-assistant-1")
            .unwrap();
        assert_eq!(
            assistant.content,
            "world\n\n### Cherry Studio tool block: fetch_html\n```json\n{\"ok\":true}\n```"
        );
        assert_eq!(assistant.thinking.as_deref(), Some("think step"));
        assert_eq!(assistant.prompt_tokens, Some(7));
        assert_eq!(assistant.completion_tokens, Some(11));
        assert_eq!(assistant.token_count, Some(18));
        assert_eq!(assistant.first_token_latency_ms, Some(123));
        assert_eq!(assistant.status, "complete");

        let error = imported_messages
            .iter()
            .find(|message| message.id == "msg-error-1")
            .unwrap();
        assert_eq!(error.status, "error");
        assert!(error.content.contains("upstream failed"));

        let stored = stored_files::Entity::find()
            .filter(stored_files::Column::OriginalName.eq("source.pdf"))
            .one(&db.conn)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(stored.conversation_id.as_deref(), None);
        assert!(docs_root.join(&stored.storage_path).exists());
        assert!(stored.storage_path.starts_with("files/"));

        let providers = provider::list_providers(&db.conn).await.unwrap();
        let imported_provider = providers
            .iter()
            .find(|provider| provider.name == "Cherry OpenAI")
            .unwrap();
        assert_eq!(imported_provider.provider_type, ProviderType::OpenAI);
        assert_eq!(imported_provider.api_host, "https://api.example.com");
        assert_eq!(imported_provider.api_path.as_deref(), Some("/v1"));
        assert!(imported_provider
            .models
            .iter()
            .any(|model| model.model_id == "gpt-4o"));
        assert_eq!(
            decrypt_key(
                &imported_provider.keys.first().unwrap().key_encrypted,
                &master_key,
            )
            .unwrap(),
            "sk-cherry",
        );

        let duplicate = import_cherry_studio_backup_from_path_with_root(
            &db.conn,
            &master_key,
            &zip_path,
            CherryStudioImportOptions {
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
        let zip_path = dir.path().join("cherry.zip");
        let docs_root = dir.path().join("aqbot-docs");
        write_cherry_zip(
            &zip_path,
            sample_backup_json(),
            &[("file-1.pdf", b"pdfdata")],
        );
        let db = create_test_pool().await.unwrap();
        db.conn
            .execute(Statement::from_string(
                DbBackend::Sqlite,
                "CREATE TRIGGER fail_cherry_conversation BEFORE INSERT ON conversations \
                 BEGIN SELECT RAISE(ABORT, 'forced conversation insert failure'); END"
                    .to_string(),
            ))
            .await
            .unwrap();

        let result = import_cherry_studio_backup_from_path_with_root(
            &db.conn,
            &[8u8; 32],
            &zip_path,
            CherryStudioImportOptions {
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
        let hash = FileStore::hash_bytes(b"pdfdata");
        let path =
            crate::storage_paths::build_relative_path("source.pdf", "application/pdf", &hash);
        assert!(!docs_root.join(path).exists());
    }

    #[tokio::test]
    async fn import_cherry_studio_provider_keys_is_opt_in() {
        let dir = tempdir().unwrap();
        let zip_path = dir.path().join("cherry.zip");
        write_cherry_zip(&zip_path, sample_backup_json(), &[]);
        let db = create_test_pool().await.unwrap();

        let result = import_cherry_studio_backup_from_path_with_root(
            &db.conn,
            &[9u8; 32],
            &zip_path,
            CherryStudioImportOptions {
                import_provider_keys: false,
            },
            &dir.path().join("docs"),
        )
        .await
        .unwrap();

        assert_eq!(result.imported_conversation_count, 1);
        assert_eq!(result.imported_provider_count, 0);
        assert!(provider::list_providers(&db.conn).await.unwrap().is_empty());

        let conversation = conversations::Entity::find_by_id("topic-1")
            .one(&db.conn)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(conversation.provider_id, "cherry-studio");
        assert_eq!(conversation.model_id, "unknown-model");

        let message = messages::Entity::find_by_id("msg-user-1")
            .one(&db.conn)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(message.provider_id.as_deref(), Some("cherry-studio"));
        assert_eq!(message.model_id.as_deref(), Some("unknown-model"));
    }

    #[tokio::test]
    async fn scan_rejects_backups_without_data_json() {
        let dir = tempdir().unwrap();
        let zip_path = dir.path().join("bad.zip");
        let file = File::create(&zip_path).unwrap();
        zip::ZipWriter::new(file).finish().unwrap();
        let db = create_test_pool().await.unwrap();

        let err = scan_cherry_studio_import_from_path(&db.conn, &zip_path)
            .await
            .unwrap_err();

        assert!(err.to_string().contains("data.json"));
    }

    #[tokio::test]
    #[ignore = "set CHERRY_STUDIO_IMPORT_SMOKE_PATH to scan/import a local Cherry Studio backup"]
    async fn smoke_real_cherry_studio_backup_from_env() {
        let backup_path = PathBuf::from(
            std::env::var("CHERRY_STUDIO_IMPORT_SMOKE_PATH")
                .expect("CHERRY_STUDIO_IMPORT_SMOKE_PATH is required"),
        );
        let dir = tempdir().unwrap();
        let db = create_test_pool().await.unwrap();
        let summary = scan_cherry_studio_import_from_path(&db.conn, &backup_path)
            .await
            .unwrap();

        let result = import_cherry_studio_backup_from_path_with_root(
            &db.conn,
            &[7u8; 32],
            &backup_path,
            CherryStudioImportOptions {
                import_provider_keys: false,
            },
            &dir.path().join("docs"),
        )
        .await
        .unwrap();

        println!("summary: {summary:?}");
        println!("result: {result:?}");
        assert_eq!(
            result.imported_conversation_count,
            summary.conversation_count
        );
        assert_eq!(result.imported_message_count, summary.message_count);
        assert_eq!(result.imported_provider_count, 0);
    }
}
