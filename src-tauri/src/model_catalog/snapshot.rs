use super::cache::validate_entries;
use super::metadata::{parse_catalog, CatalogEntry};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

const SNAPSHOT_SCHEMA_VERSION: u32 = 1;
const SOURCE_PROJECT: &str = "LiteLLM";
const SOURCE_REPOSITORY: &str = "https://github.com/BerriAI/litellm";
const SOURCE_FILE: &str = "model_prices_and_context_window.json";
const SOURCE_LICENSE: &str = "MIT";
const SOURCE_COPYRIGHT: &str = "Copyright (c) 2023 Berri AI";
const BUILTIN_SNAPSHOT: &[u8] = include_bytes!("litellm-builtin.json");

#[derive(Debug, Serialize, Deserialize)]
struct CatalogSnapshot {
    schema_version: u32,
    provenance: SnapshotProvenance,
    entries: BTreeMap<String, CatalogEntry>,
}

#[derive(Debug, Serialize, Deserialize)]
struct SnapshotProvenance {
    project: String,
    repository: String,
    source_file: String,
    source_commit: String,
    generated_at: String,
    license: String,
    copyright: String,
}

pub(super) fn load_builtin_entries() -> Result<BTreeMap<String, CatalogEntry>, String> {
    parse_snapshot(BUILTIN_SNAPSHOT)
}

pub(super) fn parse_snapshot(bytes: &[u8]) -> Result<BTreeMap<String, CatalogEntry>, String> {
    let snapshot: CatalogSnapshot = serde_json::from_slice(bytes)
        .map_err(|error| format!("Invalid built-in LiteLLM snapshot JSON: {error}"))?;
    validate_snapshot(&snapshot)?;
    Ok(snapshot.entries)
}

pub(crate) fn build_snapshot(
    raw_catalog: &[u8],
    source_commit: &str,
    generated_at: &str,
) -> Result<Vec<u8>, String> {
    validate_commit(source_commit)?;
    let entries = parse_catalog(raw_catalog)?;
    validate_entries(&entries)?;
    let snapshot = CatalogSnapshot {
        schema_version: SNAPSHOT_SCHEMA_VERSION,
        provenance: SnapshotProvenance {
            project: SOURCE_PROJECT.to_string(),
            repository: SOURCE_REPOSITORY.to_string(),
            source_file: SOURCE_FILE.to_string(),
            source_commit: source_commit.to_ascii_lowercase(),
            generated_at: generated_at.to_string(),
            license: SOURCE_LICENSE.to_string(),
            copyright: SOURCE_COPYRIGHT.to_string(),
        },
        entries,
    };
    serde_json::to_vec(&snapshot)
        .map_err(|error| format!("Failed to serialize built-in LiteLLM snapshot: {error}"))
}

fn validate_snapshot(snapshot: &CatalogSnapshot) -> Result<(), String> {
    if snapshot.schema_version != SNAPSHOT_SCHEMA_VERSION {
        return Err(format!(
            "Unsupported built-in LiteLLM snapshot schema {}",
            snapshot.schema_version
        ));
    }
    let provenance = &snapshot.provenance;
    if provenance.project != SOURCE_PROJECT
        || provenance.repository != SOURCE_REPOSITORY
        || provenance.source_file != SOURCE_FILE
        || provenance.license != SOURCE_LICENSE
        || provenance.copyright != SOURCE_COPYRIGHT
        || provenance.generated_at.is_empty()
    {
        return Err("Invalid built-in LiteLLM snapshot provenance".to_string());
    }
    validate_commit(&provenance.source_commit)?;
    validate_entries(&snapshot.entries)
}

fn validate_commit(commit: &str) -> Result<(), String> {
    if commit.len() == 40 && commit.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err("LiteLLM source commit must be a full 40-character SHA".to_string())
    }
}
