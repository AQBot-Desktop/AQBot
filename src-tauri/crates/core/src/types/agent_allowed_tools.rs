/// Configurable Agent tools shown in settings, in display order.
pub const AGENT_CONFIGURABLE_TOOLS: &[&str] = &[
    "Read",
    "Write",
    "Edit",
    "Glob",
    "Grep",
    "NotebookEdit",
    "Bash",
    "LSP",
    "WebFetch",
    "WebSearch",
    "AskUserQuestion",
    "Skill",
    "ToolSearch",
    "TaskCreate",
    "TaskGet",
    "TaskList",
    "TaskUpdate",
    "TaskStop",
    "TaskOutput",
    "TodoWrite",
    "SendMessage",
    "TeamCreate",
    "TeamDelete",
    "EnterPlanMode",
    "ExitPlanMode",
    "EnterWorktree",
    "ExitWorktree",
    "CronCreate",
    "CronDelete",
    "CronList",
    "Config",
];

/// SDK resource tools that stay hidden after allowlist filtering.
pub const AGENT_HIDDEN_SDK_TOOLS: &[&str] = &["ListMcpResources", "ReadMcpResource"];

pub fn default_agent_allowed_tools() -> Vec<String> {
    AGENT_CONFIGURABLE_TOOLS
        .iter()
        .map(|name| (*name).to_string())
        .collect()
}

pub fn is_configurable_agent_tool(name: &str) -> bool {
    AGENT_CONFIGURABLE_TOOLS.contains(&name)
}

pub fn is_hidden_agent_tool(name: &str) -> bool {
    AGENT_HIDDEN_SDK_TOOLS.contains(&name)
}

/// Build `AgentOptions.allowed_tools`. `None` keeps the historical full registry.
pub fn resolve_agent_allowed_tools(
    enabled: bool,
    selected: &[String],
    mcp_aliases: &[String],
) -> Option<Vec<String>> {
    if !enabled {
        return None;
    }

    let mut seen = std::collections::HashSet::new();
    let mut allowed = Vec::new();
    for name in selected {
        if !is_configurable_agent_tool(name) || is_hidden_agent_tool(name) {
            continue;
        }
        if seen.insert(name.clone()) {
            allowed.push(name.clone());
        }
    }
    for alias in mcp_aliases {
        if is_hidden_agent_tool(alias) {
            continue;
        }
        if seen.insert(alias.clone()) {
            allowed.push(alias.clone());
        }
    }
    Some(allowed)
}

pub fn should_inject_skills_summary(enabled: bool, selected: &[String]) -> bool {
    !enabled || selected.iter().any(|name| name == "Skill")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configurable_catalog_is_unique_and_excludes_hidden_tools() {
        let mut seen = std::collections::HashSet::new();
        for name in AGENT_CONFIGURABLE_TOOLS {
            assert!(seen.insert(*name), "duplicate configurable tool {name}");
            assert!(!is_hidden_agent_tool(name));
        }
        assert_eq!(AGENT_CONFIGURABLE_TOOLS.len(), 31);
        assert_eq!(default_agent_allowed_tools().len(), 31);
    }

    #[test]
    fn disabled_whitelist_returns_none() {
        let selected = vec!["Read".to_string(), "Bash".to_string()];
        assert_eq!(
            resolve_agent_allowed_tools(false, &selected, &["mcp__a__t__b".to_string()]),
            None
        );
        assert!(should_inject_skills_summary(false, &[]));
    }

    #[test]
    fn enabled_empty_list_keeps_only_mcp_aliases() {
        let mcp = vec!["mcp__abcc4a8112e9__query_records__97392632db7fadc2".to_string()];
        assert_eq!(
            resolve_agent_allowed_tools(true, &[], &mcp),
            Some(mcp.clone())
        );
        assert!(!should_inject_skills_summary(true, &[]));
    }

    #[test]
    fn enabled_list_filters_unknowns_hidden_tools_and_duplicates() {
        let selected = vec![
            "Read".to_string(),
            "Bash".to_string(),
            "Read".to_string(),
            "NotATool".to_string(),
            "ListMcpResources".to_string(),
            "Skill".to_string(),
        ];
        let mcp = vec![
            "mcp__one".to_string(),
            "Read".to_string(),
            "mcp__one".to_string(),
            "ReadMcpResource".to_string(),
        ];
        assert_eq!(
            resolve_agent_allowed_tools(true, &selected, &mcp),
            Some(vec![
                "Read".to_string(),
                "Bash".to_string(),
                "Skill".to_string(),
                "mcp__one".to_string(),
            ])
        );
        assert!(should_inject_skills_summary(true, &selected));
    }

    #[test]
    fn skill_summary_follows_selected_skill_when_enabled() {
        assert!(!should_inject_skills_summary(
            true,
            &["Read".to_string(), "Bash".to_string()]
        ));
        assert!(should_inject_skills_summary(
            true,
            &["Read".to_string(), "Skill".to_string()]
        ));
    }
}
