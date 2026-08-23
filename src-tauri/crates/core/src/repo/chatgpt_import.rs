use sea_orm::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::Read;
use std::path::Path;

use crate::entity::{conversations, import_jobs, messages};
use crate::error::{AQBotError, Result};
use crate::repo::settings::get_settings;
use crate::types::ContextStrategy;
use crate::utils::{gen_id, now_ts};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChatGptImportWarning {
    pub code: String,
    pub message: String,
    pub source_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ChatGptImportSummary {
    pub conversation_count: u32,
    pub message_count: u32,
    pub skipped_empty_conversation_count: u32,
    pub duplicate_conversation_count: u32,
    pub warnings: Vec<ChatGptImportWarning>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ChatGptImportResult {
    pub imported_conversation_count: u32,
    pub imported_message_count: u32,
    pub skipped_duplicate_conversation_count: u32,
    pub warnings: Vec<ChatGptImportWarning>,
}

#[derive(Debug, Clone, Deserialize, Default)]
struct ChatGptConversation {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    create_time: Option<Value>,
    #[serde(default)]
    update_time: Option<Value>,
    #[serde(default)]
    current_node: Option<String>,
    #[serde(default)]
    mapping: HashMap<String, ChatGptNode>,
}

#[derive(Debug, Clone, Deserialize, Default)]
struct ChatGptNode {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    message: Option<ChatGptMessage>,
    #[serde(default)]
    parent: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
struct ChatGptMessage {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    author: Option<ChatGptAuthor>,
    #[serde(default)]
    create_time: Option<Value>,
    #[serde(default)]
    content: Option<ChatGptContent>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    metadata: HashMap<String, Value>,
}

#[derive(Debug, Clone, Deserialize, Default)]
struct ChatGptAuthor {
    #[serde(default)]
    role: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
struct ChatGptContent {
    #[serde(default)]
    content_type: Option<String>,
    #[serde(default)]
    parts: Vec<Value>,
    #[serde(default)]
    text: Option<String>,
}

struct MaterializedConversation {
    id: String,
    title: String,
    created_at: i64,
    updated_at: i64,
    messages: Vec<MaterializedMessage>,
    warnings: Vec<ChatGptImportWarning>,
}

struct MaterializedMessage {
    id: String,
    role: String,
    content: String,
    created_at: i64,
    status: String,
}

pub async fn scan_chatgpt_import_from_path(
    db: &DatabaseConnection,
    path: &Path,
) -> Result<ChatGptImportSummary> {
    let conversations = parse_chatgpt_export(path)?;
    let mut summary = ChatGptImportSummary::default();

    for (index, conversation) in conversations.iter().enumerate() {
        let materialized = materialize_conversation(conversation, index);
        summary.warnings.extend(materialized.warnings);
        if materialized.messages.is_empty() {
            summary.skipped_empty_conversation_count += 1;
            continue;
        }
        summary.conversation_count += 1;
        summary.message_count += materialized.messages.len() as u32;
        if conversations::Entity::find_by_id(&materialized.id)
            .one(db)
            .await?
            .is_some()
        {
            summary.duplicate_conversation_count += 1;
        }
    }

    Ok(summary)
}

pub async fn import_chatgpt_export_from_path(
    db: &DatabaseConnection,
    path: &Path,
) -> Result<ChatGptImportResult> {
    let conversations = parse_chatgpt_export(path)?;
    let settings = get_settings(db).await.unwrap_or_default();
    let fallback_provider_id = settings
        .default_provider_id
        .clone()
        .unwrap_or_else(|| "chatgpt-export".to_string());
    let fallback_model_id = settings
        .default_model_id
        .clone()
        .unwrap_or_else(|| "unknown-model".to_string());
    let txn = db.begin().await?;
    let mut result = ChatGptImportResult::default();

    for (index, conversation) in conversations.iter().enumerate() {
        let materialized = materialize_conversation(conversation, index);
        result.warnings.extend(materialized.warnings);
        if materialized.messages.is_empty() {
            continue;
        }
        if conversations::Entity::find_by_id(&materialized.id)
            .one(&txn)
            .await?
            .is_some()
        {
            result.skipped_duplicate_conversation_count += 1;
            continue;
        }

        conversations::ActiveModel {
            id: Set(materialized.id.clone()),
            title: Set(materialized.title),
            model_id: Set(fallback_model_id.clone()),
            provider_id: Set(fallback_provider_id.clone()),
            system_prompt: Set(None),
            temperature: Set(None),
            max_tokens: Set(None),
            top_p: Set(None),
            frequency_penalty: Set(None),
            search_enabled: Set(0),
            search_provider_id: Set(None),
            thinking_budget: Set(None),
            thinking_level: Set(None),
            enabled_mcp_server_ids: Set("[]".to_string()),
            enabled_knowledge_base_ids: Set("[]".to_string()),
            enabled_memory_namespace_ids: Set("[]".to_string()),
            message_count: Set(materialized.messages.len() as i32),
            created_at: Set(materialized.created_at),
            updated_at: Set(materialized.updated_at),
            is_pinned: Set(0),
            is_archived: Set(0),
            workspace_snapshot_json: Set("{}".to_string()),
            active_branch_id: Set(None),
            active_artifact_id: Set(None),
            research_mode: Set(0),
            context_compression: Set(0),
            context_strategy_override: Set(Some(
                ContextStrategy::RawTruncate.as_str().to_string(),
            )),
            context_message_limit: Set(None),
            compression_keep_last_n: Set(None),
            multi_model_display_mode_override: Set(None),
            category_id: Set(None),
            parent_conversation_id: Set(None),
            sort_order: Set(0),
            mode: Set("chat".to_string()),
        }
        .insert(&txn)
        .await?;
        result.imported_conversation_count += 1;

        let mut previous_message_id: Option<String> = None;
        for message in materialized.messages {
            messages::ActiveModel {
                id: Set(message.id.clone()),
                conversation_id: Set(materialized.id.clone()),
                role: Set(message.role),
                content: Set(message.content),
                provider_id: Set(Some(fallback_provider_id.clone())),
                model_id: Set(Some(fallback_model_id.clone())),
                token_count: Set(None),
                prompt_tokens: Set(None),
                completion_tokens: Set(None),
                attachments: Set("[]".to_string()),
                thinking: Set(None),
                created_at: Set(message.created_at),
                branch_id: Set(None),
                parent_message_id: Set(previous_message_id.clone()),
                version_index: Set(0),
                is_active: Set(1),
                tool_calls_json: Set(None),
                tool_call_id: Set(None),
                status: Set(message.status),
                tokens_per_second: Set(None),
                first_token_latency_ms: Set(None),
            }
            .insert(&txn)
            .await?;
            previous_message_id = Some(message.id);
            result.imported_message_count += 1;
        }
    }

    import_jobs::ActiveModel {
        id: Set(gen_id()),
        source_type: Set("chatgpt_export".to_string()),
        status: Set("success".to_string()),
        summary_json: Set(Some(serde_json::to_string(&result).unwrap_or_default())),
        conflict_count: Set(result.skipped_duplicate_conversation_count as i32),
        created_at: Set(chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string()),
    }
    .insert(&txn)
    .await?;

    txn.commit().await?;
    Ok(result)
}

fn parse_chatgpt_export(path: &Path) -> Result<Vec<ChatGptConversation>> {
    let bytes = if path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("zip"))
    {
        read_conversations_json_from_zip(path)?
    } else {
        std::fs::read(path)?
    };
    let value = serde_json::from_slice::<Value>(&bytes).map_err(|e| {
        AQBotError::Validation(format!("Invalid ChatGPT conversations.json: {e}"))
    })?;
    let conversations_value = value.get("conversations").cloned().unwrap_or(value);
    serde_json::from_value::<Vec<ChatGptConversation>>(conversations_value).map_err(|e| {
        AQBotError::Validation(format!("Invalid ChatGPT conversations.json structure: {e}"))
    })
}

fn read_conversations_json_from_zip(path: &Path) -> Result<Vec<u8>> {
    let file = File::open(path)?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| AQBotError::Validation(format!("Invalid ChatGPT zip export: {e}")))?;
    let mut entry = archive
        .by_name("conversations.json")
        .map_err(|_| AQBotError::Validation("ChatGPT export is missing conversations.json".into()))?;
    let mut data = Vec::new();
    entry.read_to_end(&mut data)?;
    Ok(data)
}

fn materialize_conversation(
    conversation: &ChatGptConversation,
    index: usize,
) -> MaterializedConversation {
    let source_id = non_empty(conversation.id.as_deref())
        .map(str::to_string)
        .unwrap_or_else(|| format!("conversation-{index}"));
    let id = prefixed_id("chatgpt", &source_id);
    let created_at = parse_chatgpt_ts(conversation.create_time.as_ref()).unwrap_or_else(now_ts);
    let updated_at = parse_chatgpt_ts(conversation.update_time.as_ref()).unwrap_or(created_at);
    let title = non_empty(conversation.title.as_deref())
        .unwrap_or("ChatGPT Chat")
        .to_string();
    let mut warnings = Vec::new();
    let mut seen = HashSet::new();
    let messages = ordered_node_ids(conversation)
        .into_iter()
        .filter_map(|node_id| {
            let node = conversation.mapping.get(&node_id)?;
            let message = node.message.as_ref()?;
            let source_message_id = non_empty(message.id.as_deref())
                .or_else(|| non_empty(node.id.as_deref()))
                .unwrap_or(node_id.as_str());
            if !seen.insert(source_message_id.to_string()) {
                return None;
            }
            materialize_message(message, source_message_id, &mut warnings)
        })
        .collect();

    MaterializedConversation {
        id,
        title,
        created_at,
        updated_at,
        messages,
        warnings,
    }
}

fn ordered_node_ids(conversation: &ChatGptConversation) -> Vec<String> {
    if let Some(current_node) = non_empty(conversation.current_node.as_deref()) {
        let mut ids = Vec::new();
        let mut seen = HashSet::new();
        let mut cursor = Some(current_node.to_string());
        while let Some(node_id) = cursor {
            if !seen.insert(node_id.clone()) {
                break;
            }
            let Some(node) = conversation.mapping.get(&node_id) else {
                break;
            };
            ids.push(node_id);
            cursor = node.parent.clone().and_then(|parent| non_empty(Some(&parent)).map(str::to_string));
        }
        ids.reverse();
        if ids
            .iter()
            .any(|id| conversation.mapping.get(id).and_then(|node| node.message.as_ref()).is_some())
        {
            return ids;
        }
    }

    let mut nodes = conversation
        .mapping
        .iter()
        .filter(|(_, node)| node.message.is_some())
        .map(|(id, node)| {
            (
                id.clone(),
                node.message
                    .as_ref()
                    .and_then(|message| parse_chatgpt_ts(message.create_time.as_ref()))
                    .unwrap_or(0),
            )
        })
        .collect::<Vec<_>>();
    nodes.sort_by(|left, right| left.1.cmp(&right.1).then_with(|| left.0.cmp(&right.0)));
    nodes.into_iter().map(|(id, _)| id).collect()
}

fn materialize_message(
    message: &ChatGptMessage,
    source_id: &str,
    warnings: &mut Vec<ChatGptImportWarning>,
) -> Option<MaterializedMessage> {
    if metadata_bool(&message.metadata, "is_visually_hidden_from_conversation")
        || metadata_bool(&message.metadata, "is_user_system_message")
    {
        return None;
    }

    let role = map_role(
        message
            .author
            .as_ref()
            .and_then(|author| author.role.as_deref()),
    );
    let content = content_to_markdown(message.content.as_ref(), source_id, warnings);
    if content.trim().is_empty() {
        return None;
    }
    if role == "system" && content.trim().is_empty() {
        return None;
    }

    Some(MaterializedMessage {
        id: prefixed_id("chatgpt", source_id),
        role,
        content,
        created_at: parse_chatgpt_ts(message.create_time.as_ref()).unwrap_or_else(now_ts),
        status: map_status(message.status.as_deref()),
    })
}

fn content_to_markdown(
    content: Option<&ChatGptContent>,
    source_id: &str,
    warnings: &mut Vec<ChatGptImportWarning>,
) -> String {
    let Some(content) = content else {
        return String::new();
    };
    if let Some(text) = non_empty(content.text.as_deref()) {
        return text.to_string();
    }
    if content.parts.is_empty() {
        if let Some(content_type) = non_empty(content.content_type.as_deref()) {
            if content_type != "text" {
                warnings.push(warning(
                    "unsupported_content_type",
                    format!("Unsupported ChatGPT content type '{content_type}' had no text parts."),
                    Some(source_id.to_string()),
                ));
            }
        }
        return String::new();
    }
    content
        .parts
        .iter()
        .filter_map(|part| part_to_markdown(part, source_id, warnings))
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn part_to_markdown(
    part: &Value,
    source_id: &str,
    warnings: &mut Vec<ChatGptImportWarning>,
) -> Option<String> {
    match part {
        Value::String(text) => non_empty(Some(text)).map(str::to_string),
        Value::Object(map) => {
            let part_type = map
                .get("content_type")
                .and_then(Value::as_str)
                .or_else(|| map.get("type").and_then(Value::as_str))
                .unwrap_or("object");
            if matches!(part_type, "text" | "input_text" | "output_text") {
                if let Some(text) = map.get("text").and_then(Value::as_str).and_then(|text| non_empty(Some(text))) {
                    return Some(text.to_string());
                }
            }
            warnings.push(warning(
                "unsupported_content_part",
                format!("Unsupported ChatGPT content part '{part_type}' was preserved as Markdown."),
                Some(source_id.to_string()),
            ));
            Some(format!(
                "### Unsupported ChatGPT content part: {part_type}\n```json\n{}\n```",
                serde_json::to_string(part).unwrap_or_else(|_| part.to_string())
            ))
        }
        Value::Null => None,
        other => {
            warnings.push(warning(
                "unsupported_content_part",
                "Unsupported ChatGPT content part was preserved as Markdown.",
                Some(source_id.to_string()),
            ));
            Some(other.to_string())
        }
    }
}

fn parse_chatgpt_ts(value: Option<&Value>) -> Option<i64> {
    let value = value?;
    let seconds = match value {
        Value::Number(number) => number.as_f64()?,
        Value::String(text) => text
            .parse::<f64>()
            .ok()
            .or_else(|| chrono::DateTime::parse_from_rfc3339(text).ok().map(|value| value.timestamp() as f64))?,
        _ => return None,
    };
    Some(if seconds > 10_000_000_000.0 {
        (seconds / 1000.0) as i64
    } else {
        seconds as i64
    })
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn prefixed_id(prefix: &str, source_id: &str) -> String {
    format!("{prefix}-{source_id}")
}

fn map_role(role: Option<&str>) -> String {
    match role {
        Some("system") => "system",
        Some("user") => "user",
        Some("tool") => "tool",
        _ => "assistant",
    }
    .to_string()
}

fn map_status(status: Option<&str>) -> String {
    match status.unwrap_or("") {
        value if value.contains("error") || value.contains("failed") => "error",
        _ => "complete",
    }
    .to_string()
}

fn metadata_bool(metadata: &HashMap<String, Value>, key: &str) -> bool {
    metadata.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn warning(
    code: impl Into<String>,
    message: impl Into<String>,
    source_id: Option<String>,
) -> ChatGptImportWarning {
    ChatGptImportWarning {
        code: code.into(),
        message: message.into(),
        source_id,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::create_test_pool;
    use crate::entity::{conversations, messages};
    use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder};
    use serde_json::json;
    use std::fs::File;
    use std::io::Write;
    use std::path::Path;
    use tempfile::tempdir;
    use zip::write::SimpleFileOptions;

    fn write_chatgpt_zip(path: &Path, data: serde_json::Value) {
        let file = File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        zip.start_file("conversations.json", SimpleFileOptions::default())
            .unwrap();
        zip.write_all(serde_json::to_string(&data).unwrap().as_bytes())
            .unwrap();
        zip.finish().unwrap();
    }

    fn sample_export_json() -> serde_json::Value {
        json!([
            {
                "id": "conv-1",
                "title": "Mainline chat",
                "create_time": 1780000000.0,
                "update_time": 1780000200.0,
                "current_node": "msg-assistant-2",
                "mapping": {
                    "root": {
                        "id": "root",
                        "message": null,
                        "parent": null,
                        "children": ["msg-system"]
                    },
                    "msg-system": {
                        "id": "msg-system",
                        "message": {
                            "id": "msg-system",
                            "author": {"role": "system"},
                            "create_time": 1780000001.0,
                            "content": {"content_type": "text", "parts": [""]},
                            "status": "finished_successfully",
                            "metadata": {"is_visually_hidden_from_conversation": true}
                        },
                        "parent": "root",
                        "children": ["msg-user-1"]
                    },
                    "msg-user-1": {
                        "id": "msg-user-1",
                        "message": {
                            "id": "msg-user-1",
                            "author": {"role": "user"},
                            "create_time": 1780000010.0,
                            "content": {"content_type": "text", "parts": ["hello"]},
                            "status": "finished_successfully",
                            "metadata": {}
                        },
                        "parent": "msg-system",
                        "children": ["msg-assistant-1", "branch-assistant"]
                    },
                    "branch-assistant": {
                        "id": "branch-assistant",
                        "message": {
                            "id": "branch-assistant",
                            "author": {"role": "assistant"},
                            "create_time": 1780000015.0,
                            "content": {"content_type": "text", "parts": ["old branch"]},
                            "status": "finished_successfully",
                            "metadata": {}
                        },
                        "parent": "msg-user-1",
                        "children": []
                    },
                    "msg-assistant-1": {
                        "id": "msg-assistant-1",
                        "message": {
                            "id": "msg-assistant-1",
                            "author": {"role": "assistant"},
                            "create_time": 1780000020.0,
                            "content": {
                                "content_type": "multimodal_text",
                                "parts": [
                                    {"content_type": "text", "text": "hi"},
                                    {"content_type": "image_asset_pointer", "asset_pointer": "file-service://image-1"}
                                ]
                            },
                            "status": "finished_successfully",
                            "metadata": {"model_slug": "gpt-4o"}
                        },
                        "parent": "msg-user-1",
                        "children": ["msg-tool-1"]
                    },
                    "msg-tool-1": {
                        "id": "msg-tool-1",
                        "message": {
                            "id": "msg-tool-1",
                            "author": {"role": "tool"},
                            "create_time": 1780000025.0,
                            "content": {"content_type": "text", "parts": ["tool output"]},
                            "status": "finished_successfully",
                            "metadata": {}
                        },
                        "parent": "msg-assistant-1",
                        "children": ["msg-assistant-2"]
                    },
                    "msg-assistant-2": {
                        "id": "msg-assistant-2",
                        "message": {
                            "id": "msg-assistant-2",
                            "author": {"role": "assistant"},
                            "create_time": 1780000030.0,
                            "content": {"content_type": "text", "parts": ["final"]},
                            "status": "finished_successfully",
                            "metadata": {"model_slug": "gpt-4o"}
                        },
                        "parent": "msg-tool-1",
                        "children": []
                    }
                }
            },
            {
                "id": "conv-empty",
                "title": "",
                "create_time": null,
                "update_time": null,
                "current_node": null,
                "mapping": {}
            }
        ])
    }

    #[tokio::test]
    async fn scan_chatgpt_zip_summarizes_importable_conversations() {
        let dir = tempdir().unwrap();
        let zip_path = dir.path().join("chatgpt.zip");
        write_chatgpt_zip(&zip_path, sample_export_json());
        let db = create_test_pool().await.unwrap();

        let summary = scan_chatgpt_import_from_path(&db.conn, &zip_path)
            .await
            .unwrap();

        assert_eq!(summary.conversation_count, 1);
        assert_eq!(summary.message_count, 4);
        assert_eq!(summary.skipped_empty_conversation_count, 1);
        assert_eq!(summary.duplicate_conversation_count, 0);
        assert!(summary
            .warnings
            .iter()
            .any(|warning| warning.code == "unsupported_content_part"));
    }

    #[tokio::test]
    async fn import_chatgpt_json_materializes_mainline_messages_and_skips_duplicates() {
        let dir = tempdir().unwrap();
        let json_path = dir.path().join("conversations.json");
        std::fs::write(&json_path, serde_json::to_vec(&sample_export_json()).unwrap()).unwrap();
        let db = create_test_pool().await.unwrap();

        let result = import_chatgpt_export_from_path(&db.conn, &json_path)
            .await
            .unwrap();

        assert_eq!(result.imported_conversation_count, 1);
        assert_eq!(result.imported_message_count, 4);
        assert_eq!(result.skipped_duplicate_conversation_count, 0);

        let conversation = conversations::Entity::find_by_id("chatgpt-conv-1")
            .one(&db.conn)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(conversation.title, "Mainline chat");
        assert_eq!(conversation.provider_id, "chatgpt-export");
        assert_eq!(conversation.model_id, "unknown-model");
        assert_eq!(conversation.message_count, 4);
        assert_eq!(conversation.created_at, 1780000000);
        assert_eq!(conversation.updated_at, 1780000200);
        assert_eq!(
            conversation.context_strategy_override.as_deref(),
            Some("raw_truncate")
        );
        assert_eq!(conversation.multi_model_display_mode_override, None);

        let imported_messages = messages::Entity::find()
            .filter(messages::Column::ConversationId.eq("chatgpt-conv-1"))
            .order_by_asc(messages::Column::CreatedAt)
            .all(&db.conn)
            .await
            .unwrap();
        let ids = imported_messages
            .iter()
            .map(|message| message.id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            ids,
            vec![
                "chatgpt-msg-user-1",
                "chatgpt-msg-assistant-1",
                "chatgpt-msg-tool-1",
                "chatgpt-msg-assistant-2",
            ]
        );
        assert_eq!(imported_messages[0].role, "user");
        assert_eq!(imported_messages[0].content, "hello");
        assert_eq!(imported_messages[1].role, "assistant");
        assert!(imported_messages[1].content.contains("hi"));
        assert!(imported_messages[1]
            .content
            .contains("Unsupported ChatGPT content part"));
        assert_eq!(
            imported_messages[1].parent_message_id.as_deref(),
            Some("chatgpt-msg-user-1")
        );
        assert_eq!(
            imported_messages[2].parent_message_id.as_deref(),
            Some("chatgpt-msg-assistant-1")
        );
        assert_eq!(
            imported_messages[3].parent_message_id.as_deref(),
            Some("chatgpt-msg-tool-1")
        );
        assert_eq!(imported_messages[1].model_id.as_deref(), Some("unknown-model"));

        let duplicate = import_chatgpt_export_from_path(&db.conn, &json_path)
            .await
            .unwrap();
        assert_eq!(duplicate.imported_conversation_count, 0);
        assert_eq!(duplicate.skipped_duplicate_conversation_count, 1);
    }

    #[tokio::test]
    async fn scan_chatgpt_zip_rejects_missing_conversations_json() {
        let dir = tempdir().unwrap();
        let zip_path = dir.path().join("bad.zip");
        zip::ZipWriter::new(File::create(&zip_path).unwrap())
            .finish()
            .unwrap();
        let db = create_test_pool().await.unwrap();

        let err = scan_chatgpt_import_from_path(&db.conn, &zip_path)
            .await
            .unwrap_err();

        assert!(err.to_string().contains("conversations.json"));
    }
}
