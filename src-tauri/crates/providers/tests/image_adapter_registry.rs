use aqbot_core::types::ProviderType;
use aqbot_providers::image_adapters::{ImageAdapterConfig, ImageAdapterRegistry, ImageOperation};

#[test]
fn infers_xai_profile_for_custom_grok_image_models() {
    let registry = ImageAdapterRegistry::new();
    let resolved = registry
        .resolve(&ProviderType::Custom, "grok-imagine-image", None)
        .expect("custom grok image model should resolve");

    assert_eq!(resolved.id(), "xai_images");
    assert!(resolved
        .descriptor("grok-imagine-image", &ImageAdapterConfig::default())
        .operations
        .contains(&ImageOperation::Generate));
}

#[test]
fn explicit_adapter_override_wins_over_provider_inference() {
    let registry = ImageAdapterRegistry::new();
    let config = ImageAdapterConfig {
        adapter_id: Some("generic_json".into()),
        ..ImageAdapterConfig::default()
    };
    let resolved = registry
        .resolve(&ProviderType::OpenAI, "gpt-image-2", Some(&config))
        .expect("explicit generic profile should resolve");

    assert_eq!(resolved.id(), "generic_json");
}

#[test]
fn descriptors_do_not_claim_unsupported_operations() {
    let registry = ImageAdapterRegistry::new();
    let config = ImageAdapterConfig::default();
    let glm = registry
        .resolve(&ProviderType::GLM, "cogview-4", None)
        .expect("glm adapter should resolve");
    let descriptor = glm.descriptor("cogview-4", &config);

    assert_eq!(descriptor.operations, vec![ImageOperation::Generate]);
}

#[test]
fn capability_overrides_can_narrow_but_not_expand_a_profile() {
    let registry = ImageAdapterRegistry::new();
    let glm = registry
        .resolve(&ProviderType::GLM, "cogview-4", None)
        .expect("glm adapter should resolve");
    let config = ImageAdapterConfig {
        operation_overrides: Some(vec![ImageOperation::Generate, ImageOperation::Edit]),
        ..Default::default()
    };

    assert_eq!(
        glm.descriptor("cogview-4", &config).operations,
        vec![ImageOperation::Generate]
    );
}
