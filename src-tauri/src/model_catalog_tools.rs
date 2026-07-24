//! Maintainer tooling for the built-in model metadata snapshot.
//! Source data: LiteLLM model_prices_and_context_window.json (MIT).

use chrono::SecondsFormat;
use reqwest::header::USER_AGENT;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

const MAX_CATALOG_BYTES: usize = 5 * 1024 * 1024;
const SOURCE_PATH: &str = "model_prices_and_context_window.json";

struct Options {
    commit: String,
    input: Option<PathBuf>,
    output: PathBuf,
}

pub async fn run(args: impl Iterator<Item = String>) -> Result<(), String> {
    let options = parse_options(args)?;
    validate_commit(&options.commit)?;
    let source_url = format!(
        "https://raw.githubusercontent.com/BerriAI/litellm/{}/{}",
        options.commit.to_ascii_lowercase(),
        SOURCE_PATH
    );
    let official = download(&source_url).await?;
    if let Some(input) = &options.input {
        let local = std::fs::read(input)
            .map_err(|error| format!("Failed to read input {}: {error}", input.display()))?;
        if local != official {
            return Err(format!(
                "Input {} does not match LiteLLM commit {}",
                input.display(),
                options.commit
            ));
        }
    }
    let generated_at = chrono::Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
    let snapshot = crate::model_catalog::build_snapshot(&official, &options.commit, &generated_at)?;
    write_atomic(&options.output, &snapshot)?;
    println!(
        "Generated {} from LiteLLM {} ({} bytes)",
        options.output.display(),
        options.commit,
        snapshot.len()
    );
    Ok(())
}

fn parse_options(mut args: impl Iterator<Item = String>) -> Result<Options, String> {
    let mut commit = None;
    let mut input = None;
    let mut output =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/model_catalog/litellm-builtin.json");
    while let Some(flag) = args.next() {
        let value = args
            .next()
            .ok_or_else(|| format!("Missing value for {flag}\n{}", usage()))?;
        match flag.as_str() {
            "--commit" => commit = Some(value),
            "--input" => input = Some(PathBuf::from(value)),
            "--output" => output = PathBuf::from(value),
            _ => return Err(format!("Unknown option: {flag}\n{}", usage())),
        }
    }
    Ok(Options {
        commit: commit.ok_or_else(|| usage().to_string())?,
        input,
        output,
    })
}

async fn download(url: &str) -> Result<Vec<u8>, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| format!("Failed to build HTTP client: {error}"))?;
    let mut response = client
        .get(url)
        .header(USER_AGENT, aqbot_providers::default_user_agent())
        .send()
        .await
        .map_err(|error| format!("Failed to download LiteLLM catalog: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "LiteLLM catalog returned HTTP {}",
            response.status()
        ));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("Failed to read LiteLLM catalog: {error}"))?
    {
        if bytes.len() + chunk.len() > MAX_CATALOG_BYTES {
            return Err("LiteLLM catalog exceeds the 5 MiB limit".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Output path has no parent: {}", path.display()))?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("Failed to create output directory: {error}"))?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("Failed to create staging file: {error}"))?;
    temp.write_all(bytes)
        .map_err(|error| format!("Failed to write staging file: {error}"))?;
    temp.as_file_mut()
        .sync_all()
        .map_err(|error| format!("Failed to sync staging file: {error}"))?;
    temp.persist(path)
        .map_err(|error| format!("Failed to replace snapshot: {error}"))?;
    Ok(())
}

fn validate_commit(commit: &str) -> Result<(), String> {
    if commit.len() == 40 && commit.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err("LiteLLM commit must be a full 40-character SHA".to_string())
    }
}

fn usage() -> &'static str {
    "Usage: cargo run --bin update-litellm-catalog -- --commit <40-char-sha> [--input <official-json>] [--output <snapshot-json>]"
}
