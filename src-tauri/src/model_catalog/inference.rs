use super::metadata::{canonical_provider, find_catalog_entry, model_type_for_mode, CatalogEntry};
use super::types::{
    CatalogLoadResult, ModelMetadataChange, ModelSyncCandidate, ModelSyncStatus,
    RemoteModelSyncResult,
};
use aqbot_core::types::{
    default_capabilities_for_model_type, infer_chat_capabilities,
    infer_model_type_and_capabilities, Model, ModelCapability, ModelMetadataSource,
    ModelMetadataState, ModelParamOverrides, ModelType, ProviderConfig,
};
use std::collections::{BTreeMap, BTreeSet};

const UNSUPPORTED_MODE_REASON: &str = "LiteLLM catalog mode is not supported by AQBot";

pub fn infer_remote_models(
    provider: &ProviderConfig,
    remote_models: Vec<Model>,
    catalog: CatalogLoadResult,
) -> RemoteModelSyncResult {
    let catalog_provider = canonical_provider(
        &provider.provider_type,
        provider.builtin_id.as_deref(),
        &provider.api_host,
    );
    let mut status = catalog.status;
    let mut remote: BTreeMap<String, Model> = remote_models
        .into_iter()
        .map(|model| (model.model_id.clone(), model))
        .collect();
    let local: BTreeMap<String, Model> = provider
        .models
        .iter()
        .cloned()
        .map(|model| (model.model_id.clone(), model))
        .collect();
    let model_ids: BTreeSet<String> = remote.keys().chain(local.keys()).cloned().collect();
    let mut candidates = Vec::with_capacity(model_ids.len());

    for model_id in model_ids {
        match (remote.remove(&model_id), local.get(&model_id)) {
            (Some(remote_model), local_model) => {
                let mut candidate = infer_candidate(
                    remote_model,
                    local_model,
                    &catalog.entries,
                    catalog_provider,
                    false,
                );
                update_status(&mut status, &candidate);
                candidate.status = if candidate.unsupported_reason.is_some() {
                    ModelSyncStatus::Unsupported
                } else if local_model.is_some() {
                    ModelSyncStatus::Synced
                } else {
                    ModelSyncStatus::RemoteOnly
                };
                candidates.push(candidate);
            }
            (None, Some(local_model)) => candidates.push(ModelSyncCandidate {
                proposed_model: local_model.clone(),
                status: ModelSyncStatus::LocalOnly,
                catalog_mode: local_model
                    .metadata_state
                    .as_ref()
                    .and_then(|state| state.catalog_mode.clone()),
                inference_source: ModelMetadataSource::User,
                changes: Vec::new(),
                unsupported_reason: None,
            }),
            (None, None) => unreachable!("model id came from local or remote map"),
        }
    }
    status.total_chat_models = candidates
        .iter()
        .filter(|candidate| candidate.proposed_model.model_type == ModelType::Chat)
        .count();
    RemoteModelSyncResult {
        candidates,
        catalog: status,
    }
}

pub fn infer_single_model(
    provider: &ProviderConfig,
    model: Model,
    catalog: CatalogLoadResult,
    reset: bool,
) -> ModelSyncCandidate {
    let catalog_provider = canonical_provider(
        &provider.provider_type,
        provider.builtin_id.as_deref(),
        &provider.api_host,
    );
    infer_candidate(model, None, &catalog.entries, catalog_provider, reset)
}

pub(super) fn infer_candidate(
    remote_model: Model,
    local_model: Option<&Model>,
    entries: &BTreeMap<String, CatalogEntry>,
    catalog_provider: Option<&str>,
    reset: bool,
) -> ModelSyncCandidate {
    let matched = find_catalog_entry(entries, catalog_provider, &remote_model.model_id);
    let (mut proposed, inference_source) = automatic_model(remote_model, matched);
    let catalog_mode = matched.map(|(_, entry)| entry.mode.clone());
    let unsupported_reason = matched
        .filter(|(_, entry)| model_type_for_mode(&entry.mode).is_none())
        .map(|(_, entry)| format!("{UNSUPPORTED_MODE_REASON}: {}", entry.mode));

    if !reset {
        if let Some(local) = local_model {
            merge_manual_or_legacy(local, &mut proposed);
        }
    }
    let changes = local_model
        .map(|local| metadata_changes(local, &proposed))
        .unwrap_or_else(|| metadata_changes_for_new(&proposed));
    ModelSyncCandidate {
        proposed_model: proposed,
        status: ModelSyncStatus::RemoteOnly,
        catalog_mode,
        inference_source,
        changes,
        unsupported_reason,
    }
}

fn automatic_model(
    mut model: Model,
    matched: Option<(&str, &CatalogEntry)>,
) -> (Model, ModelMetadataSource) {
    let provider_state = model.metadata_state.clone();
    let (heuristic_type, heuristic_capabilities) =
        infer_model_type_and_capabilities(&model.model_id, &model.name);
    let provider_type = provider_state
        .as_ref()
        .is_some_and(|state| state.model_type == ModelMetadataSource::Provider);
    let provider_capabilities = provider_state
        .as_ref()
        .is_some_and(|state| state.capabilities == ModelMetadataSource::Provider);
    let type_source = if provider_type {
        ModelMetadataSource::Provider
    } else if heuristic_type == ModelType::Chat {
        ModelMetadataSource::Default
    } else {
        ModelMetadataSource::Heuristic
    };
    if !provider_type {
        model.model_type = heuristic_type;
    }
    if !provider_capabilities {
        model.capabilities = heuristic_capabilities;
    }
    let mut state = ModelMetadataState {
        model_type: type_source,
        capabilities: if provider_capabilities {
            ModelMetadataSource::Provider
        } else if model.capabilities != default_capabilities_for_model_type(&model.model_type) {
            ModelMetadataSource::Heuristic
        } else {
            ModelMetadataSource::Default
        },
        context_window: source_for_optional(model.context_window),
        max_output_tokens: source_for_optional(model.max_output_tokens),
        no_system_role: source_for_optional(
            model
                .param_overrides
                .as_ref()
                .and_then(|value| value.no_system_role),
        ),
        omit_sampling_params: source_for_optional(
            model
                .param_overrides
                .as_ref()
                .and_then(|value| value.omit_sampling_params),
        ),
        reasoning_options: source_for_optional(
            model
                .param_overrides
                .as_ref()
                .and_then(|value| value.reasoning_options.as_ref()),
        ),
        ..ModelMetadataState::default()
    };
    let Some((catalog_key, entry)) = matched else {
        model.metadata_state = Some(state);
        return (model, type_source);
    };

    state.catalog_key = Some(catalog_key.to_string());
    state.catalog_mode = Some(entry.mode.clone());
    if let Some(model_type) = model_type_for_mode(&entry.mode) {
        model.model_type = model_type;
        model.capabilities = catalog_capabilities(&model, entry, provider_capabilities);
        model.context_window = entry.max_input_tokens.or(model.context_window);
        model.max_output_tokens = entry.max_output_tokens.or(model.max_output_tokens);
        apply_catalog_parameters(&mut model, entry);
        state.model_type = ModelMetadataSource::Catalog;
        state.capabilities = if catalog_has_capability_metadata(entry) {
            ModelMetadataSource::Catalog
        } else if model.capabilities != default_capabilities_for_model_type(&model.model_type) {
            ModelMetadataSource::Heuristic
        } else {
            ModelMetadataSource::Default
        };
        if entry.max_input_tokens.is_some() {
            state.context_window = ModelMetadataSource::Catalog;
        }
        if entry.max_output_tokens.is_some() {
            state.max_output_tokens = ModelMetadataSource::Catalog;
        }
        if entry.supports_system_messages.is_some() {
            state.no_system_role = ModelMetadataSource::Catalog;
        }
        if entry.supports_sampling_params.is_some() {
            state.omit_sampling_params = ModelMetadataSource::Catalog;
        }
        if entry.reasoning_options.is_some() {
            state.reasoning_options = ModelMetadataSource::Catalog;
        }
    }
    model.metadata_state = Some(state);
    (model, ModelMetadataSource::Catalog)
}

fn source_for_optional<T>(value: Option<T>) -> ModelMetadataSource {
    if value.is_some() {
        ModelMetadataSource::Provider
    } else {
        ModelMetadataSource::Default
    }
}

fn catalog_capabilities(
    model: &Model,
    entry: &CatalogEntry,
    preserve_provider_capabilities: bool,
) -> Vec<ModelCapability> {
    let mut capabilities = if preserve_provider_capabilities {
        model.capabilities.clone()
    } else {
        match model.model_type {
            ModelType::Chat => infer_chat_capabilities(&model.model_id, &model.name),
            _ => default_capabilities_for_model_type(&model.model_type),
        }
    };
    if entry.mode == "realtime" {
        set_capability(&mut capabilities, ModelCapability::RealtimeVoice, true);
    }
    if model.model_type == ModelType::Chat {
        let vision = entry.supports_vision.or_else(|| {
            entry
                .supported_modalities
                .as_ref()
                .map(|modalities| modalities.iter().any(|modality| modality == "image"))
        });
        if let Some(value) = vision {
            set_capability(&mut capabilities, ModelCapability::Vision, value);
        }
        if let Some(value) = entry.supports_function_calling {
            set_capability(&mut capabilities, ModelCapability::FunctionCalling, value);
        }
        if let Some(value) = entry.supports_reasoning {
            set_capability(&mut capabilities, ModelCapability::Reasoning, value);
        }
    }
    capabilities
}

fn catalog_has_capability_metadata(entry: &CatalogEntry) -> bool {
    entry.mode == "realtime"
        || (matches!(entry.mode.as_str(), "chat" | "responses" | "completion")
            && (entry.supports_vision.is_some()
                || entry.supports_function_calling.is_some()
                || entry.supports_reasoning.is_some()
                || entry.supported_modalities.is_some()))
}

fn set_capability(
    capabilities: &mut Vec<ModelCapability>,
    capability: ModelCapability,
    enabled: bool,
) {
    capabilities.retain(|value| value != &capability);
    if enabled {
        capabilities.push(capability);
    }
}

fn apply_catalog_parameters(model: &mut Model, entry: &CatalogEntry) {
    if entry.supports_system_messages.is_none()
        && entry.supports_sampling_params.is_none()
        && entry.reasoning_options.is_none()
    {
        return;
    }
    let overrides = model
        .param_overrides
        .get_or_insert_with(ModelParamOverrides::default);
    if let Some(value) = entry.supports_system_messages {
        overrides.no_system_role = Some(!value);
    }
    if let Some(value) = entry.supports_sampling_params {
        overrides.omit_sampling_params = Some(!value);
    }
    if let Some(options) = &entry.reasoning_options {
        overrides.reasoning_options = Some(options.clone());
    }
}

fn merge_manual_or_legacy(local: &Model, proposed: &mut Model) {
    proposed.name = local.name.clone();
    proposed.group_name = local.group_name.clone();
    proposed.enabled = local.enabled;
    proposed.image_config = local.image_config.clone();
    let Some(local_state) = &local.metadata_state else {
        let auto_output = proposed.max_output_tokens;
        *proposed = local.clone();
        if proposed.max_output_tokens.is_none() {
            proposed.max_output_tokens = auto_output;
        }
        proposed.metadata_state = Some(legacy_protection_state(proposed));
        return;
    };
    let Some(mut proposed_state) = proposed.metadata_state.take() else {
        return;
    };
    if local_state.model_type == ModelMetadataSource::User {
        proposed.model_type = local.model_type.clone();
        proposed_state.model_type = ModelMetadataSource::User;
    }
    if local_state.capabilities == ModelMetadataSource::User {
        proposed.capabilities = local.capabilities.clone();
        proposed_state.capabilities = ModelMetadataSource::User;
    }
    if local_state.context_window == ModelMetadataSource::User {
        proposed.context_window = local.context_window;
        proposed_state.context_window = ModelMetadataSource::User;
    }
    if local_state.max_output_tokens == ModelMetadataSource::User {
        proposed.max_output_tokens = local.max_output_tokens;
        proposed_state.max_output_tokens = ModelMetadataSource::User;
    }
    merge_user_parameters(local, local_state, proposed, &mut proposed_state);
    proposed.metadata_state = Some(proposed_state);
}

fn legacy_protection_state(model: &Model) -> ModelMetadataState {
    ModelMetadataState {
        model_type: ModelMetadataSource::User,
        capabilities: ModelMetadataSource::User,
        context_window: ModelMetadataSource::User,
        max_output_tokens: source_for_optional(model.max_output_tokens),
        no_system_role: ModelMetadataSource::User,
        omit_sampling_params: ModelMetadataSource::User,
        reasoning_options: ModelMetadataSource::User,
        ..ModelMetadataState::default()
    }
}

fn merge_user_parameters(
    local: &Model,
    local_state: &ModelMetadataState,
    proposed: &mut Model,
    proposed_state: &mut ModelMetadataState,
) {
    let local_overrides = local.param_overrides.as_ref();
    let proposed_overrides = proposed
        .param_overrides
        .get_or_insert_with(ModelParamOverrides::default);
    if local_state.no_system_role == ModelMetadataSource::User {
        proposed_overrides.no_system_role = local_overrides.and_then(|value| value.no_system_role);
        proposed_state.no_system_role = ModelMetadataSource::User;
    }
    if local_state.omit_sampling_params == ModelMetadataSource::User {
        proposed_overrides.omit_sampling_params =
            local_overrides.and_then(|value| value.omit_sampling_params);
        proposed_state.omit_sampling_params = ModelMetadataSource::User;
    }
    if local_state.reasoning_options == ModelMetadataSource::User {
        proposed_overrides.reasoning_options =
            local_overrides.and_then(|value| value.reasoning_options.clone());
        proposed_state.reasoning_options = ModelMetadataSource::User;
    }
    copy_non_metadata_overrides(local_overrides, proposed_overrides);
}

fn copy_non_metadata_overrides(
    local: Option<&ModelParamOverrides>,
    proposed: &mut ModelParamOverrides,
) {
    let Some(local) = local else {
        return;
    };
    proposed.temperature = local.temperature;
    proposed.max_tokens = local.max_tokens;
    proposed.top_p = local.top_p;
    proposed.frequency_penalty = local.frequency_penalty;
    proposed.use_max_completion_tokens = local.use_max_completion_tokens;
    proposed.force_max_tokens = local.force_max_tokens;
    proposed.thinking_param_style = local.thinking_param_style.clone();
    proposed.reasoning_profile = local.reasoning_profile.clone();
    proposed.reasoning_default = local.reasoning_default.clone();
    proposed.extra_body = local.extra_body.clone();
}

fn metadata_changes(local: &Model, proposed: &Model) -> Vec<ModelMetadataChange> {
    let fields = [
        (
            "model_type",
            serde_json::to_value(&local.model_type),
            serde_json::to_value(&proposed.model_type),
        ),
        (
            "capabilities",
            serde_json::to_value(&local.capabilities),
            serde_json::to_value(&proposed.capabilities),
        ),
        (
            "context_window",
            serde_json::to_value(local.context_window),
            serde_json::to_value(proposed.context_window),
        ),
        (
            "max_output_tokens",
            serde_json::to_value(local.max_output_tokens),
            serde_json::to_value(proposed.max_output_tokens),
        ),
    ];
    fields
        .into_iter()
        .filter_map(|(field, previous, proposed_value)| {
            let previous = previous.ok()?;
            let proposed_value = proposed_value.ok()?;
            (previous != proposed_value).then(|| ModelMetadataChange {
                field: field.to_string(),
                previous,
                proposed: proposed_value,
                source: proposed
                    .metadata_state
                    .as_ref()
                    .map(|state| source_for_field(state, field))
                    .unwrap_or(ModelMetadataSource::Default),
            })
        })
        .collect()
}

fn metadata_changes_for_new(model: &Model) -> Vec<ModelMetadataChange> {
    metadata_changes(
        &Model {
            context_window: None,
            max_output_tokens: None,
            capabilities: Vec::new(),
            model_type: ModelType::Chat,
            metadata_state: None,
            ..model.clone()
        },
        model,
    )
}

fn source_for_field(state: &ModelMetadataState, field: &str) -> ModelMetadataSource {
    match field {
        "model_type" => state.model_type,
        "capabilities" => state.capabilities,
        "context_window" => state.context_window,
        "max_output_tokens" => state.max_output_tokens,
        _ => ModelMetadataSource::Default,
    }
}

fn update_status(status: &mut super::types::CatalogStatus, candidate: &ModelSyncCandidate) {
    if candidate.catalog_mode.is_some() {
        status.matched_models += 1;
    }
    status.autofilled_fields += candidate.changes.len();
    status.matched_context_windows += candidate
        .changes
        .iter()
        .filter(|change| change.field == "context_window")
        .count();
    status.inferred_types += candidate
        .changes
        .iter()
        .filter(|change| change.field == "model_type")
        .count();
    if candidate.unsupported_reason.is_some() {
        status.unsupported_models += 1;
    }
}
