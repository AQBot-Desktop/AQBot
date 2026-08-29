//! Official ACP Registry loader.
//!
//! Sources (priority for reads after refresh):
//! 1. live CDN (when refresh succeeds)
//! 2. local cache `~/.aqbot/acp/registry.cache.json`
//! 3. builtin snapshot embedded in the binary

use crate::paths::{ensure_acp_dirs, registry_cache_path};
use crate::proxy::ProxyEnvironment;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha512};
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

pub const REGISTRY_URL: &str =
    "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
pub(crate) const OFFICIAL_NPM_REGISTRY: &str = "https://registry.npmjs.org";
pub(crate) const GROK_NPM_PACKAGE: &str = "@xai-official/grok";
pub(crate) const GROK_AGENT_ID: &str = "grok-build";
pub(crate) const GROK_NPM_MARKER: &str = "GROK_MANAGED_BY_NPM";

/// Full offline snapshot of the official ACP registry (kept in sync with CDN).
/// Online refresh still updates `~/.aqbot/acp/registry.cache.json` when available.
pub const BUILTIN_REGISTRY_JSON: &str = include_str!("../resources/registry.builtin.json");

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryFile {
    pub version: String,
    pub agents: Vec<RegistryAgent>,
    #[serde(default)]
    pub source: Option<RegistrySource>,
    #[serde(default)]
    pub fetched_at: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RegistrySource {
    Builtin,
    Cache,
    Live,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryAgent {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub repository: Option<String>,
    #[serde(default)]
    pub website: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub license: Option<String>,
    #[serde(default)]
    pub distribution: Option<RegistryDistribution>,
    /// Known-broken entry from the official Registry quarantine list. AQBot
    /// shows it for completeness but does not allow enabling it.
    #[serde(default)]
    pub quarantine_reason: Option<String>,
}

pub fn official_quarantine_reason(agent_id: &str) -> Option<&'static str> {
    match agent_id {
        "agoragentic-acp" => Some("Official quarantine: unsafe/broken postinstall script"),
        "codebuddy-code" => Some("Official quarantine: npx cannot determine an executable"),
        "crow-cli" => Some("Official quarantine: published initialize regression"),
        "deepagents" => Some("Official quarantine: missing package dependency"),
        "fast-agent" => Some("Official quarantine: initialize exceeds the protocol timeout"),
        "minion-code" => Some("Official quarantine: unresolved Python dependencies"),
        "qoder" => Some("Official quarantine: published initialize regression"),
        "vtcode" => Some("Official quarantine: incomplete platform builds"),
        _ => None,
    }
}

pub(crate) fn grok_stdio_args() -> Vec<String> {
    vec!["agent".into(), "stdio".into()]
}

pub(crate) fn grok_command_name(command: &str) -> Option<String> {
    let name = Path::new(command)
        .file_stem()?
        .to_str()?
        .to_ascii_lowercase();
    (name == "grok" || name.starts_with("grok-")).then_some(name)
}

pub(crate) fn is_direct_grok_fingerprint(command: &str, args: &[String]) -> bool {
    grok_command_name(command).is_some() && args == grok_stdio_args()
}

pub(crate) fn is_grok_registry_agent(agent: &RegistryAgent) -> bool {
    agent.id == GROK_AGENT_ID
        || agent
            .distribution
            .as_ref()
            .and_then(|distribution| distribution.npx.as_ref())
            .is_some_and(|npx| {
                exact_npm_package_spec(&npx.package)
                    .is_some_and(|(package, _)| package == GROK_NPM_PACKAGE)
            })
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RegistryDistribution {
    #[serde(default)]
    pub npx: Option<NpxDist>,
    #[serde(default)]
    pub uvx: Option<UvxDist>,
    #[serde(default)]
    pub binary: Option<HashMap<String, BinaryDist>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NpxDist {
    pub package: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UvxDist {
    pub package: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BinaryDist {
    #[serde(default)]
    pub archive: Option<String>,
    pub cmd: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default)]
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedLaunch {
    pub command: String,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    pub kind: String,
}

pub(crate) fn current_platform_key() -> String {
    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;
    let os_part = match os {
        "macos" => "darwin",
        "windows" => "windows",
        other => other,
    };
    let arch_part = match arch {
        "aarch64" => "aarch64",
        "x86_64" => "x86_64",
        other => other,
    };
    format!("{os_part}-{arch_part}")
}

/// Resolve a CLI to an absolute path when possible.
/// GUI apps often lack shell-augmented PATH entries like `~/.grok/bin` or nvm,
/// so also probe well-known install locations for common agent CLIs.
pub(crate) fn resolve_command_path(cmd: &str) -> Option<String> {
    // Already absolute / relative with separator
    if cmd.contains('/') || cmd.contains('\\') {
        let p = PathBuf::from(cmd);
        if p.is_file() {
            return Some(cmd.to_string());
        }
    }

    let which = if cfg!(windows) { "where" } else { "which" };
    if let Ok(output) = std::process::Command::new(which).arg(cmd).output() {
        if output.status.success() {
            if let Ok(stdout) = String::from_utf8(output.stdout) {
                if let Some(line) = stdout.lines().next() {
                    let line = line.trim();
                    if !line.is_empty() {
                        return Some(line.to_string());
                    }
                }
            }
        }
    }

    // Well-known install dirs (macOS/Linux) when GUI PATH is minimal.
    if let Some(home) = dirs::home_dir().or_else(|| std::env::var_os("HOME").map(PathBuf::from)) {
        let candidates = [
            home.join(".grok/bin").join(cmd),
            home.join(".local/bin").join(cmd),
            home.join(".cargo/bin").join(cmd),
            PathBuf::from("/opt/homebrew/bin").join(cmd),
            PathBuf::from("/usr/local/bin").join(cmd),
        ];
        for c in candidates {
            if c.is_file() {
                return Some(c.to_string_lossy().to_string());
            }
        }
    }
    None
}

fn is_valid_npm_package_name(package: &str) -> bool {
    let valid_segment = |segment: &str| {
        !segment.is_empty()
            && segment != "."
            && segment != ".."
            && segment
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || "-._~".contains(ch))
    };
    if let Some(scoped) = package.strip_prefix('@') {
        let Some((scope, name)) = scoped.split_once('/') else {
            return false;
        };
        valid_segment(scope) && valid_segment(name) && !name.contains('/')
    } else {
        valid_segment(package) && !package.contains(['/', '\\'])
    }
}

pub(crate) fn exact_npm_package_spec(spec: &str) -> Option<(&str, &str)> {
    let (package, version) = spec.rsplit_once('@')?;
    if !is_valid_npm_package_name(package) || semver::Version::parse(version).is_err() {
        return None;
    }
    Some((package, version))
}

fn npx_cache_key(spec: &str) -> Option<String> {
    exact_npm_package_spec(spec)?;
    let digest = Sha512::digest(spec.as_bytes());
    Some(
        digest[..8]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
    )
}

#[cfg(unix)]
pub(crate) fn configured_npx_cache_dir(env: &HashMap<String, String>) -> Option<PathBuf> {
    let configured = env
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case("npm_config_cache"))
        .map(|(_, value)| PathBuf::from(value))
        .or_else(|| std::env::var_os("npm_config_cache").map(PathBuf::from))
        .or_else(|| std::env::var_os("NPM_CONFIG_CACHE").map(PathBuf::from));
    let root = configured.or_else(|| dirs::home_dir().map(|home| home.join(".npm")))?;
    root.is_absolute().then(|| root.join("_npx"))
}

#[cfg(not(unix))]
pub(crate) fn configured_npx_cache_dir(_env: &HashMap<String, String>) -> Option<PathBuf> {
    None
}

#[cfg(unix)]
fn read_json_file(path: &Path) -> Option<serde_json::Value> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

#[cfg(unix)]
fn select_npm_bin(manifest: &serde_json::Value, package: &str) -> Option<(String, String)> {
    let bins = manifest.get("bin")?.as_object()?;
    let package_bin = package.rsplit('/').next()?;
    if let Some(target) = bins.get(package_bin).and_then(|value| value.as_str()) {
        return Some((package_bin.to_string(), target.to_string()));
    }
    let mut targets = bins.values().filter_map(|value| value.as_str());
    let first_target = targets.next()?;
    if !targets.all(|target| target == first_target) {
        return None;
    }
    let bin_name = bins
        .iter()
        .find_map(|(name, target)| (target.as_str() == Some(first_target)).then(|| name.clone()))?;
    Some((bin_name, first_target.to_string()))
}

#[cfg(unix)]
fn safe_relative_bin_target(target: &str) -> Option<PathBuf> {
    let path = PathBuf::from(target);
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || !path
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
    {
        return None;
    }
    Some(path)
}

#[cfg(unix)]
fn lock_matches_exact_bin(
    lock: &serde_json::Value,
    package: &str,
    version: &str,
    bin_name: &str,
    bin_target: &str,
) -> bool {
    if lock
        .get("lockfileVersion")
        .and_then(|value| value.as_u64())
        .is_none_or(|version| version < 2)
    {
        return false;
    }
    let key = format!("node_modules/{package}");
    let Some(entry) = lock.get("packages").and_then(|value| value.get(&key)) else {
        return false;
    };
    entry.get("version").and_then(|value| value.as_str()) == Some(version)
        && entry
            .get("integrity")
            .and_then(|value| value.as_str())
            .is_some_and(is_sha512_integrity)
        && entry
            .get("bin")
            .and_then(|value| value.get(bin_name))
            .and_then(|value| value.as_str())
            == Some(bin_target)
}

#[cfg(unix)]
fn is_sha512_integrity(integrity: &str) -> bool {
    let Some(encoded) = integrity.strip_prefix("sha512-") else {
        return false;
    };
    let bytes = encoded.as_bytes();
    bytes.len() == 88
        && &bytes[86..] == b"=="
        && bytes[..86]
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(*byte, b'+' | b'/'))
}

#[cfg(unix)]
pub(crate) fn resolve_cached_exact_npx(npx: &NpxDist, npx_cache: &Path) -> Option<ResolvedLaunch> {
    let (package, version) = exact_npm_package_spec(&npx.package)?;
    let install_dir = npx_cache.join(npx_cache_key(&npx.package)?);
    let cache_root = std::fs::canonicalize(npx_cache).ok()?;
    let install_root = std::fs::canonicalize(&install_dir).ok()?;
    if !install_root.starts_with(&cache_root) {
        return None;
    }
    let package_dir = install_dir.join("node_modules").join(package);
    let manifest = read_json_file(&package_dir.join("package.json"))?;
    if manifest.get("name").and_then(|value| value.as_str()) != Some(package)
        || manifest.get("version").and_then(|value| value.as_str()) != Some(version)
    {
        return None;
    }
    let (bin_name, bin_target) = select_npm_bin(&manifest, package)?;
    let lock = read_json_file(&install_dir.join("package-lock.json"))?;
    if !lock_matches_exact_bin(&lock, package, version, &bin_name, &bin_target) {
        return None;
    }
    verified_cached_bin_launch(npx, &install_dir, &package_dir, &bin_name, &bin_target)
}

#[cfg(unix)]
fn verified_cached_bin_launch(
    npx: &NpxDist,
    install_dir: &Path,
    package_dir: &Path,
    bin_name: &str,
    bin_target: &str,
) -> Option<ResolvedLaunch> {
    let install_root = std::fs::canonicalize(install_dir).ok()?;
    let node_modules_root = std::fs::canonicalize(install_dir.join("node_modules")).ok()?;
    if !node_modules_root.starts_with(&install_root) {
        return None;
    }
    let package_root = std::fs::canonicalize(package_dir).ok()?;
    if !package_root.starts_with(&node_modules_root) {
        return None;
    }
    let expected =
        std::fs::canonicalize(package_dir.join(safe_relative_bin_target(bin_target)?)).ok()?;
    if !expected.starts_with(&package_root) {
        return None;
    }
    let bin_link = install_dir.join("node_modules/.bin").join(bin_name);
    let bin_dir = std::fs::canonicalize(install_dir.join("node_modules/.bin")).ok()?;
    if !std::fs::symlink_metadata(&bin_link)
        .ok()?
        .file_type()
        .is_symlink()
        || !bin_dir.starts_with(&node_modules_root)
        || std::fs::canonicalize(&bin_link).ok()? != expected
    {
        return None;
    }
    let metadata = std::fs::metadata(&expected).ok()?;
    if !metadata.is_file() || metadata.permissions().mode() & 0o111 == 0 {
        return None;
    }
    Some(ResolvedLaunch {
        command: bin_link.to_string_lossy().into_owned(),
        args: npx.args.clone(),
        env: npx.env.clone(),
        kind: "binary".into(),
    })
}

#[cfg(not(unix))]
pub(crate) fn resolve_cached_exact_npx(
    _npx: &NpxDist,
    _npx_cache: &Path,
) -> Option<ResolvedLaunch> {
    None
}

/// Reuse a local Grok CLI whenever one is already executable.
///
/// Registry version pins and installer filenames are not authoritative for an
/// already-installed binary. AQBot must not inject npm-managed markers or
/// auto-update flags; Grok's own config remains the source of truth.
pub(crate) fn resolve_installed_npx_trampoline(
    npx: &NpxDist,
    resolve_command: impl Fn(&str) -> Option<String>,
) -> Option<ResolvedLaunch> {
    let (package, _) = exact_npm_package_spec(&npx.package)?;
    if package != GROK_NPM_PACKAGE {
        return None;
    }
    let command = resolve_command("grok")?;
    let mut env = npx.env.clone();
    env.remove(GROK_NPM_MARKER);
    Some(ResolvedLaunch {
        command,
        args: grok_stdio_args(),
        env,
        kind: "binary".into(),
    })
}

pub(crate) fn configured_npx_distribution(
    command: &str,
    args: &[String],
    env: &HashMap<String, String>,
) -> Option<NpxDist> {
    let command_name = PathBuf::from(command)
        .file_stem()?
        .to_string_lossy()
        .to_ascii_lowercase();
    if command_name != "npx" {
        return None;
    }
    let package_index = args
        .iter()
        .position(|argument| exact_npm_package_spec(argument).is_some())?;
    if !args[..package_index].iter().all(|argument| {
        matches!(argument.as_str(), "-y" | "--yes") || argument.starts_with("--registry=")
    }) {
        return None;
    }
    Some(NpxDist {
        package: args[package_index].clone(),
        args: args[package_index + 1..].to_vec(),
        env: env.clone(),
    })
}

fn resolve_configured_npx_with_cache(
    command: &str,
    args: &[String],
    env: &HashMap<String, String>,
    npx_cache: Option<&Path>,
    resolve_command: impl Fn(&str) -> Option<String>,
) -> Option<ResolvedLaunch> {
    let distribution = configured_npx_distribution(command, args, env)?;
    resolve_installed_npx_trampoline(&distribution, resolve_command)
        .or_else(|| npx_cache.and_then(|cache| resolve_cached_exact_npx(&distribution, cache)))
}

#[cfg(test)]
pub(crate) fn resolve_configured_npx_trampoline_with(
    command: &str,
    args: &[String],
    env: &HashMap<String, String>,
    resolve_command: impl Fn(&str) -> Option<String>,
) -> Option<ResolvedLaunch> {
    resolve_configured_npx_with_cache(command, args, env, None, resolve_command)
}

/// Upgrade an already-persisted exact Registry npx launch without waiting for
/// a network Registry refresh. Any cache mismatch deliberately keeps npx so
/// the configured package remains authoritative.
pub(crate) fn resolve_configured_npx_trampoline(
    command: &str,
    args: &[String],
    env: &HashMap<String, String>,
) -> Option<ResolvedLaunch> {
    let npx_cache = configured_npx_cache_dir(env);
    resolve_configured_npx_with_cache(
        command,
        args,
        env,
        npx_cache.as_deref(),
        resolve_command_path,
    )
}

pub(crate) fn resolve_npx_launch(npx: &NpxDist, npx_cache: Option<&Path>) -> ResolvedLaunch {
    if let Some(cache) = npx_cache {
        if let Some(launch) = resolve_cached_exact_npx(npx, cache) {
            return launch;
        }
        tracing::debug!(
            package = %npx.package,
            cache = %cache.display(),
            "verified exact npx cache unavailable; using npx"
        );
    }
    let mut args = vec![
        "-y".to_string(),
        format!("--registry={OFFICIAL_NPM_REGISTRY}"),
        npx.package.clone(),
    ];
    args.extend(npx.args.clone());
    ResolvedLaunch {
        command: "npx".into(),
        args,
        env: npx.env.clone(),
        kind: "npx".into(),
    }
}

/// Resolve a launch command for the current platform.
/// Prefer an already-installed binary on PATH when the registry declares one
/// (e.g. local `grok` from the official installer). Otherwise prefer npx/uvx
/// (no manual download); fall back to binary cmd name only (V1 does not install).
pub fn resolve_launch(agent: &RegistryAgent) -> Option<ResolvedLaunch> {
    let npx_cache = agent
        .distribution
        .as_ref()
        .and_then(|distribution| distribution.npx.as_ref())
        .and_then(|npx| configured_npx_cache_dir(&npx.env));
    resolve_launch_with_npx_cache(agent, npx_cache.as_deref())
}

fn resolve_launch_with_npx_cache(
    agent: &RegistryAgent,
    npx_cache: Option<&Path>,
) -> Option<ResolvedLaunch> {
    let dist = agent.distribution.as_ref()?;

    // Prefer local CLI when the user already installed it (faster, no npm pin issues).
    if let Some(bin_map) = &dist.binary {
        let key = current_platform_key();
        if let Some(bin) = bin_map.get(&key) {
            let cmd = PathBuf::from(&bin.cmd)
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| bin.cmd.clone());
            if let Some(resolved) = resolve_command_path(&cmd) {
                return Some(ResolvedLaunch {
                    command: resolved,
                    args: bin.args.clone(),
                    env: bin.env.clone(),
                    kind: "binary".into(),
                });
            }
        }
    }

    if let Some(npx) = &dist.npx {
        if let Some(launch) = resolve_installed_npx_trampoline(npx, resolve_command_path) {
            return Some(launch);
        }
        return Some(resolve_npx_launch(npx, npx_cache));
    }

    if let Some(uvx) = &dist.uvx {
        let mut args = vec![uvx.package.clone()];
        args.extend(uvx.args.clone());
        return Some(ResolvedLaunch {
            command: "uvx".into(),
            args,
            env: uvx.env.clone(),
            kind: "uvx".into(),
        });
    }

    if let Some(bin_map) = &dist.binary {
        let key = current_platform_key();
        if let Some(bin) = bin_map.get(&key) {
            // V1: only expose cmd basename; user must install binary themselves.
            let cmd = PathBuf::from(&bin.cmd)
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| bin.cmd.clone());
            return Some(ResolvedLaunch {
                command: cmd,
                args: bin.args.clone(),
                env: bin.env.clone(),
                kind: "binary".into(),
            });
        }
    }

    None
}

fn parse_registry(json: &str, source: RegistrySource) -> anyhow::Result<RegistryFile> {
    // Registry CDN uses snake_case in distribution keys; keep flexible parse.
    let mut file: RegistryFile = serde_json::from_str(json).or_else(|_| {
        // CDN uses original camelCase mixed with snake_case field names in distribution.
        // Re-parse with a raw Value and map.
        parse_registry_flexible(json)
    })?;
    for agent in &mut file.agents {
        agent.quarantine_reason = official_quarantine_reason(&agent.id).map(str::to_string);
    }
    file.source = Some(source);
    Ok(file)
}

fn parse_registry_flexible(json: &str) -> anyhow::Result<RegistryFile> {
    #[derive(Deserialize)]
    struct RawFile {
        version: String,
        agents: Vec<serde_json::Value>,
    }
    let raw: RawFile = serde_json::from_str(json)?;
    let mut agents = Vec::new();
    for a in raw.agents {
        let id = a
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if id.is_empty() {
            continue;
        }
        let name = a
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or(&id)
            .to_string();
        let version = a
            .get("version")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let description = a
            .get("description")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let repository = a
            .get("repository")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let website = a
            .get("website")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let icon = a
            .get("icon")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let license = a
            .get("license")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let distribution = a.get("distribution").and_then(|d| {
            let mut dist = RegistryDistribution::default();
            if let Some(npx) = d.get("npx") {
                if let Some(package) = npx.get("package").and_then(|v| v.as_str()) {
                    let args = npx
                        .get("args")
                        .and_then(|v| v.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                                .collect()
                        })
                        .unwrap_or_default();
                    let env = npx
                        .get("env")
                        .and_then(|v| v.as_object())
                        .map(|m| {
                            m.iter()
                                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                                .collect()
                        })
                        .unwrap_or_default();
                    dist.npx = Some(NpxDist {
                        package: package.to_string(),
                        args,
                        env,
                    });
                }
            }
            if let Some(uvx) = d.get("uvx") {
                if let Some(package) = uvx.get("package").and_then(|v| v.as_str()) {
                    let args = uvx
                        .get("args")
                        .and_then(|v| v.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                                .collect()
                        })
                        .unwrap_or_default();
                    let env = uvx
                        .get("env")
                        .and_then(|v| v.as_object())
                        .map(|m| {
                            m.iter()
                                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                                .collect()
                        })
                        .unwrap_or_default();
                    dist.uvx = Some(UvxDist {
                        package: package.to_string(),
                        args,
                        env,
                    });
                }
            }
            if let Some(bin) = d.get("binary").and_then(|v| v.as_object()) {
                let mut map = HashMap::new();
                for (k, v) in bin {
                    if let Some(cmd) = v.get("cmd").and_then(|c| c.as_str()) {
                        let args = v
                            .get("args")
                            .and_then(|a| a.as_array())
                            .map(|arr| {
                                arr.iter()
                                    .filter_map(|x| x.as_str().map(|s| s.to_string()))
                                    .collect()
                            })
                            .unwrap_or_default();
                        let env = v
                            .get("env")
                            .and_then(|e| e.as_object())
                            .map(|m| {
                                m.iter()
                                    .filter_map(|(ek, ev)| {
                                        ev.as_str().map(|s| (ek.clone(), s.to_string()))
                                    })
                                    .collect()
                            })
                            .unwrap_or_default();
                        map.insert(
                            k.clone(),
                            BinaryDist {
                                archive: v
                                    .get("archive")
                                    .and_then(|a| a.as_str())
                                    .map(|s| s.to_string()),
                                cmd: cmd.to_string(),
                                args,
                                env,
                                sha256: v
                                    .get("sha256")
                                    .and_then(|s| s.as_str())
                                    .map(|s| s.to_string()),
                            },
                        );
                    }
                }
                if !map.is_empty() {
                    dist.binary = Some(map);
                }
            }
            Some(dist)
        });

        agents.push(RegistryAgent {
            id,
            name,
            version,
            description,
            repository,
            website,
            icon,
            license,
            distribution,
            quarantine_reason: None,
        });
    }
    Ok(RegistryFile {
        version: raw.version,
        agents,
        source: None,
        fetched_at: None,
    })
}

pub fn load_builtin_registry() -> anyhow::Result<RegistryFile> {
    parse_registry(BUILTIN_REGISTRY_JSON, RegistrySource::Builtin)
}

pub fn load_cached_registry() -> Option<RegistryFile> {
    let path = registry_cache_path();
    let data = std::fs::read_to_string(path).ok()?;
    parse_registry(&data, RegistrySource::Cache).ok()
}

/// Load best available registry without network.
pub fn load_registry() -> anyhow::Result<RegistryFile> {
    if let Some(mut cached) = load_cached_registry() {
        cached.source = Some(RegistrySource::Cache);
        return Ok(cached);
    }
    load_builtin_registry()
}

/// Fetch the live Registry and write the validated cache.
/// Callers decide whether to surface the error or load the existing cache.
pub async fn refresh_registry() -> anyhow::Result<RegistryFile> {
    refresh_registry_with_proxy(&ProxyEnvironment {
        http_proxy: None,
        https_proxy: None,
        all_proxy: None,
        no_proxy: None,
    })
    .await
}

/// Fetch the live Registry through an explicitly resolved process proxy.
///
/// The client always starts with automatic environment proxy discovery disabled.
/// This keeps the settings database authoritative: an empty `ProxyEnvironment`
/// is direct, while an explicit proxy is applied only to its matching scheme.
pub async fn refresh_registry_with_proxy(proxy: &ProxyEnvironment) -> anyhow::Result<RegistryFile> {
    ensure_acp_dirs()?;
    let mut file = fetch_registry_from_url(REGISTRY_URL, proxy).await?;
    file.fetched_at = Some(chrono::Utc::now().to_rfc3339());
    file.source = Some(RegistrySource::Live);
    // Cache the validated, normalized Registry plus fetch metadata.
    let cache_body = serde_json::to_string_pretty(&file)?;
    std::fs::write(registry_cache_path(), cache_body)?;
    Ok(file)
}

fn registry_client(
    registry_url: &str,
    proxy_environment: &ProxyEnvironment,
) -> anyhow::Result<reqwest::Client> {
    let scheme = reqwest::Url::parse(registry_url)
        .map_err(|error| anyhow::anyhow!("invalid Registry URL {registry_url}: {error}"))?
        .scheme()
        .to_string();
    let proxy_url = match scheme.as_str() {
        "https" => proxy_environment
            .https_proxy
            .as_deref()
            .or(proxy_environment.all_proxy.as_deref()),
        "http" => proxy_environment
            .http_proxy
            .as_deref()
            .or(proxy_environment.all_proxy.as_deref()),
        unsupported => anyhow::bail!("unsupported Registry URL scheme: {unsupported}"),
    };

    // `no_proxy()` is intentional even when an explicit proxy follows: it
    // disables reqwest's implicit HTTP(S)_PROXY lookup from the host process.
    let mut builder = reqwest::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(20))
        .user_agent("AQBot ACP Registry");
    if let Some(proxy_url) = proxy_url {
        let configured = match scheme.as_str() {
            "https" => reqwest::Proxy::https(proxy_url),
            "http" => reqwest::Proxy::http(proxy_url),
            _ => unreachable!("scheme validated above"),
        }
        .map_err(|error| anyhow::anyhow!("invalid {scheme} Registry proxy URL: {error}"))?
        .no_proxy(
            proxy_environment
                .no_proxy
                .as_deref()
                .and_then(reqwest::NoProxy::from_string),
        );
        builder = builder.proxy(configured);
    }
    builder
        .build()
        .map_err(|error| anyhow::anyhow!("build Registry HTTP client: {error}"))
}

async fn fetch_registry_from_url(
    registry_url: &str,
    proxy: &ProxyEnvironment,
) -> anyhow::Result<RegistryFile> {
    let client = registry_client(registry_url, proxy)?;
    let resp = client
        .get(registry_url)
        .send()
        .await
        .map_err(|error| anyhow::anyhow!("fetch Registry from {registry_url}: {error}"))?;
    if !resp.status().is_success() {
        anyhow::bail!("registry HTTP {}", resp.status());
    }
    let text = resp
        .text()
        .await
        .map_err(|error| anyhow::anyhow!("read Registry response body: {error}"))?;
    parse_registry(&text, RegistrySource::Live)
        .map_err(|error| anyhow::anyhow!("parse Registry response: {error}"))
}

pub fn find_registry_agent<'a>(registry: &'a RegistryFile, id: &str) -> Option<&'a RegistryAgent> {
    registry.agents.iter().find(|a| a.id == id)
}

#[cfg(all(test, unix))]
pub(crate) struct NpxCacheFixture {
    root: PathBuf,
    #[allow(dead_code)]
    pub(crate) npm_cache: PathBuf,
    pub(crate) npx_cache: PathBuf,
    pub(crate) package_dir: PathBuf,
    pub(crate) bin_link: PathBuf,
    pub(crate) lock_path: PathBuf,
}

#[cfg(all(test, unix))]
impl NpxCacheFixture {
    pub(crate) fn new(package: &str, version: &str, bin_name: &str, bin_target: &str) -> Self {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!(
            "aqbot-exact-npx-cache-test-{}",
            uuid::Uuid::new_v4()
        ));
        let npm_cache = root.join("npm-cache");
        let npx_cache = npm_cache.join("_npx");
        let spec = format!("{package}@{version}");
        let digest = Sha512::digest(spec.as_bytes());
        let hash = digest[..8]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let install_dir = npx_cache.join(hash);
        let package_dir = install_dir.join("node_modules").join(package);
        let target_path = package_dir.join(bin_target);
        std::fs::create_dir_all(target_path.parent().expect("target parent"))
            .expect("create package fixture");
        std::fs::write(&target_path, "#!/bin/sh\nexit 0\n").expect("write executable");
        let mut permissions = std::fs::metadata(&target_path)
            .expect("executable metadata")
            .permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&target_path, permissions).expect("make executable");
        let mut manifest_bins = serde_json::Map::new();
        manifest_bins.insert(bin_name.to_string(), serde_json::json!(bin_target));
        std::fs::write(
            package_dir.join("package.json"),
            serde_json::to_vec(&serde_json::json!({
                "name": package,
                "version": version,
                "bin": manifest_bins,
            }))
            .expect("package manifest"),
        )
        .expect("write package manifest");

        let lock_path = install_dir.join("package-lock.json");
        let lock_key = format!("node_modules/{package}");
        let mut packages = serde_json::Map::new();
        let mut locked_bins = serde_json::Map::new();
        locked_bins.insert(bin_name.to_string(), serde_json::json!(bin_target));
        packages.insert(
            lock_key,
            serde_json::json!({
                "version": version,
                "bin": locked_bins,
                "integrity": "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
            }),
        );
        std::fs::write(
            &lock_path,
            serde_json::to_vec(&serde_json::json!({
                "lockfileVersion": 3,
                "packages": packages,
            }))
            .expect("lock manifest"),
        )
        .expect("write lock manifest");

        let bin_dir = install_dir.join("node_modules/.bin");
        std::fs::create_dir_all(&bin_dir).expect("create bin directory");
        let bin_link = bin_dir.join(bin_name);
        symlink(
            PathBuf::from("..").join(package).join(bin_target),
            &bin_link,
        )
        .expect("link npm bin");
        Self {
            root,
            npm_cache,
            npx_cache,
            package_dir,
            bin_link,
            lock_path,
        }
    }
}

#[cfg(all(test, unix))]
impl Drop for NpxCacheFixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::SocketAddr;
    use std::sync::{Mutex, OnceLock};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio::sync::oneshot;

    const TEST_REGISTRY_BODY: &str = r#"{"version":"test","agents":[]}"#;

    fn direct_proxy() -> ProxyEnvironment {
        ProxyEnvironment {
            http_proxy: None,
            https_proxy: None,
            all_proxy: None,
            no_proxy: None,
        }
    }

    fn http_response(status: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    async fn recording_server(response: String) -> (SocketAddr, oneshot::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind recording server");
        let address = listener.local_addr().expect("recording server address");
        let (request_tx, request_rx) = oneshot::channel();
        tokio::spawn(async move {
            let (mut stream, _) =
                tokio::time::timeout(std::time::Duration::from_secs(3), listener.accept())
                    .await
                    .expect("recording server accept timeout")
                    .expect("recording server accept");
            let mut request = Vec::new();
            loop {
                let mut chunk = [0_u8; 1024];
                let read = tokio::time::timeout(
                    std::time::Duration::from_secs(1),
                    stream.read(&mut chunk),
                )
                .await
                .expect("request read timeout")
                .expect("read request");
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&chunk[..read]);
                if request.windows(4).any(|window| window == b"\r\n\r\n") {
                    break;
                }
            }
            let _ = request_tx.send(String::from_utf8_lossy(&request).into_owned());
            stream
                .write_all(response.as_bytes())
                .await
                .expect("write recording response");
        });
        (address, request_rx)
    }

    async fn assert_listener_unused(listener: &TcpListener) {
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(150), listener.accept())
                .await
                .is_err(),
            "unexpected request reached bypassed proxy"
        );
    }

    struct EnvironmentGuard {
        previous: Vec<(&'static str, Option<std::ffi::OsString>)>,
    }

    impl EnvironmentGuard {
        fn set(values: &[(&'static str, &str)]) -> Self {
            let previous = values
                .iter()
                .map(|(key, value)| {
                    let previous = std::env::var_os(key);
                    std::env::set_var(key, value);
                    (*key, previous)
                })
                .collect();
            Self { previous }
        }
    }

    impl Drop for EnvironmentGuard {
        fn drop(&mut self) {
            for (key, value) in self.previous.drain(..) {
                if let Some(value) = value {
                    std::env::set_var(key, value);
                } else {
                    std::env::remove_var(key);
                }
            }
        }
    }

    #[tokio::test]
    async fn https_registry_prefers_https_proxy_over_all_proxy_and_surfaces_failure() {
        let (https_proxy, recorded_request) =
            recording_server(http_response("502 Bad Gateway", "")).await;
        let all_proxy = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind unused ALL proxy");
        let proxy = ProxyEnvironment {
            http_proxy: None,
            https_proxy: Some(format!("http://{https_proxy}")),
            all_proxy: Some(format!(
                "http://{}",
                all_proxy.local_addr().expect("ALL proxy address")
            )),
            no_proxy: None,
        };

        let error = fetch_registry_from_url("https://registry.invalid/registry.json", &proxy)
            .await
            .expect_err("proxy tunnel failure must be returned");
        let request = recorded_request
            .await
            .expect("recorded HTTPS proxy request");

        assert!(
            request.starts_with("CONNECT registry.invalid:443 HTTP/1.1\r\n"),
            "unexpected proxy request: {request:?}"
        );
        assert_listener_unused(&all_proxy).await;
        let visible_error = error.to_string();
        assert!(
            visible_error.contains("fetch Registry from")
                && visible_error.contains("error sending request"),
            "missing visible transport error: {visible_error}"
        );
    }

    #[tokio::test]
    async fn https_registry_falls_back_to_all_proxy() {
        let (all_proxy, recorded_request) =
            recording_server(http_response("502 Bad Gateway", "")).await;
        let proxy = ProxyEnvironment {
            http_proxy: Some("http://127.0.0.1:9".into()),
            https_proxy: None,
            all_proxy: Some(format!("http://{all_proxy}")),
            no_proxy: None,
        };

        let _ = fetch_registry_from_url("https://registry.invalid/registry.json", &proxy)
            .await
            .expect_err("proxy tunnel failure must be returned");
        let request = recorded_request.await.expect("recorded ALL proxy request");
        assert!(
            request.starts_with("CONNECT registry.invalid:443 HTTP/1.1\r\n"),
            "unexpected proxy request: {request:?}"
        );
    }

    #[tokio::test]
    async fn explicit_no_proxy_bypasses_configured_proxy() {
        let (origin, origin_request) =
            recording_server(http_response("200 OK", TEST_REGISTRY_BODY)).await;
        let configured_proxy = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind bypassed proxy");
        let proxy = ProxyEnvironment {
            http_proxy: Some(format!(
                "http://{}",
                configured_proxy.local_addr().expect("proxy address")
            )),
            https_proxy: None,
            all_proxy: None,
            no_proxy: Some("127.0.0.1".into()),
        };

        let registry = fetch_registry_from_url(&format!("http://{origin}/registry.json"), &proxy)
            .await
            .expect("NO_PROXY request reaches origin");
        let request = origin_request.await.expect("recorded origin request");

        assert_eq!(registry.version, "test");
        assert!(request.starts_with("GET /registry.json HTTP/1.1\r\n"));
        assert_listener_unused(&configured_proxy).await;
    }

    #[tokio::test]
    async fn direct_registry_client_ignores_poisoned_host_proxy_environment() {
        static ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        let _lock = ENV_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .expect("environment test lock");
        let (origin, origin_request) =
            recording_server(http_response("200 OK", TEST_REGISTRY_BODY)).await;
        let (poison_proxy, poison_request) =
            recording_server(http_response("502 Bad Gateway", "")).await;
        let poison_url = format!("http://{poison_proxy}");
        let _environment = EnvironmentGuard::set(&[
            ("HTTP_PROXY", &poison_url),
            ("http_proxy", &poison_url),
            ("HTTPS_PROXY", &poison_url),
            ("https_proxy", &poison_url),
            ("ALL_PROXY", &poison_url),
            ("all_proxy", &poison_url),
            ("NO_PROXY", ""),
            ("no_proxy", ""),
        ]);

        let registry =
            fetch_registry_from_url(&format!("http://{origin}/registry.json"), &direct_proxy())
                .await
                .expect("direct Registry request reaches origin");
        let request = origin_request.await.expect("recorded direct request");

        assert_eq!(registry.version, "test");
        assert!(request.starts_with("GET /registry.json HTTP/1.1\r\n"));
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(150), poison_request)
                .await
                .is_err(),
            "direct request unexpectedly reached the poisoned host proxy"
        );
    }

    #[tokio::test]
    async fn registry_http_status_error_is_not_hidden() {
        let (origin, _) =
            recording_server(http_response("503 Service Unavailable", "offline")).await;

        let error =
            fetch_registry_from_url(&format!("http://{origin}/registry.json"), &direct_proxy())
                .await
                .expect_err("non-success Registry status must be returned");

        assert_eq!(error.to_string(), "registry HTTP 503 Service Unavailable");
    }

    #[test]
    fn builtin_registry_parses() {
        let reg = load_builtin_registry().expect("builtin");
        assert!(!reg.agents.is_empty());
        assert!(reg.agents.iter().any(|a| a.id == "codex-acp"));
        assert_eq!(
            reg.agents
                .iter()
                .filter(|agent| agent.quarantine_reason.is_some())
                .count(),
            8
        );
    }

    #[test]
    fn resolve_codex_npx() {
        let reg = load_builtin_registry().unwrap();
        let agent = find_registry_agent(&reg, "codex-acp").unwrap();
        let npx = agent
            .distribution
            .as_ref()
            .and_then(|distribution| distribution.npx.as_ref())
            .expect("Codex npx distribution");
        let launch = resolve_npx_launch(npx, None);
        assert_eq!(launch.command, "npx");
        assert!(launch.args.iter().any(|a| a.contains("codex-acp")));
    }

    #[cfg(unix)]
    #[test]
    fn exact_npx_cache_resolves_verified_bin_and_preserves_launch_data() {
        let fixture = NpxCacheFixture::new(
            "@agentclientprotocol/codex-acp",
            "1.1.14",
            "codex-acp",
            "dist/index.js",
        );
        let npx = NpxDist {
            package: "@agentclientprotocol/codex-acp@1.1.14".into(),
            args: vec!["--model".into(), "gpt-5".into()],
            env: HashMap::from([("AQBOT_TEST".into(), "1".into())]),
        };

        let launch = resolve_cached_exact_npx(&npx, &fixture.npx_cache)
            .expect("strictly verified exact npx cache");

        assert_eq!(PathBuf::from(&launch.command), fixture.bin_link);
        assert_eq!(launch.args, npx.args);
        assert_eq!(launch.env, npx.env);
        assert_eq!(launch.kind, "binary");

        let registry = load_builtin_registry().expect("builtin Registry");
        let mut agent = find_registry_agent(&registry, "codex-acp")
            .expect("Codex Registry entry")
            .clone();
        agent.distribution.as_mut().expect("Codex distribution").npx = Some(npx);
        let resolved = resolve_launch_with_npx_cache(&agent, Some(&fixture.npx_cache))
            .expect("resolve_launch exact cache integration");
        assert_eq!(PathBuf::from(resolved.command), fixture.bin_link);
    }

    #[cfg(unix)]
    #[test]
    fn exact_npx_cache_rejects_ranges_and_lock_or_canonical_bin_mismatches() {
        let fixture = NpxCacheFixture::new(
            "@agentclientprotocol/claude-agent-acp",
            "0.66.0",
            "claude-agent-acp",
            "dist/index.js",
        );
        let mut npx = NpxDist {
            package: "@agentclientprotocol/claude-agent-acp@^0.66.0".into(),
            args: Vec::new(),
            env: HashMap::new(),
        };
        assert!(resolve_cached_exact_npx(&npx, &fixture.npx_cache).is_none());

        npx.package = "@agentclientprotocol/claude-agent-acp@0.66.0".into();
        let manifest_path = fixture.package_dir.join("package.json");
        let mut manifest: serde_json::Value = serde_json::from_slice(
            &std::fs::read(&manifest_path).expect("read fixture package manifest"),
        )
        .expect("parse fixture package manifest");
        manifest["version"] = serde_json::Value::String("0.65.0".into());
        std::fs::write(
            &manifest_path,
            serde_json::to_vec(&manifest).expect("serialize mismatched package manifest"),
        )
        .expect("write mismatched package manifest");
        assert!(resolve_cached_exact_npx(&npx, &fixture.npx_cache).is_none());
        manifest["version"] = serde_json::Value::String("0.66.0".into());
        std::fs::write(
            &manifest_path,
            serde_json::to_vec(&manifest).expect("serialize restored package manifest"),
        )
        .expect("restore package manifest");

        let mut lock: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&fixture.lock_path).expect("read fixture lock"))
                .expect("parse fixture lock");
        lock["packages"]["node_modules/@agentclientprotocol/claude-agent-acp"]["version"] =
            serde_json::Value::String("0.65.0".into());
        std::fs::write(
            &fixture.lock_path,
            serde_json::to_vec(&lock).expect("serialize mismatched lock"),
        )
        .expect("write mismatched lock");
        assert!(resolve_cached_exact_npx(&npx, &fixture.npx_cache).is_none());

        lock["packages"]["node_modules/@agentclientprotocol/claude-agent-acp"]["version"] =
            serde_json::Value::String("0.66.0".into());
        std::fs::write(
            &fixture.lock_path,
            serde_json::to_vec(&lock).expect("serialize restored lock"),
        )
        .expect("restore lock");
        std::fs::remove_file(&fixture.bin_link).expect("remove verified link");
        std::os::unix::fs::symlink(&fixture.lock_path, &fixture.bin_link)
            .expect("link bin outside package");
        assert!(resolve_cached_exact_npx(&npx, &fixture.npx_cache).is_none());
        assert!(fixture.package_dir.is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn persisted_exact_npx_is_upgraded_from_cache_without_registry_refresh() {
        let fixture = NpxCacheFixture::new("@github/copilot", "1.0.78", "copilot", "npm-loader.js");
        let args = vec![
            "-y".into(),
            "--registry=https://registry.npmjs.org".into(),
            "@github/copilot@1.0.78".into(),
            "--acp".into(),
        ];

        let launch = resolve_configured_npx_with_cache(
            "/usr/local/bin/npx",
            &args,
            &HashMap::new(),
            Some(&fixture.npx_cache),
            |_| None,
        )
        .expect("cached configured npx launch");

        assert_eq!(PathBuf::from(launch.command), fixture.bin_link);
        assert_eq!(launch.args, ["--acp"]);
    }

    #[test]
    fn resolve_grok_uses_valid_npx_or_local_binary() {
        let reg = load_builtin_registry().unwrap();
        let agent = find_registry_agent(&reg, "grok-build").unwrap();
        let launch = resolve_launch(agent).unwrap();
        match launch.kind.as_str() {
            "binary" => {
                // May be basename or absolute well-known path (e.g. ~/.grok/bin/grok).
                assert!(
                    launch.command == "grok"
                        || launch.command.ends_with("/grok")
                        || launch.command.ends_with("\\grok.exe"),
                    "unexpected binary command {}",
                    launch.command
                );
                assert_eq!(launch.args, vec!["agent", "stdio"]);
            }
            "npx" => {
                assert!(
                    launch
                        .args
                        .iter()
                        .any(|a| a.contains("@xai-official/grok@1.0.0")),
                    "expected Registry package, got {:?}",
                    launch.args
                );
                assert!(launch
                    .args
                    .iter()
                    .any(|a| a == "--registry=https://registry.npmjs.org"));
                assert!(launch.args.iter().any(|a| a == "agent"));
                assert!(launch.args.iter().any(|a| a == "stdio"));
            }
            other => panic!("unexpected launch kind {other}"),
        }
    }

    #[test]
    fn npx_only_grok_reuses_any_local_binary_without_npm_marker() {
        let npx = NpxDist {
            package: "@xai-official/grok@1.0.0".into(),
            args: vec!["agent".into(), "stdio".into()],
            env: HashMap::from([(GROK_NPM_MARKER.into(), "1".into())]),
        };
        let resolved = resolve_installed_npx_trampoline(&npx, |command| {
            (command == "grok").then(|| "/opt/grok-0.2.121".into())
        })
        .expect("any installed Grok binary");

        assert_eq!(resolved.command, "/opt/grok-0.2.121");
        assert_eq!(resolved.args, ["agent", "stdio"]);
        assert!(!resolved.env.contains_key(GROK_NPM_MARKER));
        assert!(resolve_installed_npx_trampoline(&npx, |_| None).is_none());
    }

    #[test]
    fn persisted_npx_grok_is_upgraded_without_a_registry_refresh() {
        let args = vec![
            "-y".into(),
            "--registry=https://registry.npmjs.org".into(),
            "@xai-official/grok@1.0.0".into(),
            "agent".into(),
            "stdio".into(),
        ];
        let resolved = resolve_configured_npx_trampoline_with(
            "/usr/local/bin/npx",
            &args,
            &HashMap::from([(GROK_NPM_MARKER.into(), "1".into())]),
            |_| Some("/usr/local/bin/grok".into()),
        )
        .expect("any installed Grok binary");

        assert_eq!(resolved.command, "/usr/local/bin/grok");
        assert_eq!(resolved.args, ["agent", "stdio"]);
        assert!(!resolved.env.contains_key(GROK_NPM_MARKER));
    }
}
