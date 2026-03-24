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
    input: CreateMcpServerInput,
) -> Result<McpServer, String> {
    aqbot_core::repo::mcp_server::update_mcp_server(&state.sea_db, &id, input)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_mcp_server(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
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
    aqbot_core::repo::mcp_server::list_tools_for_server(&state.sea_db, &server_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_tool_executions(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<Vec<ToolExecution>, String> {
    aqbot_core::repo::tool_execution::list_tool_executions(&state.sea_db, &conversation_id)
        .await
        .map_err(|e| e.to_string())
}
