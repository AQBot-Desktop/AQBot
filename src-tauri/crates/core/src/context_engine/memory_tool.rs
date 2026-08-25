use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{coded_error, Result};
use crate::repo::memory;
use crate::types::{ChatTool, ChatToolFunction, MemoryItem, MemoryNamespace};
use sea_orm::DatabaseConnection;

use super::text_match::text_matches;

pub const MEMORY_TOOL_NAME: &str = "aqbot_memory";
const DEFAULT_PAGE: u64 = 20;
const MAX_PAGE: u64 = 50;
const PREVIEW_CHARS: usize = 160;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryToolScope {
    pub namespace_ids: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct MemoryToolBinding {
    pub scope: MemoryToolScope,
    pub tool: ChatTool,
}

#[derive(Debug, Deserialize)]
struct MemoryToolArgs {
    action: String,
    query: Option<String>,
    item_id: Option<String>,
    offset: Option<u64>,
    limit: Option<u64>,
}

pub fn memory_tool_definition() -> ChatTool {
    ChatTool {
        r#type: "function".to_string(),
        function: ChatToolFunction {
            name: MEMORY_TOOL_NAME.to_string(),
            description: Some(
                "Read the user's bound memory notebooks. Use browse to list entries, search to find text, and read to load a full entry by id. Writing memory is not allowed.".into(),
            ),
            parameters: Some(json!({
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["browse", "search", "read"] },
                    "query": { "type": "string" },
                    "item_id": { "type": "string" },
                    "offset": { "type": "integer", "minimum": 0 },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 50 }
                },
                "required": ["action"]
            })),
        },
    }
}

pub fn bind_memory_tool(namespace_ids: Vec<String>) -> Option<MemoryToolBinding> {
    if namespace_ids.is_empty() {
        return None;
    }
    Some(MemoryToolBinding {
        scope: MemoryToolScope { namespace_ids },
        tool: memory_tool_definition(),
    })
}

pub async fn execute_memory_tool(
    db: &DatabaseConnection,
    scope: &MemoryToolScope,
    arguments: Value,
) -> Result<String> {
    let args: MemoryToolArgs = serde_json::from_value(arguments).map_err(|_| {
        coded_error(
            "MEMORY_TOOL_INVALID_ACTION",
            json!({ "reason": "invalid_arguments" }),
        )
    })?;

    match args.action.as_str() {
        "browse" => browse(db, scope, args.offset.unwrap_or(0), page_size(args.limit)).await,
        "search" => {
            let query = args.query.unwrap_or_default();
            if query.trim().is_empty() {
                return Err(coded_error(
                    "MEMORY_TOOL_INVALID_ACTION",
                    json!({ "reason": "query_required" }),
                ));
            }
            search(
                db,
                scope,
                &query,
                args.offset.unwrap_or(0),
                page_size(args.limit),
            )
            .await
        }
        "read" => {
            let item_id = args.item_id.unwrap_or_default();
            if item_id.trim().is_empty() {
                return Err(coded_error(
                    "MEMORY_TOOL_INVALID_ACTION",
                    json!({ "reason": "item_id_required" }),
                ));
            }
            read(db, scope, &item_id).await
        }
        other => Err(coded_error(
            "MEMORY_TOOL_INVALID_ACTION",
            json!({ "action": other }),
        )),
    }
}

fn page_size(limit: Option<u64>) -> u64 {
    limit.unwrap_or(DEFAULT_PAGE).clamp(1, MAX_PAGE)
}

fn preview(content: &str) -> String {
    let chars: Vec<char> = content.chars().collect();
    if chars.len() <= PREVIEW_CHARS {
        return content.to_string();
    }
    chars.into_iter().take(PREVIEW_CHARS).collect::<String>() + "…"
}

fn item_in_scope(item: &MemoryItem, scope: &MemoryToolScope) -> bool {
    scope
        .namespace_ids
        .iter()
        .any(|id| id == &item.namespace_id)
}

async fn scoped_items(
    db: &DatabaseConnection,
    scope: &MemoryToolScope,
) -> Result<Vec<(MemoryNamespace, MemoryItem)>> {
    let mut namespaces = Vec::new();
    for id in &scope.namespace_ids {
        namespaces.push(memory::get_namespace(db, id).await?);
    }
    let items = memory::list_items_in_namespaces(db, &scope.namespace_ids).await?;
    Ok(items
        .into_iter()
        .filter_map(|item| {
            let ns = namespaces
                .iter()
                .find(|ns| ns.id == item.namespace_id)?
                .clone();
            Some((ns, item))
        })
        .collect())
}

fn page_json(rows: Vec<Value>, offset: u64, total: usize) -> String {
    json!({
        "offset": offset,
        "total": total,
        "items": rows
    })
    .to_string()
}

async fn browse(
    db: &DatabaseConnection,
    scope: &MemoryToolScope,
    offset: u64,
    limit: u64,
) -> Result<String> {
    let items = scoped_items(db, scope).await?;
    let total = items.len();
    let start = offset as usize;
    let rows = items
        .into_iter()
        .skip(start)
        .take(limit as usize)
        .map(|(ns, item)| {
            json!({
                "id": item.id,
                "title": item.title,
                "preview": preview(&item.content),
                "namespace": ns.name
            })
        })
        .collect();
    Ok(page_json(rows, offset, total))
}

async fn search(
    db: &DatabaseConnection,
    scope: &MemoryToolScope,
    query: &str,
    offset: u64,
    limit: u64,
) -> Result<String> {
    let items = scoped_items(db, scope).await?;
    let matched: Vec<_> = items
        .into_iter()
        .filter(|(_, item)| text_matches(&item.title, query) || text_matches(&item.content, query))
        .collect();
    let total = matched.len();
    let start = offset as usize;
    let rows = matched
        .into_iter()
        .skip(start)
        .take(limit as usize)
        .map(|(ns, item)| {
            json!({
                "id": item.id,
                "title": item.title,
                "preview": preview(&item.content),
                "namespace": ns.name,
                "match": "text"
            })
        })
        .collect();
    Ok(page_json(rows, offset, total))
}

async fn read(db: &DatabaseConnection, scope: &MemoryToolScope, item_id: &str) -> Result<String> {
    let items = memory::list_items_in_namespaces(db, &scope.namespace_ids).await?;
    let item = items.into_iter().find(|item| item.id == item_id);
    let Some(item) = item else {
        // Distinguish missing vs out of scope: look up globally via all scoped lists only.
        return Err(coded_error(
            "MEMORY_TOOL_ITEM_NOT_FOUND",
            json!({ "itemId": item_id }),
        ));
    };
    if !item_in_scope(&item, scope) {
        return Err(coded_error(
            "MEMORY_TOOL_SCOPE_DENIED",
            json!({ "itemId": item_id }),
        ));
    }
    Ok(json!({
        "id": item.id,
        "title": item.title,
        "content": item.content,
        "updatedAt": item.updated_at
    })
    .to_string())
}
