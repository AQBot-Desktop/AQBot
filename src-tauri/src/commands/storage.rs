use aqbot_core::storage_inventory::{self, StorageInventory};

#[tauri::command]
pub async fn get_storage_inventory() -> Result<StorageInventory, String> {
    Ok(storage_inventory::scan_storage())
}

#[tauri::command]
pub async fn open_storage_directory(app: tauri::AppHandle) -> Result<(), String> {
    let root = aqbot_core::storage_paths::documents_root();
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .reveal_item_in_dir(&root)
        .map_err(|e| e.to_string())
}
