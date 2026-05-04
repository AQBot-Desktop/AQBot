pub use sea_orm_migration::prelude::*;

mod m20240101_000001_init;
mod m20240102_000001_add_token_fields;
mod m20240103_000001_add_mcp_timeout_headers;
mod m20240104_000001_add_mcp_icon;
mod m20250105_000001_context_compression;
mod m20250106_000001_add_message_status;
mod m20250107_000001_add_provider_custom_headers;
mod m20250108_000001_add_provider_icon;
mod m20250109_000001_add_conversation_categories;
mod m20250110_000001_add_memory_item_index_status;
mod m20250111_000001_add_memory_item_index_error;
mod m20250113_000001_add_memory_namespace_settings;
mod m20250114_000001_add_memory_namespace_icon_sort;
mod m20250115_000001_add_knowledge_base_icon_sort;
mod m20250116_000001_add_knowledge_base_retrieval_settings;
mod m20250117_000001_add_knowledge_base_chunking_config;
mod m20250118_000001_add_knowledge_document_type;
mod m20250119_000001_add_knowledge_document_index_error;
mod m20250120_000001_add_message_timing;
mod m20250121_000001_add_conversation_parent_id;
mod m20250122_000001_merge_thinking_to_content;
mod m20250123_000001_add_category_system_prompt;
mod m20250717_000001_add_agent_support;
mod m20250718_000001_add_sdk_context_backup;
mod m20250719_000001_add_skill_states;
mod m20250720_000001_add_provider_builtin_id;
mod m20260417_000001_add_category_default_templates;
mod m20260428_000001_add_drawing_history;
mod m20260430_000001_add_conversation_thinking_level;
mod m20260501_000001_add_knowledge_base_rerank_settings;
mod m20260504_000001_split_openai_compatible_provider_types;

pub struct Migrator;

#[async_trait::async_trait]
impl MigratorTrait for Migrator {
    fn migrations() -> Vec<Box<dyn MigrationTrait>> {
        vec![
            Box::new(m20240101_000001_init::Migration),
            Box::new(m20240102_000001_add_token_fields::Migration),
            Box::new(m20240103_000001_add_mcp_timeout_headers::Migration),
            Box::new(m20240104_000001_add_mcp_icon::Migration),
            Box::new(m20250105_000001_context_compression::Migration),
            Box::new(m20250106_000001_add_message_status::Migration),
            Box::new(m20250107_000001_add_provider_custom_headers::Migration),
            Box::new(m20250108_000001_add_provider_icon::Migration),
            Box::new(m20250109_000001_add_conversation_categories::Migration),
            Box::new(m20250110_000001_add_memory_item_index_status::Migration),
            Box::new(m20250111_000001_add_memory_item_index_error::Migration),
            Box::new(m20250113_000001_add_memory_namespace_settings::Migration),
            Box::new(m20250114_000001_add_memory_namespace_icon_sort::Migration),
            Box::new(m20250115_000001_add_knowledge_base_icon_sort::Migration),
            Box::new(m20250116_000001_add_knowledge_base_retrieval_settings::Migration),
            Box::new(m20250117_000001_add_knowledge_base_chunking_config::Migration),
            Box::new(m20250118_000001_add_knowledge_document_type::Migration),
            Box::new(m20250119_000001_add_knowledge_document_index_error::Migration),
            Box::new(m20250120_000001_add_message_timing::Migration),
            Box::new(m20250121_000001_add_conversation_parent_id::Migration),
            Box::new(m20250122_000001_merge_thinking_to_content::Migration),
            Box::new(m20250123_000001_add_category_system_prompt::Migration),
            Box::new(m20250717_000001_add_agent_support::Migration),
            Box::new(m20250718_000001_add_sdk_context_backup::Migration),
            Box::new(m20250719_000001_add_skill_states::Migration),
            Box::new(m20250720_000001_add_provider_builtin_id::Migration),
            Box::new(m20260417_000001_add_category_default_templates::Migration),
            Box::new(m20260428_000001_add_drawing_history::Migration),
            Box::new(m20260430_000001_add_conversation_thinking_level::Migration),
            Box::new(m20260501_000001_add_knowledge_base_rerank_settings::Migration),
            Box::new(m20260504_000001_split_openai_compatible_provider_types::Migration),
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm_migration::sea_orm::{
        ConnectOptions, ConnectionTrait, Database, DatabaseConnection, DbBackend, Statement,
    };

    async fn sqlite_test_db() -> DatabaseConnection {
        let mut opts = ConnectOptions::new("sqlite::memory:");
        opts.max_connections(1)
            .min_connections(1)
            .sqlx_logging(false);
        Database::connect(opts)
            .await
            .expect("connect sqlite test db")
    }

    #[tokio::test]
    async fn migrator_up_adds_category_default_template_columns_on_sqlite() {
        let db = sqlite_test_db().await;

        Migrator::up(&db, None)
            .await
            .expect("run sqlite migrations");

        let manager = SchemaManager::new(&db);
        for column in [
            "default_provider_id",
            "default_model_id",
            "default_temperature",
            "default_max_tokens",
            "default_top_p",
            "default_frequency_penalty",
        ] {
            assert!(
                manager
                    .has_column("conversation_categories", column)
                    .await
                    .expect("check migrated column"),
                "missing column {column}"
            );
        }
    }

    #[tokio::test]
    async fn migrator_up_adds_drawing_history_tables_on_sqlite() {
        let db = sqlite_test_db().await;

        Migrator::up(&db, None)
            .await
            .expect("run sqlite migrations");

        let manager = SchemaManager::new(&db);
        for table in ["drawing_generations", "drawing_images"] {
            assert!(
                manager.has_table(table).await.expect("check drawing table"),
                "missing table {table}"
            );
        }
    }

    #[tokio::test]
    async fn migrator_up_adds_conversation_thinking_level_on_sqlite() {
        let db = sqlite_test_db().await;

        Migrator::up(&db, None)
            .await
            .expect("run sqlite migrations");

        let manager = SchemaManager::new(&db);
        assert!(
            manager
                .has_column("conversations", "thinking_level")
                .await
                .expect("check thinking level column"),
            "missing conversations.thinking_level"
        );
    }

    #[tokio::test]
    async fn migrator_up_adds_knowledge_base_rerank_settings_on_sqlite() {
        let db = sqlite_test_db().await;

        Migrator::up(&db, None)
            .await
            .expect("run sqlite migrations");

        let manager = SchemaManager::new(&db);
        for column in ["rerank_provider", "rerank_candidate_k"] {
            assert!(
                manager
                    .has_column("knowledge_bases", column)
                    .await
                    .expect("check knowledge base rerank column"),
                "missing knowledge_bases.{column}"
            );
        }
    }

    #[tokio::test]
    async fn split_openai_compatible_provider_types_migration_updates_builtin_rows() {
        let db = sqlite_test_db().await;
        let manager = SchemaManager::new(&db);

        m20240101_000001_init::Migration
            .up(&manager)
            .await
            .expect("run init migration");
        m20250720_000001_add_provider_builtin_id::Migration
            .up(&manager)
            .await
            .expect("add builtin_id column");

        db.execute_unprepared(
            r#"INSERT INTO providers
               (id, name, provider_type, api_host, enabled, sort_order, created_at, updated_at, builtin_id)
               VALUES
               ('provider-deepseek', 'DeepSeek', 'openai', 'https://api.deepseek.com', 1, 0, 1, 1, 'deepseek'),
               ('provider-xai', 'xAI', 'openai', 'https://api.x.ai', 1, 0, 1, 1, 'xai'),
               ('provider-glm', 'GLM', 'openai', 'https://open.bigmodel.cn/api/paas', 1, 0, 1, 1, 'glm'),
               ('provider-siliconflow', 'SiliconFlow', 'openai', 'https://api.siliconflow.cn', 1, 0, 1, 1, 'siliconflow'),
               ('provider-custom', 'Custom', 'openai', 'https://api.example.com', 1, 0, 1, 1, NULL)"#,
        )
        .await
        .expect("insert provider rows");

        m20260504_000001_split_openai_compatible_provider_types::Migration
            .up(&manager)
            .await
            .expect("split provider types");

        let rows = db
            .query_all(Statement::from_string(
                DbBackend::Sqlite,
                "SELECT id, provider_type FROM providers ORDER BY id".to_string(),
            ))
            .await
            .expect("query providers");
        let values: Vec<(String, String)> = rows
            .into_iter()
            .map(|row| {
                (
                    row.try_get("", "id").unwrap(),
                    row.try_get("", "provider_type").unwrap(),
                )
            })
            .collect();

        assert_eq!(
            values,
            vec![
                ("provider-custom".to_string(), "openai".to_string()),
                ("provider-deepseek".to_string(), "deepseek".to_string()),
                ("provider-glm".to_string(), "glm".to_string()),
                (
                    "provider-siliconflow".to_string(),
                    "siliconflow".to_string()
                ),
                ("provider-xai".to_string(), "xai".to_string()),
            ]
        );
    }

    #[tokio::test]
    async fn migrator_refresh_round_trips_latest_sqlite_schema() {
        let db = sqlite_test_db().await;

        Migrator::up(&db, None)
            .await
            .expect("run sqlite migrations");
        Migrator::refresh(&db)
            .await
            .expect("refresh sqlite migrations");
    }
}
