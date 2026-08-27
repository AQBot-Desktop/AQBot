use crate::AppState;
use aqbot_core::types::*;
use serde::Deserialize;
use tauri::State;

const PROMPTS_CHAT_CSV_URL: &str =
    "https://raw.githubusercontent.com/f/prompts.chat/main/prompts.csv";
const PLEXPT_ZH_JSON_URL: &str =
    "https://raw.githubusercontent.com/PlexPt/awesome-chatgpt-prompts-zh/main/prompts-zh.json";
const EMBEDDED_ROLE_MARKETPLACE: &str = include_str!("../../../marketplace/roles.zh-CN.json");
const DEFAULT_ROLE_MARKETPLACE_SOURCE: &str = "prompts-chat";
const MAX_MARKETPLACE_RESULTS: usize = 50;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marketplace_sources_default_to_prompts_chat() {
        let sources = marketplace_sources();

        assert_eq!(sources[0].id, "prompts-chat");
        assert_eq!(sources[0].name, "prompts.chat");
        assert!(sources[0].default);
        assert!(!sources.iter().any(|source| source.id == "aqbot"));
        assert!(!sources.iter().any(|source| source.id == "lobehub"));
    }

    #[test]
    fn marketplace_opening_questions_accept_strings_and_objects() {
        let roles = parse_marketplace_index(
            r#"{
                "roles": [
                    {
                        "id": "prompt-1",
                        "name": "Prompt",
                        "systemPrompt": "prompt",
                        "openingQuestions": ["旧问题", {"title": "短标题", "content": "完整\n正文"}],
                        "sourceKind": "prompts-chat",
                        "sourceRef": "prompts-chat://prompt",
                        "marketplaceSource": "prompts-chat"
                    }
                ]
            }"#,
        )
        .unwrap();

        let input = entry_to_create_input(roles.into_iter().next().unwrap()).unwrap();

        assert_eq!(input.opening_questions[0].content, "旧问题");
        assert_eq!(input.opening_questions[0].title, None);
        assert_eq!(input.opening_questions[1].title.as_deref(), Some("短标题"));
        assert_eq!(input.opening_questions[1].content, "完整\n正文");
    }

    #[test]
    fn marketplace_search_rejects_unknown_source() {
        let roles = parse_marketplace_index(
            r#"{
                "roles": [
                    {
                        "id": "prompt-1",
                        "name": "Prompt",
                        "systemPrompt": "prompt",
                        "sourceKind": "prompts-chat",
                        "sourceRef": "prompts-chat://prompt",
                        "marketplaceSource": "prompts-chat"
                    },
                    {
                        "id": "custom-1",
                        "name": "Custom",
                        "systemPrompt": "custom",
                        "sourceKind": "custom",
                        "sourceRef": "custom://roles/custom",
                        "marketplaceSource": "custom"
                    }
                ]
            }"#,
        )
        .unwrap();

        let filtered = filter_marketplace_entries(roles, "custom", "");

        assert!(filtered.is_empty());
    }

    #[test]
    fn prompts_chat_csv_maps_multiple_roles() {
        let csv = "act,prompt,for_devs,type,contributor\n\
English Translator,Translate text,FALSE,TEXT,alice\n\
Linux Terminal,Act as terminal,TRUE,TEXT,bob\n\
Job Interviewer,Ask interview questions,FALSE,TEXT,cara\n";

        let roles = prompts_chat_entries_from_csv(csv).unwrap();

        assert_eq!(roles.len(), 3);
        assert_eq!(roles[0].source_kind, "prompts-chat");
        assert_eq!(roles[0].marketplace_source, "prompts-chat");
        assert_eq!(roles[0].source_ref, "prompts-chat://english-translator");
    }

    #[test]
    fn plexpt_json_maps_multiple_roles() {
        let raw = r#"[
            {"act":"雅思写作考官","prompt":"评价作文"},
            {"act":"产品经理","prompt":"整理需求"},
            {"act":"小红书文案","prompt":"生成文案"}
        ]"#;

        let roles = plexpt_entries_from_json(raw).unwrap();

        assert_eq!(roles.len(), 3);
        assert_eq!(roles[0].source_kind, "plexpt-zh");
        assert_eq!(roles[0].marketplace_source, "plexpt-zh");
        assert_eq!(roles[0].source_ref, "plexpt-zh://雅思写作考官");
    }

    #[tokio::test]
    async fn lobehub_source_returns_no_marketplace_results() {
        let roles = fetch_marketplace_entries("lobehub", "").await.unwrap();

        assert!(roles.is_empty());
    }

    #[tokio::test]
    async fn installed_refs_fallback_to_empty_when_roles_schema_is_old() {
        use sea_orm::{ConnectOptions, ConnectionTrait, Database, DbBackend, Statement};

        let mut opts = ConnectOptions::new("sqlite::memory:");
        opts.max_connections(1)
            .min_connections(1)
            .sqlx_logging(false);
        let db = Database::connect(opts).await.unwrap();
        db.execute(Statement::from_string(
            DbBackend::Sqlite,
            r#"
            CREATE TABLE roles (
                id varchar NOT NULL PRIMARY KEY,
                name varchar NOT NULL,
                description text NULL,
                system_prompt text NOT NULL,
                opening_message text NULL,
                opening_questions_json text NOT NULL DEFAULT '[]',
                tags_json text NOT NULL DEFAULT '[]',
                avatar varchar NULL,
                source_kind varchar NOT NULL DEFAULT 'local',
                source_ref varchar NULL,
                created_at bigint NOT NULL,
                updated_at bigint NOT NULL
            );
            INSERT INTO roles (
                id, name, system_prompt, opening_questions_json, tags_json,
                avatar, source_kind, source_ref, created_at, updated_at
            ) VALUES (
                'role-old', '旧角色', '旧提示词', '[]', '[]',
                '🌐', 'prompts-chat', 'prompts-chat://old', 1, 1
            );
            "#,
        ))
        .await
        .unwrap();

        let refs = installed_role_refs_or_empty(&db).await;

        assert!(refs.is_empty());
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RoleMarketplaceIndex {
    roles: Vec<RoleMarketplaceEntry>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RoleMarketplaceEntry {
    id: String,
    name: String,
    description: Option<String>,
    system_prompt: Option<String>,
    opening_message: Option<String>,
    opening_questions: Option<Vec<aqbot_core::types::RoleOpeningQuestion>>,
    tags: Option<Vec<String>>,
    avatar: Option<String>,
    avatar_type: Option<String>,
    avatar_value: Option<String>,
    temperature: Option<f64>,
    top_p: Option<f64>,
    source_kind: String,
    source_ref: String,
    #[serde(default = "default_marketplace_source")]
    marketplace_source: String,
}

fn default_marketplace_source() -> String {
    DEFAULT_ROLE_MARKETPLACE_SOURCE.to_string()
}

fn marketplace_sources() -> Vec<RoleMarketplaceSource> {
    [
        ("prompts-chat", "prompts.chat"),
        ("plexpt-zh", "PlexPt 中文"),
    ]
    .into_iter()
    .map(|(id, name)| RoleMarketplaceSource {
        id: id.to_string(),
        name: name.to_string(),
        default: id == DEFAULT_ROLE_MARKETPLACE_SOURCE,
    })
    .collect()
}

fn slugify(value: &str) -> String {
    let mut out = String::new();
    let mut last_dash = false;
    for ch in value.trim().to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
            last_dash = false;
        } else if !last_dash && !out.is_empty() {
            out.push('-');
            last_dash = true;
        }
    }
    out.trim_matches('-').to_string()
}

fn source_key(value: &str) -> String {
    let slug = slugify(value);
    if slug.is_empty() {
        urlencoding::encode(value.trim()).into_owned()
    } else {
        slug
    }
}

fn short_description(prompt: &str) -> Option<String> {
    let text = prompt.trim();
    if text.is_empty() {
        return None;
    }
    let mut chars = text.chars();
    let short: String = chars.by_ref().take(120).collect();
    Some(if chars.next().is_some() {
        format!("{short}...")
    } else {
        short
    })
}

#[derive(Debug, Deserialize)]
struct PromptsChatRow {
    act: String,
    prompt: String,
    for_devs: Option<String>,
    #[serde(rename = "type")]
    kind: Option<String>,
}

fn prompts_chat_entries_from_csv(text: &str) -> Result<Vec<RoleMarketplaceEntry>, String> {
    let mut reader = csv::Reader::from_reader(text.as_bytes());
    let mut roles = Vec::new();
    for row in reader.deserialize::<PromptsChatRow>() {
        let row = row.map_err(|err| format!("Failed to parse prompts.chat CSV: {err}"))?;
        let name = row.act.trim();
        let prompt = row.prompt.trim();
        if name.is_empty() || prompt.is_empty() {
            continue;
        }
        let slug = source_key(name);
        let mut tags = Vec::new();
        if let Some(kind) = row.kind.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            tags.push(kind.to_lowercase());
        }
        if row
            .for_devs
            .as_deref()
            .map(|s| s.eq_ignore_ascii_case("true"))
            .unwrap_or(false)
        {
            tags.push("developer".to_string());
        }
        roles.push(RoleMarketplaceEntry {
            id: format!("prompts-chat-{slug}"),
            name: name.to_string(),
            description: short_description(prompt),
            system_prompt: Some(prompt.to_string()),
            opening_message: None,
            opening_questions: None,
            tags: Some(tags),
            avatar: Some("💬".to_string()),
            avatar_type: Some("emoji".to_string()),
            avatar_value: Some("💬".to_string()),
            temperature: None,
            top_p: None,
            source_kind: "prompts-chat".to_string(),
            source_ref: format!("prompts-chat://{slug}"),
            marketplace_source: "prompts-chat".to_string(),
        });
    }
    Ok(roles)
}

#[derive(Debug, Deserialize)]
struct PlexPtRole {
    act: String,
    prompt: String,
}

fn plexpt_entries_from_json(text: &str) -> Result<Vec<RoleMarketplaceEntry>, String> {
    let rows = serde_json::from_str::<Vec<PlexPtRole>>(text)
        .map_err(|err| format!("Failed to parse PlexPt roles: {err}"))?;
    Ok(rows
        .into_iter()
        .filter_map(|row| {
            let name = row.act.trim();
            let prompt = row.prompt.trim();
            if name.is_empty() || prompt.is_empty() {
                return None;
            }
            Some(RoleMarketplaceEntry {
                id: format!("plexpt-zh-{}", source_key(name)),
                name: name.to_string(),
                description: short_description(prompt),
                system_prompt: Some(prompt.to_string()),
                opening_message: None,
                opening_questions: None,
                tags: Some(vec!["中文".to_string()]),
                avatar: Some("🧠".to_string()),
                avatar_type: Some("emoji".to_string()),
                avatar_value: Some("🧠".to_string()),
                temperature: None,
                top_p: None,
                source_kind: "plexpt-zh".to_string(),
                source_ref: format!("plexpt-zh://{name}"),
                marketplace_source: "plexpt-zh".to_string(),
            })
        })
        .collect())
}

async fn fetch_text(url: &str) -> Result<String, String> {
    let response = reqwest::Client::new()
        .get(url)
        .header("User-Agent", "AQBot")
        .send()
        .await
        .map_err(|err| format!("Fetch failed: {err}"))?;
    if !response.status().is_success() {
        return Err(format!("Fetch returned status {}", response.status()));
    }
    response.text().await.map_err(|err| err.to_string())
}

async fn fetch_prompts_chat_entries() -> Result<Vec<RoleMarketplaceEntry>, String> {
    prompts_chat_entries_from_csv(&fetch_text(PROMPTS_CHAT_CSV_URL).await?)
}

async fn fetch_plexpt_entries() -> Result<Vec<RoleMarketplaceEntry>, String> {
    plexpt_entries_from_json(&fetch_text(PLEXPT_ZH_JSON_URL).await?)
}

fn parse_marketplace_index(text: &str) -> Result<Vec<RoleMarketplaceEntry>, String> {
    let index = serde_json::from_str::<RoleMarketplaceIndex>(text)
        .map_err(|err| format!("Failed to parse role marketplace: {err}"))?;
    Ok(index.roles)
}

fn entry_to_create_input(entry: RoleMarketplaceEntry) -> Result<CreateRoleInput, String> {
    let system_prompt = entry
        .system_prompt
        .ok_or_else(|| format!("Marketplace role '{}' is missing systemPrompt", entry.name))?;
    Ok(CreateRoleInput {
        name: entry.name,
        description: entry.description,
        system_prompt,
        opening_message: entry.opening_message,
        opening_questions: entry.opening_questions.unwrap_or_default(),
        tags: entry.tags.unwrap_or_default(),
        avatar: entry.avatar,
        avatar_type: entry.avatar_type,
        avatar_value: entry.avatar_value,
        temperature: entry.temperature,
        top_p: entry.top_p,
        enabled_mcp_server_ids: Vec::new(),
        enabled_skill_names: Vec::new(),
        source_kind: Some(entry.source_kind),
        source_ref: Some(entry.source_ref),
    })
}

fn filter_marketplace_entries(
    roles: Vec<RoleMarketplaceEntry>,
    source_id: &str,
    query: &str,
) -> Vec<RoleMarketplaceEntry> {
    let source_id = if source_id.trim().is_empty() {
        DEFAULT_ROLE_MARKETPLACE_SOURCE
    } else {
        source_id.trim()
    };
    if !marketplace_sources()
        .iter()
        .any(|source| source.id == source_id)
    {
        return Vec::new();
    }
    let query = query.trim().to_lowercase();

    roles
        .into_iter()
        .filter(|role| {
            role.marketplace_source == source_id
                && (query.is_empty()
                    || role.name.to_lowercase().contains(&query)
                    || role
                        .description
                        .as_deref()
                        .unwrap_or_default()
                        .to_lowercase()
                        .contains(&query)
                    || role
                        .tags
                        .as_ref()
                        .map(|tags| tags.iter().any(|tag| tag.to_lowercase().contains(&query)))
                        .unwrap_or(false))
        })
        .collect()
}

fn limit_marketplace_entries(
    roles: Vec<RoleMarketplaceEntry>,
    source_id: &str,
    query: &str,
) -> Vec<RoleMarketplaceEntry> {
    filter_marketplace_entries(roles, source_id, query)
        .into_iter()
        .take(MAX_MARKETPLACE_RESULTS)
        .collect()
}

fn fallback_marketplace_entries(source_id: &str, query: &str) -> Vec<RoleMarketplaceEntry> {
    parse_marketplace_index(EMBEDDED_ROLE_MARKETPLACE)
        .map(|roles| limit_marketplace_entries(roles, source_id, query))
        .unwrap_or_default()
}

async fn fetch_marketplace_entries(
    source_id: &str,
    query: &str,
) -> Result<Vec<RoleMarketplaceEntry>, String> {
    let source_id = if source_id.trim().is_empty() {
        DEFAULT_ROLE_MARKETPLACE_SOURCE
    } else {
        source_id.trim()
    };
    let roles = match source_id {
        "prompts-chat" => fetch_prompts_chat_entries().await?,
        "plexpt-zh" => fetch_plexpt_entries().await?,
        _ => return Ok(Vec::new()),
    };
    Ok(limit_marketplace_entries(roles, source_id, query))
}

async fn marketplace_entries_or_fallback(
    source_id: &str,
    query: &str,
) -> Vec<RoleMarketplaceEntry> {
    fetch_marketplace_entries(source_id, query)
        .await
        .unwrap_or_else(|_| fallback_marketplace_entries(source_id, query))
}

async fn installed_role_refs_or_empty(
    db: &sea_orm::DatabaseConnection,
) -> std::collections::HashSet<String> {
    match aqbot_core::repo::role::list_roles(db).await {
        Ok(roles) => roles
            .into_iter()
            .filter_map(|role| role.source_ref)
            .collect(),
        Err(err) => {
            tracing::warn!(error = %err, "Failed to load installed role refs for marketplace search");
            std::collections::HashSet::new()
        }
    }
}

#[tauri::command]
pub fn list_role_marketplace_sources() -> Vec<RoleMarketplaceSource> {
    marketplace_sources()
}

#[tauri::command]
pub async fn list_roles(state: State<'_, AppState>) -> Result<Vec<Role>, String> {
    aqbot_core::repo::role::list_roles(&state.sea_db)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn get_role(state: State<'_, AppState>, id: String) -> Result<Role, String> {
    aqbot_core::repo::role::get_role(&state.sea_db, &id)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn create_role(
    state: State<'_, AppState>,
    input: CreateRoleInput,
) -> Result<Role, String> {
    aqbot_core::repo::role::create_role(&state.sea_db, input)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn update_role(
    state: State<'_, AppState>,
    id: String,
    input: UpdateRoleInput,
) -> Result<Role, String> {
    aqbot_core::repo::role::update_role(&state.sea_db, &id, input)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn delete_role(state: State<'_, AppState>, id: String) -> Result<(), String> {
    aqbot_core::repo::role::delete_role(&state.sea_db, &id)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn search_role_marketplace(
    state: State<'_, AppState>,
    source_id: String,
    query: String,
) -> Result<Vec<MarketplaceRole>, String> {
    let installed_refs = installed_role_refs_or_empty(&state.sea_db).await;

    Ok(marketplace_entries_or_fallback(&source_id, &query)
        .await
        .into_iter()
        .map(|role| MarketplaceRole {
            id: role.id,
            name: role.name,
            description: role.description,
            tags: role.tags.unwrap_or_default(),
            avatar: role.avatar,
            avatar_type: role.avatar_type,
            avatar_value: role.avatar_value,
            temperature: role.temperature.map(|v| v as f32),
            top_p: role.top_p.map(|v| v as f32),
            installed: installed_refs.contains(&role.source_ref),
            source_kind: role.source_kind,
            source_ref: role.source_ref,
            marketplace_source: role.marketplace_source,
        })
        .collect())
}

#[tauri::command]
pub async fn install_role(
    state: State<'_, AppState>,
    source_kind: String,
    source_ref: String,
) -> Result<Role, String> {
    let input = match source_kind.as_str() {
        "prompts-chat" | "plexpt-zh" => {
            let entries = match source_kind.as_str() {
                "prompts-chat" => fetch_prompts_chat_entries().await,
                _ => fetch_plexpt_entries().await,
            }
            .unwrap_or_else(|_| fallback_marketplace_entries(&source_kind, ""));
            let entry = entries
                .into_iter()
                .find(|role| role.source_ref == source_ref || role.id == source_ref)
                .ok_or_else(|| format!("Role source not found: {source_ref}"))?;
            entry_to_create_input(entry)?
        }
        _ => return Err(format!("Unsupported role source kind: {source_kind}")),
    };

    aqbot_core::repo::role::create_role(&state.sea_db, input)
        .await
        .map_err(|err| err.to_string())
}
