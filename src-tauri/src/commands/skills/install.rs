use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};

use super::install_target_dir;

const SKILL_CONTAINERS: &[&str] = &[
    "skills",
    ".agents/skills",
    ".claude/skills",
    ".codex/skills",
    ".aqbot/skills",
    ".cursor/skills",
];

const ROOT_SKILL_SIDECARS: &[&str] = &[
    "scripts",
    "references",
    "assets",
    "templates",
    "examples",
    "lib",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SkillPackageRef {
    pub owner: String,
    pub repo: String,
    pub skill: Option<String>,
}

impl SkillPackageRef {
    pub fn repo_slug(&self) -> String {
        format!("{}/{}", self.owner, self.repo)
    }
}

#[derive(Debug, Clone)]
pub(crate) struct DiscoveredSkill {
    pub name: String,
    pub dir: PathBuf,
    pub is_repo_root: bool,
}

pub(crate) fn github_owner_repo(source_ref: &str) -> Option<(String, String)> {
    let parsed = parse_skill_package_ref(source_ref).ok()?;
    Some((parsed.owner, parsed.repo))
}

pub(crate) fn is_local_source(source: &str) -> bool {
    let source = source.trim();
    if source.starts_with('/') || source.starts_with('.') {
        return true;
    }
    let bytes = source.as_bytes();
    if bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
    {
        return true;
    }
    Path::new(source).is_dir()
}

pub(crate) fn parse_skill_package_ref(source: &str) -> Result<SkillPackageRef, String> {
    let clean = source
        .trim()
        .trim_end_matches('/')
        .trim_end_matches(".git");
    let (base, skill_from_at) = split_at_skill(clean);

    if base.contains("github.com") {
        return parse_github_url(base, skill_from_at);
    }
    if base.contains("skills.sh") {
        return parse_skills_sh_url(base, skill_from_at);
    }

    let parts: Vec<&str> = base.split('/').filter(|part| !part.is_empty()).collect();
    match parts.as_slice() {
        [owner, repo] => Ok(SkillPackageRef {
            owner: (*owner).to_string(),
            repo: repo.trim_end_matches(".git").to_string(),
            skill: skill_from_at,
        }),
        [owner, repo, skill] => Ok(SkillPackageRef {
            owner: (*owner).to_string(),
            repo: repo.trim_end_matches(".git").to_string(),
            skill: skill_from_at.or_else(|| Some((*skill).to_string())),
        }),
        _ => Err(format!(
            "Invalid source format '{source}'. Expected 'owner/repo', 'owner/repo@skill', GitHub URL, or local path."
        )),
    }
}

fn split_at_skill(source: &str) -> (&str, Option<String>) {
    let Some(index) = source.rfind('@') else {
        return (source, None);
    };
    let skill = &source[index + 1..];
    if skill.is_empty() || skill.contains('/') {
        return (source, None);
    }
    (&source[..index], Some(skill.to_string()))
}

fn parse_github_url(url: &str, skill_from_at: Option<String>) -> Result<SkillPackageRef, String> {
    let after = url
        .split("github.com/")
        .nth(1)
        .ok_or_else(|| format!("Invalid GitHub URL: {url}"))?;
    let parts: Vec<&str> = after.split('/').filter(|part| !part.is_empty()).collect();
    if parts.len() < 2 {
        return Err(format!("Invalid GitHub URL: {url}"));
    }
    let owner = parts[0].to_string();
    let repo = parts[1].trim_end_matches(".git").to_string();
    let mut skill = skill_from_at;
    if skill.is_none() && parts.len() > 2 {
        let mut rest = &parts[2..];
        if rest.len() >= 2 && matches!(rest[0], "tree" | "blob") {
            rest = &rest[2..];
        }
        if let Some(pos) = rest.iter().position(|part| *part == "skills") {
            if let Some(name) = rest.get(pos + 1) {
                skill = Some((*name).to_string());
            }
        } else if rest.len() == 1 {
            skill = Some(rest[0].to_string());
        }
    }
    Ok(SkillPackageRef {
        owner,
        repo,
        skill,
    })
}

fn parse_skills_sh_url(
    url: &str,
    skill_from_at: Option<String>,
) -> Result<SkillPackageRef, String> {
    let after = url.split("skills.sh/").nth(1).unwrap_or("");
    let parts: Vec<&str> = after.split('/').filter(|part| !part.is_empty()).collect();
    match parts.as_slice() {
        [owner, repo] => Ok(SkillPackageRef {
            owner: (*owner).to_string(),
            repo: (*repo).to_string(),
            skill: skill_from_at,
        }),
        [owner, repo, skill, ..] => Ok(SkillPackageRef {
            owner: (*owner).to_string(),
            repo: (*repo).to_string(),
            skill: skill_from_at.or_else(|| Some((*skill).to_string())),
        }),
        _ => Err(format!("Invalid skills.sh URL: {url}")),
    }
}

fn sanitize_skill_dir_name(name: &str) -> Result<String, String> {
    let mut out = String::new();
    for ch in name.trim().chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
            out.push(ch);
        } else if matches!(ch, ' ' | ':' | '/' | '\\') && !out.ends_with('-') {
            out.push('-');
        }
    }
    let out = out.trim_matches(|ch| ch == '-' || ch == '.').to_string();
    if out.is_empty() || out == "." || out == ".." {
        return Err(format!("Invalid skill directory name: {name}"));
    }
    let mut components = Path::new(&out).components();
    match (components.next(), components.next()) {
        (Some(Component::Normal(_)), None) => Ok(out),
        _ => Err(format!("Invalid skill directory name: {name}")),
    }
}

fn skill_target_dir(target_dir: &Path, name: &str) -> Result<PathBuf, String> {
    Ok(target_dir.join(sanitize_skill_dir_name(name)?))
}

fn has_skill_md(dir: &Path) -> bool {
    dir.join("SKILL.md").is_file()
}

fn should_skip_entry(name: &str) -> bool {
    matches!(
        name,
        ".git"
            | ".github"
            | ".gitignore"
            | "node_modules"
            | "target"
            | "dist"
            | ".DS_Store"
            | "__pycache__"
            | ".venv"
            | "venv"
            | ".idea"
            | ".vscode"
            | "skill-manifest.json"
    )
}

fn is_walkable_dir_name(name: &str) -> bool {
    if !name.starts_with('.') {
        return true;
    }
    matches!(name, ".curated" | ".experimental" | ".system")
}

fn read_skill_name(dir: &Path, fallback: &str) -> String {
    if let Ok(content) = std::fs::read_to_string(dir.join("SKILL.md")) {
        if let Some((meta, _)) = open_agent_sdk::skills::parse_skill_file(&content) {
            if let Ok(name) = sanitize_skill_dir_name(&meta.name) {
                return name;
            }
        }
    }
    if let Ok(name) = sanitize_skill_dir_name(fallback) {
        return name;
    }
    dir.file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| sanitize_skill_dir_name(name).ok())
        .unwrap_or_else(|| "skill".to_string())
}

fn collect_skill_dirs(dir: &Path, out: &mut Vec<DiscoveredSkill>, depth: u32, max_depth: u32) {
    if depth >= max_depth {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if !is_walkable_dir_name(&name) {
            continue;
        }
        if has_skill_md(&path) {
            out.push(DiscoveredSkill {
                name: read_skill_name(&path, &name),
                dir: path,
                is_repo_root: false,
            });
        } else {
            collect_skill_dirs(&path, out, depth + 1, max_depth);
        }
    }
}

pub(crate) fn discover_skills(root: &Path, fallback_name: &str) -> Vec<DiscoveredSkill> {
    let mut found = Vec::new();
    for rel in SKILL_CONTAINERS {
        let container = root.join(rel);
        if container.is_dir() {
            collect_skill_dirs(&container, &mut found, 0, 3);
        }
    }
    if found.is_empty() && has_skill_md(root) {
        found.push(DiscoveredSkill {
            name: read_skill_name(root, fallback_name),
            dir: root.to_path_buf(),
            is_repo_root: true,
        });
    }
    if found.is_empty() {
        collect_skill_dirs(root, &mut found, 0, 1);
    }

    let mut seen = HashSet::new();
    found
        .into_iter()
        .filter(|skill| seen.insert(skill.name.clone()))
        .collect()
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if should_skip_entry(&name_str) {
            continue;
        }
        let ty = entry.file_type().map_err(|e| e.to_string())?;
        let dst_path = dst.join(&name);
        if ty.is_dir() {
            copy_dir_recursive(&entry.path(), &dst_path)?;
        } else {
            std::fs::copy(entry.path(), &dst_path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn copy_root_skill_files(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    let skill_md = src.join("SKILL.md");
    if skill_md.is_file() {
        std::fs::copy(&skill_md, dst.join("SKILL.md")).map_err(|e| e.to_string())?;
    }
    for sidecar in ROOT_SKILL_SIDECARS {
        let from = src.join(sidecar);
        if from.is_dir() {
            copy_dir_recursive(&from, &dst.join(sidecar))?;
        }
    }
    Ok(())
}

fn copy_skill_payload(src: &Path, dst: &Path, is_repo_root: bool) -> Result<(), String> {
    if is_repo_root {
        copy_root_skill_files(src, dst)
    } else {
        copy_dir_recursive(src, dst)
    }
}

fn write_manifest(
    dest: &Path,
    source_kind: &str,
    source_repo: &str,
    skill_name: &str,
    commit: &str,
    installed_via: &str,
) -> Result<(), String> {
    let source_ref = if skill_name.is_empty() {
        source_repo.to_string()
    } else {
        format!("{source_repo}@{skill_name}")
    };
    let manifest = serde_json::json!({
        "source_kind": source_kind,
        "source_ref": source_ref,
        "branch": "main",
        "commit": commit,
        "installed_at": chrono::Utc::now().to_rfc3339(),
        "installed_via": installed_via
    });
    std::fs::write(
        dest.join("skill-manifest.json"),
        serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

fn filter_requested<'a>(
    skills: &'a [DiscoveredSkill],
    requested: Option<&str>,
) -> Result<Vec<&'a DiscoveredSkill>, String> {
    let Some(requested) = requested.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(skills.iter().collect());
    };
    let matched: Vec<&DiscoveredSkill> = skills
        .iter()
        .filter(|skill| {
            skill.name.eq_ignore_ascii_case(requested)
                || skill
                    .dir
                    .file_name()
                    .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case(requested))
        })
        .collect();
    if matched.is_empty() {
        let available = skills
            .iter()
            .map(|skill| skill.name.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        return Err(format!(
            "Skill '{requested}' not found in repository. Available: {available}"
        ));
    }
    Ok(matched)
}

pub(crate) fn install_extracted_skills(
    extracted_root: &Path,
    target_dir: &Path,
    requested: Option<&str>,
    source_kind: &str,
    source_repo: &str,
    commit: &str,
    installed_via: &str,
) -> Result<String, String> {
    let fallback = source_repo
        .split('/')
        .next_back()
        .filter(|value| !value.is_empty())
        .unwrap_or("skill");
    let discovered = discover_skills(extracted_root, fallback);
    if discovered.is_empty() {
        return Err(
            "No SKILL.md found in the repository. Install the skills/ directory or a SKILL.md file, not the whole project."
                .to_string(),
        );
    }
    let selected = filter_requested(&discovered, requested)?;
    std::fs::create_dir_all(target_dir).map_err(|e| e.to_string())?;

    let mut installed = Vec::new();
    for skill in selected {
        let dest = skill_target_dir(target_dir, &skill.name)?;
        if dest.exists() {
            std::fs::remove_dir_all(&dest).map_err(|e| e.to_string())?;
        }
        copy_skill_payload(&skill.dir, &dest, skill.is_repo_root)?;
        write_manifest(
            &dest,
            source_kind,
            source_repo,
            &skill.name,
            commit,
            installed_via,
        )?;
        installed.push(skill.name.clone());
    }
    Ok(installed.join(", "))
}

fn zipball_root_name<R: std::io::Read + std::io::Seek>(
    archive: &zip::ZipArchive<R>,
) -> Result<String, String> {
    let mut root: Option<String> = None;
    for name in archive.file_names() {
        let Some(first) = name.split('/').next().filter(|part| !part.is_empty()) else {
            continue;
        };
        match &root {
            None => root = Some(first.to_string()),
            Some(existing) if existing == first => {}
            Some(existing) => {
                return Err(format!(
                    "Unexpected zip layout: {existing} vs {first}"
                ));
            }
        }
    }
    root.ok_or_else(|| "Empty archive".to_string())
}

#[tauri::command]
pub async fn install_skill(source: String, target: Option<String>) -> Result<String, String> {
    let target_dir = install_target_dir(target.as_deref());
    std::fs::create_dir_all(&target_dir).map_err(|e| e.to_string())?;

    if is_local_source(&source) {
        install_from_local(&source, &target_dir)
    } else {
        let package = parse_skill_package_ref(&source)?;
        install_from_github(&package, &target_dir).await
    }
}

async fn install_from_github(
    package: &SkillPackageRef,
    target_dir: &Path,
) -> Result<String, String> {
    let url = format!(
        "https://api.github.com/repos/{}/{}/zipball",
        package.owner, package.repo
    );

    let client = reqwest::Client::new();
    let response = client
        .get(&url)
        .header("User-Agent", "AQBot")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("Failed to download skill: {e}"))?;

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
        zip::ZipArchive::new(cursor).map_err(|e| format!("Failed to read zip: {e}"))?;
    let top_dir = zipball_root_name(&archive)?;
    archive
        .extract(temp_dir.path())
        .map_err(|e| format!("Failed to extract: {e}"))?;

    let extracted = temp_dir.path().join(&top_dir);
    let commit = top_dir.split('-').next_back().unwrap_or("unknown");
    install_extracted_skills(
        &extracted,
        target_dir,
        package.skill.as_deref(),
        "github",
        &package.repo_slug(),
        commit,
        "marketplace",
    )
}

fn install_from_local(source: &str, target_dir: &Path) -> Result<String, String> {
    let source_path = PathBuf::from(source);
    if !source_path.exists() {
        return Err(format!("Source path does not exist: {source}"));
    }
    if !source_path.is_dir() {
        return Err(format!("Source path is not a directory: {source}"));
    }
    install_extracted_skills(
        &source_path,
        target_dir,
        None,
        "local",
        source,
        "local",
        "local",
    )
}
