use std::path::Path;

use aqbot_core::error::Result;
use sea_orm::DatabaseConnection;
use tauri::Manager;

#[derive(Debug)]
struct MediaAsset {
    bytes: Vec<u8>,
    mime_type: String,
    etag: String,
}

pub fn register(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder.register_asynchronous_uri_scheme_protocol(
        "aqbot-media",
        |context, request, responder| {
            let app = context.app_handle().clone();
            tauri::async_runtime::spawn(async move {
                let db = app.state::<crate::AppState>().sea_db.clone();
                let root = aqbot_core::storage_paths::documents_root();
                responder.respond(build_media_response(&db, &root, &request).await);
            });
        },
    )
}

fn stored_file_id_from_uri(uri: &tauri::http::Uri) -> Option<String> {
    if uri.query().is_some() {
        return None;
    }
    let authority = uri.authority()?.as_str();
    let path = uri.path().trim_matches('/');
    let id = if authority.eq_ignore_ascii_case("stored") {
        path
    } else if authority.eq_ignore_ascii_case("aqbot-media.localhost")
        || authority.eq_ignore_ascii_case("localhost")
    {
        path.strip_prefix("stored/")?
    } else {
        return None;
    };
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return None;
    }
    Some(id.to_string())
}

async fn load_media_asset(
    db: &DatabaseConnection,
    documents_root: &Path,
    stored_file_id: &str,
) -> Result<MediaAsset> {
    let stored = aqbot_core::repo::stored_file::get_stored_file(db, stored_file_id).await?;
    if !matches!(
        stored.mime_type.as_str(),
        "image/png" | "image/jpeg" | "image/webp" | "image/gif"
    ) {
        return Err(aqbot_core::error::AQBotError::Validation(format!(
            "Stored file {} is not a supported image",
            stored.id
        )));
    }
    aqbot_core::storage_paths::validate_relative_path(&stored.storage_path)
        .map_err(aqbot_core::error::AQBotError::Validation)?;
    let relative = Path::new(&stored.storage_path);
    if relative
        .components()
        .any(|component| !matches!(component, std::path::Component::Normal(_)))
        || relative
            .components()
            .next()
            .and_then(|component| component.as_os_str().to_str())
            != Some("images")
    {
        return Err(aqbot_core::error::AQBotError::Validation(
            "Stored image path must be a relative path under images/".to_string(),
        ));
    }

    let canonical_images_root = documents_root.join("images").canonicalize()?;
    let canonical_path = documents_root.join(relative).canonicalize()?;
    if !canonical_path.starts_with(&canonical_images_root) || !canonical_path.is_file() {
        return Err(aqbot_core::error::AQBotError::Validation(
            "Stored image resolves outside the documents images directory".to_string(),
        ));
    }
    let bytes = std::fs::read(canonical_path)?;
    let actual_hash = aqbot_core::file_store::FileStore::hash_bytes(&bytes);
    if actual_hash != stored.hash {
        return Err(aqbot_core::error::AQBotError::Validation(format!(
            "Stored image hash mismatch for {}",
            stored.id
        )));
    }
    aqbot_core::inline_media::validate_image_bytes(&stored.mime_type, &bytes)?;
    Ok(MediaAsset {
        bytes,
        mime_type: stored.mime_type,
        etag: format!("\"{}\"", stored.hash),
    })
}

async fn build_media_response(
    db: &DatabaseConnection,
    documents_root: &Path,
    request: &tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    use tauri::http::{header, Method, StatusCode};

    if !matches!(*request.method(), Method::GET | Method::HEAD) {
        return response_builder(StatusCode::METHOD_NOT_ALLOWED)
            .header(header::ALLOW, "GET, HEAD")
            .body(b"method not allowed".to_vec())
            .expect("static media protocol response must be valid");
    }
    let Some(stored_file_id) = stored_file_id_from_uri(request.uri()) else {
        return error_response(StatusCode::BAD_REQUEST, "invalid media URL");
    };
    let asset = match load_media_asset(db, documents_root, &stored_file_id).await {
        Ok(asset) => asset,
        Err(aqbot_core::error::AQBotError::NotFound(_)) => {
            return error_response(StatusCode::NOT_FOUND, "media not found")
        }
        Err(aqbot_core::error::AQBotError::Validation(_)) => {
            return error_response(StatusCode::FORBIDDEN, "media rejected")
        }
        Err(error) => {
            tracing::error!(
                stored_file_id,
                error = %error,
                "Failed to serve stored media"
            );
            return error_response(StatusCode::INTERNAL_SERVER_ERROR, "media unavailable");
        }
    };
    if request
        .headers()
        .get(header::IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok())
        == Some(asset.etag.as_str())
    {
        return response_builder(StatusCode::NOT_MODIFIED)
            .header(header::ETAG, asset.etag)
            .body(Vec::new())
            .expect("static media protocol response must be valid");
    }

    let content_length = asset.bytes.len().to_string();
    let body = if request.method() == Method::HEAD {
        Vec::new()
    } else {
        asset.bytes
    };
    response_builder(StatusCode::OK)
        .header(header::CONTENT_TYPE, asset.mime_type)
        .header(header::CONTENT_LENGTH, content_length)
        .header(header::ETAG, asset.etag)
        .header(
            header::CACHE_CONTROL,
            "private, max-age=31536000, immutable",
        )
        .body(body)
        .expect("static media protocol response must be valid")
}

fn response_builder(status: tauri::http::StatusCode) -> tauri::http::response::Builder {
    use tauri::http::header;

    tauri::http::Response::builder()
        .status(status)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
}

fn error_response(
    status: tauri::http::StatusCode,
    message: &str,
) -> tauri::http::Response<Vec<u8>> {
    use tauri::http::header;

    response_builder(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .body(message.as_bytes().to_vec())
        .expect("static media protocol response must be valid")
}

#[cfg(test)]
mod tests {
    use super::*;
    use aqbot_core::file_store::FileStore;

    #[test]
    fn protocol_uri_accepts_only_stored_file_ids() {
        let native: tauri::http::Uri = "aqbot-media://stored/file-123".parse().unwrap();
        let windows: tauri::http::Uri = "http://aqbot-media.localhost/stored/file-123"
            .parse()
            .unwrap();
        let traversal: tauri::http::Uri = "aqbot-media://stored/../master.key".parse().unwrap();

        assert_eq!(
            stored_file_id_from_uri(&native).as_deref(),
            Some("file-123")
        );
        assert_eq!(
            stored_file_id_from_uri(&windows).as_deref(),
            Some("file-123")
        );
        assert_eq!(stored_file_id_from_uri(&traversal), None);
    }

    #[tokio::test]
    async fn media_asset_is_loaded_from_a_verified_documents_path() {
        let db = aqbot_core::db::create_test_pool().await.unwrap().conn;
        let root = tempfile::tempdir().unwrap();
        let store = FileStore::with_root(root.path().to_path_buf());
        let saved = store
            .save_file(b"\x89PNG\r\n\x1a\n", "preview.png", "image/png")
            .unwrap();
        aqbot_core::repo::stored_file::create_stored_file(
            &db,
            "file-123",
            &saved.hash,
            "preview.png",
            "image/png",
            saved.size_bytes,
            &saved.storage_path,
            None,
        )
        .await
        .unwrap();

        let asset = load_media_asset(&db, root.path(), "file-123")
            .await
            .unwrap();

        assert_eq!(asset.bytes, b"\x89PNG\r\n\x1a\n");
        assert_eq!(asset.mime_type, "image/png");
        assert_eq!(asset.etag, format!("\"{}\"", saved.hash));
    }

    #[tokio::test]
    async fn media_asset_rejects_paths_outside_documents_images() {
        let db = aqbot_core::db::create_test_pool().await.unwrap().conn;
        let root = tempfile::tempdir().unwrap();
        aqbot_core::repo::stored_file::create_stored_file(
            &db,
            "escape",
            "unused",
            "master.key",
            "image/png",
            8,
            "../master.key",
            None,
        )
        .await
        .unwrap();

        let error = load_media_asset(&db, root.path(), "escape")
            .await
            .unwrap_err();

        assert!(error
            .to_string()
            .contains("must not contain '..' traversal"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn media_asset_rejects_symlinks_that_leave_images_directory() {
        use std::os::unix::fs::symlink;

        let db = aqbot_core::db::create_test_pool().await.unwrap().conn;
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("images")).unwrap();
        let outside = root.path().join("outside.png");
        let bytes = b"\x89PNG\r\n\x1a\n";
        std::fs::write(&outside, bytes).unwrap();
        symlink(&outside, root.path().join("images/link.png")).unwrap();
        aqbot_core::repo::stored_file::create_stored_file(
            &db,
            "symlink",
            &FileStore::hash_bytes(bytes),
            "link.png",
            "image/png",
            bytes.len() as i64,
            "images/link.png",
            None,
        )
        .await
        .unwrap();

        let error = load_media_asset(&db, root.path(), "symlink")
            .await
            .unwrap_err();

        assert!(error.to_string().contains("outside the documents images"));
    }

    #[tokio::test]
    async fn protocol_response_supports_head_and_etag_revalidation() {
        use tauri::http::{header, Method, Request, StatusCode};

        let db = aqbot_core::db::create_test_pool().await.unwrap().conn;
        let root = tempfile::tempdir().unwrap();
        let store = FileStore::with_root(root.path().to_path_buf());
        let saved = store
            .save_file(b"\x89PNG\r\n\x1a\n", "preview.png", "image/png")
            .unwrap();
        aqbot_core::repo::stored_file::create_stored_file(
            &db,
            "cached",
            &saved.hash,
            "preview.png",
            "image/png",
            saved.size_bytes,
            &saved.storage_path,
            None,
        )
        .await
        .unwrap();
        let head = Request::builder()
            .method(Method::HEAD)
            .uri("aqbot-media://stored/cached")
            .body(Vec::new())
            .unwrap();

        let head_response = build_media_response(&db, root.path(), &head).await;

        assert_eq!(head_response.status(), StatusCode::OK);
        assert!(head_response.body().is_empty());
        assert_eq!(head_response.headers()[header::CONTENT_LENGTH], "8");
        let etag = head_response.headers()[header::ETAG].clone();
        let cached = Request::builder()
            .uri("aqbot-media://stored/cached")
            .header(header::IF_NONE_MATCH, etag)
            .body(Vec::new())
            .unwrap();
        assert_eq!(
            build_media_response(&db, root.path(), &cached)
                .await
                .status(),
            StatusCode::NOT_MODIFIED
        );
    }
}
