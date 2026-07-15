use crate::AppState;
use aqbot_core::types::*;
use tauri::State;

#[tauri::command]
pub async fn list_mcp_servers(state: State<'_, AppState>) -> Result<Vec<McpServer>, String> {
    aqbot_core::repo::mcp_server::list_mcp_servers(&state.sea_db)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_mcp_server(
    state: State<'_, AppState>,
    input: CreateMcpServerInput,
) -> Result<McpServer, String> {
    aqbot_core::repo::mcp_server::create_mcp_server(&state.sea_db, input)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_mcp_server(
    state: State<'_, AppState>,
    id: String,
    input: UpdateMcpServerInput,
) -> Result<McpServer, String> {
    aqbot_core::repo::mcp_server::update_mcp_server(&state.sea_db, &id, input)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_mcp_server(state: State<'_, AppState>, id: String) -> Result<(), String> {
    aqbot_core::repo::mcp_server::delete_mcp_server(&state.sea_db, &id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn test_mcp_server(
    _state: State<'_, AppState>,
    _id: String,
) -> Result<serde_json::Value, String> {
    // Mock implementation — return success with capabilities
    Ok(serde_json::json!({"ok": true, "capabilities": ["tools"]}))
}

#[tauri::command]
pub async fn list_mcp_tools(
    state: State<'_, AppState>,
    server_id: String,
) -> Result<Vec<ToolDescriptor>, String> {
    let tools = aqbot_core::repo::mcp_server::list_tools_for_server(&state.sea_db, &server_id)
        .await
        .map_err(|e| e.to_string())?;
    Ok(sanitize_tool_descriptors_for_ipc(tools))
}

#[tauri::command]
pub async fn discover_mcp_tools(
    state: State<'_, AppState>,
    id: String,
) -> Result<Vec<ToolDescriptor>, String> {
    let server = aqbot_core::repo::mcp_server::get_mcp_server(&state.sea_db, &id)
        .await
        .map_err(|e| e.to_string())?;

    if server.source == "builtin" {
        let tools = aqbot_core::repo::mcp_server::list_tools_for_server(&state.sea_db, &id)
            .await
            .map_err(|e| e.to_string())?;
        return Ok(sanitize_tool_descriptors_for_ipc(tools));
    }

    let timeout_secs = server.discover_timeout_secs.unwrap_or(30) as u64;
    let timeout_duration = std::time::Duration::from_secs(timeout_secs);

    let tools = match server.transport.as_str() {
        "stdio" => {
            let command = server
                .command
                .as_deref()
                .ok_or_else(|| "stdio server has no command configured".to_string())?;
            let args: Vec<String> = server
                .args_json
                .as_ref()
                .and_then(|s| serde_json::from_str(s).ok())
                .unwrap_or_default();
            let env: std::collections::HashMap<String, String> = server
                .env_json
                .as_ref()
                .and_then(|s| serde_json::from_str(s).ok())
                .unwrap_or_default();
            tokio::time::timeout(
                timeout_duration,
                aqbot_core::mcp_client::discover_tools_stdio(command, &args, &env),
            )
            .await
            .map_err(|_| format!("Tool discovery timed out after {}s", timeout_secs))?
            .map_err(|e| e.to_string())?
        }
        "http" => {
            let endpoint = server
                .endpoint
                .as_deref()
                .ok_or_else(|| "HTTP server has no endpoint configured".to_string())?;
            tokio::time::timeout(
                timeout_duration,
                aqbot_core::mcp_client::discover_tools_http(
                    endpoint,
                    server.headers_json.as_deref(),
                ),
            )
            .await
            .map_err(|_| format!("Tool discovery timed out after {}s", timeout_secs))?
            .map_err(|e| e.to_string())?
        }
        "sse" => {
            let endpoint = server
                .endpoint
                .as_deref()
                .ok_or_else(|| "SSE server has no endpoint configured".to_string())?;
            tokio::time::timeout(
                timeout_duration,
                aqbot_core::mcp_client::discover_tools_sse(
                    endpoint,
                    server.headers_json.as_deref(),
                ),
            )
            .await
            .map_err(|_| format!("Tool discovery timed out after {}s", timeout_secs))?
            .map_err(|e| e.to_string())?
        }
        other => return Err(format!("Unsupported transport: {}", other)),
    };

    let tools = aqbot_core::repo::mcp_server::save_tool_descriptors(&state.sea_db, &id, tools)
        .await
        .map_err(|e| e.to_string())?;
    Ok(sanitize_tool_descriptors_for_ipc(tools))
}

#[tauri::command]
pub async fn list_tool_executions(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<Vec<ToolExecution>, String> {
    let executions =
        aqbot_core::repo::tool_execution::list_tool_executions(&state.sea_db, &conversation_id)
        .await
        .map_err(|e| e.to_string())?;
    Ok(sanitize_tool_executions_for_ipc(executions))
}

fn sanitize_tool_executions_for_ipc(mut executions: Vec<ToolExecution>) -> Vec<ToolExecution> {
    for execution in &mut executions {
        execution.id = aqbot_core::inline_media::filter_complete_inline_data(&execution.id);
        execution.conversation_id =
            aqbot_core::inline_media::filter_complete_inline_data(&execution.conversation_id);
        execution.server_id =
            aqbot_core::inline_media::filter_complete_inline_data(&execution.server_id);
        execution.tool_name =
            aqbot_core::inline_media::filter_complete_inline_data(&execution.tool_name);
        execution.status =
            aqbot_core::inline_media::filter_complete_inline_data(&execution.status);
        execution.created_at =
            aqbot_core::inline_media::filter_complete_inline_data(&execution.created_at);
        for preview in [
            &mut execution.message_id,
            &mut execution.input_preview,
            &mut execution.output_preview,
            &mut execution.error_message,
            &mut execution.approval_status,
        ] {
            if let Some(value) = preview {
                *value = aqbot_core::inline_media::filter_complete_inline_data(value);
            }
        }
    }
    executions
}

fn sanitize_tool_descriptors_for_ipc(
    mut descriptors: Vec<ToolDescriptor>,
) -> Vec<ToolDescriptor> {
    for descriptor in &mut descriptors {
        descriptor.id = aqbot_core::inline_media::filter_complete_inline_data(&descriptor.id);
        descriptor.server_id =
            aqbot_core::inline_media::filter_complete_inline_data(&descriptor.server_id);
        descriptor.name = aqbot_core::inline_media::filter_complete_inline_data(&descriptor.name);
        for value in [
            &mut descriptor.description,
            &mut descriptor.input_schema_json,
        ] {
            if let Some(value) = value {
                *value = aqbot_core::inline_media::filter_complete_inline_data(value);
            }
        }
    }
    descriptors
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_execution_list_ipc_never_contains_inline_image_data() {
        let executions = sanitize_tool_executions_for_ipc(vec![ToolExecution {
            id: "execution-1".to_string(),
            conversation_id: "conversation-1".to_string(),
            message_id: None,
            server_id: "server-1".to_string(),
            tool_name: "image_tool".to_string(),
            status: "failed".to_string(),
            input_preview: Some("data:image/png;base64,INPUT_SECRET".to_string()),
            output_preview: Some("data:image/jpeg;base64,OUTPUT_SECRET".to_string()),
            error_message: Some("data:image/webp;base64,ERROR_SECRET".to_string()),
            duration_ms: None,
            created_at: "2026-07-15 00:00:00".to_string(),
            approval_status: None,
        }]);
        let ipc_json = serde_json::to_string(&executions).unwrap();

        assert!(!ipc_json.to_ascii_lowercase().contains("data:image/"));
        assert!(!ipc_json.contains("INPUT_SECRET"));
        assert!(!ipc_json.contains("OUTPUT_SECRET"));
        assert!(!ipc_json.contains("ERROR_SECRET"));
    }

    #[test]
    fn mcp_tool_descriptor_ipc_never_contains_inline_image_data() {
        let descriptors = sanitize_tool_descriptors_for_ipc(vec![ToolDescriptor {
            id: "tool-data:image/png;base64,ID_SECRET".to_string(),
            server_id: "server-data:image/png;base64,SERVER_SECRET".to_string(),
            name: "name-data:image/png;base64,NAME_SECRET".to_string(),
            description: Some("data:image/png;base64,DESCRIPTION_SECRET".to_string()),
            input_schema_json: Some(
                r#"{"data:image/png;base64,KEY_SECRET":"data:image/png;base64,VALUE_SECRET"}"#
                    .to_string(),
            ),
        }]);

        let ipc_json = serde_json::to_string(&descriptors).unwrap();

        assert!(!ipc_json.to_ascii_lowercase().contains("data:image/"));
        assert!(!ipc_json.contains("SECRET"));
    }
}
