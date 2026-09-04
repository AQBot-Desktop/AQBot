use std::collections::HashSet;
use std::path::Path;

use open_agent_sdk::skills::SkillRegistry;

pub struct PreparedAgentSkills {
    pub registry: SkillRegistry,
    pub summary: Option<String>,
}

pub fn prepare_agent_skills(
    home: &Path,
    disabled: HashSet<String>,
    inject_summary: bool,
) -> PreparedAgentSkills {
    let mut registry = SkillRegistry::new();
    for skill in open_agent_sdk::skills::load_all_global(home) {
        registry.register(skill);
    }
    registry.set_disabled(disabled);
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
    PreparedAgentSkills { registry, summary }
}
