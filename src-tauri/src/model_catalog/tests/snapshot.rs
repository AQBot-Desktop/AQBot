use super::*;
use crate::model_catalog::snapshot::{build_snapshot, parse_snapshot};

const TEST_COMMIT: &str = "0123456789abcdef0123456789abcdef01234567";

#[test]
fn embedded_snapshot_has_valid_provenance_and_entries() {
    let bytes = include_bytes!("../litellm-builtin.json");
    let entries = parse_snapshot(bytes).expect("embedded snapshot should be valid");
    let root: serde_json::Value = serde_json::from_slice(bytes).unwrap();
    let provenance = &root["provenance"];

    assert!(entries.len() > 2_000);
    assert_eq!(provenance["project"], "LiteLLM");
    assert_eq!(
        provenance["repository"],
        "https://github.com/BerriAI/litellm"
    );
    assert_eq!(provenance["license"], "MIT");
    assert_eq!(provenance["source_commit"].as_str().unwrap().len(), 40);
}

#[test]
fn generated_snapshot_contains_only_normalized_input_context_metadata() {
    let bytes = build_snapshot(
        SAMPLE_CATALOG.as_bytes(),
        TEST_COMMIT,
        "2026-07-24T00:00:00Z",
    )
    .unwrap();
    let serialized = String::from_utf8(bytes.clone()).unwrap();
    let entries = parse_snapshot(&bytes).unwrap();

    assert_eq!(entries.len(), 4);
    assert!(!serialized.contains("max_output_tokens"));
    assert!(!serialized.contains("\"max_tokens\""));
    assert!(serialized.contains("max_input_tokens"));
}

#[test]
fn snapshot_rejects_invalid_commit_and_empty_entries() {
    assert!(build_snapshot(
        SAMPLE_CATALOG.as_bytes(),
        "moving-main",
        "2026-07-24T00:00:00Z"
    )
    .is_err());

    let empty = br#"{
      "schema_version": 1,
      "provenance": {
        "project": "LiteLLM",
        "repository": "https://github.com/BerriAI/litellm",
        "source_file": "model_prices_and_context_window.json",
        "source_commit": "0123456789abcdef0123456789abcdef01234567",
        "generated_at": "2026-07-24T00:00:00Z",
        "license": "MIT",
        "copyright": "Copyright (c) 2023 Berri AI"
      },
      "entries": {}
    }"#;
    assert!(parse_snapshot(empty).is_err());
}

#[test]
fn bundled_notice_contains_litellm_mit_attribution() {
    let notice = include_str!("../../../THIRD_PARTY_NOTICES.md");

    assert!(notice.contains("LiteLLM"));
    assert!(notice.contains("MIT License"));
    assert!(notice.contains("Copyright (c) 2023 Berri AI"));
}
