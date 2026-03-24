use std::sync::OnceLock;

use sea_orm::DatabaseConnection;

fn file_cleanup_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

pub async fn delete_attachment_reference(
    db: &DatabaseConnection,
    file_store: &aqbot_core::file_store::FileStore,
    record_id: &str,
) -> Result<(), String> {
    let _guard = file_cleanup_lock().lock().await;

    let file = aqbot_core::repo::stored_file::get_stored_file(db, record_id)
        .await
        .map_err(|e| e.to_string())?;
    aqbot_core::repo::stored_file::delete_stored_file(db, record_id)
        .await
        .map_err(|e| e.to_string())?;

    let remaining_refs =
        aqbot_core::repo::stored_file::count_stored_files_with_storage_path(db, &file.storage_path)
            .await
            .map_err(|e| e.to_string())?;
    if remaining_refs == 0 {
        file_store.delete_file(&file.storage_path).map_err(|e| {
            format!(
                "Removed file record but failed to delete backing file {}: {}",
                file.storage_path, e
            )
        })?;
    }

    Ok(())
}
