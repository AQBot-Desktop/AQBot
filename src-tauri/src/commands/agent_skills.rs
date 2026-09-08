use std::collections::HashSet;
use std::path::Path;

use open_agent_sdk::skills::{sync_skill_runtime, SkillRegistry, SkillRuntimeMap};

pub struct PreparedAgentSkills {
    pub registry: SkillRegistry,
    pub summary: Option<String>,
    pub runtime: Option<SkillRuntimeMap>,
}

pub fn prepare_agent_skills(
    home: &Path,
    disabled: HashSet<String>,
    inject_summary: bool,
    workspace: Option<&Path>,
    session_id: &str,
) -> Result<PreparedAgentSkills, String> {
    let mut registry = SkillRegistry::new();
    for skill in open_agent_sdk::skills::load_all_global(home) {
        registry.register(skill);
    }
    registry.set_disabled(disabled);

    let runtime = match workspace {
        Some(workspace) if !workspace.as_os_str().is_empty() => {
            if inject_summary {
                let enabled: Vec<_> = registry.all_enabled().into_iter().cloned().collect();
                Some(sync_skill_runtime(workspace, session_id, &enabled)?)
            } else if workspace.exists() {
                Some(SkillRuntimeMap::for_session(workspace, session_id)?)
            } else {
                None
            }
        }
        _ => None,
    };
    if let Some(runtime) = &runtime {
        registry.apply_mapped_dirs(runtime);
    }

    let summary = if inject_summary {
        let summary = registry.generate_context_summary();
        if summary.is_empty() {
            None
        } else {
            Some(summary)
        }
    } else {
        None
    };
    Ok(PreparedAgentSkills {
        registry,
        summary,
        runtime,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::fs;
    use std::path::Path;

    const SESSION_A: &str = "11111111-1111-4111-8111-111111111111";
    const SESSION_B: &str = "22222222-2222-4222-8222-222222222222";

    fn write_skill(dir: &Path, name: &str) {
        fs::create_dir_all(dir).unwrap();
        fs::write(
            dir.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: test\n---\n\n# {name}\n"),
        )
        .unwrap();
    }

    #[test]
    fn prepare_maps_unicode_skill_and_keeps_runtime_read_only() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let workspace = root.path().join("workspace with space");
        fs::create_dir_all(&workspace).unwrap();
        write_skill(&home.join(".aqbot/skills/GFE 技能"), "GFE 技能");

        let prepared = prepare_agent_skills(
            &home,
            HashSet::new(),
            true,
            Some(&workspace),
            SESSION_A,
        )
        .unwrap();
        let runtime = prepared.runtime.expect("skill runtime");
        let alias = runtime.mapped_dir_for("GFE 技能").expect("mapped skill");
        let skill_md = alias.join("SKILL.md");
        let cwd = workspace.to_str().unwrap();

        assert!(skill_md.is_file());
        assert!(runtime
            .authorize(skill_md.to_str().unwrap(), cwd, false)
            .unwrap()
            .is_ok());
        assert!(runtime
            .authorize(skill_md.to_str().unwrap(), cwd, true)
            .unwrap()
            .is_err());
    }

    #[test]
    fn prepare_isolates_skill_maps_per_session() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let workspace = root.path().join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        write_skill(&home.join(".aqbot/skills/demo"), "demo");

        let first = prepare_agent_skills(
            &home,
            HashSet::new(),
            true,
            Some(&workspace),
            SESSION_A,
        )
        .unwrap()
        .runtime
        .unwrap();
        let second = prepare_agent_skills(
            &home,
            HashSet::new(),
            true,
            Some(&workspace),
            SESSION_B,
        )
        .unwrap()
        .runtime
        .unwrap();

        let alias_a = first.mapped_dir_for("demo").unwrap();
        let alias_b = second.mapped_dir_for("demo").unwrap();
        assert_ne!(alias_a, alias_b);
        assert!(first
            .authorize(
                alias_b.join("SKILL.md").to_str().unwrap(),
                workspace.to_str().unwrap(),
                false,
            )
            .unwrap()
            .is_err());
    }

    #[test]
    fn prepare_keeps_original_mapping_error() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let workspace = root.path().join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        write_skill(&home.join(".aqbot/skills/demo"), "demo");
        let session_dir = workspace
            .join(".aqbot-skills-runtime")
            .join(SESSION_A);
        fs::create_dir_all(&session_dir).unwrap();
        fs::write(session_dir.join("blocked"), "not a link").unwrap();

        let err = match prepare_agent_skills(
            &home,
            HashSet::new(),
            true,
            Some(&workspace),
            SESSION_A,
        ) {
            Ok(_) => panic!("mapping should fail for a blocked session dir"),
            Err(error) => error,
        };
        assert!(
            err.contains("Unexpected file") || err.contains("blocked"),
            "{err}"
        );
    }
}
