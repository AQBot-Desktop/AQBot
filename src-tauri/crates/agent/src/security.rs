use open_agent_sdk::PermissionDecision;
use serde_json::Value;
use std::path::{Path, PathBuf};

/// Validate that a path resolves to within the cwd.
/// For existing paths, uses canonicalize (resolves symlinks).
/// For non-existing paths, validates the parent directory.
pub fn validate_path_within_cwd(path: &str, cwd: &str) -> Result<PathBuf, String> {
    let target = Path::new(path);
    let cwd_path = Path::new(cwd);

    // Canonicalize cwd (must exist)
    let cwd_canonical = cwd_path
        .canonicalize()
        .map_err(|e| format!("Cannot resolve working directory '{}': {}", cwd, e))?;

    // Try to resolve the target path
    let resolved = if target.is_absolute() {
        target.to_path_buf()
    } else {
        cwd_path.join(target)
    };

    // If path exists, canonicalize it (resolves symlinks)
    if resolved.exists() {
        let canonical = resolved
            .canonicalize()
            .map_err(|e| format!("Cannot resolve path '{}': {}", path, e))?;
        if canonical.starts_with(&cwd_canonical) {
            Ok(canonical)
        } else {
            Err(format!(
                "Path '{}' resolves to '{}' which is outside working directory '{}'",
                path,
                canonical.display(),
                cwd_canonical.display()
            ))
        }
    } else {
        // For non-existing paths, check parent directory
        if let Some(parent) = resolved.parent() {
            if parent.exists() {
                let parent_canonical = parent
                    .canonicalize()
                    .map_err(|e| format!("Cannot resolve parent of '{}': {}", path, e))?;
                if parent_canonical.starts_with(&cwd_canonical) {
                    Ok(resolved)
                } else {
                    Err(format!(
                        "Parent of '{}' resolves outside working directory '{}'",
                        path,
                        cwd_canonical.display()
                    ))
                }
            } else {
                // Parent doesn't exist — walk up until we find an existing ancestor
                let mut ancestor = parent.to_path_buf();
                loop {
                    if ancestor.exists() {
                        let anc_canonical = ancestor
                            .canonicalize()
                            .map_err(|e| format!("Cannot resolve ancestor: {}", e))?;
                        if anc_canonical.starts_with(&cwd_canonical) {
                            return Ok(resolved);
                        } else {
                            return Err(format!(
                                "Path '{}' is outside working directory '{}'",
                                path,
                                cwd_canonical.display()
                            ));
                        }
                    }
                    if !ancestor.pop() {
                        return Err(format!(
                            "Cannot verify path '{}' against working directory",
                            path
                        ));
                    }
                }
            }
        } else {
            Err(format!("Invalid path: '{}'", path))
        }
    }
}

/// Check if a tool's path arguments are safe (within cwd).
/// Returns Some(PermissionDecision::Deny(reason)) if unsafe, None if safe or not applicable.
pub fn check_path_safety(tool_name: &str, input: &Value, cwd: &str) -> Option<PermissionDecision> {
    let name_lower = tool_name.to_lowercase();

    match name_lower.as_str() {
        // Single-file path tools
        "read" | "read_file" | "write" | "write_file" | "edit" | "edit_file" | "create"
        | "create_file" | "delete" | "delete_file" | "rename" | "list_dir" | "listdir" => {
            check_single_path(input, cwd)
        }

        // Glob tool — check base directory of pattern
        "glob" | "glob_search" => check_glob_path(input, cwd),

        // Grep tool — optional path
        "grep" | "search" | "ripgrep" => check_grep_path(input, cwd),

        // Bash/shell — no path checking (cwd is injected, but cd escape is Phase 4)
        "bash" | "shell" | "run_command" | "execute" => None,

        // Unknown tools — don't block
        _ => None,
    }
}

fn check_single_path(input: &Value, cwd: &str) -> Option<PermissionDecision> {
    // Try common field names for path
    let path_str = input
        .get("path")
        .or_else(|| input.get("file_path"))
        .or_else(|| input.get("file"))
        .and_then(|v| v.as_str());

    if let Some(path) = path_str {
        if let Err(reason) = validate_path_within_cwd(path, cwd) {
            return Some(PermissionDecision::Deny(reason));
        }
    }

    // Also check "new_path" for rename operations
    if let Some(new_path) = input.get("new_path").and_then(|v| v.as_str()) {
        if let Err(reason) = validate_path_within_cwd(new_path, cwd) {
            return Some(PermissionDecision::Deny(reason));
        }
    }

    None
}

fn check_glob_path(input: &Value, cwd: &str) -> Option<PermissionDecision> {
    if let Some(path) = input.get("path").and_then(|v| v.as_str()) {
        if let Err(reason) = validate_path_within_cwd(path, cwd) {
            return Some(PermissionDecision::Deny(reason));
        }
    }

    let pattern = input
        .get("pattern")
        .or_else(|| input.get("glob"))
        .and_then(|v| v.as_str())?;

    // Extract base directory from glob pattern (non-wildcard prefix)
    let base_dir = extract_glob_base(pattern);

    if !base_dir.is_empty() {
        if let Err(reason) = validate_path_within_cwd(&base_dir, cwd) {
            return Some(PermissionDecision::Deny(reason));
        }
    }
    // Empty base_dir means pattern starts with wildcard → relative to cwd → safe

    None
}

fn check_grep_path(input: &Value, cwd: &str) -> Option<PermissionDecision> {
    // Grep path is optional — if not specified, defaults to cwd (safe)
    if let Some(path) = input.get("path").and_then(|v| v.as_str()) {
        if let Err(reason) = validate_path_within_cwd(path, cwd) {
            return Some(PermissionDecision::Deny(reason));
        }
    }
    None
}

/// Extract the non-wildcard prefix from a glob pattern as a base directory.
/// e.g., "src/components/**/*.tsx" → "src/components"
///       "**/*.rs" → ""
///       "/absolute/path/to/*.txt" → "/absolute/path/to"
fn extract_glob_base(pattern: &str) -> String {
    let mut parts = Vec::new();
    for segment in pattern.split('/') {
        if segment.contains('*')
            || segment.contains('?')
            || segment.contains('[')
            || segment.contains('{')
        {
            break;
        }
        parts.push(segment);
    }
    parts.join("/")
}
