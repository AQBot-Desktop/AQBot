//! Catalog contract between AQBot settings and the SDK default registry.

#[cfg(test)]
mod tests {
    use aqbot_core::types::{AGENT_CONFIGURABLE_TOOLS, AGENT_HIDDEN_SDK_TOOLS};
    use open_agent_sdk::tools::ToolRegistry;
    use std::collections::HashSet;

    #[test]
    fn catalog_classifies_every_default_sdk_tool() {
        let sdk_names: HashSet<String> = ToolRegistry::default_registry()
            .names()
            .into_iter()
            .collect();
        let mut classified = HashSet::new();

        for name in AGENT_HIDDEN_SDK_TOOLS {
            assert!(
                sdk_names.contains(*name),
                "hidden tool missing from SDK registry: {name}"
            );
            classified.insert(*name);
        }

        for name in AGENT_CONFIGURABLE_TOOLS {
            if *name == "Skill" {
                assert!(
                    !sdk_names.contains(*name),
                    "Skill must remain a custom tool rather than a default registry entry"
                );
                continue;
            }
            assert!(
                sdk_names.contains(*name),
                "configurable tool missing from SDK registry: {name}"
            );
            classified.insert(*name);
        }

        for name in &sdk_names {
            assert!(
                classified.contains(name.as_str()),
                "SDK tool {name} is neither configurable nor permanently hidden"
            );
        }
    }
}
