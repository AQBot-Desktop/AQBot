use sea_orm::*;

use crate::entity::mcp_servers;
use crate::error::{AQBotError, Result};
use crate::repo::settings;
use crate::types::{CreateMcpServerInput, McpServer, ToolDescriptor};
use crate::utils::gen_id;

// ── Builtin server definitions (not stored in DB) ───────────────────────

const BUILTIN_FETCH_ID: &str = "builtin-fetch";
const BUILTIN_SEARCH_FILE_ID: &str = "builtin-search-file";

struct BuiltinDef {
    id: &'static str,
    name: &'static str,
    default_enabled: bool,
}

const BUILTIN_DEFS: &[BuiltinDef] = &[
    BuiltinDef { id: BUILTIN_FETCH_ID, name: "@aqbot/fetch", default_enabled: true },
    BuiltinDef { id: BUILTIN_SEARCH_FILE_ID, name: "@aqbot/search-file", default_enabled: false },
];

fn builtin_setting_key(name: &str) -> String {
    format!("builtin_mcp:{name}:enabled")
}

fn make_builtin_server(def: &BuiltinDef, enabled: bool) -> McpServer {
    McpServer {
        id: def.id.to_string(),
        name: def.name.to_string(),
        transport: "builtin".to_string(),
        command: None,
        args_json: None,
        endpoint: None,
        env_json: None,
        enabled,
        permission_policy: "auto".to_string(),
        source: "builtin".to_string(),
    }
}

async fn get_builtin_enabled(db: &DatabaseConnection, name: &str, default: bool) -> bool {
    match settings::get_setting(db, &builtin_setting_key(name)).await {
        Ok(Some(v)) => v == "true",
        _ => default,
    }
}

/// Return all builtin servers with their persisted enabled state.
pub async fn list_builtin_servers(db: &DatabaseConnection) -> Vec<McpServer> {
    let mut out = Vec::with_capacity(BUILTIN_DEFS.len());
    for def in BUILTIN_DEFS {
        let enabled = get_builtin_enabled(db, def.name, def.default_enabled).await;
        out.push(make_builtin_server(def, enabled));
    }
    out
}

/// Check whether a server ID belongs to a builtin.
pub fn is_builtin_id(id: &str) -> bool {
    BUILTIN_DEFS.iter().any(|d| d.id == id)
}

/// Toggle enabled state for a builtin server (persists to settings table).
pub async fn set_builtin_enabled(db: &DatabaseConnection, id: &str, enabled: bool) -> Result<McpServer> {
    let def = BUILTIN_DEFS.iter().find(|d| d.id == id)
        .ok_or_else(|| AQBotError::NotFound(format!("Builtin server {id}")))?;
    settings::set_setting(db, &builtin_setting_key(def.name), if enabled { "true" } else { "false" }).await?;
    Ok(make_builtin_server(def, enabled))
}

/// Get a single builtin server by ID.
pub async fn get_builtin_server(db: &DatabaseConnection, id: &str) -> Result<McpServer> {
    let def = BUILTIN_DEFS.iter().find(|d| d.id == id)
        .ok_or_else(|| AQBotError::NotFound(format!("Builtin server {id}")))?;
    let enabled = get_builtin_enabled(db, def.name, def.default_enabled).await;
    Ok(make_builtin_server(def, enabled))
}

// ── DB-backed custom servers ────────────────────────────────────────────

fn model_to_mcp_server(m: mcp_servers::Model) -> McpServer {
    McpServer {
        id: m.id,
        name: m.name,
        transport: m.transport,
        command: m.command,
        args_json: m.args_json,
        endpoint: m.endpoint,
        env_json: m.env_json,
        enabled: m.enabled != 0,
        permission_policy: m.permission_policy,
        source: m.source,
    }
}

pub async fn list_mcp_servers(db: &DatabaseConnection) -> Result<Vec<McpServer>> {
    let mut servers = list_builtin_servers(db).await;

    let custom_rows = mcp_servers::Entity::find()
        .order_by_asc(mcp_servers::Column::Name)
        .all(db)
        .await?;
    servers.extend(custom_rows.into_iter().map(model_to_mcp_server));

    Ok(servers)
}

pub async fn get_mcp_server(db: &DatabaseConnection, id: &str) -> Result<McpServer> {
    // Check builtins first
    if is_builtin_id(id) {
        return get_builtin_server(db, id).await;
    }

    let model = mcp_servers::Entity::find_by_id(id)
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("McpServer {}", id)))?;

    Ok(model_to_mcp_server(model))
}

pub async fn create_mcp_server(
    db: &DatabaseConnection,
    input: CreateMcpServerInput,
) -> Result<McpServer> {
    let id = gen_id();

    let args_json = input
        .args
        .as_ref()
        .map(|a| serde_json::to_string(a).unwrap_or_default());
    let env_json = input
        .env
        .as_ref()
        .map(|e| serde_json::to_string(e).unwrap_or_default());

    mcp_servers::ActiveModel {
        id: Set(id.clone()),
        name: Set(input.name),
        transport: Set(input.transport),
        command: Set(input.command),
        args_json: Set(args_json),
        endpoint: Set(input.endpoint),
        env_json: Set(env_json),
        enabled: Set(if input.enabled.unwrap_or(true) { 1 } else { 0 }),
        permission_policy: Set(
            input
                .permission_policy
                .unwrap_or_else(|| "ask".to_string()),
        ),
        source: Set(input.source.unwrap_or_else(|| "custom".to_string())),
    }
    .insert(db)
    .await?;

    get_mcp_server(db, &id).await
}

pub async fn update_mcp_server(
    db: &DatabaseConnection,
    id: &str,
    input: CreateMcpServerInput,
) -> Result<McpServer> {
    // Builtin servers only support toggling enabled
    if is_builtin_id(id) {
        let enabled = input.enabled.unwrap_or(true);
        return set_builtin_enabled(db, id, enabled).await;
    }

    let existing = get_mcp_server(db, id).await?;

    let name = if input.name.is_empty() { existing.name } else { input.name };
    let transport = if input.transport.is_empty() {
        existing.transport
    } else {
        input.transport
    };
    let command = input.command.or(existing.command);
    let endpoint = input.endpoint.or(existing.endpoint);
    let enabled = input.enabled.unwrap_or(existing.enabled);
    let permission_policy = input
        .permission_policy
        .unwrap_or(existing.permission_policy);

    let args_json = match input.args {
        Some(ref a) => Some(serde_json::to_string(a).unwrap_or_default()),
        None => existing.args_json,
    };
    let env_json = match input.env {
        Some(ref e) => Some(serde_json::to_string(e).unwrap_or_default()),
        None => existing.env_json,
    };

    let model = mcp_servers::Entity::find_by_id(id)
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("McpServer {}", id)))?;

    let mut am: mcp_servers::ActiveModel = model.into();
    am.name = Set(name);
    am.transport = Set(transport);
    am.command = Set(command);
    am.args_json = Set(args_json);
    am.endpoint = Set(endpoint);
    am.env_json = Set(env_json);
    am.enabled = Set(if enabled { 1 } else { 0 });
    am.permission_policy = Set(permission_policy);
    am.update(db).await?;

    get_mcp_server(db, id).await
}

pub async fn delete_mcp_server(db: &DatabaseConnection, id: &str) -> Result<()> {
    // Prevent deletion of built-in MCP servers
    let server = get_mcp_server(db, id).await?;
    if server.source == "builtin" {
        return Err(AQBotError::Gateway("Cannot delete built-in MCP server".to_string()));
    }

    let result = mcp_servers::Entity::delete_by_id(id).exec(db).await?;

    if result.rows_affected == 0 {
        return Err(AQBotError::NotFound(format!("McpServer {}", id)));
    }
    Ok(())
}

/// Return tool descriptors for a given MCP server.
pub async fn list_tools_for_server(db: &DatabaseConnection, server_id: &str) -> Result<Vec<ToolDescriptor>> {
    // Builtins: resolve name from definition, no DB lookup needed
    if let Some(def) = BUILTIN_DEFS.iter().find(|d| d.id == server_id) {
        return Ok(builtin_tools(server_id, def.name));
    }
    let server = get_mcp_server(db, server_id).await?;
    Ok(builtin_tools(server_id, &server.name))
}

fn builtin_tools(server_id: &str, server_name: &str) -> Vec<ToolDescriptor> {
    match server_name {
        "@aqbot/fetch" => vec![
            ToolDescriptor {
                id: format!("{server_id}-fetch-url"),
                server_id: server_id.to_string(),
                name: "fetch_url".into(),
                description: Some("Fetch a URL and return its content".into()),
                input_schema_json: Some(r#"{"type":"object","properties":{"url":{"type":"string","description":"URL to fetch"},"max_length":{"type":"integer","description":"Maximum content length"}},"required":["url"]}"#.into()),
            },
            ToolDescriptor {
                id: format!("{server_id}-fetch-markdown"),
                server_id: server_id.to_string(),
                name: "fetch_markdown".into(),
                description: Some("Fetch a URL and convert the content to markdown".into()),
                input_schema_json: Some(r#"{"type":"object","properties":{"url":{"type":"string","description":"URL to fetch"}},"required":["url"]}"#.into()),
            },
        ],
        "@aqbot/search-file" => vec![
            ToolDescriptor {
                id: format!("{server_id}-read-file"),
                server_id: server_id.to_string(),
                name: "read_file".into(),
                description: Some("Read the contents of a file".into()),
                input_schema_json: Some(r#"{"type":"object","properties":{"path":{"type":"string","description":"File path to read"}},"required":["path"]}"#.into()),
            },
            ToolDescriptor {
                id: format!("{server_id}-list-directory"),
                server_id: server_id.to_string(),
                name: "list_directory".into(),
                description: Some("List files and directories in a given path".into()),
                input_schema_json: Some(r#"{"type":"object","properties":{"path":{"type":"string","description":"Directory path to list"}},"required":["path"]}"#.into()),
            },
            ToolDescriptor {
                id: format!("{server_id}-search-files"),
                server_id: server_id.to_string(),
                name: "search_files".into(),
                description: Some("Search for files matching a pattern".into()),
                input_schema_json: Some(r#"{"type":"object","properties":{"path":{"type":"string","description":"Base directory"},"pattern":{"type":"string","description":"Search pattern"}},"required":["path","pattern"]}"#.into()),
            },
        ],
        _ => vec![],
    }
}

/// Find which MCP server owns a given tool, searching across the provided server IDs.
pub async fn find_server_for_tool(
    db: &DatabaseConnection,
    tool_name: &str,
    server_ids: &[String],
) -> Result<Option<(McpServer, ToolDescriptor)>> {
    for server_id in server_ids {
        if let Ok(tools) = list_tools_for_server(db, server_id).await {
            if let Some(td) = tools.into_iter().find(|t| t.name == tool_name) {
                if let Ok(server) = get_mcp_server(db, server_id).await {
                    return Ok(Some((server, td)));
                }
            }
        }
    }
    Ok(None)
}
