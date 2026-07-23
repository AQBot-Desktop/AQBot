use aqbot_providers::image_adapters::{
    parse_response_payload, GenericImageMapping, ImageAdapterConfig, ParsedImageSource,
    ParsedResponsePayload,
};

#[test]
fn parses_openai_glm_and_siliconflow_response_shapes() {
    let config = ImageAdapterConfig::default();
    let openai = parse_response_payload(
        "openai_images",
        &serde_json::json!({"id":"r1","data":[{"b64_json":"aGVsbG8="}]}),
        &config,
    )
    .expect("parse openai");
    assert!(matches!(
        openai,
        ParsedResponsePayload::Completed(ref value)
            if matches!(value.images[0].source, ParsedImageSource::Base64(ref data) if data == "aGVsbG8=")
    ));

    let glm = parse_response_payload(
        "glm_images",
        &serde_json::json!({"data":[{"url":"https://example.test/glm.png"}]}),
        &config,
    )
    .expect("parse glm");
    assert!(matches!(
        glm,
        ParsedResponsePayload::Completed(ref value)
            if matches!(value.images[0].source, ParsedImageSource::Url(ref url) if url.contains("glm.png"))
    ));

    let silicon = parse_response_payload(
        "siliconflow_images",
        &serde_json::json!({"images":[{"url":"https://example.test/sf.png"}]}),
        &config,
    )
    .expect("parse siliconflow");
    assert!(matches!(
        silicon,
        ParsedResponsePayload::Completed(ref value)
            if matches!(value.images[0].source, ParsedImageSource::Url(ref url) if url.contains("sf.png"))
    ));
}

#[test]
fn parses_gemini_inline_image_output() {
    let parsed = parse_response_payload(
        "gemini_images",
        &serde_json::json!({
            "candidates": [{
                "content": {
                    "parts": [{"inlineData":{"mimeType":"image/png","data":"aGVsbG8="}}]
                }
            }]
        }),
        &ImageAdapterConfig::default(),
    )
    .expect("parse gemini");

    assert!(matches!(
        parsed,
        ParsedResponsePayload::Completed(ref value) if value.images.len() == 1
    ));
}

#[test]
fn generic_json_supports_json_pointer_and_pending_status_mapping() {
    let mut config = ImageAdapterConfig::default();
    config.mapping = GenericImageMapping {
        images_path: Some("/result/images".into()),
        image_url_path: Some("/url".into()),
        task_id_path: Some("/task/id".into()),
        status_path: Some("/task/status".into()),
        success_statuses: vec!["done".into()],
        failure_statuses: vec!["failed".into()],
        pending_statuses: vec!["queued".into(), "running".into()],
        ..GenericImageMapping::default()
    };
    let pending = parse_response_payload(
        "generic_json",
        &serde_json::json!({"task":{"id":"job-1","status":"queued"}}),
        &config,
    )
    .expect("parse pending generic response");
    assert!(matches!(
        pending,
        ParsedResponsePayload::Pending(ref value) if value.remote_task_id == "job-1"
    ));

    let unknown = parse_response_payload(
        "generic_json",
        &serde_json::json!({"task":{"id":"job-2","status":"mystery"}}),
        &config,
    )
    .expect_err("unknown terminal-less status without task id should fail");
    assert!(unknown.to_string().contains("Unknown image task status"));
}
