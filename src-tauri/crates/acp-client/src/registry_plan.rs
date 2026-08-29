//! Side-effect-free Registry launch planning and installer approval tokens.

use crate::registry::{
    configured_npx_cache_dir, current_platform_key, exact_npm_package_spec, grok_stdio_args,
    is_grok_registry_agent, official_quarantine_reason, resolve_cached_exact_npx,
    resolve_command_path, resolve_installed_npx_trampoline, NpxDist, RegistryAgent, ResolvedLaunch,
    UvxDist, GROK_NPM_MARKER, OFFICIAL_NPM_REGISTRY,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

const APPROVAL_TTL: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RegistryPlanOutcome {
    AlreadyConfigured,
    ReuseLocal,
    InstallRequired,
    ManualRequired,
    Quarantined,
}

impl RegistryPlanOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AlreadyConfigured => "alreadyConfigured",
            Self::ReuseLocal => "reuseLocal",
            Self::InstallRequired => "installRequired",
            Self::ManualRequired => "manualRequired",
            Self::Quarantined => "quarantined",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryLaunchPlan {
    pub outcome: RegistryPlanOutcome,
    pub command: String,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    pub kind: String,
    pub source: String,
    pub version: Option<String>,
    pub installer_kind: Option<String>,
    pub installer_spec: Option<String>,
    pub quarantine_reason: Option<String>,
    pub manual_reason: Option<String>,
    pub catalog_version: Option<String>,
}

impl RegistryLaunchPlan {
    pub fn launch(&self) -> Option<ResolvedLaunch> {
        if self.command.is_empty() {
            return None;
        }
        Some(ResolvedLaunch {
            command: self.command.clone(),
            args: self.args.clone(),
            env: self.env.clone(),
            kind: self.kind.clone(),
        })
    }

    pub fn fingerprint(&self, agent_id: &str) -> String {
        let mut env_pairs = self.env.iter().collect::<Vec<_>>();
        env_pairs.sort_by_key(|(key, _)| *key);
        let payload = serde_json::json!({
            "agentId": agent_id,
            "outcome": self.outcome.as_str(),
            "command": self.command,
            "args": self.args,
            "env": env_pairs,
            "kind": self.kind,
            "source": self.source,
            "installerKind": self.installer_kind,
            "installerSpec": self.installer_spec,
        });
        hex_sha256(payload.to_string().as_bytes())
    }
}

struct ApprovalRecord {
    fingerprint: String,
    expires_at: Instant,
}

fn approval_tokens() -> MutexGuard<'static, HashMap<String, ApprovalRecord>> {
    static STORE: OnceLock<Mutex<HashMap<String, ApprovalRecord>>> = OnceLock::new();
    STORE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn hex_sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn prune_expired(store: &mut HashMap<String, ApprovalRecord>, now: Instant) {
    store.retain(|_, record| record.expires_at > now);
}

pub fn issue_approval_token(agent_id: &str, plan: &RegistryLaunchPlan) -> String {
    let token = uuid::Uuid::new_v4().to_string();
    let record = ApprovalRecord {
        fingerprint: plan.fingerprint(agent_id),
        expires_at: Instant::now() + APPROVAL_TTL,
    };
    let mut store = approval_tokens();
    prune_expired(&mut store, Instant::now());
    store.insert(token.clone(), record);
    token
}

pub fn consume_approval_token(
    agent_id: &str,
    plan: &RegistryLaunchPlan,
    token: &str,
) -> anyhow::Result<()> {
    let mut store = approval_tokens();
    prune_expired(&mut store, Instant::now());
    let Some(record) = store.remove(token) else {
        anyhow::bail!("ACP installer approval token is missing or expired");
    };
    if record.fingerprint != plan.fingerprint(agent_id) {
        anyhow::bail!("ACP installer approval token does not match the current launch plan");
    }
    Ok(())
}

fn from_launch(
    outcome: RegistryPlanOutcome,
    launch: ResolvedLaunch,
    source: &str,
    version: Option<String>,
    catalog_version: Option<String>,
) -> RegistryLaunchPlan {
    RegistryLaunchPlan {
        outcome,
        command: launch.command,
        args: launch.args,
        env: launch.env,
        kind: launch.kind,
        source: source.into(),
        version,
        installer_kind: None,
        installer_spec: None,
        quarantine_reason: None,
        manual_reason: None,
        catalog_version,
    }
}

fn quarantined(reason: &str, catalog_version: Option<String>) -> RegistryLaunchPlan {
    RegistryLaunchPlan {
        outcome: RegistryPlanOutcome::Quarantined,
        command: String::new(),
        args: Vec::new(),
        env: HashMap::new(),
        kind: String::new(),
        source: "registry".into(),
        version: catalog_version.clone(),
        installer_kind: None,
        installer_spec: None,
        quarantine_reason: Some(reason.to_string()),
        manual_reason: None,
        catalog_version,
    }
}

fn manual(
    reason: &str,
    catalog_version: Option<String>,
    command: String,
    args: Vec<String>,
) -> RegistryLaunchPlan {
    RegistryLaunchPlan {
        outcome: RegistryPlanOutcome::ManualRequired,
        command,
        args,
        env: HashMap::new(),
        kind: "manual".into(),
        source: "registry".into(),
        version: catalog_version.clone(),
        installer_kind: None,
        installer_spec: None,
        quarantine_reason: None,
        manual_reason: Some(reason.to_string()),
        catalog_version,
    }
}

pub(crate) fn exact_uvx_package_spec(spec: &str) -> Option<(&str, &str)> {
    if let Some((name, version)) = spec.split_once("==") {
        if !name.is_empty() && semver::Version::parse(version).is_ok() {
            return Some((name, version));
        }
    }
    if let Some((name, version)) = spec.rsplit_once('@') {
        if !name.is_empty() && !name.starts_with('@') && semver::Version::parse(version).is_ok() {
            return Some((name, version));
        }
    }
    None
}

fn command_basename(cmd: &str) -> String {
    PathBuf::from(cmd)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| cmd.to_string())
}

fn declared_local_binary(
    agent: &RegistryAgent,
    resolve_command: impl Fn(&str) -> Option<String>,
) -> Option<ResolvedLaunch> {
    let bin = agent
        .distribution
        .as_ref()?
        .binary
        .as_ref()?
        .get(&current_platform_key())?;
    let resolved = resolve_command(&command_basename(&bin.cmd))?;
    let mut env = bin.env.clone();
    env.remove(GROK_NPM_MARKER);
    Some(ResolvedLaunch {
        command: resolved,
        args: bin.args.clone(),
        env,
        kind: "binary".into(),
    })
}

fn npx_installer_launch(npx: &NpxDist) -> ResolvedLaunch {
    let mut args = vec![
        "-y".to_string(),
        format!("--registry={OFFICIAL_NPM_REGISTRY}"),
        npx.package.clone(),
    ];
    args.extend(npx.args.clone());
    let mut env = npx.env.clone();
    env.remove(GROK_NPM_MARKER);
    ResolvedLaunch {
        command: "npx".into(),
        args,
        env,
        kind: "npx".into(),
    }
}

fn uvx_installer_launch(uvx: &UvxDist) -> ResolvedLaunch {
    let mut args = vec![uvx.package.clone()];
    args.extend(uvx.args.clone());
    ResolvedLaunch {
        command: "uvx".into(),
        args,
        env: uvx.env.clone(),
        kind: "uvx".into(),
    }
}

fn npx_version(npx: &NpxDist) -> Option<String> {
    exact_npm_package_spec(&npx.package).map(|(_, version)| version.to_string())
}

fn uvx_version(uvx: &UvxDist) -> Option<String> {
    exact_uvx_package_spec(&uvx.package).map(|(_, version)| version.to_string())
}

fn binary_install_hint(agent: &RegistryAgent) -> String {
    if let Some(website) = agent.website.as_deref().filter(|value| !value.is_empty()) {
        return format!("Install `{id}` manually from {website}", id = agent.id);
    }
    if let Some(repository) = agent
        .repository
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        return format!("Install `{id}` manually from {repository}", id = agent.id);
    }
    format!(
        "Install the `{cmd}` binary for `{id}` manually; AQBot will not download it",
        cmd = agent
            .distribution
            .as_ref()
            .and_then(|distribution| distribution.binary.as_ref())
            .and_then(|bins| bins.get(&current_platform_key()))
            .map(|bin| command_basename(&bin.cmd))
            .unwrap_or_else(|| agent.id.clone()),
        id = agent.id
    )
}

pub fn plan_registry_launch(agent: &RegistryAgent) -> RegistryLaunchPlan {
    let npx_cache = agent
        .distribution
        .as_ref()
        .and_then(|distribution| distribution.npx.as_ref())
        .and_then(|npx| configured_npx_cache_dir(&npx.env));
    plan_registry_launch_with(agent, resolve_command_path, npx_cache.as_deref())
}

pub fn plan_registry_launch_with(
    agent: &RegistryAgent,
    resolve_command: impl Fn(&str) -> Option<String>,
    npx_cache: Option<&Path>,
) -> RegistryLaunchPlan {
    let catalog_version = agent.version.clone();
    if let Some(reason) = agent
        .quarantine_reason
        .as_deref()
        .or_else(|| official_quarantine_reason(&agent.id))
    {
        return quarantined(reason, catalog_version);
    }
    let Some(distribution) = agent.distribution.as_ref() else {
        return manual(
            "Registry entry has no launch distribution",
            catalog_version,
            String::new(),
            Vec::new(),
        );
    };

    if let Some(launch) = declared_local_binary(agent, &resolve_command) {
        return from_launch(
            RegistryPlanOutcome::ReuseLocal,
            launch,
            "local",
            catalog_version.clone(),
            catalog_version,
        );
    }

    if is_grok_registry_agent(agent) {
        if let Some(command) = resolve_command("grok") {
            return from_launch(
                RegistryPlanOutcome::ReuseLocal,
                ResolvedLaunch {
                    command,
                    args: grok_stdio_args(),
                    env: HashMap::new(),
                    kind: "binary".into(),
                },
                "local",
                catalog_version.clone(),
                catalog_version,
            );
        }
    }

    if let Some(npx) = distribution.npx.as_ref() {
        if let Some(launch) = resolve_installed_npx_trampoline(npx, &resolve_command) {
            return from_launch(
                RegistryPlanOutcome::ReuseLocal,
                launch,
                "local",
                npx_version(npx).or_else(|| catalog_version.clone()),
                catalog_version,
            );
        }
        if let Some(cache) = npx_cache {
            if let Some(launch) = resolve_cached_exact_npx(npx, cache) {
                return from_launch(
                    RegistryPlanOutcome::ReuseLocal,
                    launch,
                    "npxCache",
                    npx_version(npx).or_else(|| catalog_version.clone()),
                    catalog_version,
                );
            }
        }
        if let Some(version) = npx_version(npx) {
            let launch = npx_installer_launch(npx);
            let mut plan = from_launch(
                RegistryPlanOutcome::InstallRequired,
                launch,
                "npx",
                Some(version),
                catalog_version,
            );
            plan.installer_kind = Some("npx".into());
            plan.installer_spec = Some(npx.package.clone());
            return plan;
        }
        return manual(
            "Registry npx spec is not an exact version and cannot be installed automatically",
            catalog_version,
            "npx".into(),
            vec![npx.package.clone()],
        );
    }

    if let Some(uvx) = distribution.uvx.as_ref() {
        if let Some(version) = uvx_version(uvx) {
            let launch = uvx_installer_launch(uvx);
            let mut plan = from_launch(
                RegistryPlanOutcome::InstallRequired,
                launch,
                "uvx",
                Some(version),
                catalog_version,
            );
            plan.installer_kind = Some("uvx".into());
            plan.installer_spec = Some(uvx.package.clone());
            return plan;
        }
        return manual(
            "Registry uvx spec is not an exact version and cannot be installed automatically",
            catalog_version,
            "uvx".into(),
            vec![uvx.package.clone()],
        );
    }

    if distribution.binary.is_some() {
        let hint = binary_install_hint(agent);
        let cmd = distribution
            .binary
            .as_ref()
            .and_then(|bins| bins.get(&current_platform_key()))
            .map(|bin| command_basename(&bin.cmd))
            .unwrap_or_default();
        let args = distribution
            .binary
            .as_ref()
            .and_then(|bins| bins.get(&current_platform_key()))
            .map(|bin| bin.args.clone())
            .unwrap_or_default();
        return manual(&hint, catalog_version, cmd, args);
    }

    manual(
        "Registry entry has no supported launch method",
        catalog_version,
        String::new(),
        Vec::new(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registry::{
        find_registry_agent, load_builtin_registry, RegistryDistribution, RegistryFile,
    };

    fn grok_agent() -> RegistryAgent {
        find_registry_agent(&load_builtin_registry().expect("builtin"), "grok-build")
            .expect("grok-build")
            .clone()
    }

    #[test]
    fn grok_reuses_local_binary_even_when_filename_is_unversioned() {
        let plan = plan_registry_launch_with(&grok_agent(), |_| Some("/opt/grok".into()), None);
        assert_eq!(plan.outcome, RegistryPlanOutcome::ReuseLocal);
        assert_eq!(plan.command, "/opt/grok");
        assert_eq!(plan.args, ["agent", "stdio"]);
        assert!(!plan.env.contains_key(GROK_NPM_MARKER));
        assert_eq!(plan.source, "local");
    }

    #[test]
    fn grok_reuses_version_mismatched_local_filename() {
        let mut agent = grok_agent();
        agent.distribution.as_mut().expect("distribution").binary = None;
        let plan = plan_registry_launch_with(
            &agent,
            |command| (command == "grok").then(|| "/isolated/grok-0.2.121".into()),
            None,
        );
        assert_eq!(plan.outcome, RegistryPlanOutcome::ReuseLocal);
        assert_eq!(plan.command, "/isolated/grok-0.2.121");
        assert_eq!(plan.args, grok_stdio_args());
        assert!(!plan.env.contains_key(GROK_NPM_MARKER));
    }

    #[test]
    fn grok_without_local_binary_requires_exact_npx_install() {
        let plan = plan_registry_launch_with(&grok_agent(), |_| None, None);
        assert_eq!(plan.outcome, RegistryPlanOutcome::InstallRequired);
        assert_eq!(plan.command, "npx");
        assert_eq!(plan.installer_kind.as_deref(), Some("npx"));
        assert_eq!(
            plan.installer_spec.as_deref(),
            Some("@xai-official/grok@1.0.0")
        );
        assert!(plan
            .args
            .iter()
            .any(|arg| arg == "@xai-official/grok@1.0.0"));
        assert!(!plan.env.contains_key(GROK_NPM_MARKER));
    }

    #[test]
    fn variable_npx_spec_is_manual() {
        let mut agent = grok_agent();
        agent
            .distribution
            .as_mut()
            .expect("distribution")
            .npx
            .as_mut()
            .expect("npx")
            .package = "@xai-official/grok@latest".into();
        agent.distribution.as_mut().expect("distribution").binary = None;
        let plan = plan_registry_launch_with(&agent, |_| None, None);
        assert_eq!(plan.outcome, RegistryPlanOutcome::ManualRequired);
        assert!(plan
            .manual_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("exact version")));
    }

    #[test]
    fn semver_range_npx_spec_is_manual() {
        let mut agent = grok_agent();
        agent
            .distribution
            .as_mut()
            .expect("distribution")
            .npx
            .as_mut()
            .expect("npx")
            .package = "@xai-official/grok@^1.0.0".into();
        agent.distribution.as_mut().expect("distribution").binary = None;
        let plan = plan_registry_launch_with(&agent, |_| None, None);
        assert_eq!(plan.outcome, RegistryPlanOutcome::ManualRequired);
    }

    #[test]
    fn binary_only_missing_local_is_manual() {
        let mut agent = grok_agent();
        agent.distribution = Some(RegistryDistribution {
            npx: None,
            uvx: None,
            binary: agent
                .distribution
                .and_then(|distribution| distribution.binary),
        });
        let plan = plan_registry_launch_with(&agent, |_| None, None);
        assert_eq!(plan.outcome, RegistryPlanOutcome::ManualRequired);
        assert!(plan
            .manual_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("manually")));
    }

    #[test]
    fn approval_token_fails_when_plan_changes() {
        let first = plan_registry_launch_with(&grok_agent(), |_| None, None);
        let token = issue_approval_token("grok-build", &first);
        let mut changed = grok_agent();
        changed
            .distribution
            .as_mut()
            .expect("distribution")
            .npx
            .as_mut()
            .expect("npx")
            .package = "@xai-official/grok@1.0.1".into();
        changed.distribution.as_mut().expect("distribution").binary = None;
        let second = plan_registry_launch_with(&changed, |_| None, None);
        let error = consume_approval_token("grok-build", &second, &token)
            .expect_err("stale token must fail");
        assert!(error.to_string().contains("does not match"));
    }

    #[test]
    fn approval_token_is_single_use() {
        let plan = plan_registry_launch_with(&grok_agent(), |_| None, None);
        let token = issue_approval_token("grok-build", &plan);
        consume_approval_token("grok-build", &plan, &token).expect("first consume");
        consume_approval_token("grok-build", &plan, &token).expect_err("token cannot be reused");
    }

    #[test]
    fn quarantined_registry_agent_is_not_installable() {
        let registry: RegistryFile = load_builtin_registry().expect("builtin");
        let agent = find_registry_agent(&registry, "fast-agent").expect("fast-agent");
        let plan = plan_registry_launch_with(agent, |_| None, None);
        assert_eq!(plan.outcome, RegistryPlanOutcome::Quarantined);
        assert!(plan.quarantine_reason.is_some());
    }
}
