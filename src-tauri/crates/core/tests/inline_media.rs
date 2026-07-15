use aqbot_core::file_store::FileStore;
use aqbot_core::inline_media::{
    contains_inline_image_data, extract_inline_images, filter_complete_inline_data,
    list_inline_media_diagnostics, materialize_inline_media_messages,
    materialize_message_inline_images, materialize_prepared_message_inline_images,
    materialize_streamed_inline_images, pending_inline_media_message_ids,
    prepare_message_inline_images, InlineDataStreamCapture, InlineDataStreamFilter,
};
use aqbot_core::repo::{conversation, message, stored_file};
use aqbot_core::types::MessageRole;
use base64::Engine;

const PNG_DATA: &str = "iVBORw0KGgo=";

#[test]
fn stream_filter_replaces_cross_chunk_markdown_data_uri_before_ipc() {
    let mut filter = InlineDataStreamFilter::default();
    let chunks = [
        "before ![img](da",
        "ta:ima",
        "ge/png;base64,iVBOR",
        "w0KGgo=) after",
    ];
    let mut emitted = Vec::new();
    for chunk in chunks {
        emitted.push(filter.push(chunk));
    }
    emitted.push(filter.finish());

    assert!(emitted.iter().all(|chunk| !chunk.contains("data:image")));
    assert!(emitted.iter().all(|chunk| !chunk.contains("iVBOR")));
    assert_eq!(emitted.concat(), "before ![img]([图片接收中]) after");
}

#[test]
fn stream_filter_replaces_cross_chunk_html_data_uri_case_insensitively() {
    let mut filter = InlineDataStreamFilter::default();
    let mut emitted = String::new();
    for chunk in [
        "<img alt='x' src=\"DATA:IM",
        "AGE/PNG;BASE64,iVBO",
        "Rw0K\">tail",
    ] {
        emitted.push_str(&filter.push(chunk));
    }
    emitted.push_str(&filter.finish());

    assert_eq!(emitted, "<img alt='x' src=\"[图片接收中]\">tail");
    assert!(!emitted.contains("iVBO"));
}

#[test]
fn complete_filter_never_returns_inline_image_data() {
    let filtered = filter_complete_inline_data(
        r#"{"image":"before data:image/png;base64,iVBORw0KGgo=","ok":true}"#,
    );

    assert!(!filtered.to_ascii_lowercase().contains("data:image/"));
    assert!(!filtered.contains("iVBORw0KGgo="));
    assert!(filtered.contains("[图片接收中]"));
    assert!(filtered.contains(r#"","ok":true}"#));
    assert!(contains_inline_image_data("DATA:IMAGE/PNG;base64,secret"));
    assert!(!contains_inline_image_data("ordinary message"));
}

#[test]
fn stream_capture_stages_multiple_cross_chunk_images_without_retaining_base64() {
    let temp = tempfile::tempdir().unwrap();
    let mut capture = InlineDataStreamCapture::new(temp.path().to_path_buf());
    let mut content = String::new();
    let mut events = String::new();
    for chunk in [
        "before ![one](da",
        "ta:image/png;base64,iVBO",
        "Rw0KGgo=) middle <img src='DATA:IMAGE/GIF;BASE64,R0lG",
        "ODlh'> after",
    ] {
        let delta = capture.push(chunk).unwrap();
        content.push_str(&delta.content);
        events.push_str(&delta.event_content);
    }
    let tail = capture.finish().unwrap();
    content.push_str(&tail.content);
    events.push_str(&tail.event_content);
    let images = capture.take_images();

    assert_eq!(images.len(), 2);
    assert!(!content.to_ascii_lowercase().contains("data:image/"));
    assert!(!content.contains("iVBOR"));
    assert!(!events.contains("R0lG"));
    assert_eq!(events.matches("[图片接收中]").count(), 2);
    assert_eq!(
        std::fs::read(images[0].decoded_path()).unwrap(),
        b"\x89PNG\r\n\x1a\n"
    );
    assert_eq!(std::fs::read(images[1].decoded_path()).unwrap(), b"GIF89a");
    let paths = images
        .iter()
        .map(|image| image.decoded_path().to_path_buf())
        .collect::<Vec<_>>();
    drop(images);
    assert!(paths.iter().all(|path| !path.exists()));
}

#[test]
fn dropping_stream_capture_removes_unfinished_staging_file() {
    let temp = tempfile::tempdir().unwrap();
    let mut capture = InlineDataStreamCapture::new(temp.path().to_path_buf());
    capture.push("data:image/png;base64,iVBORw0KGgo=").unwrap();
    assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 1);

    drop(capture);

    assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 0);
}

#[test]
fn stream_capture_decodes_into_migrating_file_before_the_image_finishes() {
    let temp = tempfile::tempdir().unwrap();
    let mut capture = InlineDataStreamCapture::new(temp.path().to_path_buf());

    capture
        .push("![image](data:image/png;base64,iVBORw0K")
        .unwrap();

    let staging_path = std::fs::read_dir(temp.path())
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    assert!(staging_path.to_string_lossy().ends_with(".migrating"));
    assert_eq!(std::fs::read(&staging_path).unwrap(), b"\x89PNG\r\n");

    capture.push("Ggo=)").unwrap();
    capture.finish().unwrap();
    let images = capture.take_images();
    assert_eq!(
        std::fs::read(images[0].decoded_path()).unwrap(),
        b"\x89PNG\r\n\x1a\n"
    );
}

#[test]
fn stream_capture_error_removes_current_and_completed_staging_files() {
    let temp = tempfile::tempdir().unwrap();
    let mut capture = InlineDataStreamCapture::new(temp.path().to_path_buf());
    capture
        .push("![ok](data:image/png;base64,iVBORw0KGgo=) ")
        .unwrap();
    assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 1);

    let error = capture
        .push("![bad](data:image/svg+xml;base64,PHN2Zz4=)")
        .unwrap_err();

    assert!(error.to_string().contains("Unsupported inline image"));
    assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 0);
}

#[test]
fn streaming_capture_redacts_code_examples_without_extracting_images() {
    let temp = tempfile::tempdir().unwrap();
    let mut capture = InlineDataStreamCapture::new(temp.path().to_path_buf());
    let first = capture
        .push("`![example](data:image/png;base64,iVBORw0K")
        .unwrap();
    let second = capture.push("Ggo=)`").unwrap();
    let finished = capture.finish().unwrap();
    let content = format!("{}{}{}", first.content, second.content, finished.content);
    let event = format!(
        "{}{}{}",
        first.event_content, second.event_content, finished.event_content
    );

    assert!(capture.take_images().is_empty());
    assert!(!content.to_ascii_lowercase().contains("data:image/"));
    assert!(!event.to_ascii_lowercase().contains("data:image/"));
    assert!(content.contains("[图片数据已省略]"));
    assert!(content.starts_with('`') && content.ends_with('`'));
}

#[tokio::test]
async fn streamed_capture_commits_short_reference_and_attachment_transactionally() {
    let db = aqbot_core::db::create_test_pool().await.unwrap().conn;
    let root = tempfile::tempdir().unwrap();
    let capture_dir = tempfile::tempdir().unwrap();
    let store = FileStore::with_root(root.path().to_path_buf());
    let conversation =
        conversation::create_conversation(&db, "Streamed image", "model-1", "provider-1", None)
            .await
            .unwrap();
    let message = message::create_message(
        &db,
        &conversation.id,
        MessageRole::Assistant,
        "",
        &[],
        None,
        0,
    )
    .await
    .unwrap();
    let mut capture = InlineDataStreamCapture::new(capture_dir.path().to_path_buf());
    let first = capture.push("![image](data:image/png;base64,iVBO").unwrap();
    let second = capture.push("Rw0KGgo=)").unwrap();
    let tail = capture.finish().unwrap();
    let content = format!("{}{}{}", first.content, second.content, tail.content);
    let images = capture.take_images();

    let stored = materialize_streamed_inline_images(&db, &store, &message.id, &content, &images)
        .await
        .unwrap();

    assert!(!stored.content.contains("aqbot-inline://pending/"));
    assert!(!stored.content.contains("data:image/"));
    assert!(stored.content.contains("aqbot-media://stored/"));
    assert_eq!(stored.attachments.len(), 1);
    assert!(root.path().join(&stored.attachments[0].file_path).exists());
    let serialized = serde_json::to_string(&stored).unwrap();
    assert!(!serialized.contains("iVBORw0KGgo="));
}

#[tokio::test]
async fn streamed_capture_handles_real_2_15_mib_fixture_in_bounded_text_chunks() {
    let db = aqbot_core::db::create_test_pool().await.unwrap().conn;
    let root = tempfile::tempdir().unwrap();
    let capture_dir = tempfile::tempdir().unwrap();
    let store = FileStore::with_root(root.path().to_path_buf());
    let conversation = conversation::create_conversation(
        &db,
        "Large streamed image",
        "model-1",
        "provider-1",
        None,
    )
    .await
    .unwrap();
    let message = message::create_message(
        &db,
        &conversation.id,
        MessageRole::Assistant,
        "",
        &[],
        None,
        0,
    )
    .await
    .unwrap();
    let mut bytes = vec![0_u8; 2_254_438];
    bytes[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
    let mut capture = InlineDataStreamCapture::new(capture_dir.path().to_path_buf());
    let mut content = capture
        .push("![large](data:image/png;base64,")
        .unwrap()
        .content;
    for chunk in encoded.as_bytes().chunks(4093) {
        let chunk = std::str::from_utf8(chunk).unwrap();
        let delta = capture.push(chunk).unwrap();
        assert!(delta.content.len() <= 64);
        assert!(!delta.event_content.contains("data:image/"));
        content.push_str(&delta.content);
    }
    content.push_str(&capture.push(")").unwrap().content);
    content.push_str(&capture.finish().unwrap().content);
    let images = capture.take_images();

    assert_eq!(images.len(), 1);
    assert_eq!(
        std::fs::metadata(images[0].decoded_path()).unwrap().len(),
        bytes.len() as u64
    );
    assert!(content.len() < 256);
    let stored = materialize_streamed_inline_images(&db, &store, &message.id, &content, &images)
        .await
        .unwrap();
    assert_eq!(
        std::fs::metadata(root.path().join(&stored.attachments[0].file_path))
            .unwrap()
            .len(),
        bytes.len() as u64
    );
    assert!(!serde_json::to_string(&stored)
        .unwrap()
        .contains("data:image/"));
}

#[test]
fn markdown_data_image_is_extracted_and_rewritten() {
    let content = format!("before ![preview](data:image/png;base64,{PNG_DATA}) after");

    let document = extract_inline_images(&content).expect("valid PNG data URI must be accepted");

    assert_eq!(document.images().len(), 1);
    assert_eq!(document.images()[0].mime_type, "image/png");
    assert_eq!(document.images()[0].bytes, b"\x89PNG\r\n\x1a\n");
    assert_eq!(
        document
            .rewrite(&["aqbot-media://stored/file-1".to_string()])
            .unwrap(),
        "before ![preview](aqbot-media://stored/file-1) after"
    );
}

#[tokio::test]
async fn prepared_inline_media_uses_safe_placeholder_before_first_database_write() {
    let db = aqbot_core::db::create_test_pool().await.unwrap().conn;
    let root = tempfile::tempdir().unwrap();
    let store = FileStore::with_root(root.path().to_path_buf());
    let conversation = conversation::create_conversation(&db, "Prepared", "m1", "p1", None)
        .await
        .unwrap();
    let content = format!("![generated](data:image/png;base64,{PNG_DATA})");
    let prepared = prepare_message_inline_images(&content)
        .unwrap()
        .expect("inline media should be prepared");

    assert!(!contains_inline_image_data(prepared.safe_content()));
    assert!(prepared.safe_content().contains("aqbot-inline://pending/"));
    let message = message::create_message(
        &db,
        &conversation.id,
        MessageRole::User,
        prepared.safe_content(),
        &[],
        None,
        0,
    )
    .await
    .unwrap();
    let stored = materialize_prepared_message_inline_images(&db, &store, &message.id, &prepared)
        .await
        .unwrap();

    assert!(!contains_inline_image_data(&stored.content));
    assert!(!stored.content.contains("aqbot-inline://pending/"));
    assert!(stored.content.contains("aqbot-media://stored/"));
}

#[test]
fn markdown_images_inside_inline_and_fenced_code_are_not_extracted() {
    let content = format!(
        "`![inline](data:image/png;base64,{PNG_DATA})`\n\n```md\n![fenced](data:image/png;base64,{PNG_DATA})\n```"
    );

    let document = extract_inline_images(&content).unwrap();

    assert!(document.images().is_empty());
    assert_eq!(document.rewrite(&[]).unwrap(), content);
    assert!(prepare_message_inline_images(&content).unwrap().is_none());
}

#[test]
fn mixed_supported_and_unmaterializable_data_uri_is_rejected_before_persistence() {
    let content = format!(
        "![valid](data:image/png;base64,{PNG_DATA}) then plain data:image/png;base64,{PNG_DATA}"
    );

    let error = prepare_message_inline_images(&content)
        .err()
        .expect("mixed inline media must be rejected");

    assert!(error
        .to_string()
        .contains("outside supported Markdown image or HTML img syntax"));
}

#[test]
fn escaped_markdown_image_syntax_is_not_extracted() {
    let content = format!(r"\![literal](data:image/png;base64,{PNG_DATA})");

    let document = extract_inline_images(&content).unwrap();

    assert!(document.images().is_empty());
    assert_eq!(document.rewrite(&[]).unwrap(), content);
}

#[test]
fn html_img_src_data_uri_is_extracted_without_reformatting_the_tag() {
    let content =
        "before <IMG class=\"preview\" src='data:image/gif;base64,R0lGODlh' alt=\"x\"> after";

    let document = extract_inline_images(content).unwrap();

    assert_eq!(document.images().len(), 1);
    assert_eq!(document.images()[0].mime_type, "image/gif");
    assert_eq!(
        document
            .rewrite(&["aqbot-media://stored/gif-1".to_string()])
            .unwrap(),
        "before <IMG class=\"preview\" src='aqbot-media://stored/gif-1' alt=\"x\"> after"
    );
}

#[test]
fn file_store_atomically_deduplicates_identical_image_bytes() {
    let root = tempfile::tempdir().unwrap();
    let store = FileStore::with_root(root.path().to_path_buf());

    let first = store
        .save_file(b"\x89PNG\r\n\x1a\n", "inline.png", "image/png")
        .unwrap();
    let second = store
        .save_file(b"\x89PNG\r\n\x1a\n", "inline.png", "image/png")
        .unwrap();

    assert!(first.created);
    assert!(!second.created);
    assert_eq!(first.storage_path, second.storage_path);
    assert!(first.storage_path.starts_with("images/"));
    assert!(root.path().join(&first.storage_path).is_file());
    assert!(std::fs::read_dir(root.path().join("images"))
        .unwrap()
        .all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains(".migrating")));
}

#[tokio::test]
async fn message_materialization_replaces_data_uri_and_registers_relative_attachment() {
    let db = aqbot_core::db::create_test_pool().await.unwrap().conn;
    let root = tempfile::tempdir().unwrap();
    let store = FileStore::with_root(root.path().to_path_buf());
    let conversation = conversation::create_conversation(&db, "Media", "m1", "p1", None)
        .await
        .unwrap();
    let message = message::create_message(
        &db,
        &conversation.id,
        MessageRole::Assistant,
        "pending",
        &[],
        None,
        0,
    )
    .await
    .unwrap();
    let content = format!("![generated](data:image/png;base64,{PNG_DATA})");

    let updated = materialize_message_inline_images(&db, &store, &message.id, &content)
        .await
        .unwrap();

    assert_eq!(updated.attachments.len(), 1);
    let attachment = &updated.attachments[0];
    assert_eq!(
        updated.content,
        format!("![generated](aqbot-media://stored/{})", attachment.id)
    );
    assert_eq!(attachment.file_type, "image/png");
    assert!(attachment.file_path.starts_with("images/"));
    assert!(!std::path::Path::new(&attachment.file_path).is_absolute());
    assert!(root.path().join(&attachment.file_path).is_file());
    let stored = stored_file::list_stored_files_by_conversation(&db, &conversation.id)
        .await
        .unwrap();
    assert_eq!(stored.len(), 1);
    assert_eq!(stored[0].id, attachment.id);
}

#[tokio::test]
async fn large_png_data_uri_never_remains_in_materialized_or_serialized_message() {
    const IMAGE_SIZE: usize = 2_254_438;

    let db = aqbot_core::db::create_test_pool().await.unwrap().conn;
    let root = tempfile::tempdir().unwrap();
    let store = FileStore::with_root(root.path().to_path_buf());
    let conversation = conversation::create_conversation(&db, "Large media", "m1", "p1", None)
        .await
        .unwrap();
    let message = message::create_message(
        &db,
        &conversation.id,
        MessageRole::Assistant,
        "pending",
        &[],
        None,
        0,
    )
    .await
    .unwrap();
    let mut image = vec![0_u8; IMAGE_SIZE];
    image[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
    let mut content = String::with_capacity(IMAGE_SIZE * 4 / 3 + 64);
    content.push_str("![large](data:image/png;base64,");
    base64::engine::general_purpose::STANDARD.encode_string(&image, &mut content);
    content.push(')');
    drop(image);

    let updated = materialize_message_inline_images(&db, &store, &message.id, &content)
        .await
        .unwrap();
    drop(content);

    assert!(!updated.content.contains("data:image"));
    assert!(updated.content.contains("aqbot-media://stored/"));
    assert_eq!(updated.attachments.len(), 1);
    assert_eq!(updated.attachments[0].file_size, IMAGE_SIZE as u64);
    assert_eq!(
        std::fs::metadata(root.path().join(&updated.attachments[0].file_path))
            .unwrap()
            .len(),
        IMAGE_SIZE as u64
    );
    let serialized = serde_json::to_string(&updated).unwrap();
    assert!(!serialized.contains("data:image"));
}

#[tokio::test]
async fn invalid_inline_image_leaves_message_and_storage_unchanged() {
    let db = aqbot_core::db::create_test_pool().await.unwrap().conn;
    let root = tempfile::tempdir().unwrap();
    let store = FileStore::with_root(root.path().to_path_buf());
    let conversation = conversation::create_conversation(&db, "Invalid", "m1", "p1", None)
        .await
        .unwrap();
    let message = message::create_message(
        &db,
        &conversation.id,
        MessageRole::Assistant,
        "original",
        &[],
        None,
        0,
    )
    .await
    .unwrap();

    let error = materialize_message_inline_images(
        &db,
        &store,
        &message.id,
        "![bad](data:image/png;base64,not-base64!)",
    )
    .await
    .unwrap_err();

    assert!(error.to_string().contains("Invalid inline image base64"));
    assert_eq!(
        message::get_message(&db, &message.id)
            .await
            .unwrap()
            .content,
        "original"
    );
    assert!(
        stored_file::list_stored_files_by_conversation(&db, &conversation.id)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(std::fs::read_dir(root.path()).unwrap().next().is_none());
}

#[tokio::test]
async fn unmaterializable_data_uri_text_leaves_message_unchanged() {
    let db = aqbot_core::db::create_test_pool().await.unwrap().conn;
    let root = tempfile::tempdir().unwrap();
    let store = FileStore::with_root(root.path().to_path_buf());
    let conversation = conversation::create_conversation(&db, "Invalid text", "m1", "p1", None)
        .await
        .unwrap();
    let message = message::create_message(
        &db,
        &conversation.id,
        MessageRole::User,
        "original",
        &[],
        None,
        0,
    )
    .await
    .unwrap();

    let error = materialize_message_inline_images(
        &db,
        &store,
        &message.id,
        "plain data:image/png;base64,iVBORw0KGgo=",
    )
    .await
    .unwrap_err();

    assert!(error
        .to_string()
        .contains("Markdown image or HTML img syntax"));
    assert_eq!(
        message::get_message(&db, &message.id)
            .await
            .unwrap()
            .content,
        "original"
    );
    assert!(
        stored_file::list_stored_files_by_conversation(&db, &conversation.id)
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn repeated_inline_image_reuses_one_record_and_one_url() {
    let db = aqbot_core::db::create_test_pool().await.unwrap().conn;
    let root = tempfile::tempdir().unwrap();
    let store = FileStore::with_root(root.path().to_path_buf());
    let conversation = conversation::create_conversation(&db, "Dedup", "m1", "p1", None)
        .await
        .unwrap();
    let message = message::create_message(
        &db,
        &conversation.id,
        MessageRole::Assistant,
        "original",
        &[],
        None,
        0,
    )
    .await
    .unwrap();
    let content = format!(
        "![one](data:image/png;base64,{PNG_DATA}) ![two](data:image/png;base64,{PNG_DATA})"
    );

    let updated = materialize_message_inline_images(&db, &store, &message.id, &content)
        .await
        .unwrap();

    assert_eq!(updated.attachments.len(), 1);
    let url = format!("aqbot-media://stored/{}", updated.attachments[0].id);
    assert_eq!(updated.content.matches(&url).count(), 2);
    assert_eq!(
        stored_file::list_stored_files_by_conversation(&db, &conversation.id)
            .await
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn historical_migration_is_idempotent_and_reports_failed_message_ids() {
    let db = aqbot_core::db::create_test_pool().await.unwrap().conn;
    let root = tempfile::tempdir().unwrap();
    let store = FileStore::with_root(root.path().to_path_buf());
    let conversation = conversation::create_conversation(&db, "Migration", "m1", "p1", None)
        .await
        .unwrap();
    let valid = message::create_message(
        &db,
        &conversation.id,
        MessageRole::Assistant,
        &format!("![ok](data:image/png;base64,{PNG_DATA})"),
        &[],
        None,
        0,
    )
    .await
    .unwrap();
    let valid_user = message::create_message(
        &db,
        &conversation.id,
        MessageRole::User,
        &format!("<img src=\"data:image/png;base64,{PNG_DATA}\">"),
        &[],
        None,
        0,
    )
    .await
    .unwrap();
    let invalid_content = "![bad](data:image/png;base64,broken!)";
    let invalid = message::create_message(
        &db,
        &conversation.id,
        MessageRole::Assistant,
        invalid_content,
        &[],
        None,
        0,
    )
    .await
    .unwrap();
    let code_example = message::create_message(
        &db,
        &conversation.id,
        MessageRole::User,
        &format!("`![example](data:image/png;base64,{PNG_DATA})`"),
        &[],
        None,
        0,
    )
    .await
    .unwrap();

    let candidates = pending_inline_media_message_ids(&db, None).await.unwrap();
    assert!(!candidates.contains(&code_example.id));
    let report = materialize_inline_media_messages(&db, &store, &candidates)
        .await
        .unwrap();

    assert_eq!(report.migrated, 2);
    assert_eq!(report.failures.len(), 1);
    assert_eq!(report.failures[0].message_id, invalid.id);
    assert!(message::get_message(&db, &valid.id)
        .await
        .unwrap()
        .content
        .contains("aqbot-media://stored/"));
    assert!(message::get_message(&db, &invalid.id)
        .await
        .unwrap()
        .content
        .contains("data:image/png;base64,broken!"));
    assert!(message::get_message(&db, &valid_user.id)
        .await
        .unwrap()
        .content
        .contains("aqbot-media://stored/"));
    assert!(pending_inline_media_message_ids(&db, None)
        .await
        .unwrap()
        .is_empty());

    let diagnostics = list_inline_media_diagnostics(&db, None).await.unwrap();
    assert_eq!(diagnostics.len(), 1);
    assert_eq!(diagnostics[0].message_id, invalid.id);
    assert_eq!(diagnostics[0].content_hash.len(), 64);
    assert!(!diagnostics[0].error.is_empty());

    let changed_content = "![bad](data:image/png;base64,still-broken!)";
    message::update_message_content(&db, &invalid.id, changed_content)
        .await
        .unwrap();
    assert_eq!(
        pending_inline_media_message_ids(&db, None).await.unwrap(),
        vec![invalid.id.clone()]
    );

    message::update_message_content(
        &db,
        &invalid.id,
        &format!("![fixed](data:image/png;base64,{PNG_DATA})"),
    )
    .await
    .unwrap();
    let retry = materialize_inline_media_messages(&db, &store, &[invalid.id.clone()])
        .await
        .unwrap();
    assert_eq!(retry.migrated, 1);
    assert!(retry.failures.is_empty());
    assert!(list_inline_media_diagnostics(&db, None)
        .await
        .unwrap()
        .is_empty());
}
