use std::collections::HashSet;

use sea_orm::DatabaseConnection;

pub async fn pending_snapshot(db: &DatabaseConnection) -> Result<HashSet<String>, String> {
    aqbot_core::inline_media::pending_inline_media_message_ids(db, None)
        .await
        .map(|ids| ids.into_iter().collect())
        .map_err(|error| error.to_string())
}

pub async fn materialize_new_candidates(
    db: &DatabaseConnection,
    before: &HashSet<String>,
) -> Result<aqbot_core::inline_media::InlineMediaMigrationReport, String> {
    let file_store = aqbot_core::file_store::FileStore::new();
    materialize_new_candidates_using(db, before, &file_store).await
}

async fn materialize_new_candidates_using(
    db: &DatabaseConnection,
    before: &HashSet<String>,
    file_store: &aqbot_core::file_store::FileStore,
) -> Result<aqbot_core::inline_media::InlineMediaMigrationReport, String> {
    let candidates = aqbot_core::inline_media::pending_inline_media_message_ids(db, None)
        .await
        .map_err(|error| error.to_string())?
        .into_iter()
        .filter(|message_id| !before.contains(message_id))
        .collect::<Vec<_>>();
    aqbot_core::inline_media::materialize_inline_media_messages(db, file_store, &candidates)
        .await
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use aqbot_core::repo::{conversation, message};
    use aqbot_core::types::MessageRole;

    #[tokio::test]
    async fn import_media_only_materializes_new_candidates_and_reports_ids() {
        let db = aqbot_core::db::create_test_pool().await.unwrap().conn;
        let root = tempfile::tempdir().unwrap();
        let file_store = aqbot_core::file_store::FileStore::with_root(root.path().to_path_buf());
        let conversation = conversation::create_conversation(&db, "Import", "m1", "p1", None)
            .await
            .unwrap();
        let existing = message::create_message(
            &db,
            &conversation.id,
            MessageRole::Assistant,
            "![old](data:image/png;base64,iVBORw0KGgo=)",
            &[],
            None,
            0,
        )
        .await
        .unwrap();
        let before = pending_snapshot(&db).await.unwrap();
        let valid = message::create_message(
            &db,
            &conversation.id,
            MessageRole::Assistant,
            "![new](data:image/png;base64,iVBORw0KGgo=)",
            &[],
            None,
            0,
        )
        .await
        .unwrap();
        let invalid = message::create_message(
            &db,
            &conversation.id,
            MessageRole::Assistant,
            "![bad](data:image/png;base64,broken!)",
            &[],
            None,
            0,
        )
        .await
        .unwrap();

        let report = materialize_new_candidates_using(&db, &before, &file_store)
            .await
            .unwrap();

        assert_eq!(report.candidates, 2);
        assert_eq!(report.migrated, 1);
        assert_eq!(report.failures.len(), 1);
        assert_eq!(report.failures[0].message_id, invalid.id);
        assert!(message::get_message(&db, &existing.id)
            .await
            .unwrap()
            .content
            .contains("data:image"));
        assert!(message::get_message(&db, &valid.id)
            .await
            .unwrap()
            .content
            .contains("aqbot-media://stored/"));
    }
}
