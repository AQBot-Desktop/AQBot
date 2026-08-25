use sea_orm::sea_query::Expr;
use sea_orm::*;

use crate::entity::{memory_items, memory_l1, memory_namespaces};
use crate::error::{coded_error, AQBotError, Result};
use crate::types::{
    CreateMemoryItemInput, CreateMemoryNamespaceInput, MemoryItem, MemoryL1, MemoryNamespace,
    SaveMemoryL1Input, UpdateMemoryItemInput, UpdateMemoryNamespaceInput, MEMORY_ACTIVATION_AUTO,
    MEMORY_ACTIVATION_TOOL_ONLY, MEMORY_L1_ID, MEMORY_L1_MAX_BYTES, MEMORY_L1_SIDEBAR_ID,
};
use crate::utils::gen_id;

fn normalize_activation_mode(value: Option<&str>) -> Result<String> {
    match value.unwrap_or(MEMORY_ACTIVATION_TOOL_ONLY) {
        MEMORY_ACTIVATION_TOOL_ONLY => Ok(MEMORY_ACTIVATION_TOOL_ONLY.to_string()),
        MEMORY_ACTIVATION_AUTO => Ok(MEMORY_ACTIVATION_AUTO.to_string()),
        other => Err(coded_error(
            "MEMORY_INVALID_ACTIVATION_MODE",
            serde_json::json!({ "mode": other }),
        )),
    }
}

fn model_to_namespace(m: memory_namespaces::Model) -> MemoryNamespace {
    MemoryNamespace {
        id: m.id,
        name: m.name,
        scope: m.scope,
        embedding_provider: m.embedding_provider,
        embedding_dimensions: m.embedding_dimensions,
        retrieval_threshold: m.retrieval_threshold,
        retrieval_top_k: m.retrieval_top_k,
        icon_type: m.icon_type,
        icon_value: m.icon_value,
        sort_order: m.sort_order,
        activation_mode: if m.activation_mode.is_empty() {
            MEMORY_ACTIVATION_TOOL_ONLY.to_string()
        } else {
            m.activation_mode
        },
        migration_review_required: m.migration_review_required != 0,
    }
}

fn model_to_l1(m: memory_l1::Model) -> MemoryL1 {
    MemoryL1 {
        enabled: m.enabled != 0,
        markdown: m.markdown,
        revision: m.revision,
        sort_order: m.sort_order,
        updated_at: m.updated_at,
    }
}

fn model_to_item(m: memory_items::Model) -> MemoryItem {
    MemoryItem {
        id: m.id,
        namespace_id: m.namespace_id,
        title: m.title,
        content: m.content,
        source: m.source,
        index_status: m.index_status,
        index_error: m.index_error,
        updated_at: m.updated_at,
    }
}

pub async fn list_namespaces(db: &DatabaseConnection) -> Result<Vec<MemoryNamespace>> {
    let models = memory_namespaces::Entity::find()
        .order_by_asc(memory_namespaces::Column::SortOrder)
        .all(db)
        .await?;

    Ok(models.into_iter().map(model_to_namespace).collect())
}

pub async fn get_namespace(db: &DatabaseConnection, id: &str) -> Result<MemoryNamespace> {
    let model = memory_namespaces::Entity::find_by_id(id)
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("MemoryNamespace {}", id)))?;

    Ok(model_to_namespace(model))
}

pub async fn create_namespace(
    db: &DatabaseConnection,
    input: CreateMemoryNamespaceInput,
) -> Result<MemoryNamespace> {
    let id = gen_id();

    let activation_mode = normalize_activation_mode(input.activation_mode.as_deref())?;
    let am = memory_namespaces::ActiveModel {
        id: Set(id.clone()),
        name: Set(input.name),
        scope: Set(input.scope),
        embedding_provider: Set(input.embedding_provider),
        embedding_dimensions: Set(input.embedding_dimensions),
        retrieval_threshold: Set(input.retrieval_threshold),
        retrieval_top_k: Set(input.retrieval_top_k),
        icon_type: Set(input.icon_type),
        icon_value: Set(input.icon_value),
        sort_order: Set(0),
        activation_mode: Set(activation_mode),
        migration_review_required: Set(0),
    };

    am.insert(db).await?;

    get_namespace(db, &id).await
}

pub async fn delete_namespace(db: &DatabaseConnection, id: &str) -> Result<()> {
    let result = memory_namespaces::Entity::delete_by_id(id).exec(db).await?;

    if result.rows_affected == 0 {
        return Err(AQBotError::NotFound(format!("MemoryNamespace {}", id)));
    }
    Ok(())
}

pub async fn update_namespace(
    db: &DatabaseConnection,
    id: &str,
    input: UpdateMemoryNamespaceInput,
) -> Result<MemoryNamespace> {
    let model = memory_namespaces::Entity::find_by_id(id)
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("MemoryNamespace {}", id)))?;

    let mut am: memory_namespaces::ActiveModel = model.clone().into();
    if let Some(name) = input.name {
        am.name = Set(name);
    }
    if input.update_embedding_provider {
        am.embedding_provider = Set(input.embedding_provider);
    }
    if input.update_embedding_dimensions {
        am.embedding_dimensions = Set(input.embedding_dimensions);
    }
    if input.update_retrieval_threshold {
        am.retrieval_threshold = Set(input.retrieval_threshold);
    }
    if input.update_retrieval_top_k {
        am.retrieval_top_k = Set(input.retrieval_top_k);
    }
    if input.update_icon {
        am.icon_type = Set(input.icon_type);
        am.icon_value = Set(input.icon_value);
    }
    if let Some(sort_order) = input.sort_order {
        am.sort_order = Set(sort_order);
    }
    if input.update_activation_mode {
        am.activation_mode = Set(normalize_activation_mode(input.activation_mode.as_deref())?);
    }
    if input.update_migration_review_required {
        am.migration_review_required = Set(if input.migration_review_required.unwrap_or(false) {
            1
        } else {
            0
        });
    }
    am.update(db).await?;

    get_namespace(db, id).await
}

pub async fn reorder_namespaces(db: &DatabaseConnection, namespace_ids: &[String]) -> Result<()> {
    for (i, id) in namespace_ids.iter().enumerate() {
        if id == MEMORY_L1_SIDEBAR_ID {
            set_l1_sort_order(db, i as i32).await?;
            continue;
        }
        memory_namespaces::Entity::update_many()
            .col_expr(memory_namespaces::Column::SortOrder, Expr::value(i as i32))
            .filter(memory_namespaces::Column::Id.eq(id))
            .exec(db)
            .await?;
    }
    Ok(())
}

pub async fn set_l1_sort_order(db: &DatabaseConnection, sort_order: i32) -> Result<()> {
    memory_l1::Entity::update_many()
        .col_expr(memory_l1::Column::SortOrder, Expr::value(sort_order))
        .filter(memory_l1::Column::Id.eq(MEMORY_L1_ID))
        .exec(db)
        .await?;
    Ok(())
}

pub async fn list_items(db: &DatabaseConnection, namespace_id: &str) -> Result<Vec<MemoryItem>> {
    let models = memory_items::Entity::find()
        .filter(memory_items::Column::NamespaceId.eq(namespace_id))
        .order_by_desc(memory_items::Column::UpdatedAt)
        .all(db)
        .await?;

    Ok(models.into_iter().map(model_to_item).collect())
}

pub async fn add_item(db: &DatabaseConnection, input: CreateMemoryItemInput) -> Result<MemoryItem> {
    let id = gen_id();
    let source = input.source.unwrap_or_else(|| "manual".to_string());

    let am = memory_items::ActiveModel {
        id: Set(id.clone()),
        namespace_id: Set(input.namespace_id),
        title: Set(input.title),
        content: Set(input.content),
        source: Set(source),
        ..Default::default()
    };

    am.insert(db).await?;

    let model = memory_items::Entity::find_by_id(&id)
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("MemoryItem {}", id)))?;

    Ok(model_to_item(model))
}

pub async fn delete_item(db: &DatabaseConnection, id: &str) -> Result<()> {
    let result = memory_items::Entity::delete_by_id(id).exec(db).await?;

    if result.rows_affected == 0 {
        return Err(AQBotError::NotFound(format!("MemoryItem {}", id)));
    }
    Ok(())
}

pub async fn update_item(
    db: &DatabaseConnection,
    id: &str,
    input: UpdateMemoryItemInput,
) -> Result<MemoryItem> {
    let model = memory_items::Entity::find_by_id(id)
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("MemoryItem {}", id)))?;

    let mut am: memory_items::ActiveModel = model.into();
    if let Some(title) = input.title {
        am.title = Set(title);
    }
    if let Some(content) = input.content {
        am.content = Set(content);
        // Content changed — reset index status to pending
        am.index_status = Set("pending".to_string());
    }
    am.updated_at = Set(chrono::Utc::now().to_rfc3339());
    am.update(db).await?;

    let updated = memory_items::Entity::find_by_id(id)
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("MemoryItem {}", id)))?;

    Ok(model_to_item(updated))
}

pub async fn update_item_index_status(
    db: &DatabaseConnection,
    id: &str,
    status: &str,
    error: Option<&str>,
) -> Result<()> {
    let model = memory_items::Entity::find_by_id(id)
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("MemoryItem {}", id)))?;

    let mut am: memory_items::ActiveModel = model.into();
    am.index_status = Set(status.to_string());
    am.index_error = Set(error.map(|e| e.to_string()));
    am.update(db).await?;

    Ok(())
}

pub async fn get_l1(db: &DatabaseConnection) -> Result<MemoryL1> {
    if let Some(model) = memory_l1::Entity::find_by_id(MEMORY_L1_ID).one(db).await? {
        return Ok(model_to_l1(model));
    }

    let now = chrono::Utc::now().to_rfc3339();
    let am = memory_l1::ActiveModel {
        id: Set(MEMORY_L1_ID.to_string()),
        enabled: Set(1),
        markdown: Set(String::new()),
        revision: Set(0),
        sort_order: Set(0),
        updated_at: Set(now.clone()),
    };
    am.insert(db).await?;
    Ok(MemoryL1 {
        enabled: true,
        markdown: String::new(),
        revision: 0,
        sort_order: 0,
        updated_at: now,
    })
}

pub async fn save_l1(db: &DatabaseConnection, input: SaveMemoryL1Input) -> Result<MemoryL1> {
    let bytes = input.markdown.len();
    if bytes > MEMORY_L1_MAX_BYTES {
        return Err(coded_error(
            "MEMORY_L1_TOO_LARGE",
            serde_json::json!({ "limit": MEMORY_L1_MAX_BYTES, "bytes": bytes }),
        ));
    }

    let current = memory_l1::Entity::find_by_id(MEMORY_L1_ID)
        .one(db)
        .await?
        .ok_or_else(|| {
            coded_error(
                "MEMORY_L1_READ_FAILED",
                serde_json::json!({ "reason": "missing" }),
            )
        })?;

    if current.revision != input.revision {
        return Err(coded_error(
            "MEMORY_L1_REVISION_CONFLICT",
            serde_json::json!({
                "expected": input.revision,
                "actual": current.revision
            }),
        ));
    }

    let next_revision = current.revision + 1;
    let now = chrono::Utc::now().to_rfc3339();
    let mut am: memory_l1::ActiveModel = current.into();
    am.enabled = Set(if input.enabled { 1 } else { 0 });
    am.markdown = Set(input.markdown);
    am.revision = Set(next_revision);
    am.updated_at = Set(now);
    am.update(db).await?;
    get_l1(db).await
}

pub async fn list_items_in_namespaces(
    db: &DatabaseConnection,
    namespace_ids: &[String],
) -> Result<Vec<MemoryItem>> {
    if namespace_ids.is_empty() {
        return Ok(Vec::new());
    }
    let models = memory_items::Entity::find()
        .filter(memory_items::Column::NamespaceId.is_in(namespace_ids.to_vec()))
        .order_by_desc(memory_items::Column::UpdatedAt)
        .all(db)
        .await?;
    Ok(models.into_iter().map(model_to_item).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::create_test_pool;

    #[tokio::test]
    async fn l1_initializes_empty_and_enabled() {
        let db = create_test_pool().await.unwrap().conn;
        let l1 = get_l1(&db).await.unwrap();
        assert!(l1.enabled);
        assert!(l1.markdown.is_empty());
        assert_eq!(l1.revision, 0);
        assert_eq!(l1.sort_order, 0);
    }

    #[tokio::test]
    async fn l1_save_increments_revision_and_rejects_stale() {
        let db = create_test_pool().await.unwrap().conn;
        let saved = save_l1(
            &db,
            SaveMemoryL1Input {
                enabled: true,
                markdown: "I live in Shanghai".into(),
                revision: 0,
            },
        )
        .await
        .unwrap();
        assert_eq!(saved.revision, 1);
        assert_eq!(saved.markdown, "I live in Shanghai");

        let conflict = save_l1(
            &db,
            SaveMemoryL1Input {
                enabled: true,
                markdown: "stale".into(),
                revision: 0,
            },
        )
        .await
        .unwrap_err();
        assert!(conflict.to_string().contains("MEMORY_L1_REVISION_CONFLICT"));
    }

    #[tokio::test]
    async fn l1_rejects_payloads_over_5000_utf8_bytes() {
        let db = create_test_pool().await.unwrap().conn;
        let markdown = "你".repeat(MEMORY_L1_MAX_BYTES / 3 + 1);
        assert!(markdown.len() > MEMORY_L1_MAX_BYTES);
        let err = save_l1(
            &db,
            SaveMemoryL1Input {
                enabled: true,
                markdown,
                revision: 0,
            },
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("MEMORY_L1_TOO_LARGE"));
    }

    #[tokio::test]
    async fn new_namespace_defaults_to_tool_only_without_embedding() {
        let db = create_test_pool().await.unwrap().conn;
        let ns = create_namespace(
            &db,
            CreateMemoryNamespaceInput {
                name: "Notes".into(),
                scope: "global".into(),
                embedding_provider: None,
                embedding_dimensions: None,
                retrieval_threshold: None,
                retrieval_top_k: None,
                icon_type: None,
                icon_value: None,
                activation_mode: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(ns.activation_mode, MEMORY_ACTIVATION_TOOL_ONLY);
        assert!(!ns.migration_review_required);
        assert!(ns.embedding_provider.is_none());
    }

    #[tokio::test]
    async fn existing_provider_namespaces_migrate_to_auto() {
        let db = create_test_pool().await.unwrap().conn;
        db.execute_unprepared(
            "INSERT INTO memory_namespaces
             (id, name, scope, embedding_provider, sort_order, activation_mode, migration_review_required)
             VALUES ('ns-remote', 'Old', 'global', 'prov::model', 0, 'tool_only', 0)",
        )
        .await
        .unwrap();
        // Re-run the migration update logic used for existing rows.
        db.execute_unprepared(
            "UPDATE memory_namespaces
             SET activation_mode = 'auto', migration_review_required = 0
             WHERE embedding_provider IS NOT NULL AND trim(embedding_provider) != ''",
        )
        .await
        .unwrap();
        let ns = get_namespace(&db, "ns-remote").await.unwrap();
        assert_eq!(ns.activation_mode, MEMORY_ACTIVATION_AUTO);
        assert!(!ns.migration_review_required);
    }

    #[tokio::test]
    async fn reorder_accepts_l1_sidebar_id() {
        let db = create_test_pool().await.unwrap().conn;
        let first = create_namespace(
            &db,
            CreateMemoryNamespaceInput {
                name: "First".into(),
                scope: "global".into(),
                embedding_provider: None,
                embedding_dimensions: None,
                retrieval_threshold: None,
                retrieval_top_k: None,
                icon_type: None,
                icon_value: None,
                activation_mode: None,
            },
        )
        .await
        .unwrap();
        let second = create_namespace(
            &db,
            CreateMemoryNamespaceInput {
                name: "Second".into(),
                scope: "global".into(),
                embedding_provider: None,
                embedding_dimensions: None,
                retrieval_threshold: None,
                retrieval_top_k: None,
                icon_type: None,
                icon_value: None,
                activation_mode: None,
            },
        )
        .await
        .unwrap();
        get_l1(&db).await.unwrap();
        reorder_namespaces(
            &db,
            &[
                first.id.clone(),
                MEMORY_L1_SIDEBAR_ID.to_string(),
                second.id.clone(),
            ],
        )
        .await
        .unwrap();
        let namespaces = list_namespaces(&db).await.unwrap();
        assert_eq!(namespaces[0].id, first.id);
        assert_eq!(namespaces[0].sort_order, 0);
        assert_eq!(namespaces[1].id, second.id);
        assert_eq!(namespaces[1].sort_order, 2);
        assert_eq!(get_l1(&db).await.unwrap().sort_order, 1);
    }
}
