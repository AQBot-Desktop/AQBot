use super::*;
use crate::file_store::FileStore;

#[tokio::test]
async fn tray_icon_reference_survives_settings_save_and_gc_then_resets() {
    let db = crate::db::create_test_pool().await.unwrap().conn;
    let root = tempfile::tempdir().unwrap();
    let store = FileStore::with_root(root.path().into());
    let saved = store.save_file(b"image", "tray.png", "image/png").unwrap();
    commit_change(
        &db,
        Some(NewIcon {
            id: "tray",
            saved: &saved,
            name: "tray.png",
        }),
        || Ok(()),
    )
    .await
    .unwrap();
    super::super::settings::save_settings(&db, &crate::types::AppSettings::default())
        .await
        .unwrap();
    assert_eq!(file_id(&db).await.unwrap().as_deref(), Some("tray"));
    assert_eq!(
        super::super::settings::get_settings(&db)
            .await
            .unwrap()
            .tray_icon_file_id
            .as_deref(),
        Some("tray")
    );
    assert!(super::super::stored_file::delete_unreferenced_candidates(
        &db,
        &HashSet::from(["tray".into()])
    )
    .await
    .unwrap()
    .is_empty());
    let paths = commit_change(&db, None, || Ok(())).await.unwrap();
    assert_eq!(paths, [saved.storage_path]);
    assert_eq!(file_id(&db).await.unwrap(), None);
    assert!(super::super::stored_file::get_stored_file(&db, "tray")
        .await
        .is_err());
}

#[tokio::test]
async fn tray_icon_native_failure_rolls_back_new_record_and_old_reference() {
    let db = crate::db::create_test_pool().await.unwrap().conn;
    let root = tempfile::tempdir().unwrap();
    let store = FileStore::with_root(root.path().into());
    let old = store.save_file(b"old", "old.png", "image/png").unwrap();
    let new = store.save_file(b"new", "new.png", "image/png").unwrap();
    commit_change(
        &db,
        Some(NewIcon {
            id: "old",
            saved: &old,
            name: "old.png",
        }),
        || Ok(()),
    )
    .await
    .unwrap();
    let error = commit_change(
        &db,
        Some(NewIcon {
            id: "new",
            saved: &new,
            name: "new.png",
        }),
        || Err("native failure".into()),
    )
    .await
    .unwrap_err();
    assert_eq!(error, "native failure");
    assert_eq!(file_id(&db).await.unwrap().as_deref(), Some("old"));
    assert!(super::super::stored_file::get_stored_file(&db, "old")
        .await
        .is_ok());
    assert!(super::super::stored_file::get_stored_file(&db, "new")
        .await
        .is_err());
    assert!(store.resolve_path(&old.storage_path).exists());
}

#[tokio::test]
async fn tray_icon_commit_failure_does_not_publish_the_new_reference() {
    let db = crate::db::create_test_pool().await.unwrap().conn;
    let root = tempfile::tempdir().unwrap();
    let store = FileStore::with_root(root.path().into());
    let old = store.save_file(b"old", "old.png", "image/png").unwrap();
    let new = store.save_file(b"new", "new.png", "image/png").unwrap();
    commit_change(
        &db,
        Some(NewIcon {
            id: "old",
            saved: &old,
            name: "old.png",
        }),
        || Ok(()),
    )
    .await
    .unwrap();
    for sql in [
        "CREATE TABLE icon_parent (id INTEGER PRIMARY KEY)",
        "CREATE TABLE icon_child (id INTEGER REFERENCES icon_parent(id) DEFERRABLE INITIALLY DEFERRED)",
        "CREATE TRIGGER fail_icon_commit AFTER UPDATE ON settings WHEN NEW.key = 'tray_icon_file_id' BEGIN INSERT INTO icon_child VALUES (42); END",
    ] { db.execute(Statement::from_string(DbBackend::Sqlite, sql)).await.unwrap(); }
    let applied = std::cell::Cell::new(false);
    let error = commit_change(
        &db,
        Some(NewIcon {
            id: "new",
            saved: &new,
            name: "new.png",
        }),
        || {
            applied.set(true);
            Ok(())
        },
    )
    .await
    .unwrap_err();
    assert!(applied.get(), "failure must occur after the native step");
    assert!(error.contains("commit failed"), "{error}");
    assert_eq!(file_id(&db).await.unwrap().as_deref(), Some("old"));
    assert!(super::super::stored_file::get_stored_file(&db, "old")
        .await
        .is_ok());
    assert!(super::super::stored_file::get_stored_file(&db, "new")
        .await
        .is_err());
}

#[tokio::test]
async fn tray_icon_reset_can_remove_a_missing_reference() {
    let db = crate::db::create_test_pool().await.unwrap().conn;
    super::super::settings::set_setting(&db, FILE_ID_KEY, "\"missing\"")
        .await
        .unwrap();
    commit_change(&db, None, || Ok(())).await.unwrap();
    assert_eq!(file_id(&db).await.unwrap(), None);
}

#[test]
fn tray_icon_old_settings_default_and_roundtrip() {
    let settings: crate::types::AppSettings = serde_json::from_str("{}").unwrap();
    assert_eq!(settings.tray_icon_file_id, None);
    let settings: crate::types::AppSettings =
        serde_json::from_str(r#"{"tray_icon_file_id":"image-id"}"#).unwrap();
    assert_eq!(
        serde_json::to_value(settings).unwrap()[FILE_ID_KEY],
        "image-id"
    );
}
