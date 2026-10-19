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
    assert_eq!(body["n"], 2);
}

#[test]
fn unknown_openai_model_uses_gpt_image_fallback_request_body() {
    let body = build_request_body("openai_images", &request(), &ImageAdapterConfig::default())
        .expect("build OpenAI fallback body");

    // Unverified model ids under openai_images fall back to gpt-image-2 params.
    assert_eq!(body["model"], "test-model");
    assert_eq!(body["prompt"], "draw a cat");
    assert_eq!(body["n"], 2);
    assert_eq!(body["size"], "1024x1024");
    assert_eq!(body["quality"], "high");
    assert_eq!(body["output_format"], "png");
}

#[test]
fn siliconflow_maps_image_size_and_batch_size() {
    let mut kolors_request = request();
    kolors_request.model = "Kwai-Kolors/Kolors".into();
    let body = build_request_body(
        "siliconflow_images",
        &kolors_request,
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
            ("style".into(), "input.style".into()),
        ]
        .into_iter()
        .collect(),
        ..GenericImageMapping::default()
    };
    config
        .extra_body
        .insert("safe".into(), serde_json::json!(true));
    let mut mapped_request = request();
    mapped_request
        .parameters
        .insert("style".into(), "natural".into());

    let body =
        build_request_body("generic_json", &mapped_request, &config).expect("build generic body");

    assert_eq!(body["engine"], "test-model");
    assert_eq!(body["input"]["text"], "draw a cat");
    assert_eq!(body["input"]["style"], "natural");
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
fn generic_json_only_maps_explicit_mask_fields() {
    let mut mask_request = request();
    mask_request.operation = ImageOperation::MaskEdit;
    mask_request.mask = Some(aqbot_providers::openai_images::ImageUpload {
        bytes: vec![1, 2, 3],
        file_name: "mask.png".into(),
        mime_type: "image/png".into(),
    });

    let default_body = build_request_body(
        "generic_json",
        &mask_request,
        &ImageAdapterConfig::default(),
    )
    .expect("build generic mask body");
    assert!(default_body.get("mask").is_none());

    let mut config = ImageAdapterConfig::default();
    config
        .mapping
        .request_fields
        .insert("mask".into(), "mask".into());
    let body = build_request_body("generic_json", &mask_request, &config)
        .expect("build explicitly mapped generic mask body");
    assert_eq!(body["mask"], "data:image/png;base64,AQID");
}

#[test]
fn known_xai_payload_sends_official_generation_fields() {
    let mut xai_request = request();
    xai_request.model = "grok-imagine-image".into();
    xai_request
        .parameters
        .insert("aspect_ratio".into(), "16:9".into());
    xai_request
        .parameters
        .insert("resolution".into(), "2k".into());

    let body = build_request_body("xai_images", &xai_request, &ImageAdapterConfig::default())
        .expect("build known xai body");

    assert_eq!(body["n"], 2);
    assert_eq!(body["response_format"], "b64_json");
    assert_eq!(body["aspect_ratio"], "16:9");
    assert_eq!(body["resolution"], "2k");
    assert!(body.get("size").is_none());
    assert!(body.get("quality").is_none());
}

#[test]
fn grok_image_alias_uses_full_xai_generation_payload() {
    let mut xai_request = request();
    xai_request.model = "grok-image".into();
    xai_request
        .parameters
        .insert("aspect_ratio".into(), "1:1".into());
    xai_request
        .parameters
        .insert("resolution".into(), "1k".into());

    let body = build_request_body("xai_images", &xai_request, &ImageAdapterConfig::default())
        .expect("build grok-image body");

    assert_eq!(body["model"], "grok-image");
    assert_eq!(body["response_format"], "b64_json");
    assert_eq!(body["aspect_ratio"], "1:1");
    assert_eq!(body["resolution"], "1k");
    assert_eq!(body["n"], 2);
}

fn upload(name: &str) -> aqbot_providers::openai_images::ImageUpload {
    aqbot_providers::openai_images::ImageUpload {
        bytes: vec![1, 2, 3],
        file_name: name.into(),
        mime_type: "image/png".into(),
    }
}

#[test]
fn xai_edit_uses_single_and_multi_image_request_shapes() {
    let mut edit = request();
    edit.model = "grok-imagine-image".into();
    edit.operation = ImageOperation::Edit;
    edit.images = vec![upload("one.png")];

    let single = build_request_body("xai_images", &edit, &ImageAdapterConfig::default())
        .expect("build single-image xAI edit");
    assert_eq!(single["image"]["type"], "image_url");
    assert!(single["image"]["url"]
        .as_str()
        .is_some_and(|value| value.starts_with("data:image/png;base64,")));
    assert!(single.get("images").is_none());
    assert!(single.get("mask").is_none());

    edit.images = vec![upload("one.png"), upload("two.png"), upload("three.png")];
    let multiple = build_request_body("xai_images", &edit, &ImageAdapterConfig::default())
        .expect("build multi-image xAI edit");
    assert_eq!(multiple["images"].as_array().unwrap().len(), 3);
    assert!(multiple["images"]
        .as_array()
        .unwrap()
        .iter()
        .all(|image| image["type"] == "image_url"));
    assert!(multiple.get("image").is_none());
}

#[test]
fn gemini_interactions_generate_content_and_imagen_have_distinct_shapes() {
    let mut interactions = request();
    interactions.model = "gemini-3.1-flash-image".into();
    interactions.output_format = "jpeg".into();
    interactions
        .parameters
        .insert("aspect_ratio".into(), "16:9".into());
    interactions
        .parameters
        .insert("image_size".into(), "2K".into());
    let interactions_body = build_request_body(
        "gemini_images",
        &interactions,
        &ImageAdapterConfig::default(),
    )
    .expect("build Gemini Interactions body");
    assert_eq!(interactions_body["response_format"]["type"], "image");
    assert_eq!(
        interactions_body["response_format"]["mime_type"],
        "image/jpeg"
    );
    assert_eq!(interactions_body["response_format"]["aspect_ratio"], "16:9");
    assert_eq!(interactions_body["response_format"]["image_size"], "2K");
    assert!(interactions_body.get("generationConfig").is_none());

    let mut legacy = request();
    legacy.model = "gemini-2.5-flash-image".into();
    legacy
        .parameters
        .insert("aspect_ratio".into(), "4:3".into());
    let legacy_body = build_request_body("gemini_images", &legacy, &ImageAdapterConfig::default())
        .expect("build Gemini generateContent body");
    assert_eq!(
        legacy_body["generationConfig"]["responseFormat"]["image"]["aspectRatio"],
        "4:3"
    );
    assert!(legacy_body["generationConfig"]["responseFormat"]["image"]
        .get("imageSize")
        .is_none());
    assert!(legacy_body["generationConfig"].get("imageConfig").is_none());

    let mut imagen = request();
    imagen.model = "imagen-4.0-generate-001".into();
    imagen.n = 3;
    imagen
        .parameters
        .insert("aspect_ratio".into(), "3:4".into());
    imagen.parameters.insert("image_size".into(), "2K".into());
    let imagen_body = build_request_body("gemini_images", &imagen, &ImageAdapterConfig::default())
        .expect("build Imagen predict body");
    assert_eq!(imagen_body["instances"][0]["prompt"], "draw a cat");
    assert_eq!(imagen_body["parameters"]["sampleCount"], 3);
    assert_eq!(imagen_body["parameters"]["aspectRatio"], "3:4");
    assert_eq!(imagen_body["parameters"]["imageSize"], "2K");
}

#[test]
fn glm_and_siliconflow_do_not_send_fields_unsupported_by_the_model() {
    let mut glm = request();
    glm.model = "glm-image".into();
    glm.quality = "hd".into();
    let glm_body = build_request_body("glm_images", &glm, &ImageAdapterConfig::default())
        .expect("build GLM body");
    assert!(glm_body.get("n").is_none());

    let mut edit = request();
    edit.model = "Qwen/Qwen-Image-Edit-2509".into();
    edit.operation = ImageOperation::Edit;
    edit.images = vec![upload("one.png"), upload("two.png"), upload("three.png")];
    let edit_body = build_request_body("siliconflow_images", &edit, &ImageAdapterConfig::default())
        .expect("build Qwen edit body");
    assert!(edit_body.get("image_size").is_none());
    assert!(edit_body.get("batch_size").is_none());
    assert!(edit_body.get("guidance_scale").is_none());
    assert!(edit_body.get("image").is_some());
    assert!(edit_body.get("image2").is_some());
    assert!(edit_body.get("image3").is_some());
}
