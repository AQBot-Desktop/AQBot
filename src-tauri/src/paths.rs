use std::path::PathBuf;

/// Returns the canonical AQBot home directory and ensures it exists.
///
/// - macOS / Linux: `~/.aqbot/`
/// - Windows:       `%USERPROFILE%\.aqbot\`
///
/// Panics if the home directory cannot be determined.
pub fn aqbot_home() -> PathBuf {
    #[cfg(not(windows))]
    let home = std::env::var("HOME").expect("HOME env var not set");
    #[cfg(windows)]
    let home = std::env::var("USERPROFILE").expect("USERPROFILE env var not set");

    PathBuf::from(home).join(".aqbot")
}
