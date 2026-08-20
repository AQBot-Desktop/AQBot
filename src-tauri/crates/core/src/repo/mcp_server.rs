use sea_orm::*;

use crate::entity::{mcp_servers, tool_descriptors};
use crate::error::{AQBotError, Result};
use crate::repo::settings;
use crate::types::{CreateMcpServerInput, McpServer, ToolDescriptor, UpdateMcpServerInput};
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
    BuiltinDef {
        id: BUILTIN_FETCH_ID,
        name: "@aqbot/fetch",
        default_enabled: true,
    },
    BuiltinDef {
        id: BUILTIN_SEARCH_FILE_ID,
        name: "@aqbot/search-file",
        default_enabled: false,
    },
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
        discover_timeout_secs: None,
        execute_timeout_secs: None,
        headers_json: None,
        icon_type: None,
        icon_value: None,
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
pub async fn set_builtin_enabled(
    db: &DatabaseConnection,
    id: &str,
    enabled: bool,
) -> Result<McpServer> {
    let def = BUILTIN_DEFS
        .iter()
        .find(|d| d.id == id)
        .ok_or_else(|| AQBotError::NotFound(format!("Builtin server {id}")))?;
    settings::set_setting(
        db,
        &builtin_setting_key(def.name),
        if enabled { "true" } else { "false" },
    )
    .await?;
    Ok(make_builtin_server(def, enabled))
}

/// Get a single builtin server by ID.
pub async fn get_builtin_server(db: &DatabaseConnection, id: &str) -> Result<McpServer> {
    let def = BUILTIN_DEFS
        .iter()
        .find(|d| d.id == id)
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
        discover_timeout_secs: m.discover_timeout_secs,
        execute_timeout_secs: m.execute_timeout_secs,
        headers_json: m.headers_json,
        icon_type: m.icon_type,
        icon_value: m.icon_value,
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
        permission_policy: Set(input.permission_policy.unwrap_or_else(|| "ask".to_string())),
        source: Set(input.source.unwrap_or_else(|| "custom".to_string())),
        discover_timeout_secs: Set(input.discover_timeout_secs),
        execute_timeout_secs: Set(input.execute_timeout_secs),
        headers_json: Set(input.headers_json),
        icon_type: Set(input.icon_type),
        icon_value: Set(input.icon_value),
    }
    .insert(db)
    .await?;

    get_mcp_server(db, &id).await
}

pub async fn update_mcp_server(
    db: &DatabaseConnection,
    id: &str,
    input: UpdateMcpServerInput,
) -> Result<McpServer> {
    // Builtin servers only support toggling enabled
    if is_builtin_id(id) {
        let enabled = input.enabled.unwrap_or(true);
        return set_builtin_enabled(db, id, enabled).await;
    }

    let model = mcp_servers::Entity::find_by_id(id)
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("McpServer {}", id)))?;

    let mut am: mcp_servers::ActiveModel = model.into();
    if let Some(name) = input.name {
        if !name.is_empty() {
            am.name = Set(name);
        }
    }
    if let Some(transport) = input.transport {
        if !transport.is_empty() {
            am.transport = Set(transport);
        }
    }
    if let Some(command) = input.command {
        am.command = Set(command.filter(|v| !v.is_empty()));
    }
    if let Some(args) = input.args {
        am.args_json = Set(args.map(|a| serde_json::to_string(&a).unwrap_or_default()));
    }
    if let Some(endpoint) = input.endpoint {
        am.endpoint = Set(endpoint.filter(|v| !v.is_empty()));
    }
    if let Some(env) = input.env {
        am.env_json = Set(env.map(|e| serde_json::to_string(&e).unwrap_or_default()));
    }
    if let Some(enabled) = input.enabled {
        am.enabled = Set(if enabled { 1 } else { 0 });
    }
    if let Some(permission_policy) = input.permission_policy {
        am.permission_policy = Set(permission_policy);
    }
    if let Some(discover_timeout_secs) = input.discover_timeout_secs {
        am.discover_timeout_secs = Set(Some(discover_timeout_secs));
    }
    if let Some(execute_timeout_secs) = input.execute_timeout_secs {
        am.execute_timeout_secs = Set(Some(execute_timeout_secs));
    }
    if let Some(headers_json) = input.headers_json {
        am.headers_json = Set(headers_json.filter(|v| !v.is_empty()));
    }
    if let Some(icon_type) = input.icon_type {
        am.icon_type = Set(icon_type.filter(|v| !v.is_empty()));
    }
    if let Some(icon_value) = input.icon_value {
        am.icon_value = Set(icon_value.filter(|v| !v.is_empty()));
    }
    am.update(db).await?;

    get_mcp_server(db, id).await
}

pub async fn delete_mcp_server(db: &DatabaseConnection, id: &str) -> Result<()> {
    // Prevent deletion of built-in MCP servers
    let server = get_mcp_server(db, id).await?;
    if server.source == "builtin" {
        return Err(AQBotError::Gateway(
            "Cannot delete built-in MCP server".to_string(),
        ));
    }

    let result = mcp_servers::Entity::delete_by_id(id).exec(db).await?;

    if result.rows_affected == 0 {
        return Err(AQBotError::NotFound(format!("McpServer {}", id)));
    }
    Ok(())
}

/// Return tool descriptors for a given MCP server.
pub async fn list_tools_for_server(
    db: &DatabaseConnection,
    server_id: &str,
) -> Result<Vec<ToolDescriptor>> {
    // Builtins: resolve name from definition, no DB lookup needed
    if let Some(def) = BUILTIN_DEFS.iter().find(|d| d.id == server_id) {
        return Ok(builtin_tools(server_id, def.name));
    }
    // Custom servers: read from tool_descriptors table
    let rows = tool_descriptors::Entity::find()
        .filter(tool_descriptors::Column::ServerId.eq(server_id))
        .order_by_asc(tool_descriptors::Column::Name)
        .all(db)
        .await?;
    Ok(rows
        .into_iter()
        .map(|m| ToolDescriptor {
            id: m.id,
            server_id: m.server_id,
            name: m.name,
            description: m.description,
            input_schema_json: m.input_schema_json,
        })
        .collect())
}

/// Save discovered tool descriptors for a server (replaces existing).
pub async fn save_tool_descriptors(
    db: &DatabaseConnection,
    server_id: &str,
    tools: Vec<crate::mcp_client::DiscoveredTool>,
) -> Result<Vec<ToolDescriptor>> {
    // Delete existing tools for this server
    tool_descriptors::Entity::delete_many()
        .filter(tool_descriptors::Column::ServerId.eq(server_id))
        .exec(db)
        .await?;

    // Insert new tools
    let mut result = Vec::with_capacity(tools.len());
    for tool in tools {
        let id = gen_id();
        let input_schema_json = tool
            .input_schema
            .as_ref()
            .map(|s| serde_json::to_string(s).unwrap_or_default());

        tool_descriptors::ActiveModel {
            id: Set(id.clone()),
            server_id: Set(server_id.to_string()),
            name: Set(tool.name.clone()),
            description: Set(tool.description.clone()),
            input_schema_json: Set(input_schema_json.clone()),
        }
        .insert(db)
        .await?;

        result.push(ToolDescriptor {
            id,
            server_id: server_id.to_string(),
            name: tool.name,
            description: tool.description,
            input_schema_json,
        });
    }
    Ok(result)
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
                    if server.enabled {
                        return Ok(Some((server, td)));
                    }
                }
            }
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::create_test_pool;
    use crate::types::UpdateMcpServerInput;

    fn remote_server_input(headers_json: Option<String>) -> CreateMcpServerInput {
        CreateMcpServerInput {
            name: "Remote MCP".into(),
            transport: "http".into(),
            command: None,
            args: None,
            endpoint: Some("https://example.com/mcp".into()),
            env: None,
            enabled: Some(false),
            permission_policy: Some("ask".into()),
            source: Some("custom".into()),
            discover_timeout_secs: Some(30),
            execute_timeout_secs: Some(30),
            headers_json,
            icon_type: None,
            icon_value: None,
        }
    }

    #[tokio::test]
    async fn update_mcp_server_preserves_headers_when_field_is_omitted() {
        let h = create_test_pool().await.unwrap();
        let db = &h.conn;
        let created = create_mcp_server(
            db,
            remote_server_input(Some(r#"{"Authorization":"Bearer old"}"#.into())),
        )
        .await
        .unwrap();

        let updated = update_mcp_server(
            db,
            &created.id,
            UpdateMcpServerInput {
                name: Some("Renamed MCP".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        assert_eq!(updated.name, "Renamed MCP");
        assert_eq!(
            updated.headers_json.as_deref(),
            Some(r#"{"Authorization":"Bearer old"}"#)
        );
    }

    #[tokio::test]
    async fn update_mcp_server_replaces_headers_when_value_is_provided() {
        let h = create_test_pool().await.unwrap();
        let db = &h.conn;
        let created = create_mcp_server(
            db,
            remote_server_input(Some(r#"{"Authorization":"Bearer old"}"#.into())),
        )
        .await
        .unwrap();

        let updated = update_mcp_server(
            db,
            &created.id,
            UpdateMcpServerInput {
                headers_json: Some(Some(r#"{"Authorization":"Bearer new"}"#.into())),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        assert_eq!(
            updated.headers_json.as_deref(),
            Some(r#"{"Authorization":"Bearer new"}"#)
        );
    }

    #[tokio::test]
    async fn update_mcp_server_clears_headers_when_null_is_provided() {
        let h = create_test_pool().await.unwrap();
        let db = &h.conn;
        let created = create_mcp_server(
            db,
            remote_server_input(Some(r#"{"Authorization":"Bearer old"}"#.into())),
        )
        .await
        .unwrap();

        update_mcp_server(
            db,
            &created.id,
            UpdateMcpServerInput {
                headers_json: Some(None),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let fetched = get_mcp_server(db, &created.id).await.unwrap();
        assert_eq!(fetched.headers_json, None);
    }

    #[tokio::test]
    async fn find_server_for_tool_skips_disabled_servers() {
        let h = create_test_pool().await.unwrap();
        let db = &h.conn;
        let created = create_mcp_server(db, remote_server_input(None))
            .await
            .unwrap();
        save_tool_descriptors(
            db,
            &created.id,
            vec![crate::mcp_client::DiscoveredTool {
                name: "remote_tool".into(),
                description: None,
                input_schema: None,
            }],
        )
        .await
        .unwrap();

        let found = find_server_for_tool(db, "remote_tool", &[created.id]).await;

        assert!(found.unwrap().is_none());
    }
}
