use sea_orm::*;

use crate::entity::roles;
use crate::error::{AQBotError, Result};
use crate::repo::opening_questions::{decode_columns, encode_columns, prepare_opening_questions};
use crate::types::{CreateRoleInput, Role, RoleOpeningQuestion, UpdateRoleInput};
use crate::utils::{gen_id, now_ts};

fn parse_string_list(raw: &str) -> Vec<String> {
    serde_json::from_str(raw).unwrap_or_default()
}

fn stringify_string_list(values: &[String]) -> Result<String> {
    serde_json::to_string(values)
        .map_err(|err| AQBotError::Validation(format!("Invalid role list JSON: {err}")))
}

fn clean_optional_text(value: Option<String>) -> Option<String> {
    value
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn clean_list(values: Vec<String>) -> Vec<String> {
    values
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

fn infer_avatar_type(value: &str) -> String {
    if value.starts_with("http://") || value.starts_with("https://") {
        "url".to_string()
    } else {
        "emoji".to_string()
    }
}

fn required_text(value: String, field: &str) -> Result<String> {
    let value = value.trim().to_string();
    if value.is_empty() {
        return Err(AQBotError::Validation(format!("{field} cannot be empty")));
    }
    Ok(value)
}

fn encoded_opening_questions(items: Vec<RoleOpeningQuestion>) -> Result<(String, Option<String>)> {
    let prepared = prepare_opening_questions(items)?;
    let encoded = encode_columns(&prepared)?;
    Ok((encoded.legacy_json, Some(encoded.v2_json)))
}

fn role_from_entity(m: roles::Model) -> Result<Role> {
    let fallback_avatar_type = m.avatar.as_deref().map(infer_avatar_type);
    let fallback_avatar_value = m.avatar.clone();
    Ok(Role {
        id: m.id,
        name: m.name,
        description: m.description,
        system_prompt: m.system_prompt,
        opening_message: m.opening_message,
        opening_questions: decode_columns(
            &m.opening_questions_json,
            m.opening_questions_v2_json.as_deref(),
        )?,
        tags: parse_string_list(&m.tags_json),
        avatar: m.avatar,
        avatar_type: m.avatar_type.or(fallback_avatar_type),
        avatar_value: m.avatar_value.or(fallback_avatar_value),
        temperature: m.temperature.map(|v| v as f32),
        top_p: m.top_p.map(|v| v as f32),
        enabled_mcp_server_ids: parse_string_list(&m.enabled_mcp_server_ids_json),
        enabled_skill_names: parse_string_list(&m.enabled_skill_names_json),
        source_kind: m.source_kind,
        source_ref: m.source_ref,
        created_at: m.created_at,
        updated_at: m.updated_at,
    })
}

pub async fn list_roles(db: &DatabaseConnection) -> Result<Vec<Role>> {
    let rows = roles::Entity::find()
        .order_by_desc(roles::Column::UpdatedAt)
        .all(db)
        .await?;
    rows.into_iter().map(role_from_entity).collect()
}

pub async fn get_role(db: &DatabaseConnection, id: &str) -> Result<Role> {
    let row = roles::Entity::find_by_id(id)
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("Role {id}")))?;
    role_from_entity(row)
}

pub async fn create_role(db: &DatabaseConnection, input: CreateRoleInput) -> Result<Role> {
    let id = gen_id();
    let now = now_ts();
    let avatar_type = clean_optional_text(input.avatar_type);
    let avatar_value = clean_optional_text(input.avatar_value);
    let avatar = clean_optional_text(input.avatar).or_else(|| {
        if avatar_type.as_deref() == Some("emoji") {
            avatar_value.clone()
        } else {
            None
        }
    });
    let (opening_questions_json, opening_questions_v2_json) =
        encoded_opening_questions(input.opening_questions)?;
    let model = roles::ActiveModel {
        id: Set(id.clone()),
        name: Set(required_text(input.name, "name")?),
        description: Set(clean_optional_text(input.description)),
        system_prompt: Set(required_text(input.system_prompt, "system_prompt")?),
        opening_message: Set(clean_optional_text(input.opening_message)),
        opening_questions_json: Set(opening_questions_json),
        opening_questions_v2_json: Set(opening_questions_v2_json),
        tags_json: Set(stringify_string_list(&clean_list(input.tags))?),
        avatar: Set(avatar),
        avatar_type: Set(avatar_type),
        avatar_value: Set(avatar_value),
        temperature: Set(input.temperature),
        top_p: Set(input.top_p),
        enabled_mcp_server_ids_json: Set(stringify_string_list(&clean_list(
            input.enabled_mcp_server_ids,
        ))?),
        enabled_skill_names_json: Set(stringify_string_list(&clean_list(
            input.enabled_skill_names,
        ))?),
        source_kind: Set(input.source_kind.unwrap_or_else(|| "local".to_string())),
        source_ref: Set(clean_optional_text(input.source_ref)),
        created_at: Set(now),
        updated_at: Set(now),
    };
    model.insert(db).await?;
    get_role(db, &id).await
}

pub async fn update_role(
    db: &DatabaseConnection,
    id: &str,
    input: UpdateRoleInput,
) -> Result<Role> {
    let row = roles::Entity::find_by_id(id)
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("Role {id}")))?;

    let mut model: roles::ActiveModel = row.into();
    if let Some(name) = input.name {
        model.name = Set(required_text(name, "name")?);
    }
    if let Some(description) = input.description {
        model.description = Set(clean_optional_text(description));
    }
    if let Some(system_prompt) = input.system_prompt {
        model.system_prompt = Set(required_text(system_prompt, "system_prompt")?);
    }
    if let Some(opening_message) = input.opening_message {
        model.opening_message = Set(clean_optional_text(opening_message));
    }
    if let Some(opening_questions) = input.opening_questions {
        let (legacy_json, v2_json) = encoded_opening_questions(opening_questions)?;
        model.opening_questions_json = Set(legacy_json);
        model.opening_questions_v2_json = Set(v2_json);
    }
    if let Some(tags) = input.tags {
        model.tags_json = Set(stringify_string_list(&clean_list(tags))?);
    }
    if let Some(avatar) = input.avatar {
        model.avatar = Set(clean_optional_text(avatar));
    }
    if let Some(avatar_type) = input.avatar_type {
        model.avatar_type = Set(clean_optional_text(avatar_type));
    }
    if let Some(avatar_value) = input.avatar_value {
        model.avatar_value = Set(clean_optional_text(avatar_value));
    }
    if let Some(temperature) = input.temperature {
        model.temperature = Set(temperature);
    }
    if let Some(top_p) = input.top_p {
        model.top_p = Set(top_p);
    }
    if let Some(enabled_mcp_server_ids) = input.enabled_mcp_server_ids {
        model.enabled_mcp_server_ids_json =
            Set(stringify_string_list(&clean_list(enabled_mcp_server_ids))?);
    }
    if let Some(enabled_skill_names) = input.enabled_skill_names {
        model.enabled_skill_names_json =
            Set(stringify_string_list(&clean_list(enabled_skill_names))?);
    }
    model.updated_at = Set(now_ts());
    model.update(db).await?;

    get_role(db, id).await
}

pub async fn delete_role(db: &DatabaseConnection, id: &str) -> Result<()> {
    let result = roles::Entity::delete_by_id(id).exec(db).await?;
    if result.rows_affected == 0 {
        return Err(AQBotError::NotFound(format!("Role {id}")));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::db::create_test_pool;
    use crate::entity::roles;
    use crate::types::{CreateRoleInput, RoleOpeningQuestion, UpdateRoleInput};
    use sea_orm::{ActiveModelTrait, ConnectionTrait, DbBackend, EntityTrait, Set, Statement};

    #[tokio::test]
    async fn role_repo_crud_roundtrip() {
        let h = create_test_pool().await.unwrap();

        let created = super::create_role(
            &h.conn,
            CreateRoleInput {
                name: "翻译助手".into(),
                description: Some("把输入翻译成中文".into()),
                system_prompt: "你是翻译助手".into(),
                opening_message: Some("请发来文本".into()),
                opening_questions: vec!["翻译这段话".into()],
                tags: vec!["translation".into()],
                avatar: Some("🌐".into()),
                avatar_type: Some("emoji".into()),
                avatar_value: Some("🌐".into()),
                temperature: Some(0.2),
                top_p: Some(0.8),
                enabled_mcp_server_ids: vec!["mcp-1".into()],
                enabled_skill_names: vec!["demo-skill".into()],
                source_kind: Some("local".into()),
                source_ref: None,
            },
        )
        .await
        .unwrap();

        assert_eq!(created.name, "翻译助手");
        assert_eq!(
            created.opening_questions,
            vec![crate::types::RoleOpeningQuestion::untitled("翻译这段话")]
        );
        assert_eq!(created.tags, vec!["translation"]);
        assert_eq!(created.avatar_type.as_deref(), Some("emoji"));
        assert_eq!(created.avatar_value.as_deref(), Some("🌐"));
        assert_eq!(created.temperature, Some(0.2));
        assert_eq!(created.top_p, Some(0.8));
        assert_eq!(created.enabled_mcp_server_ids, vec!["mcp-1"]);
        assert_eq!(created.enabled_skill_names, vec!["demo-skill"]);

        let listed = super::list_roles(&h.conn).await.unwrap();
        assert_eq!(listed.len(), 1);

        let updated = super::update_role(
            &h.conn,
            &created.id,
            UpdateRoleInput {
                name: Some("中文翻译助手".into()),
                description: None,
                system_prompt: Some("请只输出中文翻译".into()),
                opening_message: None,
                opening_questions: None,
                tags: Some(vec!["translation".into(), "zh-CN".into()]),
                avatar: Some(None),
                avatar_type: Some(None),
                avatar_value: Some(None),
                temperature: Some(None),
                top_p: Some(Some(0.9)),
                enabled_mcp_server_ids: Some(vec!["mcp-2".into()]),
                enabled_skill_names: Some(vec![]),
            },
        )
        .await
        .unwrap();

        assert_eq!(updated.name, "中文翻译助手");
        assert_eq!(updated.system_prompt, "请只输出中文翻译");
        assert_eq!(updated.tags, vec!["translation", "zh-CN"]);
        assert_eq!(updated.avatar_type, None);
        assert_eq!(updated.avatar_value, None);
        assert_eq!(updated.temperature, None);
        assert_eq!(updated.top_p, Some(0.9));
        assert_eq!(updated.enabled_mcp_server_ids, vec!["mcp-2"]);
        assert!(updated.enabled_skill_names.is_empty());

        super::delete_role(&h.conn, &created.id).await.unwrap();
        assert!(super::list_roles(&h.conn).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn list_roles_reads_repaired_legacy_roles() {
        use aqbot_migration::{Migrator, MigratorTrait};

        let h = create_test_pool().await.unwrap();
        h.conn
            .execute(Statement::from_string(
                DbBackend::Sqlite,
                r#"
                DROP TABLE roles;
                DELETE FROM seaql_migrations
                  WHERE version LIKE '%roles%'
                     OR version LIKE '%role_capability%'
                     OR version LIKE '%opening_questions%';
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
                INSERT INTO seaql_migrations (version, applied_at)
                VALUES ('m20260627_000001_add_roles', 1);
                "#,
            ))
            .await
            .unwrap();

        Migrator::up(&h.conn, None).await.unwrap();

        let roles = super::list_roles(&h.conn).await.unwrap();

        assert_eq!(roles.len(), 1);
        assert_eq!(roles[0].avatar_type.as_deref(), Some("emoji"));
        assert_eq!(roles[0].avatar_value.as_deref(), Some("🌐"));
    }

    #[tokio::test]
    async fn opening_questions_dual_write_roundtrip_and_legacy_mismatch() {
        let h = create_test_pool().await.unwrap();
        let created = super::create_role(
            &h.conn,
            CreateRoleInput {
                name: "翻译助手".into(),
                description: None,
                system_prompt: "你是翻译助手".into(),
                opening_message: None,
                opening_questions: vec![RoleOpeningQuestion {
                    title: Some("翻译".into()),
                    content: "请翻译\n这段话".into(),
                }],
                tags: vec![],
                avatar: None,
                avatar_type: None,
                avatar_value: None,
                temperature: None,
                top_p: None,
                enabled_mcp_server_ids: vec![],
                enabled_skill_names: vec![],
                source_kind: Some("local".into()),
                source_ref: None,
            },
        )
        .await
        .unwrap();

        assert_eq!(created.opening_questions[0].title.as_deref(), Some("翻译"));
        assert_eq!(created.opening_questions[0].content, "请翻译\n这段话");

        let stored = roles::Entity::find_by_id(&created.id)
            .one(&h.conn)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(stored.opening_questions_json, "[\"请翻译\\n这段话\"]");
        assert!(stored
            .opening_questions_v2_json
            .as_deref()
            .unwrap()
            .contains("\"version\":2"));

        let mut stale: roles::ActiveModel = stored.into();
        stale.opening_questions_json = Set(r#"["旧版本改过的正文"]"#.into());
        stale.update(&h.conn).await.unwrap();

        let reread = super::get_role(&h.conn, &created.id).await.unwrap();
        assert_eq!(reread.opening_questions[0].title, None);
        assert_eq!(reread.opening_questions[0].content, "旧版本改过的正文");
    }
}
