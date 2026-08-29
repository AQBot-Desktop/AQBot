//! User ACP agent configuration: `~/.aqbot/acp/agents.toml`

use crate::paths::{agents_toml_path, ensure_acp_dirs};
use crate::registry::{
    is_direct_grok_fingerprint, official_quarantine_reason, resolve_launch, RegistryAgent,
    RegistryFile, GROK_AGENT_ID, GROK_NPM_MARKER,
};
use crate::registry_plan::{
    consume_approval_token, issue_approval_token, plan_registry_launch, RegistryLaunchPlan,
    RegistryPlanOutcome,
};
use crate::types::AgentProbeResult;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write;
use std::path::Path;
use std::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpAgentsFile {
    #[serde(default)]
    pub general: AcpGeneralConfig,
    #[serde(default)]
    pub agents: Vec<ConfiguredAgent>,
}

impl Default for AcpAgentsFile {
    fn default() -> Self {
        Self {
            general: AcpGeneralConfig::default(),
            agents: Vec::new(),
        }
    }
}

impl AcpAgentsFile {
    pub fn validate(&self) -> anyhow::Result<()> {
        const PERMISSIONS: &[&str] = &[
            "prompt",
            "default",
            "accept_edits",
            "auto_approve",
            "full_access",
        ];
        const REFRESH_POLICIES: &[&str] = &["on_start", "manual", "never"];
        if !PERMISSIONS.contains(&self.general.permission_default.as_str()) {
            anyhow::bail!(
                "invalid ACP permission_default `{}`",
                self.general.permission_default
            );
        }
        if !REFRESH_POLICIES.contains(&self.general.registry_refresh.as_str()) {
            anyhow::bail!(
                "invalid ACP registry_refresh `{}`",
                self.general.registry_refresh
            );
        }

        let mut ids = std::collections::HashSet::new();
        for agent in &self.agents {
            agent.validate()?;
            if !ids.insert(agent.id.as_str()) {
                anyhow::bail!("duplicate ACP agent id `{}`", agent.id);
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpGeneralConfig {
    #[serde(default = "default_idle")]
    pub idle_timeout_secs: u64,
    #[serde(default = "default_max_proc")]
    pub max_concurrent_processes: u32,
    /// prompt | default | accept_edits | auto_approve | full_access
    #[serde(default = "default_permission")]
    pub permission_default: String,
    /// on_start | manual | never
    #[serde(default = "default_refresh")]
    pub registry_refresh: String,
}

fn default_idle() -> u64 {
    1800
}
/// 0 = unlimited concurrent agent processes.
fn default_max_proc() -> u32 {
    0
}
fn default_permission() -> String {
    "prompt".into()
}
fn default_refresh() -> String {
    "on_start".into()
}

impl Default for AcpGeneralConfig {
    fn default() -> Self {
        Self {
            idle_timeout_secs: default_idle(),
            max_concurrent_processes: default_max_proc(),
            permission_default: default_permission(),
            registry_refresh: default_refresh(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfiguredAgent {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub enabled: bool,
    /// registry | custom
    #[serde(default = "default_source")]
    pub source: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub sort: i32,
}

impl ConfiguredAgent {
    pub fn validate(&self) -> anyhow::Result<()> {
        if self.id.trim().is_empty() {
            anyhow::bail!("ACP agent id must not be empty");
        }
        if self.name.trim().is_empty() {
            anyhow::bail!("ACP agent `{}` name must not be empty", self.id);
        }
        if self.command.trim().is_empty() {
            anyhow::bail!("ACP agent `{}` command must not be empty", self.id);
        }
        if self.command.contains('\0') || self.args.iter().any(|arg| arg.contains('\0')) {
            anyhow::bail!("ACP agent `{}` command contains a NUL byte", self.id);
        }
        if self
            .env
            .iter()
            .any(|(key, value)| key.is_empty() || key.contains(['=', '\0']) || value.contains('\0'))
        {
            anyhow::bail!("ACP agent `{}` has an invalid environment entry", self.id);
        }
        Ok(())
    }
}

fn default_source() -> String {
    "registry".into()
}

fn apply_resolved_launch(
    agent: &mut ConfiguredAgent,
    launch: crate::registry::ResolvedLaunch,
) -> bool {
    if agent.command == launch.command && agent.args == launch.args && agent.env == launch.env {
        return false;
    }
    agent.command = launch.command;
    agent.args = launch.args;
    agent.env = launch.env;
    true
}

fn is_grok_stdio_launch(agent: &ConfiguredAgent) -> bool {
    agent.id == GROK_AGENT_ID && is_direct_grok_fingerprint(&agent.command, &agent.args)
}

fn strip_legacy_grok_npm_marker(agent: &mut ConfiguredAgent) -> bool {
    if !is_grok_stdio_launch(agent) {
        return false;
    }
    agent.env.remove(GROK_NPM_MARKER).is_some()
}

fn normalize_loaded_agents_with(
    file: &mut AcpAgentsFile,
    resolve_registry_launch: impl Fn(&ConfiguredAgent) -> Option<crate::registry::ResolvedLaunch>,
) -> bool {
    let mut updated = false;
    for agent in &mut file.agents {
        if agent.enabled
            && agent.source == "registry"
            && official_quarantine_reason(&agent.id).is_some()
        {
            agent.enabled = false;
            updated = true;
        }
        updated |= strip_legacy_grok_npm_marker(agent);
        if agent.source != "registry" {
            continue;
        }
        let Some(launch) = resolve_registry_launch(agent) else {
            continue;
        };
        updated |= apply_resolved_launch(agent, launch);
    }
    updated
}

fn normalize_loaded_agents(file: &mut AcpAgentsFile) -> anyhow::Result<bool> {
    Ok(normalize_loaded_agents_with(file, |agent| {
        crate::registry::resolve_configured_npx_trampoline(&agent.command, &agent.args, &agent.env)
    }))
}

pub fn load_agents_file() -> anyhow::Result<AcpAgentsFile> {
    let path = agents_toml_path();
    load_agents_file_at(&path)
}

fn load_agents_file_at(path: &Path) -> anyhow::Result<AcpAgentsFile> {
    Ok(read_agents_file_at(path)?.0)
}

fn read_agents_file_at(path: &Path) -> anyhow::Result<(AcpAgentsFile, bool)> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok((AcpAgentsFile::default(), true));
        }
        Err(error) => return Err(error.into()),
    };
    let mut file: AcpAgentsFile = toml::from_str(&text)?;
    file.validate()?;
    let changed = normalize_loaded_agents(&mut file)?;
    Ok((file, changed))
}

/// Persist a missing default file or any read-time launch migrations.
///
/// Call this during startup, before concurrent configuration commands begin.
pub fn migrate_agents_file() -> anyhow::Result<AcpAgentsFile> {
    ensure_acp_dirs()?;
    let path = agents_toml_path();
    migrate_agents_file_at(&path)
}

fn migrate_agents_file_at(path: &Path) -> anyhow::Result<AcpAgentsFile> {
    let (file, changed) = read_agents_file_at(path)?;
    if changed {
        save_agents_file_at(path, &file)?;
    }
    Ok(file)
}

pub fn save_agents_file(file: &AcpAgentsFile) -> anyhow::Result<()> {
    ensure_acp_dirs()?;
    let path = agents_toml_path();
    save_agents_file_at(&path, file)
}

fn save_agents_file_at(path: &Path, file: &AcpAgentsFile) -> anyhow::Result<()> {
    save_agents_file_at_with(path, file, replace_file_atomically)
}

#[cfg(not(windows))]
fn replace_file_atomically(temporary: &Path, destination: &Path) -> std::io::Result<()> {
    std::fs::rename(temporary, destination)
}

#[cfg(windows)]
fn replace_file_atomically(temporary: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(
            existing_file_name: *const u16,
            new_file_name: *const u16,
            flags: u32,
        ) -> i32;
    }

    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;

    fn wide_path(path: &Path) -> std::io::Result<Vec<u16>> {
        let mut wide = path.as_os_str().encode_wide().collect::<Vec<_>>();
        if wide.contains(&0) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "path contains a NUL character",
            ));
        }
        wide.push(0);
        Ok(wide)
    }

    let temporary = wide_path(temporary)?;
    let destination = wide_path(destination)?;
    // SAFETY: both buffers are NUL-terminated and remain alive for the call.
    let replaced = unsafe {
        MoveFileExW(
            temporary.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if replaced == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn save_agents_file_at_with(
    path: &Path,
    file: &AcpAgentsFile,
    replace: impl FnOnce(&Path, &Path) -> std::io::Result<()>,
) -> anyhow::Result<()> {
    file.validate()?;
    let text = toml::to_string_pretty(file)?;
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> anyhow::Result<()> {
        let mut output = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        output.write_all(text.as_bytes())?;
        output.sync_all()?;
        replace(&temporary, path)?;
        Ok(())
    })();
    if let Err(error) = result {
        return match std::fs::remove_file(&temporary) {
            Ok(()) => Err(error),
            Err(cleanup) if cleanup.kind() == std::io::ErrorKind::NotFound => Err(error),
            Err(cleanup) => Err(anyhow::anyhow!(
                "{error}; ACP config temporary-file cleanup failed: {cleanup}"
            )),
        };
    }
    Ok(())
}

pub fn enabled_agents(file: &AcpAgentsFile) -> Vec<&ConfiguredAgent> {
    let mut list: Vec<_> = file
        .agents
        .iter()
        .filter(|agent| is_agent_enabled(agent))
        .collect();
    list.sort_by_key(|a| a.sort);
    list
}

pub fn is_agent_enabled(agent: &ConfiguredAgent) -> bool {
    agent.enabled
        && !(agent.source == "registry"
            && crate::registry::official_quarantine_reason(&agent.id).is_some())
}

fn insert_registry_agent(
    file: &mut AcpAgentsFile,
    agent: &RegistryAgent,
    launch: crate::registry::ResolvedLaunch,
    enabled: bool,
) {
    let sort = file.agents.len() as i32;
    file.agents.push(ConfiguredAgent {
        id: agent.id.clone(),
        name: agent.name.clone(),
        enabled,
        source: "registry".into(),
        command: launch.command,
        args: launch.args,
        env: launch.env,
        icon: None,
        sort,
    });
}

/// Insert a Registry agent launch. Existing user configuration is never overwritten.
pub fn upsert_from_registry(
    file: &mut AcpAgentsFile,
    agent: &RegistryAgent,
    enabled: bool,
) -> anyhow::Result<()> {
    if file
        .agents
        .iter()
        .any(|configured| configured.id == agent.id)
    {
        return Ok(());
    }
    let launch = resolve_launch(agent)
        .ok_or_else(|| anyhow::anyhow!("no launch method for agent {}", agent.id))?;
    insert_registry_agent(file, agent, launch, enabled);
    Ok(())
}

#[derive(Debug, Clone, Default)]
pub struct RegistryRefreshSync {
    pub quarantined: Vec<QuarantinedConfiguredAgent>,
    pub disabled_agent_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuarantinedConfiguredAgent {
    pub agent_id: String,
    pub reason: String,
}

/// Refresh only applies official quarantine. User launch fields stay untouched.
pub fn sync_configured_registry_agents(
    file: &mut AcpAgentsFile,
    registry: &RegistryFile,
) -> anyhow::Result<usize> {
    Ok(apply_registry_refresh(file, registry).quarantined.len())
}

pub fn apply_registry_refresh(
    file: &mut AcpAgentsFile,
    registry: &RegistryFile,
) -> RegistryRefreshSync {
    let mut quarantined = Vec::new();
    let mut disabled_agent_ids = Vec::new();
    for configured in file
        .agents
        .iter_mut()
        .filter(|agent| agent.source == "registry")
    {
        let reason = official_quarantine_reason(&configured.id)
            .map(str::to_string)
            .or_else(|| {
                registry
                    .agents
                    .iter()
                    .find(|item| item.id == configured.id)
                    .and_then(|item| item.quarantine_reason.clone())
            });
        let Some(reason) = reason else {
            continue;
        };
        quarantined.push(QuarantinedConfiguredAgent {
            agent_id: configured.id.clone(),
            reason,
        });
        if configured.enabled {
            configured.enabled = false;
            disabled_agent_ids.push(configured.id.clone());
        }
    }
    RegistryRefreshSync {
        quarantined,
        disabled_agent_ids,
    }
}

pub fn preview_registry_agent(
    file: &AcpAgentsFile,
    registry: &RegistryFile,
    agent_id: &str,
) -> anyhow::Result<RegistryAddPreview> {
    if let Some(existing) = file
        .agents
        .iter()
        .find(|agent| agent.id == agent_id)
        .cloned()
    {
        return Ok(RegistryAddPreview::already_configured(existing));
    }
    let agent = crate::registry::find_registry_agent(registry, agent_id)
        .ok_or_else(|| anyhow::anyhow!("agent `{agent_id}` not in registry"))?;
    let plan = plan_registry_launch(agent);
    Ok(RegistryAddPreview::from_plan(agent_id, plan))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryAddPreview {
    pub agent_id: String,
    pub outcome: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    pub kind: String,
    pub source: String,
    pub version: Option<String>,
    pub catalog_version: Option<String>,
    pub installer_kind: Option<String>,
    pub installer_spec: Option<String>,
    pub approval_token: Option<String>,
    pub configured: Option<ConfiguredAgent>,
    pub quarantine_reason: Option<String>,
    pub manual_reason: Option<String>,
}

impl RegistryAddPreview {
    pub fn already_configured(existing: ConfiguredAgent) -> Self {
        Self {
            agent_id: existing.id.clone(),
            outcome: RegistryPlanOutcome::AlreadyConfigured.as_str().into(),
            command: existing.command.clone(),
            args: existing.args.clone(),
            env: existing.env.clone(),
            kind: "configured".into(),
            source: "configured".into(),
            version: None,
            catalog_version: None,
            installer_kind: None,
            installer_spec: None,
            approval_token: None,
            configured: Some(existing),
            quarantine_reason: None,
            manual_reason: None,
        }
    }

    fn from_plan(agent_id: &str, plan: RegistryLaunchPlan) -> Self {
        let approval_token = matches!(
            plan.outcome,
            RegistryPlanOutcome::ReuseLocal | RegistryPlanOutcome::InstallRequired
        )
        .then(|| issue_approval_token(agent_id, &plan));
        Self {
            agent_id: agent_id.into(),
            outcome: plan.outcome.as_str().into(),
            command: plan.command,
            args: plan.args,
            env: plan.env,
            kind: plan.kind,
            source: plan.source,
            version: plan.version,
            catalog_version: plan.catalog_version,
            installer_kind: plan.installer_kind,
            installer_spec: plan.installer_spec,
            approval_token,
            configured: None,
            quarantine_reason: plan.quarantine_reason,
            manual_reason: plan.manual_reason,
        }
    }
}

pub fn commit_registry_agent(
    file: &mut AcpAgentsFile,
    agent: &RegistryAgent,
    enabled: bool,
    allow_installer: bool,
    approval_token: Option<&str>,
) -> anyhow::Result<RegistryPlanOutcome> {
    commit_registry_agent_with(
        file,
        agent,
        enabled,
        allow_installer,
        approval_token,
        plan_registry_launch,
    )
}

pub fn commit_registry_agent_with(
    file: &mut AcpAgentsFile,
    agent: &RegistryAgent,
    enabled: bool,
    allow_installer: bool,
    approval_token: Option<&str>,
    plan_launch: impl Fn(&RegistryAgent) -> RegistryLaunchPlan,
) -> anyhow::Result<RegistryPlanOutcome> {
    if file
        .agents
        .iter()
        .any(|configured| configured.id == agent.id)
    {
        return Ok(RegistryPlanOutcome::AlreadyConfigured);
    }
    let plan = plan_launch(agent);
    match plan.outcome {
        RegistryPlanOutcome::AlreadyConfigured => Ok(RegistryPlanOutcome::AlreadyConfigured),
        RegistryPlanOutcome::Quarantined => anyhow::bail!(
            "agent `{}` is quarantined by the official ACP Registry: {}",
            agent.id,
            plan.quarantine_reason
                .unwrap_or_else(|| "quarantined".into())
        ),
        RegistryPlanOutcome::ManualRequired => anyhow::bail!(
            "{}",
            plan.manual_reason
                .unwrap_or_else(|| format!("agent `{}` requires manual installation", agent.id))
        ),
        RegistryPlanOutcome::ReuseLocal => {
            let token = approval_token.ok_or_else(|| {
                anyhow::anyhow!("adding `{}` requires a matching approval token", agent.id)
            })?;
            consume_approval_token(&agent.id, &plan, token)?;
            let launch = plan
                .launch()
                .ok_or_else(|| anyhow::anyhow!("no local launch for agent {}", agent.id))?;
            insert_registry_agent(file, agent, launch, enabled);
            Ok(RegistryPlanOutcome::ReuseLocal)
        }
        RegistryPlanOutcome::InstallRequired => {
            if !allow_installer {
                anyhow::bail!(
                    "installing `{}` requires explicit installer approval",
                    agent.id
                );
            }
            let token = approval_token.ok_or_else(|| {
                anyhow::anyhow!(
                    "installing `{}` requires a matching approval token",
                    agent.id
                )
            })?;
            consume_approval_token(&agent.id, &plan, token)?;
            let launch = plan
                .launch()
                .ok_or_else(|| anyhow::anyhow!("no installer launch for agent {}", agent.id))?;
            insert_registry_agent(file, agent, launch, enabled);
            Ok(RegistryPlanOutcome::InstallRequired)
        }
    }
}

pub fn set_agent_enabled(file: &mut AcpAgentsFile, agent_id: &str, enabled: bool) -> bool {
    if let Some(a) = file.agents.iter_mut().find(|a| a.id == agent_id) {
        a.enabled = enabled;
        true
    } else {
        false
    }
}

/// Reorder agents by the given id sequence. Unknown ids are appended at the end.
pub fn reorder_agents(file: &mut AcpAgentsFile, agent_ids: &[String]) {
    let mut by_id: HashMap<String, ConfiguredAgent> =
        file.agents.drain(..).map(|a| (a.id.clone(), a)).collect();
    let mut ordered = Vec::with_capacity(by_id.len());
    for (i, id) in agent_ids.iter().enumerate() {
        if let Some(mut a) = by_id.remove(id) {
            a.sort = i as i32;
            ordered.push(a);
        }
    }
    // Preserve any agents not present in the id list (should be rare).
    let mut rest: Vec<_> = by_id.into_values().collect();
    rest.sort_by_key(|a| a.sort);
    let base = ordered.len() as i32;
    for (i, mut a) in rest.into_iter().enumerate() {
        a.sort = base + i as i32;
        ordered.push(a);
    }
    file.agents = ordered;
}

pub fn remove_agent(file: &mut AcpAgentsFile, agent_id: &str) -> bool {
    let before = file.agents.len();
    file.agents.retain(|a| a.id != agent_id);
    if file.agents.len() != before {
        for (i, a) in file.agents.iter_mut().enumerate() {
            a.sort = i as i32;
        }
        true
    } else {
        false
    }
}

fn configured_command_is_available(command: &str, env: &HashMap<String, String>) -> bool {
    if command.contains('/') || command.contains('\\') {
        return Path::new(command).is_file();
    }
    let mut process_env = env.clone();
    crate::shell_path::inject_shell_path(&mut process_env, crate::shell_path::get_shell_path());
    let which = if cfg!(windows) { "where" } else { "which" };
    Command::new(which)
        .arg(command)
        .envs(process_env)
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

/// Lightweight availability probe (does not start full ACP session).
pub fn probe_agent(agent: &ConfiguredAgent) -> AgentProbeResult {
    let cmd_display = format!("{} {}", agent.command, agent.args.join(" "));
    let available = configured_command_is_available(&agent.command, &agent.env);
    let message = if available {
        format!("Found `{}`", agent.command)
    } else {
        format!(
            "Configured command `{}` is not available and will not fall back to the Registry or an installer.",
            agent.command
        )
    };

    AgentProbeResult {
        agent_id: agent.id.clone(),
        available,
        command: cmd_display.trim().to_string(),
        message,
    }
}

pub fn shell_command_line(agent: &ConfiguredAgent) -> String {
    let mut parts = vec![agent.command.clone()];
    parts.extend(agent.args.iter().cloned());
    // Simple quoting for display / AcpAgent::from_str
    parts
        .into_iter()
        .map(|p| {
            if p.contains(' ') {
                format!("\"{p}\"")
            } else {
                p
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestDirectory {
        path: std::path::PathBuf,
    }

    impl TestDirectory {
        fn new(label: &str) -> Self {
            let path = std::env::temp_dir()
                .join(format!("aqbot-acp-config-{label}-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&path).expect("create test directory");
            Self { path }
        }

        fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    fn agent(id: &str) -> ConfiguredAgent {
        ConfiguredAgent {
            id: id.into(),
            name: id.into(),
            enabled: true,
            source: "custom".into(),
            command: "agent-cli".into(),
            args: vec!["acp".into()],
            env: HashMap::new(),
            icon: None,
            sort: 0,
        }
    }

    fn file_with_agent(id: &str) -> AcpAgentsFile {
        AcpAgentsFile {
            general: AcpGeneralConfig::default(),
            agents: vec![agent(id)],
        }
    }

    fn persisted_file(path: &Path) -> AcpAgentsFile {
        toml::from_str(&std::fs::read_to_string(path).expect("read persisted config"))
            .expect("parse persisted config")
    }

    #[test]
    fn rejects_empty_commands_and_duplicate_agent_ids() {
        let mut invalid_agent = agent("codex");
        invalid_agent.command = "  ".into();
        assert!(invalid_agent.validate().is_err());

        let file = AcpAgentsFile {
            general: AcpGeneralConfig::default(),
            agents: vec![agent("codex"), agent("codex")],
        };
        assert!(file.validate().is_err());
    }

    #[test]
    fn rejects_unknown_general_policy_values() {
        let mut file = AcpAgentsFile::default();
        file.general.permission_default = "invented".into();
        assert!(file.validate().is_err());

        file.general.permission_default = "default".into();
        file.general.registry_refresh = "hourly".into();
        assert!(file.validate().is_err());
    }

    #[test]
    fn loaded_registry_npx_is_migrated_offline_but_custom_launch_is_untouched() {
        let mut managed = agent("github-copilot-cli");
        managed.source = "registry".into();
        managed.command = "npx".into();
        managed.args = vec!["-y".into(), "@github/copilot@1.0.78".into(), "--acp".into()];
        let mut custom = agent("custom-npx");
        custom.command = "npx".into();
        custom.args = vec!["-y".into(), "custom-agent@1.0.0".into()];
        let custom_before = custom.clone();
        let mut file = AcpAgentsFile {
            general: AcpGeneralConfig::default(),
            agents: vec![managed, custom],
        };

        let updated = normalize_loaded_agents_with(&mut file, |_| {
            Some(crate::registry::ResolvedLaunch {
                command: "/verified/npm-cache/node_modules/.bin/copilot".into(),
                args: vec!["--acp".into()],
                env: HashMap::new(),
                kind: "binary".into(),
            })
        });

        assert!(updated);
        assert_eq!(
            file.agents[0].command,
            "/verified/npm-cache/node_modules/.bin/copilot"
        );
        assert_eq!(file.agents[0].args, ["--acp"]);
        assert_eq!(file.agents[1].command, custom_before.command);
        assert_eq!(file.agents[1].args, custom_before.args);
    }

    fn deleted_npx_cache_bin(agent_id: &str, source: &str) -> ConfiguredAgent {
        let mut configured = agent(agent_id);
        configured.source = source.into();
        configured.command = std::env::temp_dir()
            .join(format!("aqbot-deleted-cache-{}", uuid::Uuid::new_v4()))
            .join("_npx/0123456789abcdef/node_modules/.bin/agent-cli")
            .to_string_lossy()
            .into_owned();
        configured
    }

    #[test]
    fn deleted_registry_cache_bin_stays_configured_and_readiness_fails() {
        let managed = deleted_npx_cache_bin("github-copilot-cli", "registry");
        let custom = deleted_npx_cache_bin("custom-cache-agent", "custom");
        let missing_command = managed.command.clone();
        let custom_command = custom.command.clone();
        let mut file = AcpAgentsFile {
            general: AcpGeneralConfig::default(),
            agents: vec![managed, custom],
        };

        let updated = normalize_loaded_agents_with(&mut file, |_| None);

        assert!(!updated);
        assert_eq!(file.agents[0].command, missing_command);
        assert_eq!(file.agents[1].command, custom_command);
        let probe = probe_agent(&file.agents[0]);
        assert!(!probe.available);
        assert!(probe.message.contains("will not fall back"));
    }

    #[test]
    fn registry_refresh_preserves_user_launch_and_only_quarantine_mutates() {
        let mut managed = agent("codex-acp");
        managed.source = "registry".into();
        managed.enabled = false;
        managed.command = "obsolete-codex-launch".into();
        managed.args = vec!["--user".into()];
        managed.env.insert("AQBOT_KEEP".into(), "1".into());
        managed.sort = 7;
        managed.name = "My Codex".into();
        managed.icon = Some("star".into());
        let custom = agent("my-private-agent");
        let mut file = AcpAgentsFile {
            general: AcpGeneralConfig::default(),
            agents: vec![managed.clone(), custom.clone()],
        };
        let mut registry = crate::registry::load_builtin_registry().expect("builtin Registry");
        if let Some(codex) = registry
            .agents
            .iter_mut()
            .find(|agent| agent.id == "codex-acp")
        {
            codex.version = Some("9.9.9".into());
        }

        assert_eq!(
            sync_configured_registry_agents(&mut file, &registry).expect("sync Registry"),
            0
        );
        let managed = file
            .agents
            .iter()
            .find(|agent| agent.id == "codex-acp")
            .expect("managed agent remains configured");
        assert_eq!(managed.command, "obsolete-codex-launch");
        assert_eq!(managed.args, ["--user"]);
        assert_eq!(managed.env.get("AQBOT_KEEP"), Some(&"1".into()));
        assert!(!managed.enabled);
        assert_eq!(managed.sort, 7);
        assert_eq!(managed.name, "My Codex");
        assert_eq!(managed.icon.as_deref(), Some("star"));
        assert_eq!(
            file.agents
                .iter()
                .find(|agent| agent.id == custom.id)
                .map(|agent| (&agent.command, &agent.args)),
            Some((&custom.command, &custom.args))
        );
    }

    #[test]
    fn registry_refresh_disables_officially_quarantined_agents() {
        let mut quarantined = agent("fast-agent");
        quarantined.source = "registry".into();
        quarantined.command = "user-fast-agent".into();
        quarantined.args = vec!["--keep".into()];
        quarantined.name = "My Fast Agent".into();
        let mut file = AcpAgentsFile {
            general: AcpGeneralConfig::default(),
            agents: vec![quarantined],
        };
        let registry = crate::registry::load_builtin_registry().expect("builtin Registry");

        let sync = apply_registry_refresh(&mut file, &registry);
        assert_eq!(sync.quarantined.len(), 1);
        assert_eq!(sync.quarantined[0].agent_id, "fast-agent");
        assert!(!sync.quarantined[0].reason.is_empty());
        assert_eq!(sync.disabled_agent_ids, ["fast-agent"]);
        assert!(!file.agents[0].enabled);
        assert_eq!(file.agents[0].command, "user-fast-agent");
        assert_eq!(file.agents[0].args, ["--keep"]);
        assert_eq!(file.agents[0].name, "My Fast Agent");
    }

    #[test]
    fn concurrent_reader_is_pure_and_normalization_migration_is_explicit() {
        let directory = TestDirectory::new("reader-writer");
        let path = directory.path().join("agents.toml");
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let (read_tx, read_rx) = std::sync::mpsc::channel();
        let reader_path = path.clone();
        let reader = std::thread::spawn(move || {
            ready_tx.send(()).expect("announce reader readiness");
            read_rx.recv().expect("wait for writer commit");
            load_agents_file_at(&reader_path)
        });
        ready_rx.recv().expect("wait for reader readiness");

        let mut quarantined = agent("fast-agent");
        quarantined.source = "registry".into();
        let mut committed = AcpAgentsFile {
            general: AcpGeneralConfig::default(),
            agents: vec![quarantined],
        };
        committed.general.idle_timeout_secs = 73;
        save_agents_file_at(&path, &committed).expect("commit writer snapshot");
        read_tx.send(()).expect("release concurrent reader");

        let loaded = reader
            .join()
            .expect("join concurrent reader")
            .expect("load committed snapshot");
        assert!(!loaded.agents[0].enabled);
        let persisted = persisted_file(&path);
        assert_eq!(persisted.general.idle_timeout_secs, 73);
        assert!(
            persisted.agents[0].enabled,
            "reader overwrote the writer's persisted snapshot"
        );

        let migrated = migrate_agents_file_at(&path).expect("migrate config");

        assert!(!migrated.agents[0].enabled);
        assert!(!persisted_file(&path).agents[0].enabled);
    }

    #[test]
    fn saving_twice_replaces_the_complete_config() {
        let directory = TestDirectory::new("save-twice");
        let path = directory.path().join("agents.toml");
        let first = file_with_agent("first");
        let mut second = file_with_agent("second");
        second.general.idle_timeout_secs = 42;

        save_agents_file_at(&path, &first).expect("save first config");
        save_agents_file_at(&path, &second).expect("replace with second config");

        let persisted = persisted_file(&path);
        assert_eq!(persisted.general.idle_timeout_secs, 42);
        assert_eq!(persisted.agents.len(), 1);
        assert_eq!(persisted.agents[0].id, "second");
    }

    #[test]
    fn failed_replacement_preserves_the_previous_complete_config() {
        let directory = TestDirectory::new("failed-replace");
        let path = directory.path().join("agents.toml");
        let original = file_with_agent("original");
        let replacement = file_with_agent("replacement");
        save_agents_file_at(&path, &original).expect("save original config");
        let original_bytes = std::fs::read(&path).expect("read original config");

        let error = save_agents_file_at_with(&path, &replacement, |_, _| {
            Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "injected replacement failure",
            ))
        })
        .expect_err("replacement must fail");

        assert!(error.to_string().contains("injected replacement failure"));
        assert_eq!(
            std::fs::read(&path).expect("read config after failed replacement"),
            original_bytes
        );
        assert_eq!(
            std::fs::read_dir(directory.path())
                .expect("list config directory")
                .count(),
            1,
            "temporary config file was not cleaned up"
        );
    }

    fn grok_registry_agent() -> crate::registry::RegistryAgent {
        crate::registry::find_registry_agent(
            &crate::registry::load_builtin_registry().expect("builtin"),
            "grok-build",
        )
        .expect("grok-build")
        .clone()
    }

    #[test]
    fn add_existing_registry_agent_is_idempotent_and_preserves_the_full_tuple() {
        let mut existing = agent("grok-build");
        existing.source = "registry".into();
        existing.command = "/opt/user-grok".into();
        existing.args = vec!["agent".into(), "stdio".into()];
        existing.env.insert("USER_KEY".into(), "keep".into());
        existing.icon = Some("star".into());
        existing.sort = 4;
        existing.enabled = false;
        existing.name = "My Grok".into();
        let mut file = AcpAgentsFile {
            general: AcpGeneralConfig::default(),
            agents: vec![existing.clone()],
        };
        let registry_agent = grok_registry_agent();

        let outcome = commit_registry_agent_with(
            &mut file,
            &registry_agent,
            true,
            true,
            Some("unused"),
            |_| panic!("existing agent must not resolve Registry"),
        )
        .expect("idempotent add");

        assert_eq!(outcome, RegistryPlanOutcome::AlreadyConfigured);
        assert_eq!(file.agents, vec![existing]);
    }

    #[test]
    fn grok_legacy_direct_marker_is_stripped_and_other_env_is_kept() {
        let mut grok = agent("grok-build");
        grok.source = "registry".into();
        grok.command = "/opt/grok".into();
        grok.args = vec!["agent".into(), "stdio".into()];
        grok.env.insert(GROK_NPM_MARKER.into(), "1".into());
        grok.env.insert("USER_TOKEN".into(), "abc".into());
        let mut custom = agent("custom-grok");
        custom.command = "/opt/grok".into();
        custom.args = vec!["agent".into(), "stdio".into()];
        custom.env.insert(GROK_NPM_MARKER.into(), "1".into());
        let mut file = AcpAgentsFile {
            general: AcpGeneralConfig::default(),
            agents: vec![grok, custom],
        };

        assert!(normalize_loaded_agents_with(&mut file, |_| None));
        assert!(!file.agents[0].env.contains_key(GROK_NPM_MARKER));
        assert_eq!(file.agents[0].env.get("USER_TOKEN"), Some(&"abc".into()));
        assert_eq!(file.agents[1].env.get(GROK_NPM_MARKER), Some(&"1".into()));
    }

    #[test]
    fn reuse_local_commit_does_not_require_installer_and_skips_npx() {
        let mut file = AcpAgentsFile::default();
        let agent = grok_registry_agent();
        let plan = crate::registry_plan::plan_registry_launch_with(
            &agent,
            |_| Some("/opt/old-grok".into()),
            None,
        );
        let token = crate::registry_plan::issue_approval_token("grok-build", &plan);
        let outcome =
            commit_registry_agent_with(&mut file, &agent, true, false, Some(&token), |_| {
                crate::registry_plan::plan_registry_launch_with(
                    &agent,
                    |_| Some("/opt/old-grok".into()),
                    None,
                )
            })
            .expect("reuse local");

        assert_eq!(outcome, RegistryPlanOutcome::ReuseLocal);
        assert_eq!(file.agents[0].command, "/opt/old-grok");
        assert_eq!(file.agents[0].args, ["agent", "stdio"]);
        assert!(!file.agents[0].env.contains_key(GROK_NPM_MARKER));
    }

    #[test]
    fn install_required_without_approval_does_not_write_config() {
        let mut file = AcpAgentsFile::default();
        let agent = grok_registry_agent();
        let error = commit_registry_agent_with(&mut file, &agent, true, false, None, |_| {
            crate::registry_plan::plan_registry_launch_with(&agent, |_| None, None)
        })
        .expect_err("installer unauthorized");

        assert!(error.to_string().contains("explicit installer approval"));
        assert!(file.agents.is_empty());
    }

    #[test]
    fn exact_version_install_persists_previewed_spec_after_token() {
        let mut file = AcpAgentsFile::default();
        let agent = grok_registry_agent();
        let plan = crate::registry_plan::plan_registry_launch_with(&agent, |_| None, None);
        let token = crate::registry_plan::issue_approval_token("grok-build", &plan);
        let outcome =
            commit_registry_agent_with(&mut file, &agent, true, true, Some(&token), |_| {
                crate::registry_plan::plan_registry_launch_with(&agent, |_| None, None)
            })
            .expect("approved install");

        assert_eq!(outcome, RegistryPlanOutcome::InstallRequired);
        assert_eq!(file.agents[0].command, "npx");
        assert!(file.agents[0]
            .args
            .iter()
            .any(|arg| arg == "@xai-official/grok@1.0.0"));
        assert!(!file.agents[0].env.contains_key(GROK_NPM_MARKER));
    }

    #[test]
    fn stale_approval_token_fails_when_plan_changes() {
        let mut file = AcpAgentsFile::default();
        let mut agent = grok_registry_agent();
        let first = crate::registry_plan::plan_registry_launch_with(&agent, |_| None, None);
        let token = crate::registry_plan::issue_approval_token("grok-build", &first);
        agent
            .distribution
            .as_mut()
            .expect("distribution")
            .npx
            .as_mut()
            .expect("npx")
            .package = "@xai-official/grok@1.0.1".into();
        agent.distribution.as_mut().expect("distribution").binary = None;

        let error =
            commit_registry_agent_with(&mut file, &agent, true, true, Some(&token), |current| {
                crate::registry_plan::plan_registry_launch_with(current, |_| None, None)
            })
            .expect_err("stale token");

        assert!(error.to_string().contains("does not match"));
        assert!(file.agents.is_empty());
    }

    #[test]
    fn variable_version_commit_is_rejected() {
        let mut file = AcpAgentsFile::default();
        let mut agent = grok_registry_agent();
        agent
            .distribution
            .as_mut()
            .expect("distribution")
            .npx
            .as_mut()
            .expect("npx")
            .package = "@xai-official/grok@latest".into();
        agent.distribution.as_mut().expect("distribution").binary = None;

        let error =
            commit_registry_agent_with(&mut file, &agent, true, true, Some("token"), |current| {
                crate::registry_plan::plan_registry_launch_with(current, |_| None, None)
            })
            .expect_err("variable spec");

        assert!(error.to_string().contains("exact version"));
        assert!(file.agents.is_empty());
    }

    #[test]
    fn grok_npx_migrates_to_any_local_binary_and_keeps_other_env() {
        let mut grok = agent("grok-build");
        grok.source = "registry".into();
        grok.command = "npx".into();
        grok.args = vec![
            "-y".into(),
            "--registry=https://registry.npmjs.org".into(),
            "@xai-official/grok@1.0.0".into(),
            "agent".into(),
            "stdio".into(),
        ];
        grok.env.insert(GROK_NPM_MARKER.into(), "1".into());
        grok.env.insert("USER_TOKEN".into(), "abc".into());
        let mut file = AcpAgentsFile {
            general: AcpGeneralConfig::default(),
            agents: vec![grok],
        };

        let updated = normalize_loaded_agents_with(&mut file, |agent| {
            crate::registry::resolve_configured_npx_trampoline_with(
                &agent.command,
                &agent.args,
                &agent.env,
                |_| Some("/isolated/grok-0.2.121".into()),
            )
        });

        assert!(updated);
        assert_eq!(file.agents[0].command, "/isolated/grok-0.2.121");
        assert_eq!(file.agents[0].args, ["agent", "stdio"]);
        assert_eq!(file.agents[0].env.get("USER_TOKEN"), Some(&"abc".into()));
        assert!(!file.agents[0].env.contains_key(GROK_NPM_MARKER));
    }

    #[test]
    fn preview_already_configured_skips_registry_lookup() {
        let mut existing = agent("grok-build");
        existing.command = "/opt/user-grok".into();
        existing.args = vec!["agent".into(), "stdio".into()];
        existing.env.insert("USER_KEY".into(), "keep".into());
        let file = AcpAgentsFile {
            general: AcpGeneralConfig::default(),
            agents: vec![existing.clone()],
        };
        let empty_registry = crate::registry::RegistryFile {
            version: "test".into(),
            agents: Vec::new(),
            source: None,
            fetched_at: None,
        };

        let preview =
            preview_registry_agent(&file, &empty_registry, "grok-build").expect("preview");

        assert_eq!(preview.outcome, "alreadyConfigured");
        assert_eq!(preview.command, "/opt/user-grok");
        assert_eq!(preview.configured.as_ref(), Some(&existing));
        assert!(preview.approval_token.is_none());
    }
}
