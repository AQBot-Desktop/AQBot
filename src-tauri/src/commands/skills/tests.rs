use super::install::{
    discover_skills, github_owner_repo, install_extracted_skills, is_local_source,
    parse_skill_package_ref,
};
use super::marketplace::{
    marketplace_installed, normalize_skills_sh_query, parse_skills_sh_skills,
};
use std::collections::HashSet;
use std::fs;
use std::path::Path;

fn write_skill(dir: &Path, name: &str, extra_files: &[(&str, &str)]) {
    fs::create_dir_all(dir).unwrap();
    fs::write(
        dir.join("SKILL.md"),
        format!("---\nname: {name}\ndescription: test skill\n---\n\n# {name}\n"),
    )
    .unwrap();
    for (rel, contents) in extra_files {
        let path = dir.join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, contents).unwrap();
    }
}

#[test]
fn skills_sh_empty_query_uses_default_search_term() {
    assert_eq!(normalize_skills_sh_query(""), "skill");
    assert_eq!(normalize_skills_sh_query(" "), "skill");
    assert_eq!(normalize_skills_sh_query("a"), "skill");
    assert_eq!(normalize_skills_sh_query("ai"), "ai");
    assert_eq!(normalize_skills_sh_query("  react  "), "react");
}

#[test]
fn parse_skills_sh_maps_individual_skill_install_ref() {
    let body = serde_json::json!({
        "skills": [{
            "id": "vercel-labs/agent-skills/frontend-design",
            "skillId": "frontend-design",
            "name": "frontend-design",
            "installs": 12,
            "source": "vercel-labs/agent-skills"
        }]
    });
    let results = parse_skills_sh_skills(&body, &HashSet::new());
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].name, "frontend-design");
    assert_eq!(results[0].repo, "vercel-labs/agent-skills");
    assert_eq!(results[0].skill_id, "frontend-design");
    assert_eq!(
        results[0].install_ref,
        "vercel-labs/agent-skills@frontend-design"
    );
    assert_eq!(results[0].installs, 12);
    assert!(!results[0].installed);
}

#[test]
fn marketplace_marks_only_the_installed_skill() {
    let mut refs = HashSet::new();
    refs.insert("vercel-labs/agent-skills@frontend-design".to_string());
    assert!(marketplace_installed(
        &refs,
        "vercel-labs/agent-skills",
        "frontend-design"
    ));
    assert!(!marketplace_installed(
        &refs,
        "vercel-labs/agent-skills",
        "web-design-guidelines"
    ));
}

#[test]
fn parse_owner_repo_at_skill() {
    let parsed = parse_skill_package_ref("vercel-labs/agent-skills@frontend-design").unwrap();
    assert_eq!(parsed.owner, "vercel-labs");
    assert_eq!(parsed.repo, "agent-skills");
    assert_eq!(parsed.skill.as_deref(), Some("frontend-design"));
}

#[test]
fn parse_github_tree_url_extracts_skill_folder() {
    let parsed = parse_skill_package_ref(
        "https://github.com/vercel-labs/agent-skills/tree/main/skills/frontend-design",
    )
    .unwrap();
    assert_eq!(parsed.repo_slug(), "vercel-labs/agent-skills");
    assert_eq!(parsed.skill.as_deref(), Some("frontend-design"));
}

#[test]
fn github_owner_repo_strips_skill_suffix() {
    assert_eq!(
        github_owner_repo("vercel-labs/agent-skills@frontend-design"),
        Some(("vercel-labs".into(), "agent-skills".into()))
    );
}

#[test]
fn windows_and_unix_paths_are_local_sources() {
    assert!(is_local_source("/tmp/skill"));
    assert!(is_local_source("./skill"));
    assert!(is_local_source("C:\\Users\\me\\skill"));
    assert!(!is_local_source("vercel-labs/agent-skills"));
    assert!(!is_local_source("vercel-labs/agent-skills@frontend-design"));
}

#[test]
fn discover_nested_skills_directory() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path();
    write_skill(&repo.join("skills/hello"), "hello", &[("scripts/run.sh", "echo hi")]);
    write_skill(&repo.join("skills/world"), "world", &[]);
    fs::write(repo.join("README.md"), "project").unwrap();
    fs::write(repo.join("package.json"), "{}").unwrap();

    let names: Vec<_> = discover_skills(repo, "repo")
        .into_iter()
        .map(|skill| skill.name)
        .collect();
    assert!(names.contains(&"hello".to_string()));
    assert!(names.contains(&"world".to_string()));
}

#[test]
fn install_copies_skill_folder_not_the_whole_repo() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("repo");
    write_skill(
        &repo.join("skills/hello"),
        "hello",
        &[("scripts/run.sh", "echo hi")],
    );
    fs::write(repo.join("README.md"), "project readme").unwrap();
    fs::write(repo.join("package.json"), "{\"name\":\"repo\"}").unwrap();
    fs::create_dir_all(repo.join("src")).unwrap();
    fs::write(repo.join("src/main.rs"), "fn main() {}").unwrap();

    let dest = tmp.path().join("dest");
    let names = install_extracted_skills(
        &repo,
        &dest,
        None,
        "github",
        "owner/repo",
        "abc1234",
        "marketplace",
    )
    .unwrap();
    assert_eq!(names, "hello");
    assert!(dest.join("hello/SKILL.md").is_file());
    assert!(dest.join("hello/scripts/run.sh").is_file());
    assert!(dest.join("hello/skill-manifest.json").is_file());
    assert!(!dest.join("hello/README.md").exists());
    assert!(!dest.join("hello/package.json").exists());
    assert!(!dest.join("hello/src/main.rs").exists());
    assert!(!dest.join("README.md").exists());
    assert!(!dest.join("package.json").exists());
}

#[test]
fn install_root_skill_skips_project_clutter() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("repo");
    write_skill(&repo, "root-skill", &[("scripts/run.sh", "echo hi")]);
    fs::write(repo.join("README.md"), "readme").unwrap();
    fs::write(repo.join("package.json"), "{}").unwrap();
    fs::create_dir_all(repo.join("src")).unwrap();
    fs::write(repo.join("src/lib.rs"), "// not a skill file").unwrap();

    let dest = tmp.path().join("dest");
    install_extracted_skills(
        &repo,
        &dest,
        None,
        "github",
        "owner/root-skill",
        "deadbeef",
        "marketplace",
    )
    .unwrap();

    assert!(dest.join("root-skill/SKILL.md").is_file());
    assert!(dest.join("root-skill/scripts/run.sh").is_file());
    assert!(!dest.join("root-skill/README.md").exists());
    assert!(!dest.join("root-skill/package.json").exists());
    assert!(!dest.join("root-skill/src/lib.rs").exists());
}

#[test]
fn install_requested_skill_only() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("repo");
    write_skill(&repo.join("skills/alpha"), "alpha", &[]);
    write_skill(&repo.join("skills/beta"), "beta", &[]);

    let dest = tmp.path().join("dest");
    let names = install_extracted_skills(
        &repo,
        &dest,
        Some("beta"),
        "github",
        "owner/pack",
        "1",
        "marketplace",
    )
    .unwrap();
    assert_eq!(names, "beta");
    assert!(dest.join("beta/SKILL.md").is_file());
    assert!(!dest.join("alpha").exists());
}

#[test]
fn install_writes_per_skill_source_ref() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("repo");
    write_skill(&repo.join(".claude/skills/demo"), "demo", &[]);
    let dest = tmp.path().join("dest");
    install_extracted_skills(
        &repo,
        &dest,
        None,
        "github",
        "owner/pack",
        "fff",
        "marketplace",
    )
    .unwrap();
    let manifest: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(dest.join("demo/skill-manifest.json")).unwrap())
            .unwrap();
    assert_eq!(manifest["source_ref"], "owner/pack@demo");
}
