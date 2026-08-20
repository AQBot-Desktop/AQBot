use crate::error::{AQBotError, Result};
use reqwest::header::{HeaderName, HeaderValue};
use rmcp::{
    model::{CallToolRequestParams, CallToolResult, Tool},
    service::{QuitReason, RunningService, RunningServiceCancellationToken},
    transport::streamable_http_client::{
        StreamableHttpClientTransportConfig, StreamableHttpClientWorker,
    },
    RoleClient, ServiceError, ServiceExt,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
#[cfg(windows)]
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tokio::sync::{Mutex, OwnedMutexGuard};
use tokio_util::sync::CancellationToken;

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

fn parse_mcp_headers_json(headers_json: Option<&str>) -> Result<HashMap<HeaderName, HeaderValue>> {
    let Some(raw) = headers_json.map(str::trim).filter(|raw| !raw.is_empty()) else {
        return Ok(HashMap::new());
    };

    let value: Value = serde_json::from_str(raw)
        .map_err(|e| AQBotError::Gateway(format!("Invalid MCP custom headers JSON: {}", e)))?;
    let object = value.as_object().ok_or_else(|| {
        AQBotError::Gateway("Invalid MCP custom headers JSON: expected object".to_string())
    })?;

    let mut headers = HashMap::with_capacity(object.len());
    for (key, value) in object {
        let header_name = HeaderName::from_bytes(key.as_bytes()).map_err(|e| {
            AQBotError::Gateway(format!("Invalid MCP custom header name '{}': {}", key, e))
        })?;
        let header_value = value.as_str().ok_or_else(|| {
            AQBotError::Gateway(format!(
                "Invalid MCP custom header value for '{}': expected string",
                key
            ))
        })?;
        let header_value = HeaderValue::from_str(header_value).map_err(|e| {
            AQBotError::Gateway(format!(
                "Invalid MCP custom header value for '{}': {}",
                key, e
            ))
        })?;
        headers.insert(header_name, header_value);
    }

    Ok(headers)
}

fn streamable_http_transport(
    endpoint: &str,
    headers_json: Option<&str>,
) -> Result<StreamableHttpClientWorker<reqwest::Client>> {
    let custom_headers = parse_mcp_headers_json(headers_json)?;
    let config =
        StreamableHttpClientTransportConfig::with_uri(endpoint).custom_headers(custom_headers);
    Ok(StreamableHttpClientWorker::new(
        reqwest::Client::default(),
        config,
    ))
}

fn apply_mcp_request_headers(
    mut builder: reqwest::RequestBuilder,
    headers: &HashMap<HeaderName, HeaderValue>,
) -> reqwest::RequestBuilder {
    for (name, value) in headers {
        builder = builder.header(name.clone(), value.clone());
    }
    builder
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
    if !shell_path.is_empty() && !env_contains_key_ignore_ascii_case(env, "PATH") {
        cmd.env("PATH", shell_path);
    }
    for (k, v) in env {
        cmd.env(k, v);
    }
}

#[derive(Debug, Clone)]
struct StdioCommandResolution {
    program: String,
    attempted_candidates: Vec<String>,
}

fn resolve_stdio_command(command: &str, env: &HashMap<String, String>) -> StdioCommandResolution {
    #[cfg(windows)]
    {
        resolve_windows_stdio_command_for_env(command, env).unwrap_or_else(|| {
            StdioCommandResolution {
                program: command.to_string(),
                attempted_candidates: windows_stdio_command_attempts_for_env(command, env),
            }
        })
    }

    #[cfg(not(windows))]
    {
        let _ = env;
        StdioCommandResolution {
            program: command.to_string(),
            attempted_candidates: Vec::new(),
        }
    }
}

fn env_contains_key_ignore_ascii_case(env: &HashMap<String, String>, key: &str) -> bool {
    env.keys().any(|k| k.eq_ignore_ascii_case(key))
}

#[cfg(windows)]
fn env_get_ignore_ascii_case<'a>(env: &'a HashMap<String, String>, key: &str) -> Option<&'a str> {
    env.iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(key))
        .map(|(_, v)| v.as_str())
}

#[cfg(windows)]
fn resolve_windows_stdio_command_for_env(
    command: &str,
    env: &HashMap<String, String>,
) -> Option<StdioCommandResolution> {
    let attempted_candidates = windows_stdio_command_attempts_for_env(command, env);
    let program = attempted_candidates
        .iter()
        .find(|candidate| Path::new(candidate.as_str()).is_file())
        .cloned()?;

    Some(StdioCommandResolution {
        program,
        attempted_candidates,
    })
}

#[cfg(windows)]
fn windows_stdio_command_attempts_for_env(
    command: &str,
    env: &HashMap<String, String>,
) -> Vec<String> {
    if !should_resolve_windows_stdio_command(command) {
        return Vec::new();
    }

    let Some(path_value) = effective_windows_path(env) else {
        return Vec::new();
    };

    let extensions = windows_path_extensions(env, command);
    path_value
        .split(';')
        .map(str::trim)
        .filter(|segment| !segment.is_empty())
        .flat_map(|dir| {
            extensions.iter().map(move |ext| {
                PathBuf::from(dir)
                    .join(format!("{command}{ext}"))
                    .to_string_lossy()
                    .to_string()
            })
        })
        .collect()
}

#[cfg(windows)]
fn should_resolve_windows_stdio_command(command: &str) -> bool {
    if command.trim().is_empty() || command.contains('/') || command.contains('\\') {
        return false;
    }

    Path::new(command).extension().is_none()
}

#[cfg(windows)]
fn effective_windows_path(env: &HashMap<String, String>) -> Option<String> {
    env_get_ignore_ascii_case(env, "PATH")
        .map(str::to_string)
        .or_else(|| {
            let shell_path = get_shell_path();
            if shell_path.is_empty() {
                None
            } else {
                Some(shell_path.to_string())
            }
        })
}

#[cfg(windows)]
fn windows_path_extensions(env: &HashMap<String, String>, command: &str) -> Vec<String> {
    let mut extensions = Vec::new();
    let mut seen = HashSet::new();
    let command_lower = command.to_ascii_lowercase();

    if command_lower == "npx" || command_lower == "npm" {
        push_windows_extension(&mut extensions, &mut seen, ".cmd");
    }

    let raw = env_get_ignore_ascii_case(env, "PATHEXT").unwrap_or(".COM;.EXE;.BAT;.CMD");
    for ext in raw.split(';') {
        push_windows_extension(&mut extensions, &mut seen, ext);
    }

    extensions
}

#[cfg(windows)]
fn push_windows_extension(extensions: &mut Vec<String>, seen: &mut HashSet<String>, ext: &str) {
    let mut normalized = ext.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return;
    }
    if !normalized.starts_with('.') {
        normalized.insert(0, '.');
    }
    if seen.insert(normalized.clone()) {
        extensions.push(normalized);
    }
}

fn spawn_mcp_stdio_error(
    command: &str,
    resolution: &StdioCommandResolution,
    error: std::io::Error,
) -> AQBotError {
    let message = format!("Failed to spawn MCP server '{}': {}", command, error);

    #[cfg(windows)]
    {
        let mut message = message;
        if resolution.program == command && should_resolve_windows_stdio_command(command) {
            message.push_str(
                ". On Windows, AQBot tried resolving the command via PATH/PATHEXT \
                 (including .cmd/.bat/.exe wrappers). Check the PATH visible to AQBot \
                 or configure an absolute command path such as C:\\Program Files\\nodejs\\npx.cmd",
            );
        }
        return AQBotError::Gateway(message);
    }

    #[cfg(not(windows))]
    {
        let _ = &resolution.attempted_candidates;
        AQBotError::Gateway(message)
    }
}

#[cfg(windows)]
fn hide_windows_console_window(cmd: &mut tokio::process::Command) {
    cmd.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_windows_console_window(_cmd: &mut tokio::process::Command) {}

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

const STDIO_CLOSE_TIMEOUT: Duration = Duration::from_secs(4);
const STDIO_CHILD_EXIT_TIMEOUT: Duration = Duration::from_secs(3);

type StdioClient = RunningService<RoleClient, ()>;

struct StdioConnection {
    client: StdioClient,
    child: tokio::process::Child,
}

/// Immutable launch configuration used to identify a persistent stdio server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StdioServerLaunch {
    pub server_id: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
}

/// A single MCP tool invocation routed through a persistent stdio connection.
#[derive(Debug, Clone)]
pub struct StdioToolCall {
    pub name: String,
    pub arguments: Value,
}

#[derive(Default)]
struct StdioSlotState {
    launch: Option<StdioServerLaunch>,
    client: Option<StdioClient>,
}

#[derive(Default)]
struct StdioClientSlot {
    state: Mutex<StdioSlotState>,
    child: Mutex<Option<tokio::process::Child>>,
    connection_token: Mutex<Option<CancellationToken>>,
    retired: AtomicBool,
}

#[derive(Debug, Clone)]
enum StdioLaunchPolicy {
    Enabled(StdioServerLaunch),
    Disabled(Option<StdioServerLaunch>),
    Removed,
}

#[derive(Clone, Copy)]
enum StdioOperation {
    Discover,
    CallTool,
}

/// Maintains one persistent, independently synchronized stdio connection per server.
#[derive(Clone, Default)]
pub struct StdioClientManager {
    slots: Arc<Mutex<HashMap<String, Arc<StdioClientSlot>>>>,
    launch_policies: Arc<Mutex<HashMap<String, StdioLaunchPolicy>>>,
    lifecycle_locks: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
    generations: Arc<Mutex<HashMap<String, u64>>>,
    shutting_down: Arc<AtomicBool>,
}

impl StdioClientManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Serialize database mutation and runtime policy updates for one server ID.
    pub async fn lock_lifecycle(&self, server_id: &str) -> OwnedMutexGuard<()> {
        let lock = self
            .lifecycle_locks
            .lock()
            .await
            .entry(server_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone();
        lock.lock_owned().await
    }

    /// Discover tools without tearing down a healthy connection afterwards.
    pub async fn discover_tools(&self, launch: StdioServerLaunch) -> Result<Vec<DiscoveredTool>> {
        validate_stdio_launch(&launch)?;
        let generation = self.generation(&launch.server_id).await;
        self.ensure_launch_allowed(&launch, StdioOperation::Discover)
            .await?;
        let slot = self.slot_for(&launch.server_id).await?;
        let mut state = slot.state.lock().await;
        ensure_stdio_slot_active(&slot, &launch.server_id)?;
        self.ensure_generation_current(&launch.server_id, generation)
            .await?;
        self.ensure_launch_allowed(&launch, StdioOperation::Discover)
            .await?;
        let client = ensure_stdio_client(&slot, &mut state, &launch).await?;
        let invalidate_on_drop = InvalidateStdioConnectionOnDrop::new(client.cancellation_token());
        ensure_stdio_slot_active(&slot, &launch.server_id)?;
        self.ensure_generation_current(&launch.server_id, generation)
            .await?;
        self.ensure_launch_allowed(&launch, StdioOperation::Discover)
            .await?;

        let tools = match client.list_all_tools().await {
            Ok(tools) => tools,
            Err(error) => {
                if matches!(&error, ServiceError::McpError(_)) {
                    invalidate_on_drop.disarm();
                }
                return Err(AQBotError::Gateway(format!(
                    "MCP tools/list failed for '{}': {}",
                    launch.server_id, error
                )));
            }
        };

        invalidate_on_drop.disarm();
        Ok(tools.iter().map(tool_to_discovered).collect())
    }

    /// Call a tool exactly once. A cancelled caller invalidates the connection
    /// instead of retrying a call whose side effects may already have happened.
    pub async fn call_tool(
        &self,
        launch: StdioServerLaunch,
        tool_call: StdioToolCall,
    ) -> Result<McpToolResult> {
        validate_stdio_launch(&launch)?;
        let generation = self.generation(&launch.server_id).await;
        self.ensure_launch_allowed(&launch, StdioOperation::CallTool)
            .await?;
        let slot = self.slot_for(&launch.server_id).await?;
        let mut state = slot.state.lock().await;
        ensure_stdio_slot_active(&slot, &launch.server_id)?;
        self.ensure_generation_current(&launch.server_id, generation)
            .await?;
        self.ensure_launch_allowed(&launch, StdioOperation::CallTool)
            .await?;
        let client = ensure_stdio_client(&slot, &mut state, &launch).await?;
        let invalidate_on_drop = InvalidateStdioConnectionOnDrop::new(client.cancellation_token());
        ensure_stdio_slot_active(&slot, &launch.server_id)?;
        self.ensure_generation_current(&launch.server_id, generation)
            .await?;
        self.ensure_launch_allowed(&launch, StdioOperation::CallTool)
            .await?;
        let params = CallToolRequestParams::new(tool_call.name)
            .with_arguments(value_to_map(tool_call.arguments));

        let result = match client.call_tool(params).await {
            Ok(result) => result,
            Err(error) => {
                if matches!(&error, ServiceError::McpError(_)) {
                    invalidate_on_drop.disarm();
                }
                return Err(AQBotError::Gateway(format!(
                    "MCP tool call failed for '{}': {}",
                    launch.server_id, error
                )));
            }
        };

        invalidate_on_drop.disarm();
        let (content, is_error) = extract_call_result(&result);
        Ok(McpToolResult { content, is_error })
    }

    /// Close and forget one server connection. Calling this for an unknown ID is idempotent.
    pub async fn disconnect(&self, server_id: &str) -> Result<()> {
        self.disconnect_slot(server_id).await
    }

    /// Allow tool calls for this exact launch configuration.
    pub async fn authorize(&self, launch: StdioServerLaunch) -> Result<()> {
        validate_stdio_launch(&launch)?;
        let server_id = launch.server_id.clone();
        self.set_launch_policy(&server_id, StdioLaunchPolicy::Enabled(launch))
            .await
    }

    /// Replace an enabled server configuration and close any connection using the old one.
    pub async fn reconfigure(&self, launch: StdioServerLaunch) -> Result<()> {
        validate_stdio_launch(&launch)?;
        let server_id = launch.server_id.clone();
        self.set_launch_policy(&server_id, StdioLaunchPolicy::Enabled(launch))
            .await?;
        self.disconnect_slot(&server_id).await
    }

    /// Block tool calls while retaining the configured launch for explicit discovery.
    pub async fn disable(&self, server_id: &str, launch: Option<StdioServerLaunch>) -> Result<()> {
        if let Some(launch) = &launch {
            validate_stdio_launch(launch)?;
            if launch.server_id != server_id {
                return Err(AQBotError::Gateway(format!(
                    "MCP stdio launch ID '{}' does not match disabled server '{}'",
                    launch.server_id, server_id
                )));
            }
        }
        self.set_launch_policy(server_id, StdioLaunchPolicy::Disabled(launch))
            .await?;
        self.disconnect_slot(server_id).await
    }

    /// Permanently reject stale work for a deleted server ID.
    pub async fn remove(&self, server_id: &str) -> Result<()> {
        self.launch_policies
            .lock()
            .await
            .insert(server_id.to_string(), StdioLaunchPolicy::Removed);
        self.disconnect_slot(server_id).await
    }

    async fn disconnect_slot(&self, server_id: &str) -> Result<()> {
        self.advance_generation(server_id).await;
        let slot = {
            let mut slots = self.slots.lock().await;
            let slot = slots.remove(server_id);
            if let Some(slot) = &slot {
                slot.retired.store(true, Ordering::Release);
            }
            slot
        };
        let Some(slot) = slot else {
            return Ok(());
        };

        close_stdio_slot(slot, server_id).await
    }

    /// Close all currently known connections concurrently so total shutdown remains bounded.
    pub async fn close_all(&self) -> Result<()> {
        self.shutting_down.store(true, Ordering::Release);
        let slots = {
            let mut slots = self.slots.lock().await;
            slots
                .drain()
                .inspect(|(_, slot)| slot.retired.store(true, Ordering::Release))
                .collect::<Vec<_>>()
        };
        let results =
            futures::future::join_all(slots.into_iter().map(|(server_id, slot)| async move {
                close_stdio_slot(slot, &server_id)
                    .await
                    .map_err(|error| format!("{}: {}", server_id, error))
            }))
            .await;
        let errors = results
            .into_iter()
            .filter_map(|result| result.err())
            .collect::<Vec<_>>();

        if errors.is_empty() {
            Ok(())
        } else {
            Err(AQBotError::Gateway(format!(
                "Failed to close stdio MCP connections: {}",
                errors.join("; ")
            )))
        }
    }

    async fn slot_for(&self, server_id: &str) -> Result<Arc<StdioClientSlot>> {
        let mut slots = self.slots.lock().await;
        if self.shutting_down.load(Ordering::Acquire) {
            return Err(AQBotError::Gateway(
                "MCP stdio client manager is shutting down".to_string(),
            ));
        }

        Ok(slots
            .entry(server_id.to_string())
            .or_insert_with(|| Arc::new(StdioClientSlot::default()))
            .clone())
    }

    async fn set_launch_policy(&self, server_id: &str, policy: StdioLaunchPolicy) -> Result<()> {
        let mut policies = self.launch_policies.lock().await;
        if matches!(policies.get(server_id), Some(StdioLaunchPolicy::Removed)) {
            return Err(AQBotError::Gateway(format!(
                "MCP stdio server '{}' was removed",
                server_id
            )));
        }
        policies.insert(server_id.to_string(), policy);
        Ok(())
    }

    async fn generation(&self, server_id: &str) -> u64 {
        self.generations
            .lock()
            .await
            .get(server_id)
            .copied()
            .unwrap_or_default()
    }

    async fn advance_generation(&self, server_id: &str) {
        let mut generations = self.generations.lock().await;
        let generation = generations.entry(server_id.to_string()).or_default();
        *generation = generation.wrapping_add(1);
    }

    async fn ensure_generation_current(&self, server_id: &str, expected: u64) -> Result<()> {
        if self.generation(server_id).await == expected {
            Ok(())
        } else {
            Err(AQBotError::Gateway(format!(
                "MCP stdio connection '{}' was disconnected",
                server_id
            )))
        }
    }

    async fn ensure_launch_allowed(
        &self,
        launch: &StdioServerLaunch,
        operation: StdioOperation,
    ) -> Result<()> {
        let policies = self.launch_policies.lock().await;
        match policies.get(&launch.server_id) {
            None => Ok(()),
            Some(StdioLaunchPolicy::Enabled(expected)) if expected == launch => Ok(()),
            Some(StdioLaunchPolicy::Disabled(Some(expected)))
                if matches!(operation, StdioOperation::Discover) && expected == launch =>
            {
                Ok(())
            }
            Some(StdioLaunchPolicy::Disabled(_)) => Err(AQBotError::Gateway(format!(
                "MCP stdio server '{}' is disabled",
                launch.server_id
            ))),
            Some(StdioLaunchPolicy::Removed) => Err(AQBotError::Gateway(format!(
                "MCP stdio server '{}' was removed",
                launch.server_id
            ))),
            Some(StdioLaunchPolicy::Enabled(_)) => Err(AQBotError::Gateway(format!(
                "MCP stdio server '{}' configuration changed",
                launch.server_id
            ))),
        }
    }
}

fn ensure_stdio_slot_active(slot: &StdioClientSlot, server_id: &str) -> Result<()> {
    if slot.retired.load(Ordering::Acquire) {
        Err(AQBotError::Gateway(format!(
            "MCP stdio connection '{}' was disconnected",
            server_id
        )))
    } else {
        Ok(())
    }
}

struct InvalidateStdioConnectionOnDrop {
    cancellation_token: Option<RunningServiceCancellationToken>,
}

impl InvalidateStdioConnectionOnDrop {
    fn new(cancellation_token: RunningServiceCancellationToken) -> Self {
        Self {
            cancellation_token: Some(cancellation_token),
        }
    }

    fn disarm(mut self) {
        self.cancellation_token.take();
    }
}

impl Drop for InvalidateStdioConnectionOnDrop {
    fn drop(&mut self) {
        if let Some(cancellation_token) = self.cancellation_token.take() {
            cancellation_token.cancel();
        }
    }
}

fn validate_stdio_launch(launch: &StdioServerLaunch) -> Result<()> {
    if launch.server_id.trim().is_empty() {
        return Err(AQBotError::Gateway(
            "MCP stdio server ID must not be empty".to_string(),
        ));
    }
    if launch.command.trim().is_empty() {
        return Err(AQBotError::Gateway(format!(
            "MCP stdio command must not be empty for '{}'",
            launch.server_id
        )));
    }
    Ok(())
}

async fn ensure_stdio_client<'a>(
    slot: &StdioClientSlot,
    state: &'a mut StdioSlotState,
    launch: &StdioServerLaunch,
) -> Result<&'a StdioClient> {
    let has_child = slot.child.lock().await.is_some();
    let should_close = state.client.as_ref().is_some_and(|client| {
        client.is_closed() || client.is_transport_closed() || state.launch.as_ref() != Some(launch)
    }) || (state.client.is_none() && has_child);
    if should_close {
        close_stdio_client(slot, state, &launch.server_id).await?;
    }

    if state.client.is_none() {
        state.launch = None;
        let connection_token = CancellationToken::new();
        {
            let mut active_token = slot.connection_token.lock().await;
            *active_token = Some(connection_token.clone());
            ensure_stdio_slot_active(slot, &launch.server_id)?;
        }
        let connection = match connect_stdio_client(launch, connection_token).await {
            Ok(connection) => connection,
            Err(error) => {
                slot.connection_token.lock().await.take();
                return Err(error);
            }
        };
        state.launch = Some(launch.clone());
        *slot.child.lock().await = Some(connection.child);
        state.client = Some(connection.client);
    }

    state.client.as_ref().ok_or_else(|| {
        AQBotError::Gateway(format!(
            "MCP stdio connection was not initialized for '{}'",
            launch.server_id
        ))
    })
}

async fn connect_stdio_client(
    launch: &StdioServerLaunch,
    connection_token: CancellationToken,
) -> Result<StdioConnection> {
    let env = launch.env.clone();
    let args = launch.args.clone();
    let resolution = resolve_stdio_command(&launch.command, &launch.env);
    let program = resolution.program.clone();

    let mut command = tokio::process::Command::new(program);
    command
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true);
    configure_stdio_env(&mut command, &env);
    hide_windows_console_window(&mut command);
    let mut child = command
        .spawn()
        .map_err(|error| spawn_mcp_stdio_error(&launch.command, &resolution, error))?;
    let child_stdout = take_stdio_pipe(child.stdout.take(), "stdout", launch, &mut child).await?;
    let child_stdin = take_stdio_pipe(child.stdin.take(), "stdin", launch, &mut child).await?;

    match ().serve_with_ct((child_stdout, child_stdin), connection_token).await {
        Ok(client) => Ok(StdioConnection { client, child }),
        Err(error) => {
            let handshake_error = AQBotError::Gateway(format!(
                "MCP handshake failed for '{}': {}",
                launch.server_id, error
            ));
            match terminate_stdio_child(&mut child, &launch.server_id).await {
                Ok(()) => Err(handshake_error),
                Err(cleanup_error) => Err(AQBotError::Gateway(format!(
                    "{}; cleanup also failed: {}",
                    handshake_error, cleanup_error
                ))),
            }
        }
    }
}

async fn take_stdio_pipe<T>(
    pipe: Option<T>,
    pipe_name: &str,
    launch: &StdioServerLaunch,
    child: &mut tokio::process::Child,
) -> Result<T> {
    if let Some(pipe) = pipe {
        return Ok(pipe);
    }

    let pipe_error = AQBotError::Gateway(format!(
        "MCP stdio {} was not captured for '{}'",
        pipe_name, launch.server_id
    ));
    match terminate_stdio_child(child, &launch.server_id).await {
        Ok(()) => Err(pipe_error),
        Err(cleanup_error) => Err(AQBotError::Gateway(format!(
            "{}; cleanup also failed: {}",
            pipe_error, cleanup_error
        ))),
    }
}

async fn terminate_stdio_child(child: &mut tokio::process::Child, server_id: &str) -> Result<()> {
    match child.try_wait() {
        Ok(Some(_)) => return Ok(()),
        Ok(None) => {}
        Err(error) => {
            return Err(AQBotError::Gateway(format!(
                "Failed to inspect MCP stdio process '{}': {}",
                server_id, error
            )))
        }
    }

    child.kill().await.map_err(|error| {
        AQBotError::Gateway(format!(
            "Failed to terminate MCP stdio process '{}': {}",
            server_id, error
        ))
    })
}

async fn close_stdio_slot(slot: Arc<StdioClientSlot>, server_id: &str) -> Result<()> {
    cancel_active_stdio_client(&slot).await;
    let child_result = take_and_close_stdio_child(&slot, server_id).await;
    let client_result = match tokio::time::timeout(STDIO_CLOSE_TIMEOUT, slot.state.lock()).await {
        Ok(mut state) => close_stdio_client(&slot, &mut state, server_id).await,
        Err(_) => Err(AQBotError::Gateway(format!(
            "Timed out after {:?} waiting to close active MCP stdio connection '{}'",
            STDIO_CLOSE_TIMEOUT, server_id
        ))),
    };
    combine_stdio_close_results(client_result, child_result)
}

async fn cancel_active_stdio_client(slot: &StdioClientSlot) {
    if let Some(cancellation_token) = slot.connection_token.lock().await.take() {
        cancellation_token.cancel();
    }
}

async fn close_stdio_client(
    slot: &StdioClientSlot,
    state: &mut StdioSlotState,
    server_id: &str,
) -> Result<()> {
    cancel_active_stdio_client(slot).await;
    state.launch = None;
    let child_result = take_and_close_stdio_child(slot, server_id).await;
    let client_result = match state.client.take() {
        Some(client) => close_running_stdio_client(client, server_id).await,
        None => Ok(()),
    };
    combine_stdio_close_results(client_result, child_result)
}

fn combine_stdio_close_results(first: Result<()>, second: Result<()>) -> Result<()> {
    match (first, second) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(error), Ok(())) | (Ok(()), Err(error)) => Err(error),
        (Err(first_error), Err(second_error)) => Err(AQBotError::Gateway(format!(
            "{}; {}",
            first_error, second_error
        ))),
    }
}

async fn close_running_stdio_client(mut client: StdioClient, server_id: &str) -> Result<()> {
    match client.close_with_timeout(STDIO_CLOSE_TIMEOUT).await {
        Ok(Some(QuitReason::JoinError(error))) => Err(AQBotError::Gateway(format!(
            "MCP stdio connection '{}' closed after task failure: {}",
            server_id, error
        ))),
        Ok(Some(_)) => Ok(()),
        Ok(None) => Err(AQBotError::Gateway(format!(
            "Timed out after {:?} closing MCP stdio connection '{}'",
            STDIO_CLOSE_TIMEOUT, server_id
        ))),
        Err(error) => Err(AQBotError::Gateway(format!(
            "Failed to close MCP stdio connection '{}': {}",
            server_id, error
        ))),
    }
}

async fn close_stdio_child(mut child: tokio::process::Child, server_id: &str) -> Result<()> {
    match tokio::time::timeout(STDIO_CHILD_EXIT_TIMEOUT, child.wait()).await {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(error)) => Err(AQBotError::Gateway(format!(
            "Failed to wait for MCP stdio process '{}': {}",
            server_id, error
        ))),
        Err(_) => terminate_stdio_child(&mut child, server_id).await,
    }
}

async fn take_and_close_stdio_child(slot: &StdioClientSlot, server_id: &str) -> Result<()> {
    let child = slot.child.lock().await.take();
    match child {
        Some(child) => close_stdio_child(child, server_id).await,
        None => Ok(()),
    }
}

// ---------------------------------------------------------------------------
// HTTP / SSE transport (Streamable HTTP — handles both)
// ---------------------------------------------------------------------------

/// Execute a tool call against an MCP server via HTTP/SSE transport.
pub async fn call_tool_http(
    endpoint: &str,
    headers_json: Option<&str>,
    tool_name: &str,
    tool_arguments: Value,
) -> Result<McpToolResult> {
    let transport = streamable_http_transport(endpoint, headers_json)?;

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
    headers_json: Option<&str>,
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
    let response = sse_send_request(endpoint, headers_json, request).await?;
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
pub async fn discover_tools_http(
    endpoint: &str,
    headers_json: Option<&str>,
) -> Result<Vec<DiscoveredTool>> {
    let transport = streamable_http_transport(endpoint, headers_json)?;

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
pub async fn discover_tools_sse(
    endpoint: &str,
    headers_json: Option<&str>,
) -> Result<Vec<DiscoveredTool>> {
    let request = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/list",
        "params": {}
    });
    let response = sse_send_request(endpoint, headers_json, request).await?;
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
async fn sse_send_request(
    sse_url: &str,
    headers_json: Option<&str>,
    request: Value,
) -> Result<Value> {
    use futures::StreamExt;

    let custom_headers = parse_mcp_headers_json(headers_json)?;
    let client = reqwest::Client::builder()
        .http1_only()
        .connect_timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| AQBotError::Gateway(format!("Failed to build SSE client: {}", e)))?;

    // 1. GET the SSE endpoint to open a persistent stream
    tracing::info!("SSE: connecting to {}", sse_url);
    let sse_resp = apply_mcp_request_headers(
        client.get(sse_url).header("Accept", "text/event-stream"),
        &custom_headers,
    )
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
    let init_resp = apply_mcp_request_headers(client.post(&messages_url), &custom_headers)
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
    let _ = apply_mcp_request_headers(client.post(&messages_url), &custom_headers)
        .json(&serde_json::json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized",
            "params": {}
        }))
        .send()
        .await;

    // 5. POST the actual request
    let resp = apply_mcp_request_headers(client.post(&messages_url), &custom_headers)
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

    const TEST_MCP_SERVER: &str = r#"
import json
import os
import pathlib
import sys
import time

counter_path = pathlib.Path(sys.argv[1])
start_count = int(counter_path.read_text()) + 1 if counter_path.exists() else 1
counter_path.write_text(str(start_count))
call_counter_path = pathlib.Path(str(counter_path) + ".calls")
identity = f"{os.getpid()}:{start_count}"

def send(response):
    try:
        print(json.dumps(response), flush=True)
    except BrokenPipeError:
        sys.exit(0)

for line in sys.stdin:
    request = json.loads(line)
    method = request.get("method")
    if method == "initialize":
        time.sleep(int(os.environ.get("AQBOT_TEST_INIT_DELAY_MS", "0")) / 1000)
        result = {
            "protocolVersion": request["params"]["protocolVersion"],
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "aqbot-test", "version": "1.0.0"},
        }
    elif method == "tools/list":
        result = {
            "tools": [{
                "name": "echo",
                "description": identity,
                "inputSchema": {"type": "object"},
            }]
        }
    elif method == "tools/call":
        call_count = int(call_counter_path.read_text()) + 1 if call_counter_path.exists() else 1
        call_counter_path.write_text(str(call_count))
        arguments = request.get("params", {}).get("arguments", {})
        if arguments.get("rpcError"):
            response = {
                "jsonrpc": "2.0",
                "id": request["id"],
                "error": {"code": -32000, "message": "expected tool error"},
            }
            send(response)
            continue
        time.sleep(arguments.get("delayMs", 0) / 1000)
        result = {"content": [{"type": "text", "text": identity}], "isError": False}
    else:
        continue

    response = {"jsonrpc": "2.0", "id": request["id"], "result": result}
    send(response)
    if method == "tools/list" and os.environ.get("AQBOT_TEST_EXIT_AFTER_LIST") == "1":
        sys.exit(0)
    if method == "initialize":
        pathlib.Path(str(counter_path) + ".initialized").write_text("1")
        time.sleep(int(os.environ.get("AQBOT_TEST_STOP_READING_MS", "0")) / 1000)
"#;

    fn test_stdio_launch(server_id: &str, counter_path: &std::path::Path) -> StdioServerLaunch {
        let env = std::env::var("PATH")
            .map(|path| HashMap::from([("PATH".to_string(), path)]))
            .unwrap_or_default();
        StdioServerLaunch {
            server_id: server_id.to_string(),
            command: "python3".to_string(),
            args: vec![
                "-u".to_string(),
                "-c".to_string(),
                TEST_MCP_SERVER.to_string(),
                counter_path.to_string_lossy().to_string(),
            ],
            env,
        }
    }

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

    #[test]
    fn parse_mcp_headers_json_accepts_authorization_and_custom_headers() {
        let headers = parse_mcp_headers_json(Some(
            r#"{"Authorization":"Bearer token","X-Custom":"value"}"#,
        ))
        .unwrap();

        assert_eq!(
            headers
                .get(&reqwest::header::HeaderName::from_static("authorization"))
                .unwrap()
                .to_str()
                .unwrap(),
            "Bearer token"
        );
        assert_eq!(
            headers
                .get(&reqwest::header::HeaderName::from_static("x-custom"))
                .unwrap()
                .to_str()
                .unwrap(),
            "value"
        );
    }

    #[test]
    fn parse_mcp_headers_json_rejects_invalid_json() {
        let err = parse_mcp_headers_json(Some("{bad-json")).unwrap_err();

        assert!(err.to_string().contains("Invalid MCP custom headers JSON"));
    }

    #[test]
    fn parse_mcp_headers_json_rejects_invalid_header_name() {
        let err = parse_mcp_headers_json(Some(r#"{"bad header":"value"}"#)).unwrap_err();

        assert!(err.to_string().contains("Invalid MCP custom header name"));
    }

    #[test]
    fn parse_mcp_headers_json_rejects_invalid_header_value() {
        let err = parse_mcp_headers_json(Some(r#"{"X-Test":"bad\u0000value"}"#)).unwrap_err();

        assert!(err.to_string().contains("Invalid MCP custom header value"));
    }

    #[test]
    fn stdio_env_treats_path_key_case_insensitively() {
        let mut env = HashMap::new();
        env.insert("Path".to_string(), "/custom/bin".to_string());

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

        assert_eq!(env_map.get("Path"), Some(&Some("/custom/bin".to_string())));
        assert!(
            !env_map.contains_key("PATH"),
            "custom Path should prevent AQBot from injecting a separate PATH"
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_stdio_command_resolves_npx_cmd_from_path() {
        let dir = tempfile::tempdir().unwrap();
        let npx = dir.path().join("npx.cmd");
        fs::write(&npx, "@echo off\r\n").unwrap();

        let mut env = HashMap::new();
        env.insert("Path".to_string(), dir.path().to_string_lossy().to_string());
        env.insert("PATHEXT".to_string(), ".COM;.EXE;.BAT;.CMD".to_string());

        let resolved = resolve_windows_stdio_command_for_env("npx", &env).unwrap();

        assert_eq!(resolved.program, npx.to_string_lossy());
    }

    #[cfg(windows)]
    #[test]
    fn windows_stdio_command_keeps_existing_cmd_extension() {
        let resolved = resolve_windows_stdio_command_for_env("npx.cmd", &HashMap::new());

        assert!(resolved.is_none());
    }

    #[cfg(windows)]
    #[test]
    fn windows_stdio_command_reports_attempted_candidates_when_missing() {
        let dir = tempfile::tempdir().unwrap();
        let mut env = HashMap::new();
        env.insert("Path".to_string(), dir.path().to_string_lossy().to_string());
        env.insert("PATHEXT".to_string(), ".EXE;.CMD".to_string());

        let attempts = windows_stdio_command_attempts_for_env("missing", &env);

        assert!(attempts.iter().any(|path| path.ends_with("missing.exe")));
        assert!(attempts.iter().any(|path| path.ends_with("missing.cmd")));
    }

    #[tokio::test]
    async fn call_tool_stdio_does_not_hang_when_initialize_stdout_is_non_json_then_eof() {
        let mut env = HashMap::new();
        if let Ok(path) = std::env::var("PATH") {
            env.insert("PATH".to_string(), path);
        }
        let manager = StdioClientManager::new();
        let launch = StdioServerLaunch {
            server_id: "non-json-stdout".to_string(),
            command: "python3".to_string(),
            args: vec!["-c".to_string(), "print('npm notice')".to_string()],
            env,
        };

        let result = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            manager.call_tool(
                launch,
                StdioToolCall {
                    name: "fetch_url".to_string(),
                    arguments: serde_json::json!({}),
                },
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

    #[tokio::test]
    async fn stdio_client_reuses_process_between_discovery_and_tool_call() {
        let dir = tempfile::tempdir().unwrap();
        let counter_path = dir.path().join("starts.txt");
        let launch = test_stdio_launch("reuse", &counter_path);
        let manager = StdioClientManager::new();

        let tools = manager.discover_tools(launch.clone()).await.unwrap();
        assert_eq!(tools.len(), 1);

        let result = manager
            .call_tool(
                launch,
                StdioToolCall {
                    name: "echo".to_string(),
                    arguments: serde_json::json!({}),
                },
            )
            .await
            .unwrap();
        assert_eq!(
            tools[0].description.as_deref(),
            Some(result.content.as_str())
        );

        let start_count = fs::read_to_string(counter_path).unwrap();
        assert_eq!(start_count, "1", "stdio MCP server must stay connected");
        manager.close_all().await.unwrap();
    }

    #[tokio::test]
    async fn lifecycle_lock_serializes_same_server_only() {
        let manager = StdioClientManager::new();
        let first = manager.lock_lifecycle("same").await;
        let waiting = manager.lock_lifecycle("same");
        futures::pin_mut!(waiting);
        assert!(futures::poll!(waiting.as_mut()).is_pending());

        let other =
            tokio::time::timeout(Duration::from_millis(100), manager.lock_lifecycle("other"))
                .await
                .unwrap();
        drop(other);
        drop(first);

        tokio::time::timeout(Duration::from_millis(100), waiting)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn stdio_client_single_flights_concurrent_first_connection() {
        let dir = tempfile::tempdir().unwrap();
        let counter_path = dir.path().join("starts.txt");
        let launch = test_stdio_launch("single-flight", &counter_path);
        let manager = StdioClientManager::new();

        let (first, second) = tokio::join!(
            manager.discover_tools(launch.clone()),
            manager.discover_tools(launch)
        );

        assert_eq!(first.unwrap().len(), 1);
        assert_eq!(second.unwrap().len(), 1);
        assert_eq!(fs::read_to_string(counter_path).unwrap(), "1");
        manager.close_all().await.unwrap();
    }

    #[tokio::test]
    async fn stdio_client_keeps_different_server_ids_isolated() {
        let dir = tempfile::tempdir().unwrap();
        let counter_path = dir.path().join("starts.txt");
        let first_launch = test_stdio_launch("first", &counter_path);
        let mut second_launch = first_launch.clone();
        second_launch.server_id = "second".to_string();
        let manager = StdioClientManager::new();

        let first = manager.discover_tools(first_launch).await.unwrap();
        let second = manager.discover_tools(second_launch).await.unwrap();

        assert_ne!(first[0].description, second[0].description);
        assert_eq!(fs::read_to_string(counter_path).unwrap(), "2");
        manager.close_all().await.unwrap();
    }

    #[tokio::test]
    async fn stdio_client_reconnects_when_launch_snapshot_changes() {
        let dir = tempfile::tempdir().unwrap();
        let counter_path = dir.path().join("starts.txt");
        let first_launch = test_stdio_launch("configured", &counter_path);
        let mut changed_launch = first_launch.clone();
        changed_launch
            .args
            .push("ignored-config-change".to_string());
        let manager = StdioClientManager::new();

        let first = manager.discover_tools(first_launch).await.unwrap();
        let second = manager.discover_tools(changed_launch).await.unwrap();

        assert_ne!(first[0].description, second[0].description);
        assert_eq!(fs::read_to_string(counter_path).unwrap(), "2");
        manager.close_all().await.unwrap();
    }

    #[tokio::test]
    async fn stdio_client_reconnects_before_call_after_transport_closes() {
        let dir = tempfile::tempdir().unwrap();
        let counter_path = dir.path().join("starts.txt");
        let mut launch = test_stdio_launch("closed-transport", &counter_path);
        launch
            .env
            .insert("AQBOT_TEST_EXIT_AFTER_LIST".to_string(), "1".to_string());
        let manager = StdioClientManager::new();

        manager.discover_tools(launch.clone()).await.unwrap();
        let slot = manager.slot_for(&launch.server_id).await.unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let transport_closed = slot
                    .state
                    .lock()
                    .await
                    .client
                    .as_ref()
                    .is_some_and(|client| client.is_transport_closed());
                if transport_closed {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();

        let result = manager
            .call_tool(
                launch,
                StdioToolCall {
                    name: "echo".to_string(),
                    arguments: serde_json::json!({}),
                },
            )
            .await
            .unwrap();

        assert!(result.content.ends_with(":2"), "{}", result.content);
        assert_eq!(fs::read_to_string(counter_path).unwrap(), "2");
        manager.close_all().await.unwrap();
    }

    #[tokio::test]
    async fn stdio_client_reconnects_after_disconnect() {
        let dir = tempfile::tempdir().unwrap();
        let counter_path = dir.path().join("starts.txt");
        let launch = test_stdio_launch("disconnect", &counter_path);
        let manager = StdioClientManager::new();

        manager.discover_tools(launch.clone()).await.unwrap();
        manager.disconnect(&launch.server_id).await.unwrap();
        manager.discover_tools(launch).await.unwrap();

        assert_eq!(fs::read_to_string(counter_path).unwrap(), "2");
        manager.close_all().await.unwrap();
    }

    #[tokio::test]
    async fn disabled_server_allows_discovery_but_blocks_calls_until_authorized() {
        let dir = tempfile::tempdir().unwrap();
        let counter_path = dir.path().join("starts.txt");
        let launch = test_stdio_launch("disabled", &counter_path);
        let manager = StdioClientManager::new();

        manager
            .disable(&launch.server_id, Some(launch.clone()))
            .await
            .unwrap();
        let tools = manager.discover_tools(launch.clone()).await.unwrap();
        let error = manager
            .call_tool(
                launch.clone(),
                StdioToolCall {
                    name: "echo".to_string(),
                    arguments: serde_json::json!({}),
                },
            )
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("disabled"), "{error}");

        manager.authorize(launch.clone()).await.unwrap();
        let result = manager
            .call_tool(
                launch,
                StdioToolCall {
                    name: "echo".to_string(),
                    arguments: serde_json::json!({}),
                },
            )
            .await
            .unwrap();

        assert_eq!(
            tools[0].description.as_deref(),
            Some(result.content.as_str())
        );
        assert_eq!(fs::read_to_string(counter_path).unwrap(), "1");
        manager.close_all().await.unwrap();
    }

    #[tokio::test]
    async fn reconfigure_rejects_stale_launch_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let counter_path = dir.path().join("starts.txt");
        let launch = test_stdio_launch("reconfigured", &counter_path);
        let mut changed_launch = launch.clone();
        changed_launch.args.push("new-config".to_string());
        let manager = StdioClientManager::new();

        manager.discover_tools(launch.clone()).await.unwrap();
        manager.reconfigure(changed_launch.clone()).await.unwrap();
        let error = manager
            .discover_tools(launch)
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("configuration changed"), "{error}");

        manager.discover_tools(changed_launch).await.unwrap();
        assert_eq!(fs::read_to_string(counter_path).unwrap(), "2");
        manager.close_all().await.unwrap();
    }

    #[tokio::test]
    async fn removed_server_rejects_stale_discovery_and_calls() {
        let dir = tempfile::tempdir().unwrap();
        let counter_path = dir.path().join("starts.txt");
        let launch = test_stdio_launch("removed", &counter_path);
        let manager = StdioClientManager::new();

        manager.discover_tools(launch.clone()).await.unwrap();
        manager.remove(&launch.server_id).await.unwrap();
        let discover_error = manager
            .discover_tools(launch.clone())
            .await
            .unwrap_err()
            .to_string();
        let call_error = manager
            .call_tool(
                launch,
                StdioToolCall {
                    name: "echo".to_string(),
                    arguments: serde_json::json!({}),
                },
            )
            .await
            .unwrap_err()
            .to_string();

        assert!(discover_error.contains("removed"), "{discover_error}");
        assert!(call_error.contains("removed"), "{call_error}");
        assert_eq!(fs::read_to_string(counter_path).unwrap(), "1");
        manager.close_all().await.unwrap();
    }

    #[tokio::test]
    async fn disabling_server_cancels_active_tool_call() {
        let dir = tempfile::tempdir().unwrap();
        let counter_path = dir.path().join("starts.txt");
        let call_counter_path =
            std::path::PathBuf::from(format!("{}.calls", counter_path.to_string_lossy()));
        let launch = test_stdio_launch("active-disable", &counter_path);
        let manager = StdioClientManager::new();
        manager.discover_tools(launch.clone()).await.unwrap();

        let call_manager = manager.clone();
        let call_launch = launch.clone();
        let active_call = tokio::spawn(async move {
            call_manager
                .call_tool(
                    call_launch,
                    StdioToolCall {
                        name: "echo".to_string(),
                        arguments: serde_json::json!({"delayMs": 10_000}),
                    },
                )
                .await
        });
        tokio::time::timeout(Duration::from_secs(2), async {
            while !call_counter_path.exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();

        let server_id = launch.server_id.clone();
        tokio::time::timeout(
            Duration::from_secs(5),
            manager.disable(&server_id, Some(launch)),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(active_call.await.unwrap().is_err());
        manager.close_all().await.unwrap();
    }

    #[tokio::test]
    async fn disabling_server_terminates_child_when_request_write_stalls() {
        let dir = tempfile::tempdir().unwrap();
        let counter_path = dir.path().join("starts.txt");
        let initialized_path =
            std::path::PathBuf::from(format!("{}.initialized", counter_path.to_string_lossy()));
        let mut launch = test_stdio_launch("stalled-write", &counter_path);
        launch.env.insert(
            "AQBOT_TEST_STOP_READING_MS".to_string(),
            "10000".to_string(),
        );
        let manager = StdioClientManager::new();

        let call_manager = manager.clone();
        let call_launch = launch.clone();
        let active_call = tokio::spawn(async move {
            call_manager
                .call_tool(
                    call_launch,
                    StdioToolCall {
                        name: "echo".to_string(),
                        arguments: serde_json::json!({"payload": "x".repeat(2 * 1024 * 1024)}),
                    },
                )
                .await
        });
        tokio::time::timeout(Duration::from_secs(2), async {
            while !initialized_path.exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;

        let server_id = launch.server_id.clone();
        tokio::time::timeout(
            Duration::from_secs(6),
            manager.disable(&server_id, Some(launch)),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(active_call.await.unwrap().is_err());
        manager.close_all().await.unwrap();
    }

    #[tokio::test]
    async fn disabling_server_cancels_initialization_handshake() {
        let dir = tempfile::tempdir().unwrap();
        let counter_path = dir.path().join("starts.txt");
        let mut launch = test_stdio_launch("handshake-disable", &counter_path);
        launch
            .env
            .insert("AQBOT_TEST_INIT_DELAY_MS".to_string(), "10000".to_string());
        let manager = StdioClientManager::new();

        let discovery_manager = manager.clone();
        let discovery_launch = launch.clone();
        let discovery =
            tokio::spawn(async move { discovery_manager.discover_tools(discovery_launch).await });
        tokio::time::timeout(Duration::from_secs(2), async {
            while !counter_path.exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();

        let server_id = launch.server_id.clone();
        tokio::time::timeout(
            Duration::from_secs(3),
            manager.disable(&server_id, Some(launch)),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(discovery.await.unwrap().is_err());
        manager.close_all().await.unwrap();
    }

    #[tokio::test]
    async fn disconnect_rejects_operation_waiting_before_slot_creation() {
        let dir = tempfile::tempdir().unwrap();
        let counter_path = dir.path().join("starts.txt");
        let launch = test_stdio_launch("pre-slot-disconnect", &counter_path);
        let manager = StdioClientManager::new();

        let policy_guard = manager.launch_policies.lock().await;
        let pending_discovery = manager.discover_tools(launch.clone());
        futures::pin_mut!(pending_discovery);
        assert!(futures::poll!(pending_discovery.as_mut()).is_pending());

        manager.disconnect(&launch.server_id).await.unwrap();
        drop(policy_guard);

        let error = pending_discovery.await.unwrap_err().to_string();
        assert!(error.contains("disconnected"), "{error}");
        assert!(!counter_path.exists());
        manager.close_all().await.unwrap();
    }

    #[tokio::test]
    async fn queued_call_on_disconnected_slot_is_rejected_before_reconnect() {
        let dir = tempfile::tempdir().unwrap();
        let counter_path = dir.path().join("starts.txt");
        let launch = test_stdio_launch("retired", &counter_path);
        let manager = StdioClientManager::new();
        manager.discover_tools(launch.clone()).await.unwrap();

        let slot = manager.slot_for(&launch.server_id).await.unwrap();
        let state_guard = slot.state.lock().await;
        let queued = manager.discover_tools(launch.clone());
        futures::pin_mut!(queued);
        assert!(futures::poll!(queued.as_mut()).is_pending());

        let server_id = launch.server_id.clone();
        let disconnect = manager.disconnect(&server_id);
        futures::pin_mut!(disconnect);
        assert!(futures::poll!(disconnect.as_mut()).is_pending());
        assert!(slot.retired.load(Ordering::Acquire));

        drop(state_guard);
        let error = queued.await.unwrap_err().to_string();
        assert!(error.contains("disconnected"), "{error}");
        disconnect.await.unwrap();

        manager.discover_tools(launch).await.unwrap();
        assert_eq!(fs::read_to_string(counter_path).unwrap(), "2");
        manager.close_all().await.unwrap();
    }

    #[tokio::test]
    async fn close_all_rejects_new_stdio_connections() {
        let dir = tempfile::tempdir().unwrap();
        let counter_path = dir.path().join("starts.txt");
        let launch = test_stdio_launch("shutdown", &counter_path);
        let manager = StdioClientManager::new();

        manager.discover_tools(launch.clone()).await.unwrap();
        manager.close_all().await.unwrap();
        let error = manager
            .discover_tools(launch)
            .await
            .unwrap_err()
            .to_string();

        assert!(error.contains("shutting down"), "{error}");
        assert_eq!(fs::read_to_string(counter_path).unwrap(), "1");
        manager.close_all().await.unwrap();
    }

    #[tokio::test]
    async fn mcp_application_error_keeps_stdio_connection_reusable() {
        let dir = tempfile::tempdir().unwrap();
        let counter_path = dir.path().join("starts.txt");
        let launch = test_stdio_launch("application-error", &counter_path);
        let manager = StdioClientManager::new();

        let error = manager
            .call_tool(
                launch.clone(),
                StdioToolCall {
                    name: "echo".to_string(),
                    arguments: serde_json::json!({"rpcError": true}),
                },
            )
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("expected tool error"), "{error}");

        let result = manager
            .call_tool(
                launch,
                StdioToolCall {
                    name: "echo".to_string(),
                    arguments: serde_json::json!({}),
                },
            )
            .await
            .unwrap();

        assert!(result.content.ends_with(":1"), "{}", result.content);
        assert_eq!(fs::read_to_string(counter_path).unwrap(), "1");
        manager.close_all().await.unwrap();
    }

    #[tokio::test]
    async fn cancelled_tool_call_invalidates_connection_without_replay() {
        let dir = tempfile::tempdir().unwrap();
        let counter_path = dir.path().join("starts.txt");
        let call_counter_path =
            std::path::PathBuf::from(format!("{}.calls", counter_path.to_string_lossy()));
        let launch = test_stdio_launch("cancelled", &counter_path);
        let manager = StdioClientManager::new();
        manager.discover_tools(launch.clone()).await.unwrap();

        let timed_out = tokio::time::timeout(
            Duration::from_millis(50),
            manager.call_tool(
                launch.clone(),
                StdioToolCall {
                    name: "echo".to_string(),
                    arguments: serde_json::json!({"delayMs": 300}),
                },
            ),
        )
        .await;
        assert!(timed_out.is_err());

        let result = manager
            .call_tool(
                launch,
                StdioToolCall {
                    name: "echo".to_string(),
                    arguments: serde_json::json!({}),
                },
            )
            .await
            .unwrap();

        assert!(result.content.ends_with(":2"), "{}", result.content);
        assert_eq!(fs::read_to_string(counter_path).unwrap(), "2");
        assert_eq!(fs::read_to_string(call_counter_path).unwrap(), "2");
        manager.close_all().await.unwrap();
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
