use serde::{Deserialize, Serialize};

// ─── Phase-2 Types ───────────────────────────────────────────────

// Search
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchProvider {
    pub id: String,
    pub name: String,
    pub provider_type: String, // tavily | zhipu | bocha | exa | keenable
    pub endpoint: Option<String>,
    pub has_api_key: bool,
    pub enabled: bool,
    pub region: Option<String>,
    pub language: Option<String>,
    pub safe_search: Option<bool>,
    pub result_limit: i32,
    pub timeout_ms: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchCitation {
    pub id: String,
    pub conversation_id: String,
    pub message_id: String,
    pub title: String,
    pub url: String,
    pub snippet: Option<String>,
    pub provider_id: String,
    pub rank: i32,
}
