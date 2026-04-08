use crate::paths::aqbot_home;
use crate::AppState;
use aqbot_core::types::*;
use std::path::{Path, PathBuf};
use tauri::State;

fn home_dir() -> PathBuf {
    dirs::home_dir().expect("Could not determine home directory")
}

fn skills_dir() -> PathBuf {
    aqbot_home().join("skills")
}

#[tauri::command]
pub async fn list_skills(state: State<'_, AppState>) -> Result<Vec<SkillInfo>, String> {
    let home = home_dir();
    let skills = open_agent_sdk::skills::load_all_global(&home);
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
                group: s.group.clone(),
            }
        })
        .collect();

    Ok(result)
}

#[tauri::command]
pub async fn get_skill(state: State<'_, AppState>, name: String) -> Result<SkillDetail, String> {
    let home = home_dir();
    let skills = open_agent_sdk::skills::load_all_global(&home);
    let skill = skills
        .into_iter()
        .find(|s| s.name == name)
        .ok_or_else(|| format!("Skill '{}' not found", name))?;

    let disabled = aqbot_core::repo::skill::get_disabled_skills(&state.sea_db)
        .await
        .map_err(|e| e.to_string())?;

    let skill_dir = skill.path.parent().unwrap_or(Path::new(""));

    // List files in skill directory
    let files = std::fs::read_dir(skill_dir)
        .map(|entries| {
            entries
                .flatten()
                .map(|e| e.file_name().to_string_lossy().to_string())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    // Read manifest if exists
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
pub async fn install_skill(source: String, target: Option<String>) -> Result<String, String> {
    let target_dir = match target.as_deref() {
        Some("claude") => home_dir().join(".claude").join("skills"),
        Some("agents") => home_dir().join(".agents").join("skills"),
        _ => skills_dir(),
    };
    std::fs::create_dir_all(&target_dir).map_err(|e| e.to_string())?;

    if source.starts_with('/') || source.starts_with('.') {
        install_from_local(&source, &target_dir).await
    } else {
        let (owner, repo) = parse_github_source(&source)?;
        install_from_github(&owner, &repo, &target_dir).await
    }
}

fn parse_github_source(source: &str) -> Result<(String, String), String> {
    let clean = source.trim_end_matches('/').trim_end_matches(".git");

    if clean.contains("github.com") {
        let parts: Vec<&str> = clean.split('/').collect();
        let len = parts.len();
        if len >= 2 {
            return Ok((parts[len - 2].to_string(), parts[len - 1].to_string()));
        }
        return Err(format!("Invalid GitHub URL: {}", source));
    }

    let parts: Vec<&str> = source.split('/').collect();
    if parts.len() == 2 && !parts[0].is_empty() && !parts[1].is_empty() {
        Ok((parts[0].to_string(), parts[1].to_string()))
    } else {
        Err(format!(
            "Invalid source format '{}'. Expected 'owner/repo', GitHub URL, or local path.",
            source
        ))
    }
}

async fn install_from_github(
    owner: &str,
    repo: &str,
    target_dir: &Path,
) -> Result<String, String> {
    let url = format!(
        "https://api.github.com/repos/{}/{}/zipball",
        owner, repo
    );

    let client = reqwest::Client::new();
    let response = client
        .get(&url)
        .header("User-Agent", "AQBot")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("Failed to download skill: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "GitHub API returned status {}: {}",
            response.status(),
            response.text().await.unwrap_or_default()
        ));
    }

    let bytes = response.bytes().await.map_err(|e| e.to_string())?;

    let temp_dir = tempfile::tempdir().map_err(|e| e.to_string())?;
    let cursor = std::io::Cursor::new(&bytes);
    let mut archive =
        zip::ZipArchive::new(cursor).map_err(|e| format!("Failed to read zip: {}", e))?;

    // GitHub zipball has a top-level directory like "owner-repo-hash/"
    let top_dir = archive
        .file_names()
        .next()
        .and_then(|n| n.split('/').next())
        .map(String::from)
        .ok_or("Empty archive")?;

    archive
        .extract(temp_dir.path())
        .map_err(|e| format!("Failed to extract: {}", e))?;

    let extracted = temp_dir.path().join(&top_dir);
    let skill_target = target_dir.join(repo);

    if skill_target.exists() {
        std::fs::remove_dir_all(&skill_target).map_err(|e| e.to_string())?;
    }

    copy_dir_recursive(&extracted, &skill_target)?;

    let manifest = serde_json::json!({
        "source_kind": "github",
        "source_ref": format!("{}/{}", owner, repo),
        "branch": "main",
        "commit": top_dir.split('-').last().unwrap_or("unknown"),
        "installed_at": chrono::Utc::now().to_rfc3339(),
        "installed_via": "marketplace"
    });
    let manifest_path = skill_target.join("skill-manifest.json");
    std::fs::write(
        &manifest_path,
        serde_json::to_string_pretty(&manifest).unwrap(),
    )
    .map_err(|e| e.to_string())?;

    Ok(repo.to_string())
}

async fn install_from_local(source: &str, target_dir: &Path) -> Result<String, String> {
    let source_path = PathBuf::from(source);
    if !source_path.exists() {
        return Err(format!("Source path does not exist: {}", source));
    }
    if !source_path.is_dir() {
        return Err(format!("Source path is not a directory: {}", source));
    }

    let name = source_path
        .file_name()
        .ok_or("Invalid source directory name")?
        .to_string_lossy()
        .to_string();

    let skill_target = target_dir.join(&name);
    if skill_target.exists() {
        std::fs::remove_dir_all(&skill_target).map_err(|e| e.to_string())?;
    }

    copy_dir_recursive(&source_path, &skill_target)?;

    let manifest = serde_json::json!({
        "source_kind": "local",
        "source_ref": source,
        "installed_at": chrono::Utc::now().to_rfc3339(),
        "installed_via": "local"
    });
    let manifest_path = skill_target.join("skill-manifest.json");
    std::fs::write(
        &manifest_path,
        serde_json::to_string_pretty(&manifest).unwrap(),
    )
    .map_err(|e| e.to_string())?;

    Ok(name)
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let ty = entry.file_type().map_err(|e| e.to_string())?;
        let dst_path = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_recursive(&entry.path(), &dst_path)?;
        } else {
            std::fs::copy(entry.path(), &dst_path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn uninstall_skill(name: String) -> Result<(), String> {
    let skill_dir = skills_dir().join(&name);
    if !skill_dir.exists() {
        return Err(format!("Skill '{}' not found in ~/.aqbot/skills/", name));
    }
    std::fs::remove_dir_all(&skill_dir).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn uninstall_skill_group(group: String) -> Result<(), String> {
    // Search all skill roots for a directory matching the group name
    let home = home_dir();
    let search_dirs = [
        home.join(".aqbot").join("skills"),
        home.join(".claude").join("skills"),
        home.join(".agents").join("skills"),
    ];

    for parent in &search_dirs {
        let group_dir = parent.join(&group);
        if group_dir.exists() && group_dir.is_dir() {
            std::fs::remove_dir_all(&group_dir).map_err(|e| e.to_string())?;
            return Ok(());
        }
    }

    Err(format!("Skill group '{}' not found", group))
}

#[tauri::command]
pub async fn open_skills_dir() -> Result<(), String> {
    let dir = skills_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    open::that(&dir).map_err(|e| format!("Failed to open directory: {}", e))
}

#[tauri::command]
pub async fn open_skill_dir(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    let dir = if p.is_dir() {
        p.to_path_buf()
    } else {
        p.parent().map(|d| d.to_path_buf()).unwrap_or_else(|| p.to_path_buf())
    };
    if dir.exists() {
        open::that(&dir).map_err(|e| format!("Failed to open directory: {}", e))
    } else {
        Err(format!("Directory does not exist: {}", dir.display()))
    }
}

/// Collect `source_ref` values from `skill-manifest.json` files across all
/// three global skill directories so marketplace results can be marked as
/// installed regardless of the directory name.
fn installed_source_refs() -> std::collections::HashSet<String> {
    let home = home_dir();
    let dirs = [
        home.join(".aqbot").join("skills"),
        home.join(".claude").join("skills"),
        home.join(".agents").join("skills"),
    ];

    let mut refs = std::collections::HashSet::new();
    for dir in &dirs {
        collect_source_refs(dir, &mut refs, /* depth */ 0);
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
        // Recurse one level for group containers (dirs without SKILL.md but
        // with subdirs that have skill-manifest.json).
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
pub async fn search_marketplace(
    query: String,
    source: Option<String>,
) -> Result<Vec<MarketplaceSkill>, String> {
    let installed_refs = installed_source_refs();

    match source.as_deref().unwrap_or("skills.sh") {
        "github" => {
            let url = format!(
                "https://api.github.com/search/repositories?q={}+topic:agent-skill&sort=stars&per_page=20",
                urlencoding::encode(&query)
            );

            let client = reqwest::Client::new();
            let response = client
                .get(&url)
                .header("User-Agent", "AQBot")
                .header("Accept", "application/vnd.github.v3+json")
                .send()
                .await
                .map_err(|e| format!("Search failed: {}", e))?;

            if !response.status().is_success() {
                return Err(format!("GitHub API error: {}", response.status()));
            }

            let body: serde_json::Value =
                response.json().await.map_err(|e| e.to_string())?;
            let items = body["items"].as_array().cloned().unwrap_or_default();

            let results: Vec<MarketplaceSkill> = items
                .into_iter()
                .map(|item| {
                    let skill_name = item["name"].as_str().unwrap_or("").to_string();
                    let repo = item["full_name"]
                        .as_str()
                        .unwrap_or("")
                        .to_string();
                    let installed = installed_refs
                        .contains(&repo.trim().trim_end_matches('/').to_lowercase());
                    MarketplaceSkill {
                        name: skill_name,
                        description: item["description"]
                            .as_str()
                            .unwrap_or("")
                            .to_string(),
                        repo,
                        stars: item["stargazers_count"].as_i64().unwrap_or(0),
                        installs: 0,
                        installed,
                    }
                })
                .collect();

            Ok(results)
        }
        _ => {
            let url = format!(
                "https://skills.sh/api/search?q={}",
                urlencoding::encode(&query)
            );

            let client = reqwest::Client::new();
            let response = client
                .get(&url)
                .header("User-Agent", "AQBot")
                .send()
                .await
                .map_err(|e| format!("Search failed: {}", e))?;

            if !response.status().is_success() {
                return Err(format!("skills.sh API error: {}", response.status()));
            }

            let body: serde_json::Value =
                response.json().await.map_err(|e| e.to_string())?;
            let items = body["skills"].as_array().cloned().unwrap_or_default();

            let results: Vec<MarketplaceSkill> = items
                .into_iter()
                .map(|item| {
                    let skill_name = item["name"].as_str().unwrap_or("").to_string();
                    let repo = item["source"].as_str().unwrap_or("").to_string();
                    let installed = installed_refs
                        .contains(&repo.trim().trim_end_matches('/').to_lowercase());
                    MarketplaceSkill {
                        name: skill_name,
                        description: String::new(),
                        repo,
                        stars: 0,
                        installs: item["installs"].as_i64().unwrap_or(0),
                        installed,
                    }
                })
                .collect();

            Ok(results)
        }
    }
}

#[tauri::command]
pub async fn check_skill_updates() -> Result<Vec<SkillUpdateInfo>, String> {
    let skills_path = skills_dir();
    let mut updates = Vec::new();

    let entries = match std::fs::read_dir(&skills_path) {
        Ok(e) => e,
        Err(_) => return Ok(updates),
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

        let parts: Vec<&str> = source_ref.split('/').collect();
        if parts.len() != 2 {
            continue;
        }

        let url = format!(
            "https://api.github.com/repos/{}/{}/commits?per_page=1",
            parts[0], parts[1]
        );

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
                            let latest_sha =
                                latest["sha"].as_str().unwrap_or("").to_string();
                            let short_latest = &latest_sha[..7.min(latest_sha.len())];
                            if !current_commit.is_empty()
                                && !latest_sha.starts_with(&current_commit)
                                && current_commit != short_latest
                            {
                                updates.push(SkillUpdateInfo {
                                    name: entry
                                        .file_name()
                                        .to_string_lossy()
                                        .to_string(),
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

    Ok(updates)
}
