use crate::AppState;
use aqbot_core::repo::stored_file::StoredFile;
use serde::Serialize;
use std::net::IpAddr;
use std::time::Duration;
use tauri::State;

const MAX_REMOTE_IMAGE_BYTES: u64 = 25 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteImageResponse {
    pub data: String,
    pub mime_type: String,
}

fn validate_remote_image_url(url: &str) -> Result<reqwest::Url, String> {
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("Invalid image URL: {e}"))?;
    match parsed.scheme() {
        "http" | "https" => {}
        scheme => return Err(format!("Unsupported image URL scheme: {scheme}")),
    }

    let host = parsed
        .host_str()
        .ok_or_else(|| "Image URL must include a host".to_string())?;
    if host.eq_ignore_ascii_case("localhost") {
        return Err("Localhost image URLs are not supported".to_string());
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        match ip {
            IpAddr::V4(ip) if ip.is_loopback() || ip.is_private() || ip.is_link_local() => {
                return Err("Private network image URLs are not supported".to_string());
            }
            IpAddr::V6(ip) if ip.is_loopback() || ip.is_unique_local() || ip.is_unspecified() => {
                return Err("Private network image URLs are not supported".to_string());
            }
            _ => {}
        }
    }

    Ok(parsed)
}

fn normalize_image_mime(raw: Option<&reqwest::header::HeaderValue>) -> Result<String, String> {
    let raw = raw
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| "Remote image response is missing Content-Type".to_string())?;
    let mime = raw
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if !mime.starts_with("image/") {
        return Err(format!("Remote URL did not return an image: {mime}"));
    }
    Ok(mime)
}

#[tauri::command]
pub async fn upload_file(
    state: State<'_, AppState>,
    data: String,
    file_name: String,
    mime_type: String,
    conversation_id: Option<String>,
) -> Result<StoredFile, String> {
    upload_file_using(
        &state.sea_db,
        &data,
        &file_name,
        &mime_type,
        conversation_id.as_deref(),
    )
    .await
}

async fn upload_file_using(
    db: &sea_orm::DatabaseConnection,
    data: &str,
    file_name: &str,
    mime_type: &str,
    conversation_id: Option<&str>,
) -> Result<StoredFile, String> {
    use base64::Engine;
    if aqbot_core::inline_media::contains_inline_image_data(file_name)
        || aqbot_core::inline_media::contains_inline_image_data(mime_type)
    {
        return Err("File metadata contains inline image data".to_string());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| format!("Invalid base64: {}", e))?;

    aqbot_core::storage_paths::ensure_documents_dirs()
        .map_err(|e| format!("Failed to ensure documents dirs: {}", e))?;
    let file_store = aqbot_core::file_store::FileStore::new();
    let _file_reference_guard = aqbot_core::repo::stored_file::lock_file_references().await;

    let saved = file_store
        .save_file(&bytes, file_name, mime_type)
        .map_err(|e| e.to_string())?;

    let id = aqbot_core::utils::gen_id();
    let stored = aqbot_core::repo::stored_file::create_stored_file(
        db,
        &id,
        &saved.hash,
        file_name,
        mime_type,
        saved.size_bytes,
        &saved.storage_path,
        conversation_id,
    )
    .await;

    let stored = match stored {
        Ok(stored) => stored,
        Err(error) => {
            let cleanup_error = if saved.created {
                match aqbot_core::repo::stored_file::count_stored_files_with_storage_path(
                    db,
                    &saved.storage_path,
                )
                .await
                {
                    Ok(0) => file_store.delete_file(&saved.storage_path).err(),
                    Ok(_) => None,
                    Err(cleanup_error) => Some(cleanup_error),
                }
            } else {
                None
            };
            return Err(format!(
                "Failed to register stored file: {error}; cleanup error: {}",
                cleanup_error
                    .map(|cleanup_error| cleanup_error.to_string())
                    .unwrap_or_else(|| "none".to_string())
            ));
        }
    };

    Ok(stored)
}

#[tauri::command]
pub async fn download_file(state: State<'_, AppState>, file_id: String) -> Result<String, String> {
    use base64::Engine;
    let file = aqbot_core::repo::stored_file::get_stored_file(&state.sea_db, &file_id)
        .await
        .map_err(|e| e.to_string())?;

    let file_store = aqbot_core::file_store::FileStore::new();

    let data = file_store
        .read_file(&file.storage_path)
        .map_err(|e| e.to_string())?;

    Ok(base64::engine::general_purpose::STANDARD.encode(&data))
}

#[tauri::command]
pub async fn fetch_remote_image(url: String) -> Result<RemoteImageResponse, String> {
    use base64::Engine;
    use reqwest::header::{CONTENT_TYPE, USER_AGENT};

    let parsed = validate_remote_image_url(&url)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| format!("Failed to create image download client: {e}"))?;

    let response = client
        .get(parsed)
        .header(USER_AGENT, "AQBot/remote-image-fetch")
        .send()
        .await
        .map_err(|e| format!("Failed to download image: {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Failed to download image: HTTP {}",
            response.status()
        ));
    }

    if let Some(len) = response.content_length() {
        if len > MAX_REMOTE_IMAGE_BYTES {
            return Err(format!("Remote image is too large: {len} bytes"));
        }
    }

    let mime_type = normalize_image_mime(response.headers().get(CONTENT_TYPE))?;
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read remote image: {e}"))?;
    if bytes.len() as u64 > MAX_REMOTE_IMAGE_BYTES {
        return Err(format!("Remote image is too large: {} bytes", bytes.len()));
    }

    Ok(RemoteImageResponse {
        data: base64::engine::general_purpose::STANDARD.encode(&bytes),
        mime_type,
    })
}

#[tauri::command]
pub async fn list_files(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<Vec<StoredFile>, String> {
    aqbot_core::repo::stored_file::list_stored_files_by_conversation(
        &state.sea_db,
        &conversation_id,
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_file(state: State<'_, AppState>, file_id: String) -> Result<(), String> {
    let file_store = aqbot_core::file_store::FileStore::new();
    super::file_cleanup::delete_attachment_reference(&state.sea_db, &file_store, &file_id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    #[test]
    fn validate_remote_image_url_accepts_http_and_https() {
        assert!(validate_remote_image_url("https://example.com/image.png").is_ok());
        assert!(validate_remote_image_url("http://example.com/image.png").is_ok());
    }

    #[test]
    fn validate_remote_image_url_rejects_local_or_non_http_sources() {
        assert!(validate_remote_image_url("data:image/png;base64,aGVsbG8=").is_err());
        assert!(validate_remote_image_url("file:///tmp/image.png").is_err());
        assert!(validate_remote_image_url("http://localhost/image.png").is_err());
        assert!(validate_remote_image_url("http://127.0.0.1/image.png").is_err());
        assert!(validate_remote_image_url("http://192.168.1.1/image.png").is_err());
    }

    #[test]
    fn normalize_image_mime_requires_image_content_type() {
        let png = reqwest::header::HeaderValue::from_static("image/png; charset=utf-8");
        assert_eq!(normalize_image_mime(Some(&png)).unwrap(), "image/png");

        let json = reqwest::header::HeaderValue::from_static("application/json");
        assert!(normalize_image_mime(Some(&json)).is_err());
        assert!(normalize_image_mime(None).is_err());
    }

    #[tokio::test]
    async fn upload_removes_new_physical_file_when_database_registration_fails() {
        let db = aqbot_core::db::create_test_pool().await.unwrap().conn;
        let bytes = format!("orphan-test-{}", aqbot_core::utils::gen_id()).into_bytes();
        let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
        let file_name = format!("orphan-{}.png", aqbot_core::utils::gen_id());
        let mime_type = "image/png";
        let expected_path = aqbot_core::storage_paths::build_relative_path(
            &file_name,
            mime_type,
            &aqbot_core::file_store::FileStore::hash_bytes(&bytes),
        );

        let result = upload_file_using(
            &db,
            &encoded,
            &file_name,
            mime_type,
            Some("missing-conversation"),
        )
        .await;

        assert!(result.is_err());
        assert!(!aqbot_core::file_store::FileStore::new()
            .resolve_path(&expected_path)
            .exists());
        assert!(aqbot_core::repo::stored_file::list_all_stored_files(&db)
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn upload_rejects_inline_data_in_metadata_before_writing() {
        let db = aqbot_core::db::create_test_pool().await.unwrap().conn;
        let encoded = base64::engine::general_purpose::STANDARD.encode(b"metadata-test");

        let error = upload_file_using(
            &db,
            &encoded,
            "data:image/png;base64,SECRET",
            "image/png",
            None,
        )
        .await
        .unwrap_err();

        assert!(error.contains("metadata"));
        assert!(!error.contains("SECRET"));
        assert!(aqbot_core::repo::stored_file::list_all_stored_files(&db)
            .await
            .unwrap()
            .is_empty());
    }
}
