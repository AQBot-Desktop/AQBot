//! Turn-time context assembly for chat (L1 injection, L2 tools, RAG routing).

mod memory_tool;
mod text_match;

pub use memory_tool::{
    bind_memory_tool, execute_memory_tool, memory_tool_definition, MemoryToolBinding,
    MemoryToolScope, MEMORY_TOOL_NAME,
};

use sea_orm::DatabaseConnection;
use serde_json::json;

use crate::error::{coded_error, AQBotError, Result};
use crate::repo::memory;
use crate::types::{ContextDiagnostic, MEMORY_ACTIVATION_AUTO, MEMORY_ACTIVATION_TOOL_ONLY};

#[derive(Debug, Clone)]
pub struct PrepareTurnRequest<'a> {
    pub enabled_knowledge_base_ids: &'a [String],
    pub enabled_memory_namespace_ids: &'a [String],
    pub inject_l1: bool,
    pub model_supports_tools: bool,
}

#[derive(Debug, Clone)]
pub struct PreparedTurn {
    pub l1_system_message: Option<String>,
    pub auto_memory_ids: Vec<String>,
    pub knowledge_ids: Vec<String>,
    pub memory_tool: Option<MemoryToolBinding>,
    pub diagnostics: Vec<ContextDiagnostic>,
}

pub async fn prepare_turn(
    db: &DatabaseConnection,
    request: PrepareTurnRequest<'_>,
) -> Result<PreparedTurn> {
    let l1_system_message = if request.inject_l1 {
        let l1 = memory::get_l1(db)
            .await
            .map_err(|_| coded_error("MEMORY_L1_READ_FAILED", json!({})))?;
        if l1.enabled && !l1.markdown.trim().is_empty() {
            Some(format!(
                "Always-on user memory (L1). Treat these as durable facts about the user unless contradicted:\n\n{}",
                l1.markdown
            ))
        } else {
            None
        }
    } else {
        None
    };

    let mut auto_memory_ids = Vec::new();
    let mut tool_namespace_ids = Vec::new();
    let mut diagnostics = Vec::new();

    for id in request.enabled_memory_namespace_ids {
        let ns = match memory::get_namespace(db, id).await {
            Ok(ns) => ns,
            Err(AQBotError::NotFound(_)) => {
                diagnostics.push(ContextDiagnostic {
                    code: "MEMORY_NAMESPACE_MISSING".into(),
                    source_type: "memory".into(),
                    container_id: Some(id.clone()),
                    args: json!({}),
                });
                continue;
            }
            Err(err) => return Err(err),
        };

        if ns.migration_review_required {
            diagnostics.push(ContextDiagnostic {
                code: "MEMORY_MIGRATION_REVIEW_REQUIRED".into(),
                source_type: "memory".into(),
                container_id: Some(ns.id),
                args: json!({}),
            });
            continue;
        }

        let has_embedding = ns
            .embedding_provider
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty());

        match ns.activation_mode.as_str() {
            MEMORY_ACTIVATION_AUTO if has_embedding => auto_memory_ids.push(ns.id),
            MEMORY_ACTIVATION_AUTO => {
                diagnostics.push(ContextDiagnostic {
                    code: "MEMORY_NEEDS_ENGINE".into(),
                    source_type: "memory".into(),
                    container_id: Some(ns.id),
                    args: json!({}),
                });
            }
            MEMORY_ACTIVATION_TOOL_ONLY | _ => tool_namespace_ids.push(ns.id),
        }
    }

    if !tool_namespace_ids.is_empty() && !request.model_supports_tools {
        return Err(coded_error(
            "TOOL_CAPABILITY_REQUIRED",
            json!({ "namespaces": tool_namespace_ids }),
        ));
    }

    Ok(PreparedTurn {
        l1_system_message,
        auto_memory_ids,
        knowledge_ids: request.enabled_knowledge_base_ids.to_vec(),
        memory_tool: bind_memory_tool(tool_namespace_ids),
        diagnostics,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::create_test_pool;
    use crate::types::{CreateMemoryItemInput, CreateMemoryNamespaceInput, SaveMemoryL1Input};

    async fn fixture() -> sea_orm::DatabaseConnection {
        create_test_pool().await.unwrap().conn
    }

    #[tokio::test]
    async fn prepare_turn_injects_l1_after_it_is_saved() {
        let db = fixture().await;
        memory::save_l1(
            &db,
            SaveMemoryL1Input {
                enabled: true,
                markdown: "Name: Ada".into(),
                revision: 0,
            },
        )
        .await
        .unwrap();

        let prepared = prepare_turn(
            &db,
            PrepareTurnRequest {
                enabled_knowledge_base_ids: &[],
                enabled_memory_namespace_ids: &[],
                inject_l1: true,
                model_supports_tools: true,
            },
        )
        .await
        .unwrap();
        assert!(prepared
            .l1_system_message
            .as_deref()
            .unwrap()
            .contains("Name: Ada"));
    }

    #[tokio::test]
    async fn prepare_turn_skips_empty_or_disabled_l1() {
        let db = fixture().await;
        let empty = prepare_turn(
            &db,
            PrepareTurnRequest {
                enabled_knowledge_base_ids: &[],
                enabled_memory_namespace_ids: &[],
                inject_l1: true,
                model_supports_tools: true,
            },
        )
        .await
        .unwrap();
        assert!(empty.l1_system_message.is_none());

        memory::save_l1(
            &db,
            SaveMemoryL1Input {
                enabled: false,
                markdown: "hidden".into(),
                revision: 0,
            },
        )
        .await
        .unwrap();
        let disabled = prepare_turn(
            &db,
            PrepareTurnRequest {
                enabled_knowledge_base_ids: &[],
                enabled_memory_namespace_ids: &[],
                inject_l1: true,
                model_supports_tools: true,
            },
        )
        .await
        .unwrap();
        assert!(disabled.l1_system_message.is_none());
    }

    #[tokio::test]
    async fn prepare_turn_does_not_inject_l1_for_external_agents() {
        let db = fixture().await;
        memory::save_l1(
            &db,
            SaveMemoryL1Input {
                enabled: true,
                markdown: "secret".into(),
                revision: 0,
            },
        )
        .await
        .unwrap();
        let prepared = prepare_turn(
            &db,
            PrepareTurnRequest {
                enabled_knowledge_base_ids: &[],
                enabled_memory_namespace_ids: &[],
                inject_l1: false,
                model_supports_tools: true,
            },
        )
        .await
        .unwrap();
        assert!(prepared.l1_system_message.is_none());
    }

    #[tokio::test]
    async fn tool_only_memory_requires_function_calling() {
        let db = fixture().await;
        let ns = memory::create_namespace(
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
        let err = prepare_turn(
            &db,
            PrepareTurnRequest {
                enabled_knowledge_base_ids: &[],
                enabled_memory_namespace_ids: &[ns.id],
                inject_l1: true,
                model_supports_tools: false,
            },
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("TOOL_CAPABILITY_REQUIRED"));
    }

    #[tokio::test]
    async fn missing_namespace_is_diagnostic_not_error() {
        let db = fixture().await;
        let prepared = prepare_turn(
            &db,
            PrepareTurnRequest {
                enabled_knowledge_base_ids: &[],
                enabled_memory_namespace_ids: &["missing-ns".into()],
                inject_l1: false,
                model_supports_tools: true,
            },
        )
        .await
        .unwrap();
        assert_eq!(prepared.diagnostics[0].code, "MEMORY_NAMESPACE_MISSING");
        assert!(prepared.memory_tool.is_none());
        assert!(prepared.auto_memory_ids.is_empty());
    }

    #[tokio::test]
    async fn review_required_namespaces_are_not_opened() {
        let db = fixture().await;
        let ns = memory::create_namespace(
            &db,
            CreateMemoryNamespaceInput {
                name: "Legacy".into(),
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
        memory::update_namespace(
            &db,
            &ns.id,
            crate::types::UpdateMemoryNamespaceInput {
                name: None,
                embedding_provider: None,
                update_embedding_provider: false,
                embedding_dimensions: None,
                update_embedding_dimensions: false,
                retrieval_threshold: None,
                update_retrieval_threshold: false,
                retrieval_top_k: None,
                update_retrieval_top_k: false,
                icon_type: None,
                icon_value: None,
                update_icon: false,
                sort_order: None,
                activation_mode: None,
                update_activation_mode: false,
                migration_review_required: Some(true),
                update_migration_review_required: true,
            },
        )
        .await
        .unwrap();

        let prepared = prepare_turn(
            &db,
            PrepareTurnRequest {
                enabled_knowledge_base_ids: &[],
                enabled_memory_namespace_ids: &[ns.id],
                inject_l1: true,
                model_supports_tools: false,
            },
        )
        .await
        .unwrap();
        assert!(prepared.memory_tool.is_none());
        assert_eq!(
            prepared.diagnostics[0].code,
            "MEMORY_MIGRATION_REVIEW_REQUIRED"
        );
    }

    #[tokio::test]
    async fn memory_tool_cannot_read_outside_scope() {
        let db = fixture().await;
        let allowed = memory::create_namespace(
            &db,
            CreateMemoryNamespaceInput {
                name: "Allowed".into(),
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
        let denied = memory::create_namespace(
            &db,
            CreateMemoryNamespaceInput {
                name: "Denied".into(),
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
        let secret = memory::add_item(
            &db,
            CreateMemoryItemInput {
                namespace_id: denied.id,
                title: "Secret".into(),
                content: "do not leak".into(),
                source: None,
            },
        )
        .await
        .unwrap();

        let err = execute_memory_tool(
            &db,
            &MemoryToolScope {
                namespace_ids: vec![allowed.id],
            },
            json!({ "action": "read", "item_id": secret.id }),
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("MEMORY_TOOL_ITEM_NOT_FOUND"));
    }

    #[tokio::test]
    async fn memory_tool_search_is_unicode_normalized() {
        let db = fixture().await;
        let ns = memory::create_namespace(
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
        memory::add_item(
            &db,
            CreateMemoryItemInput {
                namespace_id: ns.id.clone(),
                title: "Café".into(),
                content: "Fullwidth ＡＢＣ notes".into(),
                source: None,
            },
        )
        .await
        .unwrap();

        let result = execute_memory_tool(
            &db,
            &MemoryToolScope {
                namespace_ids: vec![ns.id],
            },
            json!({ "action": "search", "query": "abc" }),
        )
        .await
        .unwrap();
        assert!(result.contains("Café") || result.contains("Cafe") || result.contains("ABC"));
    }
}
