use serde::{Deserialize, Serialize};

/// Tool risk classification
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RiskLevel {
    ReadOnly,
    Write,
    Execute,
}

/// Permission mode for the agent session
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PermissionMode {
    Default,
    AcceptEdits,
    FullAccess,
}

impl PermissionMode {
    pub fn from_str(s: &str) -> Self {
        match s {
            "accept_edits" => Self::AcceptEdits,
            "full_access" => Self::FullAccess,
            _ => Self::Default,
        }
    }
}

/// What the permission system decides
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionAction {
    AutoAllow,
    RequireApproval,
    HardDeny,
}

/// Agent-facing alias prefix for tools backed by external MCP servers.
pub const MCP_TOOL_ALIAS_PREFIX: &str = "mcp__";

/// Classify a tool's risk level based on its name
pub fn classify_tool_risk(tool_name: &str) -> RiskLevel {
    let name_lower = tool_name.to_lowercase();

    // Execute-level tools
    if name_lower.starts_with(MCP_TOOL_ALIAS_PREFIX)
        || matches!(
            name_lower.as_str(),
            "bash" | "shell" | "run_command" | "execute"
        )
        || name_lower.contains("exec")
        || name_lower.contains("run")
        || name_lower.contains("bash")
        || name_lower.contains("shell")
    {
        return RiskLevel::Execute;
    }

    // Write-level tools
    if matches!(
        name_lower.as_str(),
        "write"
            | "edit"
            | "create"
            | "delete"
            | "rename"
            | "patch"
            | "write_file"
            | "edit_file"
            | "create_file"
            | "delete_file"
            | "move"
            | "mkdir"
            | "remove"
    ) || name_lower.contains("write")
        || name_lower.contains("edit")
        || name_lower.contains("create")
        || name_lower.contains("delete")
        || name_lower.contains("patch")
    {
        return RiskLevel::Write;
    }

    // Everything else is read-only
    RiskLevel::ReadOnly
}

/// Decision matrix: given permission mode, risk level, and whether the tool
/// is in the "always allowed" set, return the action to take.
pub fn decide_permission(
    mode: PermissionMode,
    risk: RiskLevel,
    is_always_allowed: bool,
) -> PermissionAction {
    // Cached "always allow" never covers Execute tools.
    if is_always_allowed && allows_persistent_approval(risk) {
        return PermissionAction::AutoAllow;
    }

    match (mode, risk) {
        // Default mode: only read is auto-allowed
        (PermissionMode::Default, RiskLevel::ReadOnly) => PermissionAction::AutoAllow,
        (PermissionMode::Default, RiskLevel::Write) => PermissionAction::RequireApproval,
        (PermissionMode::Default, RiskLevel::Execute) => PermissionAction::RequireApproval,

        // Accept edits: read + write auto-allowed
        (PermissionMode::AcceptEdits, RiskLevel::ReadOnly) => PermissionAction::AutoAllow,
        (PermissionMode::AcceptEdits, RiskLevel::Write) => PermissionAction::AutoAllow,
        (PermissionMode::AcceptEdits, RiskLevel::Execute) => PermissionAction::RequireApproval,

        // Full access: everything auto-allowed
        (PermissionMode::FullAccess, _) => PermissionAction::AutoAllow,
    }
}

/// Whether "always allow" may be persisted for this risk.
pub fn allows_persistent_approval(risk: RiskLevel) -> bool {
    !matches!(risk, RiskLevel::Execute)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bash_and_shell_are_execute() {
        assert_eq!(classify_tool_risk("Bash"), RiskLevel::Execute);
        assert_eq!(classify_tool_risk("shell"), RiskLevel::Execute);
        assert_eq!(classify_tool_risk("run_command"), RiskLevel::Execute);
    }

    #[test]
    fn default_and_accept_edits_require_approval_for_execute() {
        assert_eq!(
            decide_permission(PermissionMode::Default, RiskLevel::Execute, false),
            PermissionAction::RequireApproval
        );
        assert_eq!(
            decide_permission(PermissionMode::AcceptEdits, RiskLevel::Execute, false),
            PermissionAction::RequireApproval
        );
    }

    #[test]
    fn full_access_auto_allows_execute() {
        assert_eq!(
            decide_permission(PermissionMode::FullAccess, RiskLevel::Execute, false),
            PermissionAction::AutoAllow
        );
    }

    #[test]
    fn execute_cannot_use_persistent_allow_or_cached_always_allowed() {
        assert!(!allows_persistent_approval(RiskLevel::Execute));
        assert!(allows_persistent_approval(RiskLevel::Write));
        assert_eq!(
            decide_permission(PermissionMode::Default, RiskLevel::Execute, true),
            PermissionAction::RequireApproval
        );
        assert_eq!(
            decide_permission(PermissionMode::Default, RiskLevel::Write, true),
            PermissionAction::AutoAllow
        );
    }

    #[test]
    fn mcp_tools_are_execute_only_and_never_persistently_approved() {
        let risk = classify_tool_risk("mcp__server_query__0123456789abcdef");

        assert_eq!(risk, RiskLevel::Execute);
        assert_eq!(
            decide_permission(PermissionMode::Default, risk, true),
            PermissionAction::RequireApproval
        );
        assert_eq!(
            decide_permission(PermissionMode::AcceptEdits, risk, true),
            PermissionAction::RequireApproval
        );
        assert_eq!(
            decide_permission(PermissionMode::FullAccess, risk, true),
            PermissionAction::AutoAllow
        );
        assert!(!allows_persistent_approval(risk));
    }
}
