use crate::error::{AQBotError, Result};
use rmcp::{
    model::{CallToolRequestParams, CallToolResult, Tool},
    transport::streamable_http_client::StreamableHttpClientWorker,
    transport::{ConfigureCommandExt, TokioChildProcess},
    ServiceExt,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

/// Result of a tool call via MCP.
#[derive(Debug, Clone)]
pub struct McpToolResult {
    pub content: String,
    pub is_error: bool,
}

/// A tool discovered from an MCP server via tools/list.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscoveredTool {
    pub name: String,
    pub description: Option<String>,
    pub input_schema: Option<Value>,
}

/// Resolve the user's login shell PATH so that GUI-launched apps can find
/// tools like `npx`, `node`, `python`, etc. that are installed via version
/// managers (nvm, fnm, volta, pyenv, …).
///
/// On macOS/Linux GUI apps inherit a minimal PATH (`/usr/bin:/bin:…`).
/// This function runs the user's login shell once and caches the full PATH.
fn get_shell_path() -> &'static str {
    static SHELL_PATH: OnceLock<String> = OnceLock::new();
    SHELL_PATH.get_or_init(|| resolve_login_shell_path().unwrap_or_default())
}

#[cfg(unix)]
fn resolve_login_shell_path() -> Option<String> {
    let current_path = std::env::var("PATH").ok();
    let mut best_path: Option<String> = None;

    for shell in shell_candidates() {
        if let Some(candidate_path) = read_path_from_shell(&shell) {
            let merged = merge_paths(&candidate_path, current_path.as_deref());
            if path_score(&merged) > best_path.as_ref().map(|path| path_score(path)).unwrap_or(0) {
                best_path = Some(merged);
            }
        }
    }

    best_path.or(current_path)
}

#[cfg(not(unix))]
fn resolve_login_shell_path() -> Option<String> {
    std::env::var("PATH").ok()
}

#[cfg(unix)]
fn shell_candidates() -> Vec<String> {
    let mut candidates = Vec::new();
    let mut seen = HashSet::new();

    for candidate in [
        std::env::var("SHELL").ok(),
        Some("zsh".to_string()),
        Some("/bin/zsh".to_string()),
        Some("bash".to_string()),
        Some("/bin/bash".to_string()),
        Some("sh".to_string()),
        Some("/bin/sh".to_string()),
    ]
    .into_iter()
    .flatten()
    {
        if !candidate.is_empty() && seen.insert(candidate.clone()) {
            candidates.push(candidate);
        }
    }

    candidates
}

#[cfg(unix)]
fn read_path_from_shell(shell: &str) -> Option<String> {
    const START: &str = "__AQBOT_PATH_START__";
    const END: &str = "__AQBOT_PATH_END__";

    let output = std::process::Command::new(shell)
        .args([
            "-i",
            "-l",
            "-c",
            &format!("printf '{START}'; printenv PATH; printf '{END}'"),
        ])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;

    extract_marked_path(&output.stdout, START, END)
}

#[cfg(unix)]
fn extract_marked_path(output: &[u8], start: &str, end: &str) -> Option<String> {
    let stdout = String::from_utf8(output.to_vec()).ok()?;
    let start_idx = stdout.find(start)? + start.len();
    let end_idx = stdout[start_idx..].find(end)? + start_idx;
    let path = stdout[start_idx..end_idx].trim().to_string();

    if path.is_empty() {
        None
    } else {
        Some(path)
    }
}

#[cfg(unix)]
fn merge_paths(primary: &str, fallback: Option<&str>) -> String {
    let mut merged = Vec::new();
    let mut seen = HashSet::new();

    for path_list in [Some(primary), fallback] {
        for segment in path_list
            .unwrap_or_default()
            .split(':')
            .map(str::trim)
            .filter(|segment| !segment.is_empty())
        {
            if seen.insert(segment.to_string()) {
                merged.push(segment.to_string());
            }
        }
    }

    merged.join(":")
}

#[cfg(unix)]
fn path_score(path: &str) -> usize {
    path.split(':')
        .filter(|segment| !segment.is_empty())
        .count()
}

/// Inject login-shell PATH into the command unless the user already
/// provides an explicit PATH in their custom environment variables.
fn configure_stdio_env(cmd: &mut tokio::process::Command, env: &HashMap<String, String>) {
    let shell_path = get_shell_path();
    if !shell_path.is_empty() && !env.contains_key("PATH") {
        cmd.env("PATH", shell_path);
    }
    for (k, v) in env {
        cmd.env(k, v);
    }
}

/// Convert rmcp Tool to our DiscoveredTool.
fn tool_to_discovered(tool: &Tool) -> DiscoveredTool {
    DiscoveredTool {
        name: tool.name.to_string(),
        description: tool.description.as_ref().map(|d| d.to_string()),
        input_schema: serde_json::to_value(&tool.input_schema).ok(),
    }
}

/// Convert serde_json::Value to serde_json::Map for rmcp arguments.
fn value_to_map(v: Value) -> serde_json::Map<String, Value> {
    match v {
        Value::Object(m) => m,
        _ => serde_json::Map::new(),
    }
}

/// Extract text content from an rmcp CallToolResult.
fn extract_call_result(result: &CallToolResult) -> (String, bool) {
    let texts: Vec<String> = result
        .content
        .iter()
        .filter_map(|c| c.as_text().map(|t| t.text.clone()))
        .collect();
    let content = if texts.is_empty() {
        serde_json::to_string_pretty(&result.content).unwrap_or_else(|_| "null".into())
    } else {
        texts.join("\n")
    };
    (content, result.is_error.unwrap_or(false))
}

// ---------------------------------------------------------------------------
// Stdio transport
// ---------------------------------------------------------------------------

/// Execute a tool call against an MCP server via stdio transport.
pub async fn call_tool_stdio(
    command: &str,
    args: &[String],
    env: &HashMap<String, String>,
    tool_name: &str,
    tool_arguments: Value,
) -> Result<McpToolResult> {
    let env_clone = env.clone();
    let args_clone: Vec<String> = args.to_vec();

    let transport =
        TokioChildProcess::new(tokio::process::Command::new(command).configure(move |cmd| {
            cmd.args(&args_clone);
            configure_stdio_env(cmd, &env_clone);
        }))
        .map_err(|e| {
            AQBotError::Gateway(format!("Failed to spawn MCP server '{}': {}", command, e))
        })?;

    let client = ()
        .serve(transport)
        .await
        .map_err(|e| AQBotError::Gateway(format!("MCP handshake failed: {}", e)))?;

    let params = CallToolRequestParams::new(tool_name.to_string())
        .with_arguments(value_to_map(tool_arguments));
    let result = client
        .call_tool(params)
        .await
        .map_err(|e| AQBotError::Gateway(format!("MCP tool call failed: {}", e)))?;

    let _ = client.cancel().await;

    let (content, is_error) = extract_call_result(&result);
    Ok(McpToolResult { content, is_error })
}

/// Discover tools from an MCP server via stdio transport.
pub async fn discover_tools_stdio(
    command: &str,
    args: &[String],
    env: &HashMap<String, String>,
) -> Result<Vec<DiscoveredTool>> {
    let env_clone = env.clone();
    let args_clone: Vec<String> = args.to_vec();

    let transport =
        TokioChildProcess::new(tokio::process::Command::new(command).configure(move |cmd| {
            cmd.args(&args_clone);
            configure_stdio_env(cmd, &env_clone);
        }))
        .map_err(|e| {
            AQBotError::Gateway(format!("Failed to spawn MCP server '{}': {}", command, e))
        })?;

    let client = ()
        .serve(transport)
        .await
        .map_err(|e| AQBotError::Gateway(format!("MCP handshake failed: {}", e)))?;

    let tools = client
        .list_all_tools()
        .await
        .map_err(|e| AQBotError::Gateway(format!("MCP tools/list failed: {}", e)))?;

    let _ = client.cancel().await;

    Ok(tools.iter().map(tool_to_discovered).collect())
}

// ---------------------------------------------------------------------------
// HTTP / SSE transport (Streamable HTTP — handles both)
// ---------------------------------------------------------------------------

/// Execute a tool call against an MCP server via HTTP/SSE transport.
pub async fn call_tool_http(
    endpoint: &str,
    tool_name: &str,
    tool_arguments: Value,
) -> Result<McpToolResult> {
    let transport = StreamableHttpClientWorker::<reqwest::Client>::new_simple(endpoint);

    let client = ()
        .serve(transport)
        .await
        .map_err(|e| AQBotError::Gateway(format!("MCP HTTP connect failed: {}", e)))?;

    let params = CallToolRequestParams::new(tool_name.to_string())
        .with_arguments(value_to_map(tool_arguments));
    let result = client
        .call_tool(params)
        .await
        .map_err(|e| AQBotError::Gateway(format!("MCP tool call failed: {}", e)))?;

    let _ = client.cancel().await;

    let (content, is_error) = extract_call_result(&result);
    Ok(McpToolResult { content, is_error })
}

/// SSE transport uses the legacy MCP SSE protocol (GET /sse → endpoint → POST).
pub async fn call_tool_sse(
    endpoint: &str,
    tool_name: &str,
    tool_arguments: Value,
) -> Result<McpToolResult> {
    let request = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {
            "name": tool_name,
            "arguments": tool_arguments,
        }
    });
    let response = sse_send_request(endpoint, request).await?;
    let result_obj = response.get("result").ok_or_else(|| {
        let err = response
            .get("error")
            .map(|e| e.to_string())
            .unwrap_or_else(|| "unknown error".into());
        AQBotError::Gateway(format!("MCP tool call error: {}", err))
    })?;
    let content_arr = result_obj.get("content").and_then(|c| c.as_array());
    let texts: Vec<String> = content_arr
        .map(|arr| {
            arr.iter()
                .filter_map(|c| {
                    if c.get("type").and_then(|t| t.as_str()) == Some("text") {
                        c.get("text").and_then(|t| t.as_str()).map(String::from)
                    } else {
                        None
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    let content = if texts.is_empty() {
        serde_json::to_string_pretty(result_obj).unwrap_or_else(|_| "null".into())
    } else {
        texts.join("\n")
    };
    let is_error = result_obj
        .get("isError")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    Ok(McpToolResult { content, is_error })
}

/// Discover tools from an MCP server via HTTP transport.
pub async fn discover_tools_http(endpoint: &str) -> Result<Vec<DiscoveredTool>> {
    let transport = StreamableHttpClientWorker::<reqwest::Client>::new_simple(endpoint);

    let client = ()
        .serve(transport)
        .await
        .map_err(|e| AQBotError::Gateway(format!("MCP HTTP connect failed: {}", e)))?;

    let tools = client
        .list_all_tools()
        .await
        .map_err(|e| AQBotError::Gateway(format!("MCP tools/list failed: {}", e)))?;

    let _ = client.cancel().await;

    Ok(tools.iter().map(tool_to_discovered).collect())
}

/// Discover tools from an MCP server via legacy SSE protocol.
pub async fn discover_tools_sse(endpoint: &str) -> Result<Vec<DiscoveredTool>> {
    let request = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/list",
        "params": {}
    });
    let response = sse_send_request(endpoint, request).await?;
    tracing::info!(
        "SSE tools/list response: {}",
        serde_json::to_string_pretty(&response).unwrap_or_default()
    );
    let result = response.get("result").ok_or_else(|| {
        let err_msg = response
            .get("error")
            .map(|e| format!("tools/list error: {}", e))
            .unwrap_or_else(|| format!("tools/list unexpected response: {}", response));
        AQBotError::Gateway(err_msg)
    })?;
    let empty_tools = Vec::new();
    let tools = result
        .get("tools")
        .and_then(|t| t.as_array())
        .unwrap_or(&empty_tools);
    Ok(tools
        .iter()
        .filter_map(|t| {
            Some(DiscoveredTool {
                name: t.get("name")?.as_str()?.to_string(),
                description: t
                    .get("description")
                    .and_then(|d| d.as_str())
                    .map(String::from),
                input_schema: t.get("inputSchema").cloned(),
            })
        })
        .collect())
}

// ---------------------------------------------------------------------------
// Legacy SSE protocol helpers
// ---------------------------------------------------------------------------

/// Perform a full legacy MCP SSE session: connect → initialize → send request → return response.
async fn sse_send_request(sse_url: &str, request: Value) -> Result<Value> {
    use futures::StreamExt;

    let client = reqwest::Client::builder()
        .http1_only()
        .connect_timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| AQBotError::Gateway(format!("Failed to build SSE client: {}", e)))?;

    // 1. GET the SSE endpoint to open a persistent stream
    tracing::info!("SSE: connecting to {}", sse_url);
    let sse_resp = client
        .get(sse_url)
        .header("Accept", "text/event-stream")
        .send()
        .await
        .map_err(|e| AQBotError::Gateway(format!("SSE connect failed: {}", e)))?;

    if !sse_resp.status().is_success() {
        return Err(AQBotError::Gateway(format!(
            "SSE connect returned {}",
            sse_resp.status()
        )));
    }
    tracing::info!("SSE: connected, status={}", sse_resp.status());

    let base_url = {
        let parsed = reqwest::Url::parse(sse_url)
            .map_err(|e| AQBotError::Gateway(format!("Invalid SSE URL: {}", e)))?;
        format!("{}://{}", parsed.scheme(), parsed.authority())
    };

    let mut byte_stream = sse_resp.bytes_stream();
    let mut buffer = String::new();

    // 2. Read SSE events until we get the `endpoint` event
    let messages_url = loop {
        let chunk = byte_stream
            .next()
            .await
            .ok_or_else(|| AQBotError::Gateway("SSE stream ended before endpoint event".into()))?
            .map_err(|e| AQBotError::Gateway(format!("SSE read error: {}", e)))?;
        let text = String::from_utf8_lossy(&chunk)
            .replace("\r\n", "\n")
            .replace('\r', "\n");
        buffer.push_str(&text);

        if let Some(url) = extract_sse_endpoint(&mut buffer, &base_url) {
            break url;
        }
    };
    tracing::info!("SSE: got messages endpoint: {}", messages_url);

    // 3. POST initialize handshake
    let init_request = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 0,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": { "name": "AQBot", "version": "1.0.0" }
        }
    });
    let init_resp = client
        .post(&messages_url)
        .json(&init_request)
        .send()
        .await
        .map_err(|e| AQBotError::Gateway(format!("SSE initialize POST failed: {}", e)))?;
    if !init_resp.status().is_success() {
        return Err(AQBotError::Gateway(format!(
            "SSE initialize returned {}",
            init_resp.status()
        )));
    }
    tracing::info!(
        "SSE: initialize POST accepted, status={}",
        init_resp.status()
    );

    // Read init response from SSE stream
    let _init_result = sse_read_response(&mut byte_stream, &mut buffer).await?;
    tracing::info!("SSE: initialize handshake complete");

    // 4. POST initialized notification (no id — it's a notification)
    let _ = client
        .post(&messages_url)
        .json(&serde_json::json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized",
            "params": {}
        }))
        .send()
        .await;

    // 5. POST the actual request
    let resp = client
        .post(&messages_url)
        .json(&request)
        .send()
        .await
        .map_err(|e| AQBotError::Gateway(format!("SSE request POST failed: {}", e)))?;
    if !resp.status().is_success() {
        return Err(AQBotError::Gateway(format!(
            "SSE request returned {}",
            resp.status()
        )));
    }
    tracing::info!("SSE: request POST accepted, reading response...");

    // 6. Read the response from SSE stream
    sse_read_response(&mut byte_stream, &mut buffer).await
}

/// Extract the messages endpoint URL from SSE buffer. Drains consumed events.
fn extract_sse_endpoint(buffer: &mut String, base_url: &str) -> Option<String> {
    let mut search_start = 0;
    loop {
        let remaining = &buffer[search_start..];
        let block_end = remaining.find("\n\n")?;
        let block = &remaining[..block_end];
        let abs_block_end = search_start + block_end + 2;

        let mut event_type = None;
        let mut data = None;
        for line in block.lines() {
            if let Some(val) = line.strip_prefix("event:") {
                event_type = Some(val.trim());
            } else if let Some(val) = line.strip_prefix("data:") {
                data = Some(val.trim());
            }
        }
        if event_type == Some("endpoint") {
            if let Some(path) = data {
                let url = if path.starts_with("http://") || path.starts_with("https://") {
                    path.to_string()
                } else {
                    format!("{}{}", base_url, path)
                };
                buffer.drain(..abs_block_end);
                return Some(url);
            }
        }
        search_start = abs_block_end;
    }
}

/// Read a JSON-RPC response from the SSE byte stream.
async fn sse_read_response<S, E>(stream: &mut S, buffer: &mut String) -> Result<Value>
where
    S: futures::Stream<Item = std::result::Result<E, reqwest::Error>> + Unpin,
    E: AsRef<[u8]>,
{
    use futures::StreamExt;

    let timeout = tokio::time::Duration::from_secs(30);
    let deadline = tokio::time::Instant::now() + timeout;

    loop {
        if let Some(value) = extract_sse_json_response(buffer) {
            return Ok(value);
        }

        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        match tokio::time::timeout(remaining, stream.next()).await {
            Err(_) => return Err(AQBotError::Gateway("SSE response timed out".into())),
            Ok(None) => {
                return Err(AQBotError::Gateway(
                    "SSE stream ended before response".into(),
                ))
            }
            Ok(Some(Err(e))) => return Err(AQBotError::Gateway(format!("SSE read error: {}", e))),
            Ok(Some(Ok(chunk))) => {
                let text = String::from_utf8_lossy(chunk.as_ref())
                    .replace("\r\n", "\n")
                    .replace('\r', "\n");
                buffer.push_str(&text);
            }
        }
    }
}

/// Try to extract a JSON-RPC response from SSE event data in the buffer.
/// Removes consumed events from the buffer on success.
fn extract_sse_json_response(buffer: &mut String) -> Option<Value> {
    let mut search_start = 0;
    loop {
        let remaining = &buffer[search_start..];
        let block_end = remaining.find("\n\n");
        let block = if let Some(pos) = block_end {
            &remaining[..pos]
        } else {
            break None;
        };

        let abs_block_end = search_start + block_end.unwrap() + 2; // +2 for "\n\n"

        let mut event_type = None;
        let mut data_lines = Vec::new();
        for line in block.lines() {
            if let Some(val) = line.strip_prefix("event:") {
                event_type = Some(val.trim().to_string());
            } else if let Some(val) = line.strip_prefix("data:") {
                data_lines.push(val.trim().to_string());
            }
        }

        // Accept "message" events or events with no explicit type that contain data
        let is_message = event_type.as_deref() == Some("message")
            || (event_type.is_none() && !data_lines.is_empty());

        if is_message {
            let data = data_lines.join("");
            if let Ok(value) = serde_json::from_str::<Value>(&data) {
                if value.get("jsonrpc").is_some() && value.get("id").is_some() {
                    // Remove everything up to and including this event
                    buffer.drain(..abs_block_end);
                    return Some(value);
                }
            }
        }

        search_start = abs_block_end;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::fs;

    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn configure_stdio_env_applies_custom_variables() {
        let mut env = HashMap::new();
        env.insert("TAVILY_API_KEY".to_string(), "secret-key".to_string());
        env.insert("PATH".to_string(), "/custom/bin".to_string());

        let mut cmd = tokio::process::Command::new("python3");
        configure_stdio_env(&mut cmd, &env);

        let env_map: HashMap<String, Option<String>> = cmd
            .as_std()
            .get_envs()
            .map(|(key, value)| {
                (
                    key.to_string_lossy().to_string(),
                    value.map(|v| v.to_string_lossy().to_string()),
                )
            })
            .collect();

        assert_eq!(
            env_map.get("TAVILY_API_KEY"),
            Some(&Some("secret-key".to_string()))
        );
        assert_eq!(env_map.get("PATH"), Some(&Some("/custom/bin".to_string())));
    }

    #[tokio::test]
    async fn call_tool_stdio_does_not_hang_when_initialize_stdout_is_non_json_then_eof() {
        let args = vec!["-c".to_string(), "print('npm notice')".to_string()];

        let result = tokio::time::timeout(
            std::time::Duration::from_millis(500),
            call_tool_stdio(
                "python3",
                &args,
                &HashMap::new(),
                "fetch_url",
                serde_json::json!({}),
            ),
        )
        .await;

        assert!(
            result.is_ok(),
            "call_tool_stdio hung after non-JSON initialize output"
        );

        let err = result.unwrap().unwrap_err().to_string();
        assert!(err.contains("MCP") || err.contains("handshake") || err.contains("spawn"));
    }

    #[cfg(unix)]
    #[test]
    fn resolve_login_shell_path_uses_interactive_shell_config() {
        let dir = tempfile::tempdir().unwrap();
        let fake_shell = dir.path().join("fake-shell.sh");
        let fake_node_dir = dir.path().join("bin");
        fs::create_dir_all(&fake_node_dir).unwrap();
        let interactive_path = std::iter::once(fake_node_dir.to_string_lossy().to_string())
            .chain((0..24).map(|index| format!("/tmp/aqbot-shell-{index}")))
            .collect::<Vec<_>>()
            .join(":");

        let script = format!(
            "#!/bin/sh\nmode=plain\nfor arg in \"$@\"; do\n  if [ \"$arg\" = \"-i\" ]; then\n    mode=interactive\n  fi\ndone\nif [ \"$mode\" = \"interactive\" ]; then\n  printf '__AQBOT_PATH_START__%s__AQBOT_PATH_END__\\n' '{}:/usr/bin:/bin'\nelse\n  printf '__AQBOT_PATH_START__%s__AQBOT_PATH_END__\\n' '/usr/bin:/bin'\nfi\n",
            interactive_path
        );
        fs::write(&fake_shell, script).unwrap();

        let mut perms = fs::metadata(&fake_shell).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&fake_shell, perms).unwrap();

        let original_shell = std::env::var_os("SHELL");
        std::env::set_var("SHELL", &fake_shell);

        let resolved = resolve_login_shell_path().unwrap();

        match original_shell {
            Some(shell) => std::env::set_var("SHELL", shell),
            None => std::env::remove_var("SHELL"),
        }

        assert!(
            resolved
                .split(':')
                .any(|segment| segment == fake_node_dir.to_string_lossy()),
            "expected interactive PATH to include {}, got {}",
            fake_node_dir.display(),
            resolved
        );
    }

    #[cfg(unix)]
    #[test]
    fn merge_paths_deduplicates_segments() {
        let merged = merge_paths("/opt/bin:/usr/bin", Some("/usr/bin:/bin"));
        assert_eq!(merged, "/opt/bin:/usr/bin:/bin");
    }
}
