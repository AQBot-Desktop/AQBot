use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use aqbot_core::repo::cli_config::{connect, get_config_path, CliTool};
use serde_json::{json, Value};

static ENV_MUTEX: Mutex<()> = Mutex::new(());
static TEMP_HOME_COUNTER: AtomicUsize = AtomicUsize::new(0);

struct TempHome {
    root: PathBuf,
    home: PathBuf,
    appdata: PathBuf,
    saved_home: Option<OsString>,
    saved_userprofile: Option<OsString>,
    saved_appdata: Option<OsString>,
}

impl TempHome {
    fn new() -> Self {
        let nonce = TEMP_HOME_COUNTER.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "aqbot-cli-config-test-{}-{nonce}",
            std::process::id()
        ));
        let home = root.join("home");
        let appdata = root.join("appdata");

        std::fs::create_dir_all(&home).expect("create temp home");
        std::fs::create_dir_all(&appdata).expect("create temp appdata");

        let saved_home = std::env::var_os("HOME");
        let saved_userprofile = std::env::var_os("USERPROFILE");
        let saved_appdata = std::env::var_os("APPDATA");

        unsafe {
            std::env::set_var("HOME", &home);
            std::env::set_var("USERPROFILE", &home);
            std::env::set_var("APPDATA", &appdata);
        }

        Self {
            root,
            home,
            appdata,
            saved_home,
            saved_userprofile,
            saved_appdata,
        }
    }

    fn root(&self) -> &Path {
        &self.root
    }

    fn home(&self) -> &Path {
        &self.home
    }

    fn appdata(&self) -> &Path {
        &self.appdata
    }

    fn saved_home(&self) -> Option<&OsStr> {
        self.saved_home.as_deref()
    }

    fn saved_userprofile(&self) -> Option<&OsStr> {
        self.saved_userprofile.as_deref()
    }

    fn saved_appdata(&self) -> Option<&OsStr> {
        self.saved_appdata.as_deref()
    }
}

impl Drop for TempHome {
    fn drop(&mut self) {
        restore_env_var("HOME", self.saved_home.as_deref());
        restore_env_var("USERPROFILE", self.saved_userprofile.as_deref());
        restore_env_var("APPDATA", self.saved_appdata.as_deref());
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn restore_env_var(key: &str, value: Option<&OsStr>) {
    unsafe {
        match value {
            Some(value) => std::env::set_var(key, value),
            None => std::env::remove_var(key),
        }
    }
}

fn with_temp_home<T>(test: impl FnOnce(&TempHome) -> T) -> T {
    let _guard = ENV_MUTEX
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    let temp_home = TempHome::new();
    test(&temp_home)
}

fn write_json(path: &Path, value: &Value) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("create parent directories for write_json");
    }
    let content = serde_json::to_string_pretty(value).expect("serialize json for write_json");
    std::fs::write(path, content).expect("write json test fixture");
}

fn read_json(path: &Path) -> Value {
    let content = std::fs::read_to_string(path).expect("read json test fixture");
    serde_json::from_str(&content).expect("parse json test fixture")
}

fn gemini_env_path(home: &Path) -> PathBuf {
    home.join(".gemini").join(".env")
}

fn gemini_settings_path(home: &Path) -> PathBuf {
    home.join(".gemini").join("settings.json")
}

fn claude_settings_path(home: &Path) -> PathBuf {
    home.join(".claude").join("settings.json")
}

fn claude_config_path(home: &Path) -> PathBuf {
    home.join(".claude").join("config.json")
}

fn codex_auth_path(home: &Path) -> PathBuf {
    home.join(".codex").join("auth.json")
}

fn codex_config_path(home: &Path) -> PathBuf {
    home.join(".codex").join("config.toml")
}

fn opencode_config_path(home: &Path) -> PathBuf {
    home.join(".config").join("opencode").join("opencode.json")
}

#[cfg(target_os = "macos")]
fn cursor_settings_path(home: &Path, _appdata: &Path) -> PathBuf {
    home.join("Library")
        .join("Application Support")
        .join("Cursor")
        .join("User")
        .join("settings.json")
}

#[cfg(target_os = "windows")]
fn cursor_settings_path(_home: &Path, appdata: &Path) -> PathBuf {
    appdata.join("Cursor").join("User").join("settings.json")
}

#[cfg(target_os = "linux")]
fn cursor_settings_path(home: &Path, _appdata: &Path) -> PathBuf {
    home.join(".config")
        .join("Cursor")
        .join("User")
        .join("settings.json")
}

#[test]
fn harness_restores_environment_after_run() {
    let _guard = ENV_MUTEX
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    let restored_env =
        std::sync::Mutex::new(None::<(Option<OsString>, Option<OsString>, Option<OsString>)>);
    let temp_root = std::sync::Mutex::new(None::<PathBuf>);

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let temp_home = TempHome::new();
        *restored_env.lock().expect("lock restored_env") = Some((
            temp_home.saved_home().map(OsStr::to_os_string),
            temp_home.saved_userprofile().map(OsStr::to_os_string),
            temp_home.saved_appdata().map(OsStr::to_os_string),
        ));
        *temp_root.lock().expect("lock temp_root") = Some(temp_home.root().to_path_buf());

        assert_eq!(
            std::env::var_os("HOME").as_deref(),
            Some(temp_home.home().as_os_str())
        );
        assert_eq!(
            std::env::var_os("USERPROFILE").as_deref(),
            Some(temp_home.home().as_os_str())
        );
        assert_eq!(
            std::env::var_os("APPDATA").as_deref(),
            Some(temp_home.appdata().as_os_str())
        );

        let opencode_path = opencode_config_path(temp_home.home());
        write_json(
            &opencode_path,
            &json!({ "provider": { "aqbot": { "enabled": true } } }),
        );
        assert_eq!(
            read_json(&opencode_path),
            json!({ "provider": { "aqbot": { "enabled": true } } })
        );

        panic!("intentional panic to verify Drop cleanup");
    }));

    assert!(
        result.is_err(),
        "test harness should preserve cleanup during panic"
    );
    let Some((restored_home, restored_userprofile, restored_appdata)) = restored_env
        .lock()
        .expect("lock restored_env after panic")
        .clone()
    else {
        panic!("TempHome::new() panicked before the harness captured saved env values");
    };
    assert_eq!(std::env::var_os("HOME"), restored_home);
    assert_eq!(std::env::var_os("USERPROFILE"), restored_userprofile);
    assert_eq!(std::env::var_os("APPDATA"), restored_appdata);

    let temp_root = temp_root
        .lock()
        .expect("lock temp_root after panic")
        .clone()
        .expect("capture temp_root path");
    assert!(
        !temp_root.exists(),
        "temporary test root should be removed in Drop: {temp_root:?}"
    );
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
#[test]
fn cursor_path_uses_current_platform_layout() {
    with_temp_home(|temp_home| {
        let expected = cursor_settings_path(temp_home.home(), temp_home.appdata());
        let production = PathBuf::from(
            get_config_path(CliTool::Cursor).expect("get_config_path(Cursor) should succeed"),
        );

        assert_eq!(production, expected);
    });
}

#[test]
fn gemini_connect_writes_both_env_and_settings() {
    with_temp_home(|temp_home| {
        connect(CliTool::Gemini, "http://localhost:1234/v1", "test-api-key")
            .expect("connect(Gemini) should succeed before contract assertions");

        let env_path = gemini_env_path(temp_home.home());
        let settings_path = gemini_settings_path(temp_home.home());

        assert!(env_path.exists(), "expected Gemini .env at {env_path:?}");
        assert!(
            settings_path.exists(),
            "expected Gemini settings.json at {settings_path:?}"
        );
    });
}

#[test]
fn claude_connect_writes_anthropic_env_settings_and_config() {
    with_temp_home(|temp_home| {
        connect(
            CliTool::ClaudeCode,
            "http://localhost:1234/v1",
            "test-api-key",
        )
        .expect("connect(ClaudeCode) should succeed before contract assertions");

        let settings_path = claude_settings_path(temp_home.home());
        let config_path = claude_config_path(temp_home.home());

        assert!(
            settings_path.exists(),
            "expected Claude settings.json at {settings_path:?}"
        );
        let settings = read_json(&settings_path);
        assert_eq!(settings["env"]["ANTHROPIC_BASE_URL"], "http://localhost:1234/v1");
        assert_eq!(settings["env"]["ANTHROPIC_AUTH_TOKEN"], "test-api-key");
        assert!(
            config_path.exists(),
            "expected Claude config.json at {config_path:?}"
        );
        let config = read_json(&config_path);
        assert_eq!(config["primaryApiKey"], "any");
    });
}

#[test]
fn claude_connect_overwrites_existing_anthropic_env_settings() {
    with_temp_home(|temp_home| {
        let settings_path = claude_settings_path(temp_home.home());
        let config_path = claude_config_path(temp_home.home());

        write_json(
            &settings_path,
            &json!({
                "env": {
                    "ANTHROPIC_BASE_URL": "http://62.204.54.105:3000",
                    "ANTHROPIC_AUTH_TOKEN": "old-token",
                    "ANTHROPIC_MODEL": "claude-opus-4-6"
                },
                "permissions": {
                    "allow": ["mcp__pencil"]
                }
            }),
        );
        write_json(&config_path, &json!({ "primaryApiKey": "old-value" }));

        connect(
            CliTool::ClaudeCode,
            "https://127.0.0.1:8443/v1",
            "new-token",
        )
        .expect("connect should succeed");

        let settings = read_json(&settings_path);
        assert_eq!(
            settings["env"]["ANTHROPIC_BASE_URL"],
            "https://127.0.0.1:8443/v1"
        );
        assert_eq!(settings["env"]["ANTHROPIC_AUTH_TOKEN"], "new-token");
        assert_eq!(settings["env"]["ANTHROPIC_MODEL"], "claude-opus-4-6");
        assert_eq!(settings["permissions"]["allow"][0], "mcp__pencil");

        let config = read_json(&config_path);
        assert_eq!(config["primaryApiKey"], "any");
    });
}

#[test]
fn codex_connect_writes_openai_api_key_auth_and_proxy_provider_contract() {
    with_temp_home(|temp_home| {
        connect(CliTool::Codex, "http://localhost:1234/v1", "test-api-key")
            .expect("connect(Codex) should succeed before contract assertions");

        let auth_path = codex_auth_path(temp_home.home());
        let config_path = codex_config_path(temp_home.home());

        let auth = read_json(&auth_path);
        assert_eq!(
            auth.get("OPENAI_API_KEY").and_then(|value| value.as_str()),
            Some("test-api-key"),
            "Codex auth.json should store AQBot's key as OPENAI_API_KEY"
        );
        assert!(
            auth.get("token").is_none(),
            "Codex auth.json should no longer use the legacy token field"
        );

        let config = std::fs::read_to_string(&config_path).expect("read Codex config.toml");
        let doc = config
            .parse::<toml_edit::DocumentMut>()
            .expect("parse Codex config.toml");

        assert_eq!(
            doc.get("model_provider").and_then(|value| value.as_str()),
            Some("any"),
            "Codex should keep using the existing AQBot provider slot"
        );

        let provider = doc
            .get("model_providers")
            .and_then(|value| value.as_table())
            .and_then(|table| table.get("any"))
            .and_then(|value| value.as_table())
            .expect("Codex config.toml should contain [model_providers.any]");

        assert_eq!(
            provider.get("base_url").and_then(|value| value.as_str()),
            Some("http://localhost:1234/v1"),
            "Codex provider should point at the AQBot gateway URL"
        );
        assert_eq!(
            provider.get("wire_api").and_then(|value| value.as_str()),
            Some("responses"),
            "Codex provider should keep using the responses wire API"
        );
        assert_eq!(
            provider
                .get("requires_openai_auth")
                .and_then(|value| value.as_bool()),
            Some(true),
            "Codex provider should opt into OpenAI-auth-compatible key loading"
        );
    });
}

#[test]
fn gemini_validation_requires_both_env_and_settings() {
    use aqbot_core::repo::cli_config::validate_connection;
    
    with_temp_home(|temp_home| {
        let env_path = gemini_env_path(temp_home.home());
        let settings_path = gemini_settings_path(temp_home.home());
        
        // Write only .env, missing settings.json
        std::fs::create_dir_all(env_path.parent().unwrap()).unwrap();
        std::fs::write(
            &env_path,
            "GEMINI_API_KEY=test-key\nGEMINI_API_BASE_URL=http://localhost:1234/v1\n",
        )
        .unwrap();
        
        assert_eq!(
            validate_connection(CliTool::Gemini, "http://localhost:1234/v1").unwrap(),
            false,
            "should reject when settings.json is missing"
        );
        
        // Add settings.json with correct selectedType
        write_json(
            &settings_path,
            &json!({
                "security": {
                    "auth": {
                        "selectedType": "gemini-api-key"
                    }
                }
            }),
        );
        
        assert_eq!(
            validate_connection(CliTool::Gemini, "http://localhost:1234/v1").unwrap(),
            true,
            "should accept when both files are correct"
        );
    });
}

#[test]
fn codex_validation_requires_openai_api_key_auth_and_proxy_provider_contract() {
    use aqbot_core::repo::cli_config::validate_connection;

    with_temp_home(|temp_home| {
        let auth_path = codex_auth_path(temp_home.home());
        let config_path = codex_config_path(temp_home.home());

        assert_eq!(
            validate_connection(CliTool::Codex, "http://localhost:1234/v1").unwrap(),
            false,
            "should reject when Codex config files are missing"
        );

        std::fs::create_dir_all(auth_path.parent().expect("codex auth parent"))
            .expect("create Codex config directory");

        write_json(
            &auth_path,
            &json!({
                "token": "legacy-api-key",
                "token_type": "api_key"
            }),
        );
        std::fs::write(
            &config_path,
            r#"model_provider = "any"

[model_providers.any]
base_url = "http://localhost:1234/v1"
wire_api = "responses"
requires_openai_auth = true
"#,
        )
        .expect("write legacy-shape Codex config.toml");

        assert_eq!(
            validate_connection(CliTool::Codex, "http://localhost:1234/v1").unwrap(),
            false,
            "should reject legacy token-based auth.json even if the provider table exists"
        );

        write_json(
            &auth_path,
            &json!({
                "OPENAI_API_KEY": "test-api-key"
            }),
        );

        assert_eq!(
            validate_connection(CliTool::Codex, "http://localhost:1234/v1").unwrap(),
            true,
            "should accept OPENAI_API_KEY auth.json plus requires_openai_auth provider config"
        );
    });
}

#[test]
fn gemini_validation_drift_rejects_wrong_selected_type() {
    use aqbot_core::repo::cli_config::validate_connection;
    
    with_temp_home(|temp_home| {
        connect(CliTool::Gemini, "http://localhost:1234/v1", "test-api-key")
            .expect("connect should succeed");
        
        // Verify initially connected
        assert_eq!(
            validate_connection(CliTool::Gemini, "http://localhost:1234/v1").unwrap(),
            true
        );
        
        // User manually changes selectedType
        let settings_path = gemini_settings_path(temp_home.home());
        write_json(
            &settings_path,
            &json!({
                "security": {
                    "auth": {
                        "selectedType": "oauth"
                    }
                }
            }),
        );
        
        // Should now be disconnected
        assert_eq!(
            validate_connection(CliTool::Gemini, "http://localhost:1234/v1").unwrap(),
            false,
            "should detect drift when selectedType changes"
        );
    });
}

#[test]
fn claude_validation_requires_anthropic_env_and_primary_api_key() {
    use aqbot_core::repo::cli_config::validate_connection;
    
    with_temp_home(|temp_home| {
        let settings_path = claude_settings_path(temp_home.home());
        let config_path = claude_config_path(temp_home.home());
        
        // Write only settings.json, missing config.json
        write_json(
            &settings_path,
            &json!({
                "env": {
                    "ANTHROPIC_BASE_URL": "http://localhost:1234/v1",
                    "ANTHROPIC_AUTH_TOKEN": "test-api-key"
                }
            }),
        );
        
        assert_eq!(
            validate_connection(CliTool::ClaudeCode, "http://localhost:1234/v1").unwrap(),
            false,
            "should reject when config.json is missing"
        );
        
        // Add config.json with primaryApiKey == "any"
        write_json(&config_path, &json!({ "primaryApiKey": "any" }));
        
        assert_eq!(
            validate_connection(CliTool::ClaudeCode, "http://localhost:1234/v1").unwrap(),
            true,
            "should accept when Anthropic env settings and primaryApiKey are correct"
        );
    });
}

#[test]
fn claude_validation_rejects_stale_anthropic_env_override() {
    use aqbot_core::repo::cli_config::validate_connection;

    with_temp_home(|temp_home| {
        let settings_path = claude_settings_path(temp_home.home());
        let config_path = claude_config_path(temp_home.home());

        write_json(
            &settings_path,
            &json!({
                "apiBaseUrl": "http://localhost:1234/v1",
                "apiKey": "test-api-key",
                "env": {
                    "ANTHROPIC_BASE_URL": "http://62.204.54.105:3000",
                    "ANTHROPIC_AUTH_TOKEN": "old-token",
                    "ANTHROPIC_MODEL": "claude-opus-4-6"
                }
            }),
        );
        write_json(&config_path, &json!({ "primaryApiKey": "any" }));

        assert_eq!(
            validate_connection(CliTool::ClaudeCode, "http://localhost:1234/v1").unwrap(),
            false,
            "should reject when effective Anthropic env settings still point at the old gateway"
        );
    });
}

#[test]
fn claude_validation_drift_rejects_wrong_primary_api_key() {
    use aqbot_core::repo::cli_config::validate_connection;
    
    with_temp_home(|temp_home| {
        connect(
            CliTool::ClaudeCode,
            "http://localhost:1234/v1",
            "test-api-key",
        )
        .expect("connect should succeed");
        
        // Verify initially connected
        assert_eq!(
            validate_connection(CliTool::ClaudeCode, "http://localhost:1234/v1").unwrap(),
            true
        );
        
        // User manually changes primaryApiKey
        let config_path = claude_config_path(temp_home.home());
        write_json(&config_path, &json!({ "primaryApiKey": "some-other-value" }));
        
        // Should now be disconnected
        assert_eq!(
            validate_connection(CliTool::ClaudeCode, "http://localhost:1234/v1").unwrap(),
            false,
            "should detect drift when primaryApiKey changes"
        );
    });
}

#[test]
fn gemini_disconnect_restore_backup_restores_both_files() {
    use aqbot_core::repo::cli_config::disconnect;
    
    with_temp_home(|temp_home| {
        let env_path = gemini_env_path(temp_home.home());
        let settings_path = gemini_settings_path(temp_home.home());
        
        // Create original files
        write_json(
            &settings_path,
            &json!({
                "security": {
                    "auth": {
                        "selectedType": "oauth",
                        "oauthToken": "original-token"
                    }
                }
            }),
        );
        std::fs::create_dir_all(env_path.parent().unwrap()).unwrap();
        std::fs::write(&env_path, "ORIGINAL_VAR=original-value\n").unwrap();
        
        // Connect (this creates backups)
        connect(CliTool::Gemini, "http://localhost:1234/v1", "test-api-key")
            .expect("connect should succeed");
        
        // Verify files were modified
        let settings = read_json(&settings_path);
        assert_eq!(
            settings["security"]["auth"]["selectedType"],
            "gemini-api-key"
        );
        
        // Disconnect with restore
        disconnect(CliTool::Gemini, true, "http://localhost:1234/v1")
            .expect("disconnect restore should succeed");
        
        // Verify original files were restored
        let restored_settings = read_json(&settings_path);
        assert_eq!(restored_settings["security"]["auth"]["selectedType"], "oauth");
        assert_eq!(
            restored_settings["security"]["auth"]["oauthToken"],
            "original-token"
        );
        
        let restored_env = std::fs::read_to_string(&env_path).unwrap();
        assert!(restored_env.contains("ORIGINAL_VAR=original-value"));
        assert!(!restored_env.contains("GEMINI_API_KEY"));
    });
}

#[test]
fn claude_disconnect_restore_backup_restores_both_files() {
    use aqbot_core::repo::cli_config::disconnect;
    
    with_temp_home(|temp_home| {
        let settings_path = claude_settings_path(temp_home.home());
        let config_path = claude_config_path(temp_home.home());
        
        // Create original files
        write_json(
            &settings_path,
            &json!({
                "apiBaseUrl": "https://api.claude.ai",
                "apiKey": "original-claude-key"
            }),
        );
        write_json(&config_path, &json!({ "primaryApiKey": "user-key-123" }));
        
        // Connect (this creates backups)
        connect(
            CliTool::ClaudeCode,
            "http://localhost:1234/v1",
            "test-api-key",
        )
        .expect("connect should succeed");
        
        // Verify files were modified
        let settings = read_json(&settings_path);
        assert_eq!(settings["apiBaseUrl"], "http://localhost:1234/v1");
        let config = read_json(&config_path);
        assert_eq!(config["primaryApiKey"], "any");
        
        // Disconnect with restore
        disconnect(CliTool::ClaudeCode, true, "http://localhost:1234/v1")
            .expect("disconnect restore should succeed");
        
        // Verify original files were restored
        let restored_settings = read_json(&settings_path);
        assert_eq!(restored_settings["apiBaseUrl"], "https://api.claude.ai");
        assert_eq!(restored_settings["apiKey"], "original-claude-key");
        
        let restored_config = read_json(&config_path);
        assert_eq!(restored_config["primaryApiKey"], "user-key-123");
    });
}

#[test]
fn gemini_disconnect_minimal_cleanup_removes_only_aqbot_keys() {
    use aqbot_core::repo::cli_config::disconnect;
    
    with_temp_home(|temp_home| {
        let env_path = gemini_env_path(temp_home.home());
        let settings_path = gemini_settings_path(temp_home.home());
        
        // Create files with mix of AQBot and user data
        std::fs::create_dir_all(env_path.parent().unwrap()).unwrap();
        std::fs::write(
            &env_path,
            "USER_VAR=keep-this\nGEMINI_API_KEY=aqbot-key\nANOTHER_VAR=also-keep\nGEMINI_API_BASE_URL=http://localhost:1234/v1\n",
        )
        .unwrap();
        
        write_json(
            &settings_path,
            &json!({
                "security": {
                    "auth": {
                        "selectedType": "gemini-api-key",
                        "oauthToken": "keep-this-token"
                    }
                },
                "otherSetting": "keep-this"
            }),
        );
        
        // Disconnect without restore
        disconnect(CliTool::Gemini, false, "http://localhost:1234/v1")
            .expect("disconnect should succeed");
        
        // Verify only AQBot keys removed from .env
        let env_content = std::fs::read_to_string(&env_path).unwrap();
        assert!(env_content.contains("USER_VAR=keep-this"));
        assert!(env_content.contains("ANOTHER_VAR=also-keep"));
        assert!(!env_content.contains("GEMINI_API_KEY"));
        assert!(!env_content.contains("GEMINI_API_BASE_URL"));
        
        // Verify selectedType removed but other settings preserved
        let settings = read_json(&settings_path);
        assert!(!settings["security"]["auth"].as_object().unwrap().contains_key("selectedType"));
        assert_eq!(settings["security"]["auth"]["oauthToken"], "keep-this-token");
        assert_eq!(settings["otherSetting"], "keep-this");
    });
}

#[test]
fn claude_disconnect_minimal_cleanup_removes_only_aqbot_fields() {
    use aqbot_core::repo::cli_config::disconnect;
    
    with_temp_home(|temp_home| {
        let settings_path = claude_settings_path(temp_home.home());
        let config_path = claude_config_path(temp_home.home());
        
        // Create files with mix of AQBot and user data
        write_json(
            &settings_path,
            &json!({
                "apiBaseUrl": "http://localhost:1234/v1",
                "apiKey": "test-api-key",
                "userSetting": "keep-this"
            }),
        );
        
        write_json(
            &config_path,
            &json!({
                "primaryApiKey": "any",
                "otherConfig": "keep-this"
            }),
        );
        
        // Disconnect without restore
        disconnect(CliTool::ClaudeCode, false, "http://localhost:1234/v1")
            .expect("disconnect should succeed");
        
        // Verify AQBot fields removed from settings.json
        let settings = read_json(&settings_path);
        assert!(!settings.as_object().unwrap().contains_key("apiBaseUrl"));
        assert!(!settings.as_object().unwrap().contains_key("apiKey"));
        assert_eq!(settings["userSetting"], "keep-this");
        
        // Verify primaryApiKey removed from config.json
        let config = read_json(&config_path);
        assert!(!config.as_object().unwrap().contains_key("primaryApiKey"));
        assert_eq!(config["otherConfig"], "keep-this");
    });
}

#[test]
fn claude_disconnect_minimal_cleanup_removes_only_aqbot_anthropic_env_fields() {
    use aqbot_core::repo::cli_config::disconnect;

    with_temp_home(|temp_home| {
        let settings_path = claude_settings_path(temp_home.home());
        let config_path = claude_config_path(temp_home.home());

        write_json(
            &settings_path,
            &json!({
                "apiBaseUrl": "http://localhost:1234/v1",
                "apiKey": "test-api-key",
                "env": {
                    "ANTHROPIC_BASE_URL": "http://localhost:1234/v1",
                    "ANTHROPIC_AUTH_TOKEN": "test-api-key",
                    "ANTHROPIC_MODEL": "claude-opus-4-6"
                },
                "permissions": {
                    "allow": ["mcp__pencil"]
                }
            }),
        );
        write_json(
            &config_path,
            &json!({
                "primaryApiKey": "any",
                "otherConfig": "keep-this"
            }),
        );

        disconnect(CliTool::ClaudeCode, false, "http://localhost:1234/v1")
            .expect("disconnect should succeed");

        let settings = read_json(&settings_path);
        assert!(settings.get("apiBaseUrl").is_none());
        assert!(settings.get("apiKey").is_none());
        assert!(settings["env"].get("ANTHROPIC_BASE_URL").is_none());
        assert!(settings["env"].get("ANTHROPIC_AUTH_TOKEN").is_none());
        assert_eq!(settings["env"]["ANTHROPIC_MODEL"], "claude-opus-4-6");
        assert_eq!(settings["permissions"]["allow"][0], "mcp__pencil");

        let config = read_json(&config_path);
        assert!(config.get("primaryApiKey").is_none());
        assert_eq!(config["otherConfig"], "keep-this");
    });
}

#[test]
fn gemini_disconnect_minimal_cleanup_preserves_non_aqbot_selected_type() {
    use aqbot_core::repo::cli_config::disconnect;
    
    with_temp_home(|temp_home| {
        let env_path = gemini_env_path(temp_home.home());
        let settings_path = gemini_settings_path(temp_home.home());
        
        // User manually set selectedType to something else
        std::fs::create_dir_all(env_path.parent().unwrap()).unwrap();
        std::fs::write(
            &env_path,
            "GEMINI_API_KEY=key\nGEMINI_API_BASE_URL=http://localhost:1234/v1\n",
        )
        .unwrap();
        
        write_json(
            &settings_path,
            &json!({
                "security": {
                    "auth": {
                        "selectedType": "oauth"
                    }
                }
            }),
        );
        
        // Disconnect should succeed but leave selectedType alone
        disconnect(CliTool::Gemini, false, "http://localhost:1234/v1")
            .expect("disconnect should succeed");
        
        let settings = read_json(&settings_path);
        assert_eq!(settings["security"]["auth"]["selectedType"], "oauth",
            "should preserve non-gemini-api-key selectedType");
    });
}

#[test]
fn claude_disconnect_minimal_cleanup_preserves_non_any_primary_api_key() {
    use aqbot_core::repo::cli_config::disconnect;
    
    with_temp_home(|temp_home| {
        let settings_path = claude_settings_path(temp_home.home());
        let config_path = claude_config_path(temp_home.home());
        
        // Create files where primaryApiKey is not "any"
        write_json(
            &settings_path,
            &json!({
                "apiBaseUrl": "http://localhost:1234/v1",
                "apiKey": "test-api-key"
            }),
        );
        
        write_json(
            &config_path,
            &json!({
                "primaryApiKey": "user-custom-key"
            }),
        );
        
        // Disconnect should remove settings fields but preserve primaryApiKey
        disconnect(CliTool::ClaudeCode, false, "http://localhost:1234/v1")
            .expect("disconnect should succeed");
        
        let config = read_json(&config_path);
        assert_eq!(config["primaryApiKey"], "user-custom-key",
            "should preserve non-any primaryApiKey");
    });
}

#[test]
fn gemini_connect_rollback_on_post_write_validation_failure() {
    with_temp_home(|temp_home| {
        let env_path = gemini_env_path(temp_home.home());
        let settings_path = gemini_settings_path(temp_home.home());

        // Seed original files, but make settings.json invalid for connect_gemini()
        std::fs::create_dir_all(env_path.parent().unwrap()).unwrap();
        std::fs::write(&env_path, "ORIGINAL=value\n").unwrap();
        std::fs::write(&settings_path, "[]").unwrap();

        let err = connect(CliTool::Gemini, "http://localhost:1234/v1", "test-api-key")
            .expect_err("connect should fail and roll back when settings.json is not an object");

        let err_text = err.to_string();
        assert!(
            err_text.contains("rolled back"),
            "expected rollback error text, got: {err_text}"
        );

        let restored_env = std::fs::read_to_string(&env_path).unwrap();
        assert_eq!(restored_env, "ORIGINAL=value\n");
        assert_eq!(
            std::fs::read_to_string(&settings_path).unwrap(),
            "[]",
            "settings.json should be restored to its original invalid content"
        );
    });
}

#[test]
fn claude_connect_rollback_on_post_write_validation_failure() {
    with_temp_home(|temp_home| {
        let settings_path = claude_settings_path(temp_home.home());
        let config_path = claude_config_path(temp_home.home());

        // Seed original files, but make config.json invalid for connect_claude_code()
        write_json(&settings_path, &json!({ "original": "settings" }));
        std::fs::write(&config_path, "[]").unwrap();

        let err = connect(
            CliTool::ClaudeCode,
            "http://localhost:1234/v1",
            "test-api-key",
        )
        .expect_err("connect should fail and roll back when config.json is not an object");

        let err_text = err.to_string();
        assert!(
            err_text.contains("rolled back"),
            "expected rollback error text, got: {err_text}"
        );

        assert_eq!(
            read_json(&settings_path),
            json!({ "original": "settings" }),
            "settings.json should be restored after rollback"
        );
        assert_eq!(
            std::fs::read_to_string(&config_path).unwrap(),
            "[]",
            "config.json should be restored to its original invalid content"
        );
    });
}

// ─── OpenCode Tests ─────────────────────────────────────────

#[test]
fn opencode_connect_preserves_existing_non_aqbot_providers() {
    with_temp_home(|temp_home| {
        let config_path = opencode_config_path(temp_home.home());
        
        // Create config with existing providers
        write_json(
            &config_path,
            &json!({
                "$schema": "https://opencode.ai/config.json",
                "provider": {
                    "anthropic": {
                        "apiKey": "existing-key",
                        "models": {
                            "claude": {
                                "name": "Claude"
                            }
                        }
                    },
                    "openai": {
                        "apiKey": "openai-key",
                        "models": {
                            "gpt-4": {
                                "name": "GPT-4"
                            }
                        }
                    }
                }
            }),
        );
        
        connect(CliTool::OpenCode, "http://localhost:1234/v1", "test-api-key")
            .expect("connect should succeed");
        
        let config = read_json(&config_path);
        
        // Verify aqbot was added
        assert!(
            config
                .get("provider")
                .and_then(|p| p.get("aqbot"))
                .is_some(),
            "aqbot provider should be added"
        );
        
        // Verify existing providers are preserved
        let provider = config.get("provider").unwrap();
        assert_eq!(
            provider.get("anthropic").and_then(|p| p.get("apiKey")).and_then(|k| k.as_str()),
            Some("existing-key"),
            "anthropic provider should be preserved"
        );
        assert_eq!(
            provider.get("openai").and_then(|p| p.get("apiKey")).and_then(|k| k.as_str()),
            Some("openai-key"),
            "openai provider should be preserved"
        );
    });
}

#[test]
fn opencode_disconnect_without_restore_removes_only_aqbot_provider() {
    use aqbot_core::repo::cli_config::disconnect;
    
    with_temp_home(|temp_home| {
        let config_path = opencode_config_path(temp_home.home());
        
        // Create config with multiple providers including aqbot
        write_json(
            &config_path,
            &json!({
                "$schema": "https://opencode.ai/config.json",
                "provider": {
                    "aqbot": {
                        "apiKey": "test-key",
                        "baseURL": "http://localhost:1234/v1",
                        "models": {
                            "default": {
                                "name": "Default Model"
                            }
                        }
                    },
                    "anthropic": {
                        "apiKey": "existing-key",
                        "models": {
                            "claude": {
                                "name": "Claude"
                            }
                        }
                    }
                },
                "otherSetting": "value"
            }),
        );
        
        disconnect(CliTool::OpenCode, false, "http://localhost:1234/v1")
            .expect("disconnect without restore should succeed");
        
        let config = read_json(&config_path);
        
        // Verify aqbot was removed
        assert!(
            config
                .get("provider")
                .and_then(|p| p.get("aqbot"))
                .is_none(),
            "aqbot provider should be removed"
        );
        
        // Verify other providers and settings are preserved
        let provider = config.get("provider").unwrap();
        assert_eq!(
            provider.get("anthropic").and_then(|p| p.get("apiKey")).and_then(|k| k.as_str()),
            Some("existing-key"),
            "anthropic provider should be preserved"
        );
        assert_eq!(
            config.get("otherSetting").and_then(|v| v.as_str()),
            Some("value"),
            "other settings should be preserved"
        );
    });
}

#[test]
fn opencode_disconnect_with_restore_restores_original_config() {
    use aqbot_core::repo::cli_config::disconnect;
    
    with_temp_home(|temp_home| {
        let config_path = opencode_config_path(temp_home.home());
        
        // Create original config
        let original_config = json!({
            "$schema": "https://opencode.ai/config.json",
            "provider": {
                "anthropic": {
                    "apiKey": "original-key",
                    "models": {
                        "claude": {
                            "name": "Claude"
                        }
                    }
                }
            },
            "theme": "dark"
        });
        write_json(&config_path, &original_config);
        
        // Connect (this should create a backup)
        connect(CliTool::OpenCode, "http://localhost:1234/v1", "test-api-key")
            .expect("connect should succeed");
        
        // Verify connected state has aqbot
        let connected_config = read_json(&config_path);
        assert!(
            connected_config
                .get("provider")
                .and_then(|p| p.get("aqbot"))
                .is_some(),
            "aqbot should be present after connect"
        );
        
        // Disconnect with restore
        disconnect(CliTool::OpenCode, true, "http://localhost:1234/v1")
            .expect("disconnect with restore should succeed");
        
        // Verify original config is restored
        let restored_config = read_json(&config_path);
        assert_eq!(
            restored_config,
            original_config,
            "config should be restored to original state"
        );
    });
}

#[test]
fn opencode_validation_requires_aqbot_provider_with_correct_fields() {
    use aqbot_core::repo::cli_config::validate_connection;
    
    with_temp_home(|temp_home| {
        let config_path = opencode_config_path(temp_home.home());
        
        // Test 1: Missing config file
        assert_eq!(
            validate_connection(CliTool::OpenCode, "http://localhost:1234/v1").unwrap(),
            false,
            "should reject when config file is missing"
        );
        
        // Test 2: Config without provider section
        write_json(
            &config_path,
            &json!({
                "$schema": "https://opencode.ai/config.json"
            }),
        );
        assert_eq!(
            validate_connection(CliTool::OpenCode, "http://localhost:1234/v1").unwrap(),
            false,
            "should reject when provider section is missing"
        );
        
        // Test 3: Provider without aqbot
        write_json(
            &config_path,
            &json!({
                "$schema": "https://opencode.ai/config.json",
                "provider": {
                    "anthropic": {
                        "apiKey": "key"
                    }
                }
            }),
        );
        assert_eq!(
            validate_connection(CliTool::OpenCode, "http://localhost:1234/v1").unwrap(),
            false,
            "should reject when aqbot provider is missing"
        );
        
        // Test 4: aqbot with wrong baseURL
        write_json(
            &config_path,
            &json!({
                "provider": {
                    "aqbot": {
                        "apiKey": "test-key",
                        "baseURL": "http://wrong-url/v1"
                    }
                }
            }),
        );
        assert_eq!(
            validate_connection(CliTool::OpenCode, "http://localhost:1234/v1").unwrap(),
            false,
            "should reject when baseURL doesn't match"
        );
        
        // Test 5: aqbot with empty apiKey
        write_json(
            &config_path,
            &json!({
                "provider": {
                    "aqbot": {
                        "apiKey": "",
                        "baseURL": "http://localhost:1234/v1"
                    }
                }
            }),
        );
        assert_eq!(
            validate_connection(CliTool::OpenCode, "http://localhost:1234/v1").unwrap(),
            false,
            "should reject when apiKey is empty"
        );
        
        // Test 6: Valid configuration
        connect(CliTool::OpenCode, "http://localhost:1234/v1", "test-api-key")
            .expect("connect should succeed");
        assert_eq!(
            validate_connection(CliTool::OpenCode, "http://localhost:1234/v1").unwrap(),
            true,
            "should accept when all fields are correct"
        );
    });
}

// ─── Cursor Tests ───────────────────────────────────────────

#[test]
fn cursor_connect_sets_gateway_fields_without_removing_other_settings() {
    with_temp_home(|temp_home| {
        let settings_path = cursor_settings_path(temp_home.home(), temp_home.appdata());
        
        // Create settings with existing configuration
        write_json(
            &settings_path,
            &json!({
                "editor.fontSize": 14,
                "editor.tabSize": 2,
                "workbench.colorTheme": "Dark+",
                "extensions.autoUpdate": true
            }),
        );
        
        connect(CliTool::Cursor, "http://localhost:1234/v1", "test-api-key")
            .expect("connect should succeed");
        
        let settings = read_json(&settings_path);
        
        // Verify gateway fields were added
        assert_eq!(
            settings.get("openai.apiBaseUrl").and_then(|v| v.as_str()),
            Some("http://localhost:1234/v1"),
            "openai.apiBaseUrl should be set"
        );
        assert_eq!(
            settings.get("openai.apiKey").and_then(|v| v.as_str()),
            Some("test-api-key"),
            "openai.apiKey should be set"
        );
        
        // Verify existing settings are preserved
        assert_eq!(
            settings.get("editor.fontSize").and_then(|v| v.as_i64()),
            Some(14),
            "editor.fontSize should be preserved"
        );
        assert_eq!(
            settings.get("workbench.colorTheme").and_then(|v| v.as_str()),
            Some("Dark+"),
            "workbench.colorTheme should be preserved"
        );
    });
}

#[test]
fn cursor_disconnect_with_restore_restores_original_settings() {
    use aqbot_core::repo::cli_config::disconnect;
    
    with_temp_home(|temp_home| {
        let settings_path = cursor_settings_path(temp_home.home(), temp_home.appdata());
        
        // Create original settings
        let original_settings = json!({
            "editor.fontSize": 14,
            "workbench.colorTheme": "Dark+"
        });
        write_json(&settings_path, &original_settings);
        
        // Connect (this should create a backup)
        connect(CliTool::Cursor, "http://localhost:1234/v1", "test-api-key")
            .expect("connect should succeed");
        
        // Verify connected state has gateway fields
        let connected_settings = read_json(&settings_path);
        assert!(
            connected_settings.get("openai.apiBaseUrl").is_some(),
            "openai.apiBaseUrl should be present after connect"
        );
        
        // Disconnect with restore
        disconnect(CliTool::Cursor, true, "http://localhost:1234/v1")
            .expect("disconnect with restore should succeed");
        
        // Verify original settings are restored
        let restored_settings = read_json(&settings_path);
        assert_eq!(
            restored_settings,
            original_settings,
            "settings should be restored to original state"
        );
    });
}

#[test]
fn cursor_disconnect_without_restore_removes_only_gateway_fields() {
    use aqbot_core::repo::cli_config::disconnect;
    
    with_temp_home(|temp_home| {
        let settings_path = cursor_settings_path(temp_home.home(), temp_home.appdata());
        
        // Create settings with gateway fields and other settings
        write_json(
            &settings_path,
            &json!({
                "openai.apiBaseUrl": "http://localhost:1234/v1",
                "openai.apiKey": "test-api-key",
                "editor.fontSize": 14,
                "workbench.colorTheme": "Dark+",
                "extensions.autoUpdate": true
            }),
        );
        
        disconnect(CliTool::Cursor, false, "http://localhost:1234/v1")
            .expect("disconnect without restore should succeed");
        
        let settings = read_json(&settings_path);
        
        // Verify gateway fields were removed
        assert!(
            settings.get("openai.apiBaseUrl").is_none(),
            "openai.apiBaseUrl should be removed"
        );
        assert!(
            settings.get("openai.apiKey").is_none(),
            "openai.apiKey should be removed"
        );
        
        // Verify other settings are preserved
        assert_eq!(
            settings.get("editor.fontSize").and_then(|v| v.as_i64()),
            Some(14),
            "editor.fontSize should be preserved"
        );
        assert_eq!(
            settings.get("workbench.colorTheme").and_then(|v| v.as_str()),
            Some("Dark+"),
            "workbench.colorTheme should be preserved"
        );
    });
}

#[test]
fn cursor_validation_requires_gateway_fields_with_correct_values() {
    use aqbot_core::repo::cli_config::validate_connection;
    
    with_temp_home(|temp_home| {
        let settings_path = cursor_settings_path(temp_home.home(), temp_home.appdata());
        
        // Test 1: Missing settings file
        assert_eq!(
            validate_connection(CliTool::Cursor, "http://localhost:1234/v1").unwrap(),
            false,
            "should reject when settings file is missing"
        );
        
        // Test 2: Settings without gateway fields
        write_json(
            &settings_path,
            &json!({
                "editor.fontSize": 14
            }),
        );
        assert_eq!(
            validate_connection(CliTool::Cursor, "http://localhost:1234/v1").unwrap(),
            false,
            "should reject when gateway fields are missing"
        );
        
        // Test 3: Only apiBaseUrl present
        write_json(
            &settings_path,
            &json!({
                "openai.apiBaseUrl": "http://localhost:1234/v1"
            }),
        );
        assert_eq!(
            validate_connection(CliTool::Cursor, "http://localhost:1234/v1").unwrap(),
            false,
            "should reject when apiKey is missing"
        );
        
        // Test 4: Wrong apiBaseUrl
        write_json(
            &settings_path,
            &json!({
                "openai.apiBaseUrl": "http://wrong-url/v1",
                "openai.apiKey": "test-key"
            }),
        );
        assert_eq!(
            validate_connection(CliTool::Cursor, "http://localhost:1234/v1").unwrap(),
            false,
            "should reject when apiBaseUrl doesn't match"
        );
        
        // Test 5: Empty apiKey
        write_json(
            &settings_path,
            &json!({
                "openai.apiBaseUrl": "http://localhost:1234/v1",
                "openai.apiKey": ""
            }),
        );
        assert_eq!(
            validate_connection(CliTool::Cursor, "http://localhost:1234/v1").unwrap(),
            false,
            "should reject when apiKey is empty"
        );
        
        // Test 6: Valid configuration
        connect(CliTool::Cursor, "http://localhost:1234/v1", "test-api-key")
            .expect("connect should succeed");
        assert_eq!(
            validate_connection(CliTool::Cursor, "http://localhost:1234/v1").unwrap(),
            true,
            "should accept when all fields are correct"
        );
    });
}
