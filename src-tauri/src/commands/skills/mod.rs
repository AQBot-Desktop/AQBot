mod install;
mod marketplace;

pub use install::{install_skill, __cmd__install_skill};
pub use marketplace::{search_marketplace, __cmd__search_marketplace};

use crate::paths::aqbot_home;
use crate::AppState;
use aqbot_core::types::*;
use std::path::{Component, Path, PathBuf};
use tauri::State;

#[cfg(test)]
mod tests;

fn home_dir() -> PathBuf {
    dirs::home_dir().expect("Could not determine home directory")
}

fn skills_dir() -> PathBuf {
    aqbot_home().join("skills")
}

fn codex_skills_dir() -> PathBuf {
    home_dir().join(".codex").join("skills")
}

fn claude_skills_dir() -> PathBuf {
    home_dir().join(".claude").join("skills")
}

fn agents_skills_dir() -> PathBuf {
    home_dir().join(".agents").join("skills")
}

fn skill_roots() -> [PathBuf; 4] {
    [
        skills_dir(),
        claude_skills_dir(),
        agents_skills_dir(),
        codex_skills_dir(),
    ]
}

pub(super) fn install_target_dir(target: Option<&str>) -> PathBuf {
    match target {
        Some("codex") => codex_skills_dir(),
        Some("claude") => claude_skills_dir(),
        Some("agents") => agents_skills_dir(),
        _ => skills_dir(),
    }
}

fn source_root(source: &str) -> Option<PathBuf> {
    match source {
        "aqbot" => Some(skills_dir()),
        "codex" => Some(codex_skills_dir()),
        "claude" => Some(claude_skills_dir()),
        "agents" => Some(agents_skills_dir()),
        _ => None,
    }
}

fn ensure_removable_skill_dir(skill_dir: &Path) -> Result<(), String> {
    if !skill_dir.is_dir() {
        return Err(format!(
            "Skill directory does not exist: {}",
            skill_dir.display()
        ));
    }

    let skill_dir = std::fs::canonicalize(skill_dir).map_err(|e| e.to_string())?;
    for root in skill_roots() {
        let Ok(root) = std::fs::canonicalize(root) else {
            continue;
        };
        if skill_dir == root {
            return Err("Refusing to remove a skills root directory".to_string());
        }
        if skill_dir.starts_with(&root) {
            let relative = skill_dir.strip_prefix(&root).map_err(|e| e.to_string())?;
            let hidden = relative.components().any(|component| match component {
                Component::Normal(name) => name.to_string_lossy().starts_with('.'),
                _ => false,
            });
            if hidden {
                return Err("Refusing to remove a hidden skills directory".to_string());
            }
            return Ok(());
        }
    }

    Err(format!(
        "Skill directory is outside managed skills roots: {}",
        skill_dir.display()
    ))
}

fn inspect_report_from_sdk(
    report: open_agent_sdk::skills::SkillInspectReport,
) -> SkillInspectReport {
    SkillInspectReport {
        items: report
            .items
            .into_iter()
            .map(|item| SkillInspectItem {
                name: item.name,
                description: item.description,
                source: item.source,
                source_path: item.source_path,
                enabled: item.enabled,
                disable_model_invocation: item.disable_model_invocation,
                user_invocable: item.user_invocable,
                group: item.group,
                effective: item.effective,
                effective_source_path: item.effective_source_path,
                callable: item.callable,
                reasons: item
                    .reasons
                    .into_iter()
                    .map(|reason| SkillAvailabilityReason {
                        code: reason.code,
                        params: reason.params,
                    })
                    .collect(),
            })
            .collect(),
        scan_errors: report
            .scan_errors
            .into_iter()
            .map(|error| SkillInspectScanError {
                path: error.path,
                code: error.code,
                message: error.message,
                line: error.line,
                column: error.column,
            })
            .collect(),
        skill_tool_allowed: report.skill_tool_allowed,
    }
}

#[tauri::command]
pub async fn inspect_skills(state: State<'_, AppState>) -> Result<SkillInspectReport, String> {
    let settings = aqbot_core::repo::settings::get_settings(&state.sea_db)
        .await
        .map_err(|e| e.to_string())?;
    let skill_tool_allowed = aqbot_core::types::should_inject_skills_summary(
        settings.agent_allowed_tools_enabled,
        &settings.agent_allowed_tools,
    );
    let disabled = aqbot_core::repo::skill::get_disabled_skills(&state.sea_db)
        .await
        .map_err(|e| e.to_string())?;
    let home = home_dir();
    let report = tokio::task::spawn_blocking(move || {
        open_agent_sdk::skills::inspect_global_skills(&home, &disabled, skill_tool_allowed)
    })
    .await
    .map_err(|e| format!("Failed to inspect skills: {e}"))?;
    Ok(inspect_report_from_sdk(report))
}

#[tauri::command]
pub async fn list_skills(state: State<'_, AppState>) -> Result<Vec<SkillInfo>, String> {
    let home = home_dir();
    let skills = open_agent_sdk::skills::load_all_global_for_management(&home);
    let disabled = aqbot_core::repo::skill::get_disabled_skills(&state.sea_db)
        .await
        .map_err(|e| e.to_string())?;

    let result: Vec<SkillInfo> = skills
        .into_iter()
        .map(|s| {
            let enabled = !disabled.contains(&s.name);
            SkillInfo {
                name: s.name.clone(),
                description: s.metadata.description.clone().unwrap_or_default(),
                author: s
                    .metadata
                    .metadata
                    .as_ref()
                    .and_then(|m| m.get("author"))
                    .and_then(|v| v.as_str())
                    .map(String::from),
                version: s
                    .metadata
                    .metadata
                    .as_ref()
                    .and_then(|m| m.get("version"))
                    .and_then(|v| v.as_str())
                    .map(String::from),
                source: s.source.as_str().to_string(),
                source_path: s.path.to_string_lossy().to_string(),
                enabled,
                has_update: false,
                user_invocable: s.metadata.user_invocable,
                argument_hint: s.metadata.argument_hint.clone(),
                when_to_use: s.metadata.when_to_use.clone(),
                group: s.group.clone(),
            }
        })
        .collect();

    Ok(result)
}

#[tauri::command]
pub async fn get_skill(
    state: State<'_, AppState>,
    name: String,
    source_path: Option<String>,
) -> Result<SkillDetail, String> {
    let home = home_dir();
    let skills = open_agent_sdk::skills::load_all_global_for_management(&home);
    let source_path = source_path.map(PathBuf::from);
    let skill = skills
        .into_iter()
        .find(|s| {
            source_path
                .as_ref()
                .map(|path| s.path == *path)
                .unwrap_or_else(|| s.name == name)
        })
        .ok_or_else(|| format!("Skill '{name}' not found"))?;

    let disabled = aqbot_core::repo::skill::get_disabled_skills(&state.sea_db)
        .await
        .map_err(|e| e.to_string())?;

    let skill_dir = skill.path.parent().unwrap_or(Path::new(""));

    let files = std::fs::read_dir(skill_dir)
        .map(|entries| {
            entries
                .flatten()
                .map(|e| e.file_name().to_string_lossy().to_string())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let manifest_path = skill_dir.join("skill-manifest.json");
    let manifest = std::fs::read_to_string(&manifest_path)
        .ok()
        .and_then(|s| serde_json::from_str::<SkillManifest>(&s).ok());

    let info = SkillInfo {
        name: skill.name.clone(),
        description: skill.metadata.description.clone().unwrap_or_default(),
        author: skill
            .metadata
            .metadata
            .as_ref()
            .and_then(|m| m.get("author"))
            .and_then(|v| v.as_str())
            .map(String::from),
        version: skill
            .metadata
            .metadata
            .as_ref()
            .and_then(|m| m.get("version"))
            .and_then(|v| v.as_str())
            .map(String::from),
        source: skill.source.as_str().to_string(),
        source_path: skill.path.to_string_lossy().to_string(),
        enabled: !disabled.contains(&skill.name),
        has_update: false,
        user_invocable: skill.metadata.user_invocable,
        argument_hint: skill.metadata.argument_hint.clone(),
        when_to_use: skill.metadata.when_to_use.clone(),
        group: skill.group.clone(),
    };

    Ok(SkillDetail {
        info,
        content: skill.content.clone(),
        files,
        manifest,
    })
}

#[tauri::command]
pub async fn toggle_skill(
    state: State<'_, AppState>,
    name: String,
    enabled: bool,
) -> Result<(), String> {
    aqbot_core::repo::skill::set_skill_enabled(&state.sea_db, &name, enabled)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn uninstall_skill(name: String, source_path: Option<String>) -> Result<(), String> {
    let skill_dir = if let Some(source_path) = source_path {
        let path = PathBuf::from(source_path);
        if path.is_dir() {
            path
        } else {
            path.parent()
                .ok_or_else(|| "Invalid skill source path".to_string())?
                .to_path_buf()
        }
    } else {
        skills_dir().join(&name)
    };
    if !skill_dir.exists() {
        return Err(format!("Skill '{name}' not found in ~/.aqbot/skills/"));
    }
    ensure_removable_skill_dir(&skill_dir)?;
    std::fs::remove_dir_all(&skill_dir).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn uninstall_skill_group(group: String, source: Option<String>) -> Result<(), String> {
    let roots = source
        .as_deref()
        .and_then(source_root)
        .map(|root| vec![root])
        .unwrap_or_else(|| skill_roots().to_vec());

    for parent in roots {
        let group_dir = parent.join(&group);
        if group_dir.exists() && group_dir.is_dir() {
            ensure_removable_skill_dir(&group_dir)?;
            std::fs::remove_dir_all(&group_dir).map_err(|e| e.to_string())?;
            return Ok(());
        }
    }

    Err(format!("Skill group '{group}' not found"))
}

#[tauri::command]
pub async fn open_skills_dir() -> Result<(), String> {
    let dir = skills_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    open::that(&dir).map_err(|e| format!("Failed to open directory: {e}"))
}

#[tauri::command]
pub async fn open_skill_dir(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    let dir = if p.is_dir() {
        p.to_path_buf()
    } else {
        p.parent()
            .map(|d| d.to_path_buf())
            .unwrap_or_else(|| p.to_path_buf())
    };
    if dir.exists() {
        open::that(&dir).map_err(|e| format!("Failed to open directory: {e}"))
    } else {
        Err(format!("Directory does not exist: {}", dir.display()))
    }
}

pub(super) fn installed_source_refs() -> std::collections::HashSet<String> {
    let mut refs = std::collections::HashSet::new();
    for dir in skill_roots() {
        collect_source_refs(&dir, &mut refs, 0);
    }
    refs
}

fn collect_source_refs(dir: &Path, refs: &mut std::collections::HashSet<String>, depth: u32) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let manifest = path.join("skill-manifest.json");
        if manifest.exists() {
            if let Some(sr) = read_source_ref(&manifest) {
                refs.insert(sr);
            }
        }
        if depth == 0 {
            collect_source_refs(&path, refs, depth + 1);
        }
    }
}

fn read_source_ref(manifest: &Path) -> Option<String> {
    let text = std::fs::read_to_string(manifest).ok()?;
    let val: serde_json::Value = serde_json::from_str(&text).ok()?;
    let sr = val["source_ref"].as_str()?;
    let normalized = sr.trim().trim_end_matches('/').to_lowercase();
    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}

#[tauri::command]
pub async fn check_skill_updates() -> Result<Vec<SkillUpdateInfo>, String> {
    let mut updates = Vec::new();

    for skills_path in skill_roots() {
        let entries = match std::fs::read_dir(&skills_path) {
            Ok(e) => e,
            Err(_) => continue,
        };

        for entry in entries.flatten() {
            let manifest_path = entry.path().join("skill-manifest.json");
            if !manifest_path.exists() {
                continue;
            }

            let manifest_str = match std::fs::read_to_string(&manifest_path) {
                Ok(s) => s,
                Err(_) => continue,
            };
            let manifest: serde_json::Value = match serde_json::from_str(&manifest_str) {
                Ok(v) => v,
                Err(_) => continue,
            };

            if manifest["source_kind"].as_str() != Some("github") {
                continue;
            }

            let source_ref = manifest["source_ref"].as_str().unwrap_or("").to_string();
            let current_commit = manifest["commit"].as_str().unwrap_or("").to_string();

            if source_ref.is_empty() || current_commit.is_empty() {
                continue;
            }

            let Some((owner, repo)) = install::github_owner_repo(&source_ref) else {
                continue;
            };

            let url = format!("https://api.github.com/repos/{owner}/{repo}/commits?per_page=1");

            let client = reqwest::Client::new();
            let response = client
                .get(&url)
                .header("User-Agent", "AQBot")
                .header("Accept", "application/vnd.github.v3+json")
                .send()
                .await;

            if let Ok(resp) = response {
                if resp.status().is_success() {
                    if let Ok(body) = resp.json::<serde_json::Value>().await {
                        if let Some(commits) = body.as_array() {
                            if let Some(latest) = commits.first() {
                                let latest_sha = latest["sha"].as_str().unwrap_or("").to_string();
                                let short_latest = &latest_sha[..7.min(latest_sha.len())];
                                if !current_commit.is_empty()
                                    && !latest_sha.starts_with(&current_commit)
                                    && current_commit != short_latest
                                {
                                    updates.push(SkillUpdateInfo {
                                        name: entry.file_name().to_string_lossy().to_string(),
                                        current_commit: current_commit.clone(),
                                        latest_commit: short_latest.to_string(),
                                        source_ref: source_ref.clone(),
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(updates)
}
