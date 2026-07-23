use aqbot_providers::image_adapters::{
    build_request_body, GenericImageMapping, ImageAdapterConfig, ImageAdapterRequest,
    ImageOperation,
};

fn request() -> ImageAdapterRequest {
    ImageAdapterRequest {
        operation: ImageOperation::Generate,
        model: "test-model".into(),
        prompt: "draw a cat".into(),
        n: 2,
        size: "1024x1024".into(),
        quality: "high".into(),
        output_format: "png".into(),
        background: None,
        output_compression: None,
        images: Vec::new(),
        mask: None,
        parameters: serde_json::Map::new(),
    }
}

#[test]
fn xai_payload_omits_undeclared_openai_parameters() {
    let body = build_request_body("xai_images", &request(), &ImageAdapterConfig::default())
        .expect("build xai body");

    assert_eq!(body["model"], "test-model");
    assert_eq!(body["prompt"], "draw a cat");
    assert!(body.get("quality").is_none());
    assert!(body.get("output_format").is_none());
    assert!(body.get("background").is_none());
}

#[test]
fn siliconflow_maps_image_size_and_batch_size() {
    let body = build_request_body(
        "siliconflow_images",
        &request(),
        &ImageAdapterConfig::default(),
    )
    .expect("build siliconflow body");

    assert_eq!(body["image_size"], "1024x1024");
    assert_eq!(body["batch_size"], 2);
}

#[test]
fn generic_json_uses_structured_field_mapping_and_extra_body() {
    let mut config = ImageAdapterConfig::default();
    config.mapping = GenericImageMapping {
        request_fields: [
            ("model".into(), "engine".into()),
            ("prompt".into(), "input.text".into()),
        ]
        .into_iter()
        .collect(),
        ..GenericImageMapping::default()
    };
    config
        .extra_body
        .insert("safe".into(), serde_json::json!(true));

    let body = build_request_body("generic_json", &request(), &config).expect("build generic body");

    assert_eq!(body["engine"], "test-model");
    assert_eq!(body["input"]["text"], "draw a cat");
    assert_eq!(body["safe"], true);
}

#[test]
fn generic_json_rejects_invalid_structured_field_paths() {
    let mut config = ImageAdapterConfig::default();
    config
        .mapping
        .request_fields
        .insert("prompt".into(), "input..text".into());

    let error = build_request_body("generic_json", &request(), &config)
        .expect_err("empty mapping path segments must be rejected");

    assert!(error
        .to_string()
        .contains("Invalid generic image field mapping"));
}

#[test]
fn generic_json_maps_mask_edits_without_executing_custom_code() {
    let mut mask_request = request();
    mask_request.operation = ImageOperation::MaskEdit;
    mask_request.mask = Some(aqbot_providers::openai_images::ImageUpload {
        bytes: vec![1, 2, 3],
        file_name: "mask.png".into(),
        mime_type: "image/png".into(),
    });

    let body = build_request_body(
        "generic_json",
        &mask_request,
        &ImageAdapterConfig::default(),
    )
    .expect("build generic mask body");
    assert_eq!(body["mask"], "data:image/png;base64,AQID");
}
