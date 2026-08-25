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
mod m20260515_000001_add_knowledge_base_index_schedule;
mod m20260518_000001_add_builtin_model_deletions;
mod m20260627_000001_add_roles;
mod m20260628_000001_repair_roles_schema;
mod m20260701_000001_add_chat_perf_indexes;
mod m20260702_000001_add_inline_media_failures;
mod m20260723_000001_add_image_adapter_support;
mod m20260724_000001_add_model_metadata;
mod m20260725_000001_add_provider_aws_region;
mod m20260806_000001_add_role_capability_bindings;
mod m20260807_000001_add_conversation_context_message_limit;
mod m20260808_000001_compression_keep_and_source;
mod m20260809_000001_add_model_aliases_and_auto_route;
mod m20260810_000001_add_acp_tables;
mod m20260811_000001_acp_project_sort_order;
mod m20260812_000001_acp_thread_pin_sort;
mod m20260813_000001_acp_project_kind;
mod m20260814_000001_add_context_strategy;
mod m20260815_000001_add_conversation_sort_order;
mod m20260823_000001_add_conversation_multi_model_display_mode_override;
mod m20260825_000001_add_memory_l1_and_activation;
mod m20260825_000002_add_memory_l1_sort_order;
mod m20260825_000003_fix_assistant_version_slots;
mod m20260825_000004_add_conversation_multi_model_preferences;

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
            Box::new(m20260515_000001_add_knowledge_base_index_schedule::Migration),
            Box::new(m20260518_000001_add_builtin_model_deletions::Migration),
            Box::new(m20260627_000001_add_roles::Migration),
            Box::new(m20260628_000001_repair_roles_schema::Migration),
            Box::new(m20260701_000001_add_chat_perf_indexes::Migration),
            Box::new(m20260702_000001_add_inline_media_failures::Migration),
            Box::new(m20260723_000001_add_image_adapter_support::Migration),
            Box::new(m20260724_000001_add_model_metadata::Migration),
            Box::new(m20260725_000001_add_provider_aws_region::Migration),
            Box::new(m20260806_000001_add_role_capability_bindings::Migration),
            Box::new(m20260807_000001_add_conversation_context_message_limit::Migration),
            Box::new(m20260808_000001_compression_keep_and_source::Migration),
            Box::new(m20260809_000001_add_model_aliases_and_auto_route::Migration),
            Box::new(m20260810_000001_add_acp_tables::Migration),
            Box::new(m20260811_000001_acp_project_sort_order::Migration),
            Box::new(m20260812_000001_acp_thread_pin_sort::Migration),
            Box::new(m20260813_000001_acp_project_kind::Migration),
            Box::new(m20260814_000001_add_context_strategy::Migration),
            Box::new(m20260815_000001_add_conversation_sort_order::Migration),
            Box::new(
                m20260823_000001_add_conversation_multi_model_display_mode_override::Migration,
            ),
            Box::new(m20260825_000001_add_memory_l1_and_activation::Migration),
            Box::new(m20260825_000002_add_memory_l1_sort_order::Migration),
            Box::new(m20260825_000003_fix_assistant_version_slots::Migration),
            Box::new(m20260825_000004_add_conversation_multi_model_preferences::Migration),
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

    async fn sqlite_index_names(db: &DatabaseConnection, table: &str) -> Vec<String> {
        db.query_all(Statement::from_string(
            DbBackend::Sqlite,
            format!("PRAGMA index_list('{table}')"),
        ))
        .await
        .expect("query sqlite index list")
        .into_iter()
        .map(|row| row.try_get("", "name").expect("read index name"))
        .collect()
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
    async fn migrator_up_adds_image_adapter_columns_on_sqlite() {
        let db = sqlite_test_db().await;

        Migrator::up(&db, None)
            .await
            .expect("run sqlite migrations");

        let manager = SchemaManager::new(&db);
        assert!(manager
            .has_column("models", "image_config_json")
            .await
            .expect("check models.image_config_json"));
        for column in [
            "adapter_id",
            "adapter_config_snapshot",
            "remote_task_id",
            "remote_status",
            "opaque_state_json",
            "poll_count",
            "consecutive_errors",
            "last_polled_at",
            "deadline_at",
        ] {
            assert!(
                manager
                    .has_column("drawing_generations", column)
                    .await
                    .expect("check drawing generation column"),
                "missing drawing_generations.{column}"
            );
        }
    }

    #[tokio::test]
    async fn migrator_up_adds_model_metadata_columns_on_sqlite() {
        let db = sqlite_test_db().await;
        Migrator::up(&db, None)
            .await
            .expect("run sqlite migrations");
        let manager = SchemaManager::new(&db);

        for column in ["max_output_tokens", "metadata_state_json", "aliases_json"] {
            assert!(
                manager
                    .has_column("models", column)
                    .await
                    .expect("check model metadata column"),
                "missing models.{column}"
            );
        }
    }

    #[tokio::test]
    async fn migrator_up_adds_builtin_model_deletions_table_on_sqlite() {
        let db = sqlite_test_db().await;

        Migrator::up(&db, None)
            .await
            .expect("run sqlite migrations");

        let manager = SchemaManager::new(&db);
        assert!(
            manager
                .has_table("builtin_model_deletions")
                .await
                .expect("check builtin model deletions table"),
            "missing builtin_model_deletions table"
        );
    }

    #[tokio::test]
    async fn migrator_up_adds_roles_table_on_sqlite() {
        let db = sqlite_test_db().await;

        Migrator::up(&db, None)
            .await
            .expect("run sqlite migrations");

        let manager = SchemaManager::new(&db);
        assert!(
            manager.has_table("roles").await.expect("check roles table"),
            "missing roles table"
        );
        for column in [
            "temperature",
            "top_p",
            "avatar_type",
            "avatar_value",
            "enabled_mcp_server_ids_json",
            "enabled_skill_names_json",
        ] {
            assert!(
                manager
                    .has_column("roles", column)
                    .await
                    .expect("check roles column"),
                "missing roles.{column}"
            );
        }
    }

    #[tokio::test]
    async fn migrator_up_adds_chat_performance_indexes_on_sqlite() {
        let db = sqlite_test_db().await;

        Migrator::up(&db, None)
            .await
            .expect("run sqlite migrations");

        let message_indexes = sqlite_index_names(&db, "messages").await;
        for index_name in [
            "idx_messages_conv_active_created_id",
            "idx_messages_conv_parent_role_version",
            "idx_messages_conv_role_parent",
            "idx_messages_conv_created_id",
        ] {
            assert!(
                message_indexes.contains(&index_name.to_string()),
                "missing messages performance index {index_name}"
            );
        }

        let conversation_indexes = sqlite_index_names(&db, "conversations").await;
        for index_name in [
            "idx_conversations_active_order",
            "idx_conversations_archived_order",
            "idx_conversations_category_active_root_sort",
        ] {
            assert!(
                conversation_indexes.contains(&index_name.to_string()),
                "missing conversations performance index {index_name}"
            );
        }
    }

    #[tokio::test]
    async fn conversation_sort_order_migration_backfills_current_visual_order() {
        let db = sqlite_test_db().await;
        db.execute_unprepared(
            r#"
            CREATE TABLE conversations (
                id TEXT PRIMARY KEY NOT NULL,
                category_id TEXT NULL,
                is_pinned INTEGER NOT NULL,
                is_archived INTEGER NOT NULL DEFAULT 0,
                parent_conversation_id TEXT NULL,
                updated_at INTEGER NOT NULL
            );
            INSERT INTO conversations (id, category_id, is_pinned, updated_at) VALUES
                ('cat-b', 'category', 0, 20),
                ('cat-a', 'category', 1, 20),
                ('cat-c', 'category', 0, 10),
                ('pin-b', NULL, 1, 30),
                ('pin-a', NULL, 1, 30),
                ('plain-b', NULL, 0, 20),
                ('plain-a', NULL, 0, 20);
            INSERT INTO conversations
                (id, category_id, is_pinned, is_archived, parent_conversation_id, updated_at)
            VALUES
                ('cat-child', 'category', 0, 0, 'cat-a', 40),
                ('pin-archived', NULL, 1, 1, NULL, 40);
            "#,
        )
        .await
        .expect("create legacy conversations");

        let manager = SchemaManager::new(&db);
        m20260815_000001_add_conversation_sort_order::Migration
            .up(&manager)
            .await
            .expect("add conversation sort order");

        let rows = db
            .query_all(Statement::from_string(
                DbBackend::Sqlite,
                "SELECT id, sort_order FROM conversations ORDER BY id".to_string(),
            ))
            .await
            .expect("query conversation sort order");
        let actual = rows
            .into_iter()
            .map(|row| {
                (
                    row.try_get::<String>("", "id").expect("conversation id"),
                    row.try_get::<i32>("", "sort_order").expect("sort order"),
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(
            actual,
            vec![
                ("cat-a".to_string(), 1),
                ("cat-b".to_string(), 2),
                ("cat-c".to_string(), 3),
                ("cat-child".to_string(), 0),
                ("pin-a".to_string(), 1),
                ("pin-archived".to_string(), 0),
                ("pin-b".to_string(), 2),
                ("plain-a".to_string(), 3),
                ("plain-b".to_string(), 4),
            ]
        );

        for (where_clause, expected) in [
            ("category_id = 'category'", vec!["cat-a", "cat-b", "cat-c"]),
            (
                "category_id IS NULL",
                vec!["pin-a", "pin-b", "plain-a", "plain-b"],
            ),
        ] {
            let rows = db
                .query_all(Statement::from_string(
                    DbBackend::Sqlite,
                    format!(
                        "SELECT id FROM conversations WHERE {where_clause} \
                         AND is_archived = 0 AND parent_conversation_id IS NULL \
                         ORDER BY sort_order"
                    ),
                ))
                .await
                .expect("query active root visual order");
            assert_eq!(
                rows.into_iter()
                    .map(|row| row.try_get::<String>("", "id").expect("conversation id"))
                    .collect::<Vec<_>>(),
                expected
            );
        }
        assert!(sqlite_index_names(&db, "conversations")
            .await
            .contains(&"idx_conversations_category_active_root_sort".to_string()));
    }

    #[tokio::test]
    async fn migrator_up_adds_inline_media_failure_diagnostics_on_sqlite() {
        let db = sqlite_test_db().await;

        Migrator::up(&db, None)
            .await
            .expect("run sqlite migrations");

        let manager = SchemaManager::new(&db);
        assert!(manager
            .has_table("inline_media_failures")
            .await
            .expect("check inline media failures table"));
        for column in ["message_id", "content_hash", "error", "updated_at"] {
            assert!(
                manager
                    .has_column("inline_media_failures", column)
                    .await
                    .expect("check inline media failure column"),
                "missing inline_media_failures.{column}"
            );
        }
    }

    #[tokio::test]
    async fn migrator_up_repairs_existing_roles_table_on_sqlite() {
        let db = sqlite_test_db().await;
        db.execute(Statement::from_string(
            DbBackend::Sqlite,
            r#"
            CREATE TABLE roles (
                id varchar NOT NULL PRIMARY KEY,
                name varchar NOT NULL,
                description text NULL,
                system_prompt text NOT NULL,
                opening_message text NULL,
                opening_questions_json text NOT NULL DEFAULT '[]',
                tags_json text NOT NULL DEFAULT '[]',
                avatar varchar NULL,
                source_kind varchar NOT NULL DEFAULT 'local',
                source_ref varchar NULL,
                created_at bigint NOT NULL,
                updated_at bigint NOT NULL
            );
            INSERT INTO roles (
                id, name, system_prompt, opening_questions_json, tags_json,
                avatar, source_kind, created_at, updated_at
            ) VALUES (
                'role-old', '旧角色', '旧提示词', '[]', '[]',
                '🌐', 'local', 1, 1
            );
            CREATE TABLE seaql_migrations (
                version varchar NOT NULL PRIMARY KEY,
                applied_at bigint NOT NULL
            );
            INSERT INTO seaql_migrations (version, applied_at)
            VALUES ('m20260627_000001_add_roles', 1);
            "#,
        ))
        .await
        .expect("create old roles schema");

        Migrator::up(&db, None)
            .await
            .expect("run sqlite migrations");

        let manager = SchemaManager::new(&db);
        for column in [
            "temperature",
            "top_p",
            "avatar_type",
            "avatar_value",
            "enabled_mcp_server_ids_json",
            "enabled_skill_names_json",
        ] {
            assert!(
                manager
                    .has_column("roles", column)
                    .await
                    .expect("check repaired column"),
                "missing roles.{column}"
            );
        }

        let count = db
            .query_one(Statement::from_string(
                DbBackend::Sqlite,
                "SELECT COUNT(*) AS count FROM roles WHERE id = 'role-old'",
            ))
            .await
            .expect("query old role")
            .expect("old role count row")
            .try_get_by_index::<i64>(0)
            .expect("old role count");
        assert_eq!(count, 1);
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
    async fn migrator_up_adds_knowledge_base_index_schedule_on_sqlite() {
        let db = sqlite_test_db().await;

        Migrator::up(&db, None)
            .await
            .expect("run sqlite migrations");

        let manager = SchemaManager::new(&db);
        for column in ["index_concurrency", "index_interval_ms"] {
            assert!(
                manager
                    .has_column("knowledge_bases", column)
                    .await
                    .expect("check knowledge base index schedule column"),
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
    async fn add_provider_aws_region_preserves_existing_rows() {
        let db = sqlite_test_db().await;
        let manager = SchemaManager::new(&db);

        m20240101_000001_init::Migration
            .up(&manager)
            .await
            .expect("run init migration");
        db.execute_unprepared(
            r#"INSERT INTO providers
               (id, name, provider_type, api_host, enabled, sort_order, created_at, updated_at)
               VALUES ('provider-openai', 'OpenAI', 'openai', 'https://api.openai.com', 1, 0, 1, 1)"#,
        )
        .await
        .expect("insert legacy provider");

        m20260725_000001_add_provider_aws_region::Migration
            .up(&manager)
            .await
            .expect("add aws_region column");

        assert!(manager
            .has_column("providers", "aws_region")
            .await
            .expect("check aws_region column"));
        let row = db
            .query_one(Statement::from_string(
                DbBackend::Sqlite,
                "SELECT name, aws_region FROM providers WHERE id = 'provider-openai'".to_string(),
            ))
            .await
            .expect("query legacy provider")
            .expect("legacy provider row");
        assert_eq!(
            row.try_get::<String>("", "name").expect("provider name"),
            "OpenAI"
        );
        assert_eq!(
            row.try_get::<Option<String>>("", "aws_region")
                .expect("aws_region"),
            None
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

    #[tokio::test]
    async fn migrator_up_adds_memory_l1_and_namespace_activation() {
        let db = sqlite_test_db().await;
        Migrator::up(&db, None)
            .await
            .expect("run sqlite migrations");
        let manager = SchemaManager::new(&db);
        assert!(manager
            .has_table("memory_l1")
            .await
            .expect("check memory_l1"));
        for column in ["activation_mode", "migration_review_required"] {
            assert!(
                manager
                    .has_column("memory_namespaces", column)
                    .await
                    .expect("check namespace column"),
                "missing memory_namespaces.{column}"
            );
        }
        let row = db
            .query_one(Statement::from_string(
                DbBackend::Sqlite,
                "SELECT id, enabled, markdown, revision FROM memory_l1 WHERE id = 'global'"
                    .to_string(),
            ))
            .await
            .expect("query l1")
            .expect("global l1 row");
        assert_eq!(row.try_get::<String>("", "id").unwrap(), "global");
        assert_eq!(row.try_get::<i64>("", "enabled").unwrap(), 1);
        assert_eq!(row.try_get::<String>("", "markdown").unwrap(), "");
        assert_eq!(row.try_get::<i64>("", "revision").unwrap(), 0);
        assert!(manager
            .has_column("memory_l1", "sort_order")
            .await
            .expect("check memory_l1.sort_order"));
    }

    #[tokio::test]
    async fn migrations_add_nullable_multi_model_display_mode_override_to_conversations() {
        let db = sqlite_test_db().await;

        Migrator::up(&db, None)
            .await
            .expect("run sqlite migrations");

        let columns = db
            .query_all(Statement::from_string(
                DbBackend::Sqlite,
                "PRAGMA table_info(conversations)".to_string(),
            ))
            .await
            .expect("inspect conversations schema");
        let column = columns
            .iter()
            .find(|row| {
                row.try_get::<String>("", "name").expect("column name")
                    == "multi_model_display_mode_override"
            })
            .expect("multi-model display mode override column");

        assert_eq!(column.try_get::<i64>("", "notnull").expect("notnull"), 0);
        assert_eq!(
            column
                .try_get::<Option<String>>("", "dflt_value")
                .expect("default value"),
            None
        );
    }

    #[tokio::test]
    async fn multi_model_display_mode_override_migration_leaves_existing_rows_null() {
        let db = sqlite_test_db().await;
        db.execute_unprepared(
            "CREATE TABLE conversations (id TEXT PRIMARY KEY NOT NULL); \
             INSERT INTO conversations (id) VALUES ('existing');",
        )
        .await
        .expect("create legacy conversations");

        let manager = SchemaManager::new(&db);
        m20260823_000001_add_conversation_multi_model_display_mode_override::Migration
            .up(&manager)
            .await
            .expect("run multi-model display mode migration");

        let row = db
            .query_one(Statement::from_string(
                DbBackend::Sqlite,
                "SELECT multi_model_display_mode_override FROM conversations WHERE id = 'existing'"
                    .to_string(),
            ))
            .await
            .expect("query migrated conversation")
            .expect("existing conversation row");
        assert_eq!(
            row.try_get::<Option<String>>("", "multi_model_display_mode_override")
                .expect("read display mode override"),
            None
        );
    }

    #[tokio::test]
    async fn context_strategy_migration_backfills_legacy_rows_and_leaves_new_rows_null() {
        let db = sqlite_test_db().await;
        db.execute_unprepared(
            "CREATE TABLE conversations (\
                id TEXT PRIMARY KEY NOT NULL, \
                context_compression INTEGER NOT NULL\
             ); \
             INSERT INTO conversations (id, context_compression) VALUES \
                ('compressed', 1), \
                ('raw', 0);",
        )
        .await
        .expect("create legacy conversations");

        let manager = SchemaManager::new(&db);
        m20260814_000001_add_context_strategy::Migration
            .up(&manager)
            .await
            .expect("run context strategy migration");

        let rows = db
            .query_all(Statement::from_string(
                DbBackend::Sqlite,
                "SELECT id, context_strategy_override FROM conversations ORDER BY id".to_string(),
            ))
            .await
            .expect("query migrated conversations");
        assert_eq!(
            rows[0]
                .try_get::<Option<String>>("", "context_strategy_override")
                .expect("read compressed strategy")
                .as_deref(),
            Some("smart_summary")
        );
        assert_eq!(
            rows[1]
                .try_get::<Option<String>>("", "context_strategy_override")
                .expect("read raw strategy")
                .as_deref(),
            Some("raw_truncate")
        );

        db.execute_unprepared(
            "INSERT INTO conversations (id, context_compression) VALUES ('new', 0)",
        )
        .await
        .expect("insert post-migration conversation");
        let row = db
            .query_one(Statement::from_string(
                DbBackend::Sqlite,
                "SELECT context_strategy_override FROM conversations WHERE id = 'new'".to_string(),
            ))
            .await
            .expect("query new conversation")
            .expect("new conversation row");
        assert_eq!(
            row.try_get::<Option<String>>("", "context_strategy_override")
                .expect("read new strategy"),
            None
        );
    }

    #[tokio::test]
    async fn assistant_version_slot_migration_densifies_duplicates_and_rejects_new_collisions() {
        let db = sqlite_test_db().await;
        db.execute_unprepared(
            "CREATE TABLE messages (
                id TEXT PRIMARY KEY NOT NULL,
                conversation_id TEXT NOT NULL,
                role TEXT NOT NULL,
                parent_message_id TEXT,
                version_index INTEGER NOT NULL,
                created_at INTEGER NOT NULL
             );
             INSERT INTO messages (id, conversation_id, role, parent_message_id, version_index, created_at) VALUES
                ('a', 'conv', 'assistant', 'user-1', 0, 1),
                ('b', 'conv', 'assistant', 'user-1', 1, 2),
                ('c', 'conv', 'assistant', 'user-1', 1, 3);",
        )
        .await
        .expect("create legacy duplicate slots");

        let manager = SchemaManager::new(&db);
        m20260825_000003_fix_assistant_version_slots::Migration
            .up(&manager)
            .await
            .expect("run version slot migration");

        let rows = db
            .query_all(Statement::from_string(
                DbBackend::Sqlite,
                "SELECT id, version_index FROM messages ORDER BY version_index, id".to_string(),
            ))
            .await
            .expect("query densified slots");
        let slots = rows
            .iter()
            .map(|row| {
                (
                    row.try_get::<String>("", "id").expect("id"),
                    row.try_get::<i64>("", "version_index").expect("slot"),
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(
            slots,
            vec![
                ("a".to_string(), 0),
                ("b".to_string(), 1),
                ("c".to_string(), 2),
            ]
        );

        let insert_duplicate = db
            .execute_unprepared(
                "INSERT INTO messages (id, conversation_id, role, parent_message_id, version_index, created_at)
                 VALUES ('d', 'conv', 'assistant', 'user-1', 1, 4)",
            )
            .await;
        assert!(insert_duplicate.is_err(), "duplicate slot should be rejected");
    }

    #[tokio::test]
    async fn conversation_multi_model_preferences_migration_defaults_legacy_rows() {
        let db = sqlite_test_db().await;
        db.execute_unprepared(
            "CREATE TABLE conversations (id TEXT PRIMARY KEY NOT NULL);
             INSERT INTO conversations (id) VALUES ('existing');",
        )
        .await
        .expect("create legacy conversations");

        let manager = SchemaManager::new(&db);
        m20260825_000004_add_conversation_multi_model_preferences::Migration
            .up(&manager)
            .await
            .expect("run multi-model preference migration");

        let row = db
            .query_one(Statement::from_string(
                DbBackend::Sqlite,
                "SELECT multi_model_targets_json, multi_model_continuation_mode FROM conversations WHERE id = 'existing'"
                    .to_string(),
            ))
            .await
            .expect("query migrated conversation")
            .expect("existing conversation row");
        assert_eq!(
            row.try_get::<String>("", "multi_model_targets_json")
                .expect("read targets"),
            "[]"
        );
        assert_eq!(
            row.try_get::<String>("", "multi_model_continuation_mode")
                .expect("read continuation mode"),
            "selected"
        );
    }
}
