//! Automatic multi-provider model routing for the gateway.
//!
//! When the same model id or alias is configured on multiple providers and
//! `gateway_auto_model_routing` is enabled, requests form a candidate pool ordered
//! by `provider.sort_order`. Retriable upstream failures mark a candidate as
//! cooled-down and try the next one.

use aqbot_core::types::{model_matches_request_name, Model, ProviderConfig};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// Default cooldown after a retriable upstream failure.
pub const DEFAULT_COOLDOWN: Duration = Duration::from_secs(45);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RouteCandidate {
    pub provider_id: String,
    pub provider_name: String,
    pub sort_order: i32,
    pub real_model_id: String,
    /// The client-facing name that matched (model_id or alias).
    pub request_name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MatchVia {
    ModelId,
    Alias,
}

/// In-process circuit breaker: `(provider_id, real_model_id) -> reopen_at`.
fn cooldown_map() -> &'static Mutex<HashMap<(String, String), Instant>> {
    static MAP: OnceLock<Mutex<HashMap<(String, String), Instant>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn mark_failure(provider_id: &str, model_id: &str) {
    mark_failure_for(provider_id, model_id, DEFAULT_COOLDOWN);
}

pub fn mark_failure_for(provider_id: &str, model_id: &str, cooldown: Duration) {
    if let Ok(mut map) = cooldown_map().lock() {
        map.insert(
            (provider_id.to_string(), model_id.to_string()),
            Instant::now() + cooldown,
        );
    }
}

pub fn mark_success(provider_id: &str, model_id: &str) {
    if let Ok(mut map) = cooldown_map().lock() {
        map.remove(&(provider_id.to_string(), model_id.to_string()));
    }
}

pub fn is_cooled_down(provider_id: &str, model_id: &str) -> bool {
    let Ok(mut map) = cooldown_map().lock() else {
        return false;
    };
    let key = (provider_id.to_string(), model_id.to_string());
    match map.get(&key) {
        Some(until) if *until > Instant::now() => true,
        Some(_) => {
            map.remove(&key);
            false
        }
        None => false,
    }
}

/// Clear all cooldowns (tests only).
#[cfg(test)]
pub fn clear_cooldowns() {
    if let Ok(mut map) = cooldown_map().lock() {
        map.clear();
    }
}

/// Find the real model_id on a model for a request name, if any.
pub fn resolve_real_model_id(model: &Model, name: &str) -> Option<String> {
    if model.model_id == name {
        return Some(model.model_id.clone());
    }
    if model.aliases.iter().any(|a| a == name) {
        return Some(model.model_id.clone());
    }
    None
}

/// Collect enabled models matching `request_name` (real id or alias) across providers.
pub fn collect_candidates(
    providers: &[ProviderConfig],
    request_name: &str,
) -> Vec<RouteCandidate> {
    let mut out = Vec::new();
    for provider in providers.iter().filter(|p| p.enabled) {
        for model in provider.models.iter().filter(|m| m.enabled) {
            if !model_matches_request_name(model, request_name) {
                continue;
            }
            out.push(RouteCandidate {
                provider_id: provider.id.clone(),
                provider_name: provider.name.clone(),
                sort_order: provider.sort_order,
                real_model_id: model.model_id.clone(),
                request_name: request_name.to_string(),
            });
        }
    }
    order_candidates(&mut out);
    out
}

pub fn order_candidates(cands: &mut [RouteCandidate]) {
    cands.sort_by(|a, b| {
        a.sort_order
            .cmp(&b.sort_order)
            .then_with(|| a.provider_id.cmp(&b.provider_id))
            .then_with(|| a.real_model_id.cmp(&b.real_model_id))
    });
}

/// Order candidates, skipping cooled-down ones when alternatives remain.
/// If every candidate is cooled down, return them all so we still try.
pub fn candidates_for_attempt(cands: &[RouteCandidate]) -> Vec<RouteCandidate> {
    let healthy: Vec<RouteCandidate> = cands
        .iter()
        .filter(|c| !is_cooled_down(&c.provider_id, &c.real_model_id))
        .cloned()
        .collect();
    if healthy.is_empty() {
        cands.to_vec()
    } else {
        healthy
    }
}

/// Heuristic: whether an upstream/provider error is worth retrying on another source.
pub fn is_retriable_error_message(message: &str) -> bool {
    let lower = message.to_lowercase();
    const NEEDLES: &[&str] = &[
        "429",
        "408",
        "500",
        "502",
        "503",
        "504",
        "timeout",
        "timed out",
        "connection",
        "connect",
        "reset",
        "refused",
        "unavailable",
        "rate limit",
        "rate_limit",
        "overloaded",
        "temporarily",
        "bad gateway",
        "gateway timeout",
        "no active api key",
        "no active key",
    ];
    NEEDLES.iter().any(|n| lower.contains(n))
}

/// Distinct request names (model ids + aliases) exposed by enabled models.
/// Returns `(name, count_of_providers_exposing_it)`.
pub fn request_name_provider_counts(providers: &[ProviderConfig]) -> HashMap<String, usize> {
    let mut counts: HashMap<String, usize> = HashMap::new();
    for provider in providers.iter().filter(|p| p.enabled) {
        let mut names_on_provider = std::collections::HashSet::new();
        for model in provider.models.iter().filter(|m| m.enabled) {
            names_on_provider.insert(model.model_id.clone());
            for alias in &model.aliases {
                names_on_provider.insert(alias.clone());
            }
        }
        for name in names_on_provider {
            *counts.entry(name).or_default() += 1;
        }
    }
    counts
}

#[cfg(test)]
mod tests {
    use super::*;
    use aqbot_core::types::{Model, ModelType, ProviderConfig, ProviderType};

    fn provider(id: &str, sort: i32, models: Vec<(&str, &[&str])>) -> ProviderConfig {
        ProviderConfig {
            id: id.into(),
            name: id.into(),
            provider_type: ProviderType::OpenAI,
            api_host: "https://example.com".into(),
            api_path: None,
            aws_region: None,
            enabled: true,
            models: models
                .into_iter()
                .map(|(mid, aliases)| Model {
                    provider_id: id.into(),
                    model_id: mid.into(),
                    name: mid.into(),
                    group_name: None,
                    model_type: ModelType::Chat,
                    capabilities: vec![],
                    context_window: None,
                    max_output_tokens: None,
                    enabled: true,
                    param_overrides: None,
                    image_config: None,
                    metadata_state: None,
                    aliases: aliases.iter().map(|s| (*s).to_string()).collect(),
                    icon: None,
                })
                .collect(),
            keys: vec![],
            proxy_config: None,
            custom_headers: None,
            icon: None,
            builtin_id: None,
            sort_order: sort,
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn collect_matches_model_id_and_alias() {
        let providers = vec![
            provider("a", 0, vec![("gpt-5.5", &["5.5"])]),
            provider("b", 1, vec![("gpt-5.5-turbo", &["5.5"])]),
        ];
        let by_id = collect_candidates(&providers, "gpt-5.5");
        assert_eq!(by_id.len(), 1);
        assert_eq!(by_id[0].provider_id, "a");
        assert_eq!(by_id[0].real_model_id, "gpt-5.5");

        let by_alias = collect_candidates(&providers, "5.5");
        assert_eq!(by_alias.len(), 2);
        assert_eq!(by_alias[0].provider_id, "a");
        assert_eq!(by_alias[1].provider_id, "b");
        assert_eq!(by_alias[1].real_model_id, "gpt-5.5-turbo");
    }

    #[test]
    fn order_uses_sort_order() {
        let providers = vec![
            provider("b", 10, vec![("m", &[])]),
            provider("a", 0, vec![("m", &[])]),
        ];
        let c = collect_candidates(&providers, "m");
        assert_eq!(c[0].provider_id, "a");
        assert_eq!(c[1].provider_id, "b");
    }

    #[test]
    fn cooldown_skips_unhealthy_when_alternatives_exist() {
        clear_cooldowns();
        let providers = vec![
            provider("a", 0, vec![("m", &[])]),
            provider("b", 1, vec![("m", &[])]),
        ];
        let all = collect_candidates(&providers, "m");
        mark_failure_for("a", "m", Duration::from_secs(60));
        let attempt = candidates_for_attempt(&all);
        assert_eq!(attempt.len(), 1);
        assert_eq!(attempt[0].provider_id, "b");
        clear_cooldowns();
    }

    #[test]
    fn retriable_error_detection() {
        assert!(is_retriable_error_message("HTTP 429 rate limit"));
        assert!(is_retriable_error_message("connection refused"));
        assert!(is_retriable_error_message("request timed out"));
        assert!(!is_retriable_error_message("invalid_request: bad prompt"));
        assert!(!is_retriable_error_message("401 unauthorized"));
    }

    #[test]
    fn request_name_counts_include_aliases() {
        let providers = vec![
            provider("a", 0, vec![("gpt-5.5", &["5.5"])]),
            provider("b", 1, vec![("other", &["5.5"])]),
        ];
        let counts = request_name_provider_counts(&providers);
        assert_eq!(counts.get("5.5"), Some(&2));
        assert_eq!(counts.get("gpt-5.5"), Some(&1));
    }
}
