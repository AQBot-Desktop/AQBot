use std::collections::HashSet;

use aqbot_core::types::MarketplaceSkill;

use super::install::parse_skill_package_ref;
use super::installed_source_refs;

const SKILLS_SH_DEFAULT_QUERY: &str = "skill";
const SKILLS_SH_MIN_QUERY_CHARS: usize = 2;
const SKILLS_SH_LIMIT: u32 = 50;

pub(crate) fn normalize_skills_sh_query(query: &str) -> String {
    let trimmed = query.trim();
    if trimmed.chars().count() >= SKILLS_SH_MIN_QUERY_CHARS {
        trimmed.to_string()
    } else {
        SKILLS_SH_DEFAULT_QUERY.to_string()
    }
}

pub(crate) fn marketplace_installed(
    refs: &HashSet<String>,
    repo: &str,
    skill_id: &str,
) -> bool {
    let repo_n = repo.trim().trim_end_matches('/').to_lowercase();
    if repo_n.is_empty() {
        return false;
    }
    if !skill_id.is_empty() {
        let specific = format!("{}@{}", repo_n, skill_id.trim().to_lowercase());
        if refs.contains(&specific) {
            return true;
        }
    }
    refs.contains(&repo_n)
}

fn repo_from_source(source: &str) -> String {
    let source = source.trim().trim_end_matches('/');
    if source.is_empty() {
        return String::new();
    }
    parse_skill_package_ref(source)
        .map(|pkg| pkg.repo_slug())
        .unwrap_or_else(|_| source.to_string())
}

fn string_field(item: &serde_json::Value, keys: &[&str]) -> String {
    keys.iter()
        .find_map(|key| item.get(*key).and_then(|value| value.as_str()))
        .unwrap_or("")
        .trim()
        .to_string()
}

pub(crate) fn parse_skills_sh_skills(
    body: &serde_json::Value,
    installed: &HashSet<String>,
) -> Vec<MarketplaceSkill> {
    let items = body
        .get("skills")
        .or_else(|| body.get("data"))
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();

    items
        .into_iter()
        .filter_map(|item| {
            let skill_id = string_field(&item, &["skillId", "slug", "skill_id"]);
            let name = string_field(&item, &["name"]);
            let name = if name.is_empty() {
                skill_id.clone()
            } else {
                name
            };
            if name.is_empty() {
                return None;
            }
            let repo = repo_from_source(&string_field(&item, &["source"]));
            let description = string_field(&item, &["description"]);
            let install_ref = if skill_id.is_empty() {
                repo.clone()
            } else if repo.is_empty() {
                skill_id.clone()
            } else {
                format!("{repo}@{skill_id}")
            };
            Some(MarketplaceSkill {
                name,
                description,
                repo: repo.clone(),
                skill_id: skill_id.clone(),
                install_ref,
                stars: 0,
                installs: item.get("installs").and_then(|value| value.as_i64()).unwrap_or(0),
                installed: marketplace_installed(installed, &repo, &skill_id),
            })
        })
        .collect()
}

pub(crate) fn parse_github_marketplace_skills(
    body: &serde_json::Value,
    installed: &HashSet<String>,
) -> Vec<MarketplaceSkill> {
    let items = body
        .get("items")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();

    items
        .into_iter()
        .map(|item| {
            let skill_name = string_field(&item, &["name"]);
            let repo = string_field(&item, &["full_name"]);
            MarketplaceSkill {
                name: skill_name,
                description: string_field(&item, &["description"]),
                repo: repo.clone(),
                skill_id: String::new(),
                install_ref: repo.clone(),
                stars: item
                    .get("stargazers_count")
                    .and_then(|value| value.as_i64())
                    .unwrap_or(0),
                installs: 0,
                installed: marketplace_installed(installed, &repo, ""),
            }
        })
        .collect()
}

fn github_search_query(query: &str) -> String {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        "topic:agent-skill".to_string()
    } else {
        format!("{}+topic:agent-skill", urlencoding::encode(trimmed))
    }
}

#[tauri::command]
pub async fn search_marketplace(
    query: String,
    source: Option<String>,
) -> Result<Vec<MarketplaceSkill>, String> {
    let installed_refs = installed_source_refs();
    let client = reqwest::Client::new();

    match source.as_deref().unwrap_or("skills.sh") {
        "github" => {
            let url = format!(
                "https://api.github.com/search/repositories?q={}&sort=stars&per_page=20",
                github_search_query(&query)
            );
            let response = client
                .get(&url)
                .header("User-Agent", "AQBot")
                .header("Accept", "application/vnd.github.v3+json")
                .send()
                .await
                .map_err(|e| format!("Search failed: {e}"))?;

            if !response.status().is_success() {
                return Err(format!("GitHub API error: {}", response.status()));
            }

            let body: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
            Ok(parse_github_marketplace_skills(&body, &installed_refs))
        }
        _ => {
            let search_query = normalize_skills_sh_query(&query);
            let url = format!(
                "https://skills.sh/api/search?q={}&limit={SKILLS_SH_LIMIT}",
                urlencoding::encode(&search_query)
            );
            let response = client
                .get(&url)
                .header("User-Agent", "AQBot")
                .header("Accept", "application/json")
                .send()
                .await
                .map_err(|e| format!("Search failed: {e}"))?;

            if !response.status().is_success() {
                return Err(format!("skills.sh API error: {}", response.status()));
            }

            let body: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
            Ok(parse_skills_sh_skills(&body, &installed_refs))
        }
    }
}
