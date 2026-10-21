use super::{model::Model, serde_helpers::deserialize_double_option, settings::AppSettings};
use serde::{Deserialize, Serialize};

// === Provider System ===

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderConfig {
    pub id: String,
    pub name: String,
    pub provider_type: ProviderType,
    pub api_host: String,
    pub api_path: Option<String>,
    pub aws_region: Option<String>,
    pub enabled: bool,
    pub models: Vec<Model>,
    pub keys: Vec<ProviderKey>,
    pub proxy_config: Option<ProviderProxyConfig>,
    pub custom_headers: Option<String>,
    pub icon: Option<String>,
    pub builtin_id: Option<String>,
    /// Custom public prefix used by the gateway (`prefix/model`); `None` derives it from the name.
    #[serde(default)]
    pub gateway_prefix: Option<String>,
    pub sort_order: i32,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ProviderType {
    OpenAI,
    #[serde(rename = "openai_responses")]
    OpenAIResponses,
    DeepSeek,
    XAI,
    GLM,
    SiliconFlow,
    Anthropic,
    Gemini,
    Jina,
    Cohere,
    Voyage,
    Bedrock,
    Custom,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderKey {
    pub id: String,
    pub provider_id: String,
    pub key_encrypted: String,
    pub key_prefix: String,
    pub enabled: bool,
    pub last_validated_at: Option<i64>,
    pub last_error: Option<String>,
    pub rotation_index: u32,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderProxyConfig {
    pub proxy_type: Option<String>,
    pub proxy_address: Option<String>,
    pub proxy_port: Option<u16>,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BedrockCredentialInput {
    pub access_key_id: String,
    pub secret_access_key: String,
    pub session_token: Option<String>,
}

impl ProviderProxyConfig {
    /// Resolve effective proxy: provider-level overrides global.
    /// If provider has explicit proxy_type, use it (even "none" to disable).
    /// Otherwise fall back to global settings.
    pub fn resolve(provider: &Option<Self>, global_settings: &AppSettings) -> Option<Self> {
        if let Some(config) = provider {
            if config.proxy_type.is_some() {
                if config.proxy_type.as_deref() == Some("none") {
                    return None;
                }
                return Some(config.clone());
            }
        }
        // Fall back to global proxy
        match global_settings.proxy_type.as_deref() {
            Some("none") | None => None,
            Some("system") => Some(Self {
                proxy_type: Some("system".to_string()),
                proxy_address: None,
                proxy_port: None,
            }),
            _ => Some(Self {
                proxy_type: global_settings.proxy_type.clone(),
                proxy_address: global_settings.proxy_address.clone(),
                proxy_port: global_settings.proxy_port,
            }),
        }
    }
}

#[cfg(test)]
mod provider_proxy_config_tests {
    use super::{AppSettings, ProviderProxyConfig};

    fn global_with_proxy(proxy_type: Option<&str>) -> AppSettings {
        let mut settings = AppSettings::default();
        settings.proxy_type = proxy_type.map(str::to_string);
        settings.proxy_address = Some("127.0.0.1".to_string());
        settings.proxy_port = Some(7890);
        settings
    }

    fn provider_proxy(proxy_type: Option<&str>) -> Option<ProviderProxyConfig> {
        Some(ProviderProxyConfig {
            proxy_type: proxy_type.map(str::to_string),
            proxy_address: Some("10.0.0.1".to_string()),
            proxy_port: Some(1080),
        })
    }

    #[test]
    fn resolve_follows_global_when_provider_config_is_none() {
        let global = global_with_proxy(Some("system"));
        let resolved = ProviderProxyConfig::resolve(&None, &global);
        assert_eq!(
            resolved.and_then(|c| c.proxy_type),
            Some("system".to_string())
        );
    }

    #[test]
    fn resolve_follows_global_when_provider_proxy_type_is_null() {
        let global = global_with_proxy(Some("http"));
        let resolved = ProviderProxyConfig::resolve(&provider_proxy(None), &global);
        assert_eq!(
            resolved,
            Some(ProviderProxyConfig {
                proxy_type: Some("http".to_string()),
                proxy_address: Some("127.0.0.1".to_string()),
                proxy_port: Some(7890),
            })
        );
    }

    #[test]
    fn resolve_provider_none_disables_even_when_global_is_system() {
        let global = global_with_proxy(Some("system"));
        let resolved = ProviderProxyConfig::resolve(&provider_proxy(Some("none")), &global);
        assert!(resolved.is_none());
    }

    #[test]
    fn resolve_provider_system_overrides_global_none() {
        let global = global_with_proxy(None);
        let resolved = ProviderProxyConfig::resolve(&provider_proxy(Some("system")), &global);
        assert_eq!(
            resolved.and_then(|c| c.proxy_type),
            Some("system".to_string())
        );
    }

    #[test]
    fn resolve_provider_http_overrides_global() {
        let global = global_with_proxy(Some("system"));
        let resolved = ProviderProxyConfig::resolve(&provider_proxy(Some("http")), &global);
        assert_eq!(
            resolved,
            Some(ProviderProxyConfig {
                proxy_type: Some("http".to_string()),
                proxy_address: Some("10.0.0.1".to_string()),
                proxy_port: Some(1080),
            })
        );
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateProviderInput {
    pub name: String,
    pub provider_type: ProviderType,
    pub api_host: String,
    pub api_path: Option<String>,
    #[serde(default)]
    pub aws_region: Option<String>,
    pub enabled: bool,
    #[serde(default)]
    pub builtin_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct UpdateProviderInput {
    pub name: Option<String>,
    pub provider_type: Option<ProviderType>,
    pub api_host: Option<String>,
    pub api_path: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub aws_region: Option<Option<String>>,
    pub enabled: Option<bool>,
    pub proxy_config: Option<ProviderProxyConfig>,
    pub custom_headers: Option<Option<String>>,
    pub icon: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub gateway_prefix: Option<Option<String>>,
    pub sort_order: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeepLinkProviderImportInput {
    pub name: String,
    pub baseurl: String,
    pub apikey: String,
    #[serde(rename = "type")]
    pub provider_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeepLinkProviderImportResult {
    pub provider_id: String,
    pub provider_name: String,
    pub created_provider: bool,
    pub added_key: bool,
    pub reused_key: bool,
}
