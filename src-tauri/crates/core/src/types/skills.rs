use serde::{Deserialize, Serialize};

// ── Skills ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInfo {
    pub name: String,
    pub description: String,
    pub author: Option<String>,
    pub version: Option<String>,
    pub source: String,
    pub source_path: String,
    pub enabled: bool,
    pub has_update: bool,
    pub user_invocable: bool,
    pub argument_hint: Option<String>,
    pub when_to_use: Option<String>,
    pub group: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDetail {
    pub info: SkillInfo,
    pub content: String,
    pub files: Vec<String>,
    pub manifest: Option<SkillManifest>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillManifest {
    pub source_kind: String,
    pub source_ref: Option<String>,
    pub branch: Option<String>,
    pub commit: Option<String>,
    pub installed_at: String,
    pub installed_via: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillUpdateInfo {
    pub name: String,
    pub current_commit: String,
    pub latest_commit: String,
    pub source_ref: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceSkill {
    pub name: String,
    pub description: String,
    pub repo: String,
    #[serde(default)]
    pub skill_id: String,
    #[serde(default)]
    pub install_ref: String,
    pub stars: i64,
    pub installs: i64,
    pub installed: bool,
}
