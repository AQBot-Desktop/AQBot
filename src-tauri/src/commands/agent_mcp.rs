use aqbot_agent::permission::MCP_TOOL_ALIAS_PREFIX;
use aqbot_core::mcp_client::{
    call_tool_for_server, truncate_mcp_tool_result_content, StdioClientManager,
};
use async_trait::async_trait;
use open_agent_sdk::types::{Tool, ToolError, ToolInputSchema, ToolResult, ToolUseContext};
use sea_orm::DatabaseConnection;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

const MCP_TOOL_RESULT_MAX_BYTES: usize = 50_000;
const DEFAULT_MCP_EXECUTE_TIMEOUT_SECS: u64 = 30;
const MCP_TOOL_ALIAS_MAX_BYTES: usize = 64;

pub(crate) async fn build_agent_mcp_tools(
    db: &DatabaseConnection,
    stdio_clients: Arc<StdioClientManager>,
    enabled_server_ids: &[String],
) -> Result<(Vec<Arc<dyn Tool>>, HashMap<String, String>), String> {
    let enabled_servers: HashMap<_, _> = aqbot_core::repo::mcp_server::list_mcp_servers(db)
        .await
        .map_err(|error| format!("Failed to load MCP servers for Agent: {error}"))?
        .into_iter()
        .filter(|server| server.enabled)
        .map(|server| (server.id.clone(), server))
        .collect();
    let mut seen_server_ids = HashSet::new();
    let mut seen_aliases = HashSet::new();
    let mut tools = Vec::<Arc<dyn Tool>>::new();
    let mut display_names = HashMap::new();

    for server_id in enabled_server_ids {
        if !seen_server_ids.insert(server_id.as_str()) {
            continue;
        }
        let Some(server) = enabled_servers.get(server_id) else {
            continue;
        };
        let descriptors = aqbot_core::repo::mcp_server::list_tools_for_server(db, server_id)
            .await
            .map_err(|error| {
                format!(
                    "Failed to load MCP tools for Agent server '{}': {error}",
                    server.name
                )
            })?;
        if descriptors.is_empty() {
            return Err(format!(
                "Selected MCP server '{}' has no discovered tools",
                server.name
            ));
        }

        for descriptor in descriptors {
            if descriptor.server_id != *server_id {
                return Err(format!(
                    "MCP tool '{}' belongs to unexpected server '{}'",
                    descriptor.name, descriptor.server_id
                ));
            }
            let alias = mcp_tool_alias(server_id, &descriptor.name);
            if !seen_aliases.insert(alias.clone()) {
                return Err(format!(
                    "Duplicate MCP tool '{}' on server '{}'",
                    descriptor.name, server.name
                ));
            }
            let display_name = format!("MCP · {} · {}", server.name, descriptor.name);
            let description = descriptor
                .description
                .filter(|value| !value.trim().is_empty())
                .map(|description| format!("{display_name} — {description}"))
                .unwrap_or_else(|| display_name.clone());
            let tool = AgentMcpTool {
                alias: alias.clone(),
                display_name: display_name.clone(),
                description,
                server_id: server_id.clone(),
                tool_name: descriptor.name,
                input_schema: parse_input_schema(
                    descriptor.input_schema_json.as_deref(),
                    &display_name,
                )?,
                db: db.clone(),
                stdio_clients: stdio_clients.clone(),
            };
            display_names.insert(alias, display_name);
            tools.push(Arc::new(tool));
        }
    }

    Ok((tools, display_names))
}

pub(crate) fn display_agent_tool_name<'a>(
    display_names: &'a HashMap<String, String>,
    tool_name: &'a str,
) -> &'a str {
    display_names
        .get(tool_name)
        .map(String::as_str)
        .unwrap_or(tool_name)
}

fn parse_input_schema(schema_json: Option<&str>, display_name: &str) -> Result<Value, String> {
    let schema = match schema_json {
        Some(schema_json) => serde_json::from_str(schema_json)
            .map_err(|error| format!("Invalid input schema for {display_name}: {error}"))?,
        None => serde_json::to_value(ToolInputSchema::default())
            .expect("ToolInputSchema must always serialize to JSON"),
    };
    if !schema.is_object() {
        return Err(format!(
            "Invalid input schema for {display_name}: expected object"
        ));
    }
    Ok(schema)
}

fn mcp_tool_alias(server_id: &str, tool_name: &str) -> String {
    let mut server_hasher = Sha256::new();
    server_hasher.update(server_id.as_bytes());
    let server_hash = hex::encode(&server_hasher.finalize()[..6]);
    let mut binding_hasher = Sha256::new();
    binding_hasher.update((server_id.len() as u64).to_le_bytes());
    binding_hasher.update(server_id.as_bytes());
    binding_hasher.update((tool_name.len() as u64).to_le_bytes());
    binding_hasher.update(tool_name.as_bytes());
    let binding_hash = hex::encode(&binding_hasher.finalize()[..8]);
    let slug_max_bytes = MCP_TOOL_ALIAS_MAX_BYTES
        - MCP_TOOL_ALIAS_PREFIX.len()
        - server_hash.len()
        - binding_hash.len()
        - 4;
    let mut slug = String::with_capacity(slug_max_bytes);
    let mut last_was_underscore = false;

    for byte in tool_name.bytes() {
        let safe = if byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-' {
            byte as char
        } else {
            '_'
        };
        if safe == '_' && last_was_underscore {
            continue;
        }
        if slug.len() == slug_max_bytes {
            break;
        }
        slug.push(safe);
        last_was_underscore = safe == '_';
    }
    let slug = slug.trim_matches('_');
    let slug = if slug.is_empty() { "tool" } else { slug };

    format!("{MCP_TOOL_ALIAS_PREFIX}{server_hash}__{slug}__{binding_hash}")
}

struct AgentMcpTool {
    alias: String,
    display_name: String,
    description: String,
    server_id: String,
    tool_name: String,
    input_schema: Value,
    db: DatabaseConnection,
    stdio_clients: Arc<StdioClientManager>,
}

impl AgentMcpTool {
    async fn current_server(&self) -> Result<aqbot_core::types::McpServer, ToolError> {
        let server = aqbot_core::repo::mcp_server::get_mcp_server(&self.db, &self.server_id)
            .await
            .map_err(|error| {
                ToolError::ExecutionError(format!(
                    "{}: server is no longer available: {error}",
                    self.display_name
                ))
            })?;
        let source = format!("MCP · {} · {}", server.name, self.tool_name);
        if !server.enabled {
            return Err(ToolError::ExecutionError(format!(
                "{source}: server is disabled"
            )));
        }
        let descriptor =
            aqbot_core::repo::mcp_server::list_tools_for_server(&self.db, &self.server_id)
                .await
                .map_err(|error| {
                    ToolError::ExecutionError(format!(
                        "{source}: descriptor lookup failed: {error}"
                    ))
                })?
                .into_iter()
                .find(|descriptor| {
                    descriptor.server_id == self.server_id && descriptor.name == self.tool_name
                })
                .ok_or_else(|| {
                    ToolError::ExecutionError(format!("{source}: tool is no longer available"))
                })?;
        parse_input_schema(descriptor.input_schema_json.as_deref(), &source)
            .map_err(ToolError::ExecutionError)?;
        Ok(server)
    }
}

#[async_trait]
impl Tool for AgentMcpTool {
    fn name(&self) -> &str {
        &self.alias
    }

    fn description(&self) -> &str {
        &self.description
    }

    fn input_schema(&self) -> ToolInputSchema {
        // The Agent loop consumes input_schema_json below; this typed method is
        // only the SDK trait's legacy fallback and raw MCP JSON is canonical.
        ToolInputSchema::default()
    }

    fn input_schema_json(&self) -> Value {
        self.input_schema.clone()
    }

    async fn call(&self, input: Value, context: &ToolUseContext) -> Result<ToolResult, ToolError> {
        if context.abort_signal.is_cancelled() {
            return Err(ToolError::Aborted);
        }
        let server = self.current_server().await?;
        let source = format!("MCP · {} · {}", server.name, self.tool_name);
        let timeout_secs = server
            .execute_timeout_secs
            .map(u64::try_from)
            .transpose()
            .map_err(|_| ToolError::ExecutionError(format!("{source}: invalid execute timeout")))?
            .unwrap_or(DEFAULT_MCP_EXECUTE_TIMEOUT_SECS);
        if timeout_secs == 0 {
            return Err(ToolError::ExecutionError(format!(
                "{source}: invalid execute timeout"
            )));
        }
        let call =
            call_tool_for_server(self.stdio_clients.as_ref(), &server, &self.tool_name, input);
        let result = tokio::select! {
            biased;
            _ = context.abort_signal.cancelled() => return Err(ToolError::Aborted),
            result = tokio::time::timeout(Duration::from_secs(timeout_secs), call) => {
                result.map_err(|_| ToolError::ExecutionError(
                    format!("{source}: timed out after {timeout_secs}s")
                ))?
            }
        }
        .map_err(|error| ToolError::ExecutionError(format!("{source}: {error}")))?;
        let content = if result.is_error {
            format!("{source}: {}", result.content)
        } else {
            result.content
        };
        let content = truncate_mcp_tool_result_content(&content, MCP_TOOL_RESULT_MAX_BYTES);

        if result.is_error {
            Ok(ToolResult::error(content))
        } else {
            Ok(ToolResult::text(content))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aqbot_core::mcp_client::DiscoveredTool;
    use aqbot_core::types::{CreateMcpServerInput, UpdateMcpServerInput};
    use serde_json::json;

    fn custom_server(name: &str, enabled: bool) -> CreateMcpServerInput {
        CreateMcpServerInput {
            name: name.to_string(),
            transport: "stdio".to_string(),
            command: Some("unused-in-agent-mcp-tests".to_string()),
            enabled: Some(enabled),
            permission_policy: Some("ask".to_string()),
            source: Some("custom".to_string()),
            ..Default::default()
        }
    }

    #[test]
    fn aliases_are_stable_ascii_unique_and_bounded() {
        let alias = mcp_tool_alias("服务器/one", "查找 \"records\"");

        assert_eq!(
            mcp_tool_alias("server-1", "query_records"),
            "mcp__abcc4a8112e9__query_records__97392632db7fadc2"
        );
        assert_eq!(alias, mcp_tool_alias("服务器/one", "查找 \"records\""));
        assert_ne!(alias, mcp_tool_alias("服务器/two", "查找 \"records\""));
        assert_ne!(alias, mcp_tool_alias("服务器/one", "another_tool"));
        assert!(alias.starts_with(MCP_TOOL_ALIAS_PREFIX));
        assert!(alias.is_ascii());
        assert!(alias.len() <= MCP_TOOL_ALIAS_MAX_BYTES);
        assert_eq!(
            mcp_tool_alias("server", &"a".repeat(200)).len(),
            MCP_TOOL_ALIAS_MAX_BYTES
        );
        assert!(alias
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-'));
        let parts: Vec<_> = alias
            .strip_prefix(MCP_TOOL_ALIAS_PREFIX)
            .unwrap()
            .split("__")
            .collect();
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[0].len(), 12);
        assert!(!parts[1].is_empty());
        assert_eq!(parts[2].len(), 16);
        assert!(parts[0].bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert!(parts[2].bytes().all(|byte| byte.is_ascii_hexdigit()));
    }

    #[tokio::test]
    async fn selected_servers_are_intersected_with_currently_enabled_servers() {
        let db = aqbot_core::db::create_test_pool().await.unwrap().conn;
        let enabled =
            aqbot_core::repo::mcp_server::create_mcp_server(&db, custom_server("Enabled", true))
                .await
                .unwrap();
        let disabled =
            aqbot_core::repo::mcp_server::create_mcp_server(&db, custom_server("Disabled", false))
                .await
                .unwrap();
        for server in [&enabled, &disabled] {
            aqbot_core::repo::mcp_server::save_tool_descriptors(
                &db,
                &server.id,
                vec![DiscoveredTool {
                    name: "query".to_string(),
                    description: Some("Query records".to_string()),
                    input_schema: Some(json!({
                        "type": "object",
                        "$defs": {"identifier": {"type": "string"}}
                    })),
                }],
            )
            .await
            .unwrap();
        }

        let (tools, display_names) = build_agent_mcp_tools(
            &db,
            Arc::new(StdioClientManager::new()),
            &[
                disabled.id,
                enabled.id.clone(),
                "missing".to_string(),
                enabled.id,
            ],
        )
        .await
        .unwrap();

        assert_eq!(tools.len(), 1);
        assert_eq!(
            display_names.get(tools[0].name()).map(String::as_str),
            Some("MCP · Enabled · query")
        );
        assert!(tools[0].input_schema_json().get("$defs").is_some());
    }

    #[tokio::test]
    async fn selected_enabled_server_without_descriptors_is_an_error() {
        let db = aqbot_core::db::create_test_pool().await.unwrap().conn;
        let server =
            aqbot_core::repo::mcp_server::create_mcp_server(&db, custom_server("Empty", true))
                .await
                .unwrap();

        let error = build_agent_mcp_tools(
            &db,
            Arc::new(StdioClientManager::new()),
            std::slice::from_ref(&server.id),
        )
        .await
        .err()
        .unwrap();

        assert!(error.contains("Selected MCP server 'Empty' has no discovered tools"));
    }

    #[tokio::test]
    async fn adapter_calls_original_builtin_tool_and_preserves_result_semantics() {
        let db = aqbot_core::db::create_test_pool().await.unwrap().conn;
        aqbot_core::repo::mcp_server::set_builtin_enabled(&db, "builtin-search-file", true)
            .await
            .unwrap();
        let stdio_clients = Arc::new(StdioClientManager::new());
        let (tools, display_names) =
            build_agent_mcp_tools(&db, stdio_clients, &["builtin-search-file".to_string()])
                .await
                .unwrap();
        let read_file = tools
            .iter()
            .find(|tool| {
                display_names
                    .get(tool.name())
                    .is_some_and(|name| name.ends_with(" · read_file"))
            })
            .unwrap();
        assert_ne!(read_file.name(), "read_file");

        let dir = tempfile::tempdir().unwrap();
        let large_file = dir.path().join("large.txt");
        std::fs::write(&large_file, "x".repeat(MCP_TOOL_RESULT_MAX_BYTES + 10_000)).unwrap();
        let result = read_file
            .call(
                json!({"path": large_file.to_string_lossy()}),
                &ToolUseContext::new(String::new()),
            )
            .await
            .unwrap();
        assert!(!result.is_error);
        assert!(result.get_text().contains("MCP tool output truncated"));

        let missing_file = dir.path().join("missing.txt");
        let result = read_file
            .call(
                json!({"path": missing_file.to_string_lossy()}),
                &ToolUseContext::new(String::new()),
            )
            .await
            .unwrap();
        assert!(result.is_error);
        assert!(result
            .get_text()
            .contains("MCP · @aqbot/search-file · read_file"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn adapter_cancels_running_calls_and_enforces_server_timeout() {
        let db = aqbot_core::db::create_test_pool().await.unwrap().conn;
        let mut input = custom_server("Slow", true);
        input.command = Some("sh".to_string());
        input.args = Some(vec!["-c".to_string(), "sleep 10".to_string()]);
        input.execute_timeout_secs = Some(1);
        let server = aqbot_core::repo::mcp_server::create_mcp_server(&db, input)
            .await
            .unwrap();
        aqbot_core::repo::mcp_server::save_tool_descriptors(
            &db,
            &server.id,
            vec![DiscoveredTool {
                name: "wait".to_string(),
                description: None,
                input_schema: Some(json!({"type": "object"})),
            }],
        )
        .await
        .unwrap();
        let stdio_clients = Arc::new(StdioClientManager::new());
        let (tools, _) =
            build_agent_mcp_tools(&db, stdio_clients.clone(), std::slice::from_ref(&server.id))
                .await
                .unwrap();

        let cancel_token = open_agent_sdk::CancellationToken::new();
        let context = ToolUseContext::with_abort(String::new(), cancel_token.clone());
        let tool = tools[0].clone();
        let cancelled = tokio::spawn(async move { tool.call(json!({}), &context).await });
        tokio::time::sleep(Duration::from_millis(50)).await;
        cancel_token.cancel();
        let error = tokio::time::timeout(Duration::from_secs(1), cancelled)
            .await
            .expect("running MCP call must stop after cancellation")
            .unwrap()
            .unwrap_err();
        assert!(matches!(error, ToolError::Aborted));

        let error = tokio::time::timeout(
            Duration::from_secs(2),
            tools[0].call(json!({}), &ToolUseContext::new(String::new())),
        )
        .await
        .expect("MCP timeout must be enforced by the Agent adapter")
        .unwrap_err();
        assert!(error.to_string().contains("timed out after 1s"));
        stdio_clients.close_all().await.unwrap();
    }

    #[tokio::test]
    async fn every_call_revalidates_server_and_descriptor() {
        let db = aqbot_core::db::create_test_pool().await.unwrap().conn;
        let server =
            aqbot_core::repo::mcp_server::create_mcp_server(&db, custom_server("Mutable", true))
                .await
                .unwrap();
        let descriptor = DiscoveredTool {
            name: "query".to_string(),
            description: None,
            input_schema: Some(json!({"type": "object"})),
        };
        aqbot_core::repo::mcp_server::save_tool_descriptors(
            &db,
            &server.id,
            vec![descriptor.clone()],
        )
        .await
        .unwrap();
        let (tools, _) = build_agent_mcp_tools(
            &db,
            Arc::new(StdioClientManager::new()),
            std::slice::from_ref(&server.id),
        )
        .await
        .unwrap();

        let cancelled_context = ToolUseContext::new(String::new());
        cancelled_context.abort_signal.cancel();
        let error = tokio::time::timeout(
            Duration::from_millis(100),
            tools[0].call(json!({}), &cancelled_context),
        )
        .await
        .expect("a pre-cancelled MCP tool must return immediately")
        .unwrap_err();
        assert!(matches!(error, ToolError::Aborted));

        let error = tools[0]
            .call(json!({}), &ToolUseContext::new(String::new()))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("MCP · Mutable · query"));

        aqbot_core::repo::mcp_server::update_mcp_server(
            &db,
            &server.id,
            UpdateMcpServerInput {
                enabled: Some(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let error = tools[0]
            .call(json!({}), &ToolUseContext::new(String::new()))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("disabled"));

        aqbot_core::repo::mcp_server::update_mcp_server(
            &db,
            &server.id,
            UpdateMcpServerInput {
                enabled: Some(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        aqbot_core::repo::mcp_server::save_tool_descriptors(
            &db,
            &server.id,
            vec![DiscoveredTool {
                input_schema: Some(json!("invalid-schema")),
                ..descriptor.clone()
            }],
        )
        .await
        .unwrap();
        let error = tools[0]
            .call(json!({}), &ToolUseContext::new(String::new()))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("MCP · Mutable · query"));
        assert!(error.to_string().contains("Invalid input schema"));

        aqbot_core::repo::mcp_server::save_tool_descriptors(&db, &server.id, Vec::new())
            .await
            .unwrap();
        let error = tools[0]
            .call(json!({}), &ToolUseContext::new(String::new()))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("no longer available"));

        aqbot_core::repo::mcp_server::delete_mcp_server(&db, &server.id)
            .await
            .unwrap();
        let error = tools[0]
            .call(json!({}), &ToolUseContext::new(String::new()))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("MCP · Mutable · query"));
        assert!(error.to_string().contains("server is no longer available"));
    }
}
