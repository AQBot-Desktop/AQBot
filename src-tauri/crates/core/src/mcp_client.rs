use crate::error::{AQBotError, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};

static REQUEST_ID: AtomicU64 = AtomicU64::new(1);

fn next_id() -> u64 {
    REQUEST_ID.fetch_add(1, Ordering::Relaxed)
}

#[derive(Serialize)]
struct JsonRpcRequest {
    jsonrpc: String,
    id: u64,
    method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    params: Option<Value>,
}

#[derive(Deserialize, Debug)]
struct JsonRpcResponse {
    #[allow(dead_code)]
    jsonrpc: String,
    #[allow(dead_code)]
    id: Option<u64>,
    result: Option<Value>,
    error: Option<JsonRpcError>,
}

#[derive(Deserialize, Debug)]
struct JsonRpcError {
    code: i64,
    message: String,
    #[allow(dead_code)]
    data: Option<Value>,
}

/// Result of a tool call via MCP.
#[derive(Debug, Clone)]
pub struct McpToolResult {
    pub content: String,
    pub is_error: bool,
}

/// Capture whatever the MCP server wrote to stderr (best-effort, 2s timeout).
async fn capture_stderr(stderr: Option<tokio::process::ChildStderr>) -> String {
    use tokio::io::AsyncReadExt;
    let Some(mut stderr) = stderr else { return String::new() };
    let mut buf = String::new();
    let _ = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        stderr.read_to_string(&mut buf),
    ).await;
    buf.trim().to_string()
}

/// Execute a tool call against an MCP server via stdio transport.
pub async fn call_tool_stdio(
    command: &str,
    args: &[String],
    env: &HashMap<String, String>,
    tool_name: &str,
    tool_arguments: Value,
) -> Result<McpToolResult> {
    use tokio::io::{AsyncWriteExt, BufReader};
    use tokio::process::Command;

    let mut child = Command::new(command)
        .args(args)
        .envs(env)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| AQBotError::Gateway(format!("Failed to spawn MCP server '{}': {}", command, e)))?;

    let mut stdin = child.stdin.take()
        .ok_or_else(|| AQBotError::Gateway("Failed to get stdin".into()))?;
    let stdout = child.stdout.take()
        .ok_or_else(|| AQBotError::Gateway("Failed to get stdout".into()))?;
    let stderr_handle = child.stderr.take();
    let mut reader = BufReader::new(stdout);

    // 1. Send initialize request
    let init_req = JsonRpcRequest {
        jsonrpc: "2.0".into(),
        id: next_id(),
        method: "initialize".into(),
        params: Some(serde_json::json!({
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": { "name": "aqbot", "version": "1.0.0" }
        })),
    };
    let mut init_bytes = serde_json::to_vec(&init_req)
        .map_err(|e| AQBotError::Gateway(format!("JSON serialize error: {}", e)))?;
    init_bytes.push(b'\n');
    stdin.write_all(&init_bytes).await
        .map_err(|e| AQBotError::Gateway(format!("Failed to write to stdin: {}", e)))?;
    stdin.flush().await
        .map_err(|e| AQBotError::Gateway(format!("Failed to flush stdin: {}", e)))?;

    // Read initialize response
    let mut line = String::new();
    let init_resp = match tokio::time::timeout(
        std::time::Duration::from_secs(30),
        parse_first_response(&mut reader, &mut line),
    ).await {
        Ok(Ok(resp)) => resp,
        Ok(Err(e)) => {
            let stderr_info = capture_stderr(stderr_handle).await;
            let msg = if stderr_info.is_empty() {
                format!("{}", e)
            } else {
                format!("{}\nServer stderr: {}", e, stderr_info)
            };
            drop(stdin);
            let _ = child.kill().await;
            return Err(AQBotError::Gateway(msg));
        }
        Err(_) => {
            let stderr_info = capture_stderr(stderr_handle).await;
            let msg = if stderr_info.is_empty() {
                "MCP initialize timeout (30s)".to_string()
            } else {
                format!("MCP initialize timeout (30s)\nServer stderr: {}", stderr_info)
            };
            drop(stdin);
            let _ = child.kill().await;
            return Err(AQBotError::Gateway(msg));
        }
    };

    // Parse and check for errors (skip notification lines)
    if let Some(err) = init_resp.error {
        return Err(AQBotError::Gateway(format!("MCP initialize error: {} (code {})", err.message, err.code)));
    }

    // 2. Send initialized notification
    let initialized_notif = serde_json::json!({
        "jsonrpc": "2.0",
        "method": "notifications/initialized"
    });
    let mut notif_bytes = serde_json::to_vec(&initialized_notif)
        .map_err(|e| AQBotError::Gateway(format!("JSON serialize error: {}", e)))?;
    notif_bytes.push(b'\n');
    stdin.write_all(&notif_bytes).await
        .map_err(|e| AQBotError::Gateway(format!("Failed to write notification: {}", e)))?;
    stdin.flush().await
        .map_err(|e| AQBotError::Gateway(format!("Failed to flush: {}", e)))?;

    // 3. Send tools/call request
    let call_req = JsonRpcRequest {
        jsonrpc: "2.0".into(),
        id: next_id(),
        method: "tools/call".into(),
        params: Some(serde_json::json!({
            "name": tool_name,
            "arguments": tool_arguments
        })),
    };
    let mut call_bytes = serde_json::to_vec(&call_req)
        .map_err(|e| AQBotError::Gateway(format!("JSON serialize error: {}", e)))?;
    call_bytes.push(b'\n');
    stdin.write_all(&call_bytes).await
        .map_err(|e| AQBotError::Gateway(format!("Failed to write tool call: {}", e)))?;
    stdin.flush().await
        .map_err(|e| AQBotError::Gateway(format!("Failed to flush: {}", e)))?;

    // Read tool call response
    let mut call_line = String::new();
    let call_resp = tokio::time::timeout(
        std::time::Duration::from_secs(120),
        read_json_rpc_response(&mut reader, &mut call_line),
    )
    .await
    .map_err(|_| AQBotError::Gateway("MCP tool call timeout (120s)".into()))?
    .map_err(|e| AQBotError::Gateway(format!("Failed to read tool response: {}", e)))?;

    if let Some(err) = call_resp.error {
        return Ok(McpToolResult {
            content: format!("Error: {} (code {})", err.message, err.code),
            is_error: true,
        });
    }

    // 4. Parse result content
    let result = call_resp.result.unwrap_or(Value::Null);
    let content_text = extract_tool_result_text(&result);
    let is_error = result.get("isError").and_then(|v| v.as_bool()).unwrap_or(false);

    // 5. Clean up process
    drop(stdin);
    let _ = child.kill().await;

    Ok(McpToolResult { content: content_text, is_error })
}

/// Execute a tool call against an MCP server via HTTP transport.
pub async fn call_tool_http(
    endpoint: &str,
    tool_name: &str,
    tool_arguments: Value,
) -> Result<McpToolResult> {
    let client = reqwest::Client::new();

    let call_req = JsonRpcRequest {
        jsonrpc: "2.0".into(),
        id: next_id(),
        method: "tools/call".into(),
        params: Some(serde_json::json!({
            "name": tool_name,
            "arguments": tool_arguments
        })),
    };

    let resp = client
        .post(endpoint)
        .json(&call_req)
        .timeout(std::time::Duration::from_secs(120))
        .send()
        .await
        .map_err(|e| AQBotError::Gateway(format!("HTTP MCP request failed: {}", e)))?;

    let body = resp.text().await
        .map_err(|e| AQBotError::Gateway(format!("Failed to read HTTP response: {}", e)))?;

    let rpc_resp: JsonRpcResponse = serde_json::from_str(&body)
        .map_err(|e| AQBotError::Gateway(format!("Failed to parse MCP response: {}", e)))?;

    if let Some(err) = rpc_resp.error {
        return Ok(McpToolResult {
            content: format!("Error: {} (code {})", err.message, err.code),
            is_error: true,
        });
    }

    let result = rpc_resp.result.unwrap_or(Value::Null);
    let content_text = extract_tool_result_text(&result);
    let is_error = result.get("isError").and_then(|v| v.as_bool()).unwrap_or(false);

    Ok(McpToolResult { content: content_text, is_error })
}

/// Extract text from MCP tool result content array.
fn extract_tool_result_text(result: &Value) -> String {
    if let Some(content) = result.get("content").and_then(|v| v.as_array()) {
        content
            .iter()
            .filter_map(|block| {
                if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                    block.get("text").and_then(|t| t.as_str()).map(|s| s.to_string())
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join("\n")
    } else if let Some(s) = result.as_str() {
        s.to_string()
    } else {
        serde_json::to_string_pretty(result).unwrap_or_else(|_| "null".into())
    }
}

/// Read lines until we get a valid JSON-RPC response (skip notifications).
async fn parse_first_response<R>(
    reader: &mut R,
    buf: &mut String,
) -> Result<JsonRpcResponse>
where
    R: tokio::io::AsyncBufRead + Unpin,
{
    use tokio::io::AsyncBufReadExt;
    loop {
        let trimmed = buf.trim();
        if !trimmed.is_empty() {
            if let Ok(resp) = serde_json::from_str::<JsonRpcResponse>(trimmed) {
                return Ok(resp);
            }
        }
        buf.clear();
        let n = reader.read_line(buf).await
            .map_err(|e| AQBotError::Gateway(format!("Failed to read stdout: {}", e)))?;
        if n == 0 {
            return Err(AQBotError::Gateway(
                "MCP initialize stream closed before JSON-RPC response".into(),
            ));
        }
    }
}

/// Read a JSON-RPC response from the reader, skipping notification lines.
async fn read_json_rpc_response(
    reader: &mut tokio::io::BufReader<tokio::process::ChildStdout>,
    buf: &mut String,
) -> std::io::Result<JsonRpcResponse> {
    use tokio::io::AsyncBufReadExt;
    loop {
        buf.clear();
        let n = reader.read_line(buf).await?;
        if n == 0 {
            return Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "MCP server closed stdout"));
        }
        let trimmed = buf.trim();
        if trimmed.is_empty() { continue; }
        if let Ok(resp) = serde_json::from_str::<JsonRpcResponse>(trimmed) {
            if resp.id.is_some() {
                return Ok(resp);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[tokio::test]
    async fn call_tool_stdio_does_not_hang_when_initialize_stdout_is_non_json_then_eof() {
        let args = vec![
            "-c".to_string(),
            "print('npm notice')".to_string(),
        ];

        let result = tokio::time::timeout(
            std::time::Duration::from_millis(500),
            call_tool_stdio("python3", &args, &HashMap::new(), "fetch_url", serde_json::json!({})),
        )
        .await;

        assert!(result.is_ok(), "call_tool_stdio hung after non-JSON initialize output");

        let err = result.unwrap().unwrap_err().to_string();
        assert!(err.contains("MCP initialize") || err.contains("stdout"));
    }
}
