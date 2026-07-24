use sea_orm::{
    ConnectOptions, ConnectionTrait, Database, DatabaseConnection, DbBackend, QueryResult,
    Statement,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use crate::crypto::{decrypt_key, encrypt_key};
use crate::error::{AQBotError, Result};
use crate::repo::provider;
use crate::types::{
    infer_model_type_and_capabilities, CreateProviderInput, Model, ModelParamOverrides,
    ProviderConfig, ProviderType,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderImportStatus {
    Ready,
    AddKey,
    AlreadyExists,
    Unsupported,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderImportCandidate {
    pub id: String,
    pub source_app: String,
    pub name: String,
    pub provider_type: ProviderType,
    pub api_host: String,
    pub api_path: Option<String>,
    pub key_prefix: String,
    pub models: Vec<String>,
    pub status: ProviderImportStatus,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProviderImportBatchResult {
    pub created_count: u32,
    pub added_key_count: u32,
    pub reused_count: u32,
    pub skipped_count: u32,
    pub provider_ids: Vec<String>,
}

#[derive(Debug, Clone)]
struct RawProviderImportCandidate {
    public: ProviderImportCandidate,
    raw_key: Option<String>,
    unsupported: bool,
}

#[derive(Debug, Clone)]
struct CcSwitchRow {
    id: String,
    name: String,
    source_app: String,
    api_format: Option<String>,
    settings_config: serde_json::Value,
}

pub async fn scan_cc_switch_provider_imports(
    aqbot_db: &DatabaseConnection,
    master_key: &[u8; 32],
) -> Result<Vec<ProviderImportCandidate>> {
    let path = default_cc_switch_db_path()?;
    scan_cc_switch_provider_imports_from_path(aqbot_db, master_key, &path).await
}

pub async fn import_cc_switch_provider_configs(
    aqbot_db: &DatabaseConnection,
    master_key: &[u8; 32],
    candidate_ids: Vec<String>,
) -> Result<ProviderImportBatchResult> {
    let path = default_cc_switch_db_path()?;
    import_cc_switch_provider_configs_from_path(aqbot_db, master_key, &path, candidate_ids).await
}

pub async fn scan_cc_switch_provider_imports_from_path(
    aqbot_db: &DatabaseConnection,
    master_key: &[u8; 32],
    path: &Path,
) -> Result<Vec<ProviderImportCandidate>> {
    let raw = scan_raw_candidates_from_path(aqbot_db, master_key, path).await?;
    Ok(raw.into_iter().map(|candidate| candidate.public).collect())
}

pub async fn import_cc_switch_provider_configs_from_path(
    aqbot_db: &DatabaseConnection,
    master_key: &[u8; 32],
    path: &Path,
    candidate_ids: Vec<String>,
) -> Result<ProviderImportBatchResult> {
    let selected: HashSet<String> = candidate_ids.into_iter().collect();
    let candidates = scan_raw_candidates_from_path(aqbot_db, master_key, path).await?;
    let mut result = ProviderImportBatchResult::default();

    for candidate in candidates {
        if !selected.contains(&candidate.public.id) {
            continue;
        }
        if candidate.unsupported || candidate.public.status == ProviderImportStatus::Unsupported {
            result.skipped_count += 1;
            continue;
        }

        let Some(raw_key) = candidate.raw_key.as_deref() else {
            result.skipped_count += 1;
            continue;
        };

        match import_candidate(aqbot_db, master_key, &candidate.public, raw_key).await? {
            ImportOutcome::Created(provider_id) => {
                result.created_count += 1;
                push_unique(&mut result.provider_ids, provider_id);
            }
            ImportOutcome::AddedKey(provider_id) => {
                result.added_key_count += 1;
                push_unique(&mut result.provider_ids, provider_id);
            }
            ImportOutcome::Reused(provider_id) => {
                result.reused_count += 1;
                push_unique(&mut result.provider_ids, provider_id);
            }
        }
    }

    Ok(result)
}

fn push_unique(values: &mut Vec<String>, value: String) {
    if !values.contains(&value) {
        values.push(value);
    }
}

#[derive(Debug, Clone)]
enum ImportOutcome {
    Created(String),
    AddedKey(String),
    Reused(String),
}

async fn import_candidate(
    db: &DatabaseConnection,
    master_key: &[u8; 32],
    candidate: &ProviderImportCandidate,
    raw_key: &str,
) -> Result<ImportOutcome> {
    let (provider_config, created) = match find_matching_provider(db, candidate).await? {
        Some(existing) => {
            let id = provider::resolve_provider_id(db, &existing.id).await?;
            (provider::get_provider(db, &id).await?, false)
        }
        None => {
            let created = provider::create_provider(
                db,
                CreateProviderInput {
                    name: candidate.name.clone(),
                    provider_type: candidate.provider_type.clone(),
                    api_host: candidate.api_host.clone(),
                    api_path: candidate.api_path.clone(),
                    enabled: true,
                    builtin_id: None,
                },
            )
            .await?;
            (created, true)
        }
    };

    let key_exists = provider_config.keys.iter().any(|key| {
        decrypt_key(&key.key_encrypted, master_key)
            .map(|decrypted| decrypted == raw_key)
            .unwrap_or(false)
    });

    let outcome = if key_exists {
        ImportOutcome::Reused(provider_config.id.clone())
    } else {
        let encrypted = encrypt_key(raw_key, master_key)?;
        provider::add_provider_key(db, &provider_config.id, &encrypted, &key_prefix(raw_key))
            .await?;
        if created {
            ImportOutcome::Created(provider_config.id.clone())
        } else {
            ImportOutcome::AddedKey(provider_config.id.clone())
        }
    };

    merge_candidate_models(db, &provider_config, &candidate.models).await?;
    Ok(outcome)
}

async fn merge_candidate_models(
    db: &DatabaseConnection,
    provider_config: &ProviderConfig,
    model_ids: &[String],
) -> Result<()> {
    if model_ids.is_empty() {
        return Ok(());
    }

    let mut models = provider_config.models.clone();
    let existing_ids: HashSet<String> = models.iter().map(|model| model.model_id.clone()).collect();
    for model_id in model_ids {
        if existing_ids.contains(model_id) {
            continue;
        }
        let (model_type, capabilities) = infer_model_type_and_capabilities(model_id, model_id);
        models.push(Model {
            provider_id: provider_config.id.clone(),
            model_id: model_id.clone(),
            name: model_id.clone(),
            group_name: None,
            capabilities,
            model_type,
            context_window: None,
            max_output_tokens: None,
            enabled: true,
            param_overrides: empty_param_overrides_for_import(&provider_config.provider_type),
            image_config: None,
            metadata_state: None,
        });
    }

    provider::save_models(db, &provider_config.id, &models).await
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
        omit_sampling_params: None,
        force_max_tokens: None,
        thinking_param_style: None,
        reasoning_profile: Some(profile),
        reasoning_options: None,
        reasoning_default: None,
        extra_body: None,
    })
}

async fn scan_raw_candidates_from_path(
    aqbot_db: &DatabaseConnection,
    master_key: &[u8; 32],
    path: &Path,
) -> Result<Vec<RawProviderImportCandidate>> {
    if !path.exists() {
        return Ok(Vec::new());
    }

    let cc_db = connect_readonly_sqlite(path).await?;
    if !table_exists(&cc_db, "providers").await? {
        return Ok(Vec::new());
    }

    let endpoint_map = if table_exists(&cc_db, "provider_endpoints").await? {
        load_endpoint_map(&cc_db).await?
    } else {
        HashMap::new()
    };

    let rows = load_provider_rows(&cc_db).await?;
    let mut candidates = Vec::new();
    let mut seen = HashSet::new();
    for row in rows {
        let raw = row_to_candidate(&row, endpoint_map.get(&row.id));
        let mut public = raw.public;
        if !raw.unsupported {
            public.status =
                classify_candidate(aqbot_db, master_key, &public, raw.raw_key.as_deref()).await?;
        }
        if seen.insert(public.id.clone()) {
            candidates.push(RawProviderImportCandidate {
                public,
                raw_key: raw.raw_key,
                unsupported: raw.unsupported,
            });
        }
    }

    Ok(candidates)
}

async fn connect_readonly_sqlite(path: &Path) -> Result<DatabaseConnection> {
    let url = format!("sqlite:{}?mode=ro", path.display());
    let mut options = ConnectOptions::new(url);
    options.max_connections(1).sqlx_logging(false);
    Database::connect(options)
        .await
        .map_err(AQBotError::Database)
}

async fn table_exists(db: &DatabaseConnection, table: &str) -> Result<bool> {
    let row = db
        .query_one(Statement::from_sql_and_values(
            DbBackend::Sqlite,
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
            [table.into()],
        ))
        .await?;
    Ok(row.is_some())
}

async fn load_provider_rows(db: &DatabaseConnection) -> Result<Vec<CcSwitchRow>> {
    let rows = db
        .query_all(Statement::from_string(
            DbBackend::Sqlite,
            "SELECT * FROM providers".to_string(),
        ))
        .await?;

    let mut result = Vec::new();
    for row in rows {
        let id = get_string(&row, "id").unwrap_or_else(|| hash_id(&["missing-id"]));
        let name = get_string(&row, "name").unwrap_or_else(|| id.clone());
        let source_app = get_string(&row, "app_type")
            .or_else(|| get_string(&row, "app"))
            .or_else(|| get_string(&row, "appType"))
            .unwrap_or_else(|| "unknown".to_string());
        let api_format = get_string(&row, "api_format")
            .or_else(|| get_string(&row, "apiFormat"))
            .or_else(|| get_string(&row, "wire_api"));
        let settings_config = get_string(&row, "settings_config")
            .or_else(|| get_string(&row, "settingsConfig"))
            .and_then(|value| serde_json::from_str(&value).ok())
            .unwrap_or_else(|| serde_json::json!({}));

        result.push(CcSwitchRow {
            id,
            name,
            source_app,
            api_format,
            settings_config,
        });
    }
    Ok(result)
}

async fn load_endpoint_map(db: &DatabaseConnection) -> Result<HashMap<String, String>> {
    let rows = db
        .query_all(Statement::from_string(
            DbBackend::Sqlite,
            "SELECT * FROM provider_endpoints".to_string(),
        ))
        .await?;
    let mut map = HashMap::new();
    for row in rows {
        let Some(provider_id) =
            get_string(&row, "provider_id").or_else(|| get_string(&row, "providerId"))
        else {
            continue;
        };
        let Some(url) = get_string(&row, "url")
            .or_else(|| get_string(&row, "base_url"))
            .or_else(|| get_string(&row, "baseUrl"))
        else {
            continue;
        };
        let is_default = get_string(&row, "is_default")
            .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
            .unwrap_or(false);
        if is_default || !map.contains_key(&provider_id) {
            map.insert(provider_id, url);
        }
    }
    Ok(map)
}

fn get_string(row: &QueryResult, column: &str) -> Option<String> {
    row.try_get::<Option<String>>("", column)
        .ok()
        .flatten()
        .or_else(|| {
            row.try_get::<Option<i64>>("", column)
                .ok()
                .flatten()
                .map(|value| value.to_string())
        })
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn row_to_candidate(
    row: &CcSwitchRow,
    endpoint_url: Option<&String>,
) -> RawProviderImportCandidate {
    let api_format_from_settings = find_string_value(
        &row.settings_config,
        &["api_format", "apiFormat", "wire_api", "wireApi"],
    );
    let api_format = row
        .api_format
        .as_deref()
        .or(api_format_from_settings.as_deref());
    let provider_type = infer_provider_type(&row.source_app, api_format, &row.settings_config);
    let raw_key = find_api_key(&row.settings_config);
    let raw_url = endpoint_url
        .cloned()
        .or_else(|| find_base_url(&row.settings_config));
    let models = find_models(&row.settings_config);
    let mut reason = None;
    let unsupported = if is_oauth_like(&row.settings_config, api_format) {
        reason = Some(
            "OAuth providers cannot be imported because no reusable API key is available"
                .to_string(),
        );
        true
    } else if raw_key.as_deref().map(is_masked_key).unwrap_or(true) {
        reason = Some("No readable API key was found in this CC Switch provider".to_string());
        true
    } else if raw_url.is_none() {
        reason = Some("No valid endpoint URL was found in this CC Switch provider".to_string());
        true
    } else {
        false
    };

    let (api_host, api_path) = raw_url
        .as_deref()
        .and_then(split_api_url)
        .unwrap_or_else(|| ("".to_string(), None));
    let key_prefix = raw_key
        .as_deref()
        .filter(|key| !is_masked_key(key))
        .map(key_prefix)
        .unwrap_or_default();
    let id = hash_id(&[
        &row.source_app,
        &row.id,
        &row.name,
        provider_type_str(&provider_type),
        &api_host,
        api_path.as_deref().unwrap_or(""),
        raw_key.as_deref().unwrap_or(""),
    ]);

    RawProviderImportCandidate {
        public: ProviderImportCandidate {
            id,
            source_app: row.source_app.clone(),
            name: row.name.clone(),
            provider_type,
            api_host,
            api_path,
            key_prefix,
            models,
            status: if unsupported {
                ProviderImportStatus::Unsupported
            } else {
                ProviderImportStatus::Ready
            },
            reason,
        },
        raw_key,
        unsupported,
    }
}

async fn classify_candidate(
    db: &DatabaseConnection,
    master_key: &[u8; 32],
    candidate: &ProviderImportCandidate,
    raw_key: Option<&str>,
) -> Result<ProviderImportStatus> {
    let Some(raw_key) = raw_key else {
        return Ok(ProviderImportStatus::Unsupported);
    };
    let Some(provider) = find_matching_provider(db, candidate).await? else {
        return Ok(ProviderImportStatus::Ready);
    };
    if provider.id.starts_with("builtin_") {
        return Ok(ProviderImportStatus::AddKey);
    }

    let provider = provider::get_provider(db, &provider.id).await?;
    let key_exists = provider.keys.iter().any(|key| {
        decrypt_key(&key.key_encrypted, master_key)
            .map(|decrypted| decrypted == raw_key)
            .unwrap_or(false)
    });
    if key_exists {
        Ok(ProviderImportStatus::AlreadyExists)
    } else {
        Ok(ProviderImportStatus::AddKey)
    }
}

async fn find_matching_provider(
    db: &DatabaseConnection,
    candidate: &ProviderImportCandidate,
) -> Result<Option<ProviderConfig>> {
    let providers = provider::list_providers_merged(db).await?;
    Ok(providers.into_iter().find(|provider| {
        provider.provider_type == candidate.provider_type
            && normalize_url(&provider.api_host) == normalize_url(&candidate.api_host)
            && api_paths_match(
                &candidate.provider_type,
                provider.api_path.as_deref(),
                candidate.api_path.as_deref(),
            )
    }))
}

fn normalize_url(value: &str) -> String {
    value
        .trim()
        .trim_end_matches('/')
        .trim_end_matches('!')
        .to_string()
}

fn normalize_api_path(value: Option<&str>) -> String {
    value
        .unwrap_or("")
        .trim()
        .trim_end_matches('!')
        .trim_matches('/')
        .to_string()
}

fn api_paths_match(
    provider_type: &ProviderType,
    existing: Option<&str>,
    candidate: Option<&str>,
) -> bool {
    let existing = normalize_api_path(existing);
    let candidate = normalize_api_path(candidate);
    if existing == candidate {
        return true;
    }

    default_api_path(provider_type)
        .map(|default_path| {
            let default_path = normalize_api_path(Some(default_path));
            (existing.is_empty() && candidate == default_path)
                || (candidate.is_empty() && existing == default_path)
        })
        .unwrap_or(false)
}

fn default_api_path(provider_type: &ProviderType) -> Option<&'static str> {
    match provider_type {
        ProviderType::OpenAI => Some("/v1/chat/completions"),
        ProviderType::OpenAIResponses => Some("/v1/responses"),
        ProviderType::Anthropic => Some("/v1/messages"),
        _ => None,
    }
}

fn infer_provider_type(
    source_app: &str,
    api_format: Option<&str>,
    settings: &serde_json::Value,
) -> ProviderType {
    let app = source_app.to_lowercase();
    let format = api_format.unwrap_or("").to_lowercase();
    let base_url = find_base_url(settings).unwrap_or_default().to_lowercase();

    if format.contains("anthropic") || format.contains("messages") {
        return ProviderType::Anthropic;
    }
    if format.contains("responses") || format.contains("codex") {
        return ProviderType::OpenAIResponses;
    }
    if format.contains("gemini") || app.contains("gemini") {
        return ProviderType::Gemini;
    }
    if format.contains("chat_completions") || format.contains("chat-completions") {
        if base_url.contains("api.openai.com") {
            return ProviderType::OpenAI;
        }
        return ProviderType::Custom;
    }

    if app.contains("claude") {
        ProviderType::Anthropic
    } else if app.contains("codex") {
        ProviderType::OpenAIResponses
    } else if app.contains("gemini") {
        ProviderType::Gemini
    } else if base_url.contains("api.openai.com") {
        ProviderType::OpenAI
    } else {
        ProviderType::Custom
    }
}

fn is_oauth_like(settings: &serde_json::Value, api_format: Option<&str>) -> bool {
    api_format
        .map(|format| format.to_lowercase().contains("oauth"))
        .unwrap_or(false)
        || find_string_value(
            settings,
            &["authType", "auth_type", "authMethod", "auth_method", "type"],
        )
        .map(|value| value.to_lowercase().contains("oauth"))
        .unwrap_or(false)
}

fn find_api_key(settings: &serde_json::Value) -> Option<String> {
    find_string_value(
        settings,
        &[
            "apiKey",
            "api_key",
            "apikey",
            "key",
            "authToken",
            "auth_token",
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
            "OPENAI_API_KEY",
            "GEMINI_API_KEY",
            "GOOGLE_API_KEY",
        ],
    )
}

fn find_base_url(settings: &serde_json::Value) -> Option<String> {
    find_string_value(
        settings,
        &[
            "baseUrl",
            "base_url",
            "apiBaseUrl",
            "api_base_url",
            "endpoint",
            "endpointUrl",
            "endpoint_url",
            "url",
            "ANTHROPIC_BASE_URL",
            "OPENAI_BASE_URL",
            "GEMINI_API_BASE_URL",
            "GOOGLE_GEMINI_BASE_URL",
        ],
    )
}

fn find_models(settings: &serde_json::Value) -> Vec<String> {
    let mut models = Vec::new();
    collect_model_values(
        settings,
        &[
            "model",
            "defaultModel",
            "default_model",
            "primaryModel",
            "primary_model",
            "ANTHROPIC_MODEL",
            "GEMINI_MODEL",
        ],
        &mut models,
    );
    models.sort();
    models.dedup();
    models
}

fn find_string_value(settings: &serde_json::Value, keys: &[&str]) -> Option<String> {
    match settings {
        serde_json::Value::Object(map) => {
            for key in keys {
                if let Some(value) = map.get(*key).and_then(|value| value.as_str()) {
                    let trimmed = value.trim();
                    if !trimmed.is_empty() {
                        return Some(trimmed.to_string());
                    }
                }
            }
            for value in map.values() {
                if let Some(found) = find_string_value(value, keys) {
                    return Some(found);
                }
            }
            None
        }
        serde_json::Value::Array(values) => {
            for value in values {
                if let Some(found) = find_string_value(value, keys) {
                    return Some(found);
                }
            }
            None
        }
        _ => None,
    }
}

fn collect_model_values(settings: &serde_json::Value, keys: &[&str], models: &mut Vec<String>) {
    match settings {
        serde_json::Value::Object(map) => {
            for key in keys {
                if let Some(value) = map.get(*key) {
                    collect_model_value(value, models);
                }
            }
            if let Some(value) = map.get("models") {
                collect_model_value(value, models);
            }
            for value in map.values() {
                collect_model_values(value, keys, models);
            }
        }
        serde_json::Value::Array(values) => {
            for value in values {
                collect_model_values(value, keys, models);
            }
        }
        _ => {}
    }
}

fn collect_model_value(value: &serde_json::Value, models: &mut Vec<String>) {
    match value {
        serde_json::Value::String(model) => {
            let trimmed = model.trim();
            if !trimmed.is_empty() {
                models.push(trimmed.to_string());
            }
        }
        serde_json::Value::Array(values) => {
            for value in values {
                collect_model_value(value, models);
            }
        }
        serde_json::Value::Object(map) => {
            if let Some(id) = map
                .get("id")
                .or_else(|| map.get("model"))
                .or_else(|| map.get("name"))
                .and_then(|value| value.as_str())
            {
                let trimmed = id.trim();
                if !trimmed.is_empty() {
                    models.push(trimmed.to_string());
                }
            }
        }
        _ => {}
    }
}

fn split_api_url(value: &str) -> Option<(String, Option<String>)> {
    let parsed = reqwest::Url::parse(value.trim()).ok()?;
    match parsed.scheme() {
        "http" | "https" => {}
        _ => return None,
    }
    if parsed.host_str().is_none() {
        return None;
    }

    let mut host = format!(
        "{}://{}",
        parsed.scheme(),
        parsed.host_str().unwrap_or_default()
    );
    if let Some(port) = parsed.port() {
        host.push(':');
        host.push_str(&port.to_string());
    }

    let path = parsed.path().trim_end_matches('/').to_string();
    let known_suffixes = [
        "/v1/chat/completions",
        "/v1/responses",
        "/v1/messages",
        "/v1beta/models",
        "/v4/chat/completions",
        "/v2/rerank",
        "/v1/rerank",
    ];
    if known_suffixes.iter().any(|suffix| path == *suffix) {
        return Some((host, Some(path)));
    }

    if path.is_empty() || path == "/" {
        Some((host, None))
    } else {
        host.push_str(&path);
        Some((host, None))
    }
}

fn is_masked_key(key: &str) -> bool {
    let value = key.trim().to_lowercase();
    value.is_empty()
        || value.contains('*')
        || value.contains('•')
        || value.contains("xxx")
        || value.contains("redacted")
        || value.contains("your-api-key")
        || value.contains("your_key")
}

fn key_prefix(raw_key: &str) -> String {
    if raw_key.len() >= 8 {
        format!("{}...", &raw_key[..8])
    } else {
        raw_key.to_string()
    }
}

fn provider_type_str(provider_type: &ProviderType) -> &'static str {
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

fn hash_id(parts: &[&str]) -> String {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part.as_bytes());
        hasher.update([0]);
    }
    hex::encode(hasher.finalize())
}

fn default_cc_switch_db_path() -> Result<PathBuf> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| AQBotError::NotFound("Could not determine home directory".into()))?;
    Ok(PathBuf::from(home).join(".cc-switch").join("cc-switch.db"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::{decrypt_key, encrypt_key};
    use crate::db::create_test_pool;
    use crate::repo::provider::{add_provider_key, create_provider, get_provider, list_providers};
    use crate::types::{CreateProviderInput, ProviderType};
    use sea_orm::{ConnectionTrait, Database, DbBackend, Statement};
    use tempfile::tempdir;

    async fn create_cc_switch_db(sql: &str) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempdir().unwrap();
        let path = dir.path().join("cc-switch.db");
        let db = Database::connect(format!("sqlite:{}?mode=rwc", path.display()))
            .await
            .unwrap();
        for statement in sql.split(';').map(str::trim).filter(|s| !s.is_empty()) {
            db.execute(Statement::from_string(
                DbBackend::Sqlite,
                statement.to_string(),
            ))
            .await
            .unwrap();
        }
        (dir, path)
    }

    fn schema_sql(rows: &str) -> String {
        format!(
            r#"
            CREATE TABLE providers (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              app_type TEXT NOT NULL,
              api_format TEXT,
              settings_config TEXT,
              category TEXT
            );
            CREATE TABLE provider_endpoints (
              id TEXT PRIMARY KEY,
              provider_id TEXT NOT NULL,
              url TEXT NOT NULL,
              is_default INTEGER NOT NULL DEFAULT 0
            );
            {rows}
            "#
        )
    }

    #[tokio::test]
    async fn scan_missing_cc_switch_db_returns_empty_candidates() {
        let h = create_test_pool().await.unwrap();
        let path = tempdir().unwrap().path().join("missing.db");

        let candidates = scan_cc_switch_provider_imports_from_path(&h.conn, &[1u8; 32], &path)
            .await
            .unwrap();

        assert!(candidates.is_empty());
    }

    #[tokio::test]
    async fn scan_reads_cc_switch_providers_and_splits_full_endpoint_urls() {
        let (_dir, path) = create_cc_switch_db(&schema_sql(
            r#"
            INSERT INTO providers (id, name, app_type, api_format, settings_config, category)
            VALUES
              ('claude-1', 'Claude Relay', 'claude', 'anthropic_messages',
               '{"env":{"ANTHROPIC_AUTH_TOKEN":"sk-ant","ANTHROPIC_BASE_URL":"https://api.anthropic.com/v1/messages","ANTHROPIC_MODEL":"claude-sonnet-4-6-20251117"}}', 'custom'),
              ('codex-1', 'Codex Relay', 'codex', 'codex_responses',
               '{"apiKey":"sk-codex","baseUrl":"https://api.example.com/v1/responses","model":"gpt-5.4"}', 'custom'),
              ('openai-chat-1', 'OpenAI Compatible', 'claude', 'chat_completions',
               '{"apiKey":"sk-openai-chat","model":"custom-chat"}', 'custom');
            INSERT INTO provider_endpoints (id, provider_id, url, is_default)
            VALUES ('ep-1', 'openai-chat-1', 'https://relay.example.com/v1/chat/completions', 1);
            "#,
        ))
        .await;
        let h = create_test_pool().await.unwrap();

        let candidates = scan_cc_switch_provider_imports_from_path(&h.conn, &[2u8; 32], &path)
            .await
            .unwrap();

        let claude = candidates
            .iter()
            .find(|candidate| candidate.name == "Claude Relay")
            .unwrap();
        assert_eq!(claude.provider_type, ProviderType::Anthropic);
        assert_eq!(claude.api_host, "https://api.anthropic.com");
        assert_eq!(claude.api_path.as_deref(), Some("/v1/messages"));
        assert_eq!(claude.key_prefix, "sk-ant");
        assert_eq!(claude.models, vec!["claude-sonnet-4-6-20251117"]);
        assert_eq!(claude.status, ProviderImportStatus::AddKey);

        let codex = candidates
            .iter()
            .find(|candidate| candidate.name == "Codex Relay")
            .unwrap();
        assert_eq!(codex.provider_type, ProviderType::OpenAIResponses);
        assert_eq!(codex.api_host, "https://api.example.com");
        assert_eq!(codex.api_path.as_deref(), Some("/v1/responses"));

        let custom = candidates
            .iter()
            .find(|candidate| candidate.name == "OpenAI Compatible")
            .unwrap();
        assert_eq!(custom.provider_type, ProviderType::Custom);
        assert_eq!(custom.api_host, "https://relay.example.com");
        assert_eq!(custom.api_path.as_deref(), Some("/v1/chat/completions"));
    }

    #[tokio::test]
    async fn scan_marks_oauth_missing_key_and_masked_key_as_unsupported() {
        let (_dir, path) = create_cc_switch_db(&schema_sql(
            r#"
            INSERT INTO providers (id, name, app_type, api_format, settings_config, category)
            VALUES
              ('oauth-1', 'Codex OAuth', 'codex', 'codex_oauth',
               '{"authType":"oauth","baseUrl":"https://chatgpt.com/backend-api/codex"}', 'official'),
              ('masked-1', 'Masked Key', 'claude', 'anthropic_messages',
               '{"env":{"ANTHROPIC_AUTH_TOKEN":"sk-****","ANTHROPIC_BASE_URL":"https://api.example.com"}}', 'custom');
            "#,
        ))
        .await;
        let h = create_test_pool().await.unwrap();

        let candidates = scan_cc_switch_provider_imports_from_path(&h.conn, &[3u8; 32], &path)
            .await
            .unwrap();

        assert!(candidates.iter().all(|candidate| {
            candidate.status == ProviderImportStatus::Unsupported && candidate.reason.is_some()
        }));
    }

    #[tokio::test]
    async fn import_creates_provider_adds_keys_and_reuses_duplicates() {
        let (_dir, path) = create_cc_switch_db(&schema_sql(
            r#"
            INSERT INTO providers (id, name, app_type, api_format, settings_config, category)
            VALUES
              ('custom-1', 'Custom Provider', 'claude', 'chat_completions',
               '{"apiKey":"sk-first","baseUrl":"https://api.new.example.com/v1/chat/completions","model":"model-a"}', 'custom'),
              ('existing-1', 'Existing Provider', 'claude', 'chat_completions',
               '{"apiKey":"sk-second","baseUrl":"https://api.existing.example.com/v1/chat/completions","model":"model-b"}', 'custom'),
              ('duplicate-1', 'Duplicate Provider', 'claude', 'chat_completions',
               '{"apiKey":"sk-duplicate","baseUrl":"https://api.duplicate.example.com/v1/chat/completions","model":"model-c"}', 'custom');
            "#,
        ))
        .await;
        let h = create_test_pool().await.unwrap();
        let db = &h.conn;
        let master_key = [4u8; 32];

        create_provider(
            db,
            CreateProviderInput {
                name: "Existing Provider".into(),
                provider_type: ProviderType::Custom,
                api_host: "https://api.existing.example.com".into(),
                api_path: Some("/v1/chat/completions".into()),
                enabled: true,
                builtin_id: None,
            },
        )
        .await
        .unwrap();

        let duplicate = create_provider(
            db,
            CreateProviderInput {
                name: "Duplicate Provider".into(),
                provider_type: ProviderType::Custom,
                api_host: "https://api.duplicate.example.com".into(),
                api_path: Some("/v1/chat/completions".into()),
                enabled: true,
                builtin_id: None,
            },
        )
        .await
        .unwrap();
        let encrypted_duplicate = encrypt_key("sk-duplicate", &master_key).unwrap();
        add_provider_key(db, &duplicate.id, &encrypted_duplicate, "sk-dupli...")
            .await
            .unwrap();

        let candidates = scan_cc_switch_provider_imports_from_path(db, &master_key, &path)
            .await
            .unwrap();
        let selected_ids: Vec<String> = candidates
            .iter()
            .filter(|candidate| candidate.status != ProviderImportStatus::Unsupported)
            .map(|candidate| candidate.id.clone())
            .collect();

        let result =
            import_cc_switch_provider_configs_from_path(db, &master_key, &path, selected_ids)
                .await
                .unwrap();

        assert_eq!(result.created_count, 1);
        assert_eq!(result.added_key_count, 1);
        assert_eq!(result.reused_count, 1);
        assert_eq!(result.skipped_count, 0);

        let mut imported = None;
        for id in &result.provider_ids {
            let provider = get_provider(db, id).await.unwrap();
            if provider.name == "Custom Provider" {
                imported = Some(provider);
                break;
            }
        }
        let imported = imported.unwrap();
        assert_eq!(imported.keys.len(), 1);
        assert_eq!(
            decrypt_key(&imported.keys[0].key_encrypted, &master_key).unwrap(),
            "sk-first"
        );
        assert!(imported
            .models
            .iter()
            .any(|model| model.model_id == "model-a"));

        let duplicate_after = get_provider(db, &duplicate.id).await.unwrap();
        assert_eq!(duplicate_after.keys.len(), 1);
    }

    #[tokio::test]
    async fn import_materializes_matching_builtin_provider() {
        let (_dir, path) = create_cc_switch_db(&schema_sql(
            r#"
            INSERT INTO providers (id, name, app_type, api_format, settings_config, category)
            VALUES
              ('anthropic-1', 'Anthropic Official', 'claude', 'anthropic_messages',
               '{"apiKey":"sk-ant-builtin","baseUrl":"https://api.anthropic.com/v1/messages","model":"claude-sonnet-4-6-20251117"}', 'official');
            "#,
        ))
        .await;
        let h = create_test_pool().await.unwrap();
        let db = &h.conn;
        let master_key = [5u8; 32];

        let candidates = scan_cc_switch_provider_imports_from_path(db, &master_key, &path)
            .await
            .unwrap();
        let candidate = candidates
            .iter()
            .find(|candidate| candidate.name == "Anthropic Official")
            .unwrap();
        assert_eq!(candidate.status, ProviderImportStatus::AddKey);
        assert!(list_providers(db).await.unwrap().is_empty());

        let result = import_cc_switch_provider_configs_from_path(
            db,
            &master_key,
            &path,
            vec![candidate.id.clone()],
        )
        .await
        .unwrap();

        assert_eq!(result.created_count, 0);
        assert_eq!(result.added_key_count, 1);
        assert_eq!(result.provider_ids.len(), 1);

        let provider = get_provider(db, &result.provider_ids[0]).await.unwrap();
        assert_eq!(provider.builtin_id.as_deref(), Some("anthropic"));
        assert_eq!(provider.keys.len(), 1);
        assert_eq!(
            decrypt_key(&provider.keys[0].key_encrypted, &master_key).unwrap(),
            "sk-ant-builtin"
        );
    }
}
