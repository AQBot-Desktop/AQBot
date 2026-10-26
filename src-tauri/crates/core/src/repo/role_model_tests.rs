use super::tests::{sample_create_input, sample_update_input};
use crate::db::{create_pool, create_test_pool};
use crate::types::RoleModelBinding;
use sea_orm::ConnectionTrait;

fn binding(provider: &str) -> RoleModelBinding {
    RoleModelBinding {
        provider_id: provider.into(),
        model_id: "shared-model".into(),
    }
}

async fn insert_models(db: &sea_orm::DatabaseConnection) {
    db.execute_unprepared("INSERT INTO providers (id, name, provider_type, api_host, enabled, sort_order, created_at, updated_at)
        VALUES ('p1','First','openai','https://example.com',1,0,1,1),
               ('p2','Second','openai','https://example.com',1,1,1,1),
               ('disabled','Disabled','openai','https://example.com',0,2,1,1);
        INSERT INTO models (provider_id, model_id, name, model_type, capabilities, enabled)
        VALUES ('p1','shared-model','Shared','chat','[]',1),
               ('p2','shared-model','Shared','chat','[]',1),
               ('disabled','shared-model','Shared','chat','[]',1),
               ('p1','disabled-model','Disabled','chat','[]',0),
               ('p1','image-model','Image','image','[]',1);")
        .await.unwrap();
}

#[tokio::test]
async fn role_model_bindings_preserve_order_reopen_omit_clear_and_blank_prompt() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("roles.db");
    let db = create_pool(path.to_str().unwrap()).await.unwrap();
    insert_models(&db.conn).await;
    let mut input = sample_create_input();
    input.system_prompt = "  \n  ".into();
    input.model_bindings = vec![binding("p2"), binding("p1")];
    let created = super::create_role(&db.conn, input).await.unwrap();
    assert_eq!(created.system_prompt, "");
    assert_eq!(created.model_bindings, vec![binding("p2"), binding("p1")]);
    db.conn.close().await.unwrap();
    let db = create_pool(path.to_str().unwrap()).await.unwrap();
    let reopened = super::get_role(&db.conn, &created.id).await.unwrap();
    assert_eq!(reopened.model_bindings, created.model_bindings);
    let mut update = sample_update_input();
    update.system_prompt = Some(" ".into());
    let omitted = super::update_role(&db.conn, &created.id, update)
        .await
        .unwrap();
    assert_eq!(omitted.model_bindings, created.model_bindings);
    assert_eq!(omitted.system_prompt, "");
    let mut update = sample_update_input();
    update.model_bindings = Some(vec![]);
    assert!(super::update_role(&db.conn, &created.id, update)
        .await
        .unwrap()
        .model_bindings
        .is_empty());
    let mut update = sample_update_input();
    update.model_bindings = Some(vec![binding("p1"), binding("p2")]);
    assert_eq!(
        super::update_role(&db.conn, &created.id, update)
            .await
            .unwrap()
            .model_bindings,
        vec![binding("p1"), binding("p2")]
    );
    db.conn.close().await.unwrap();
}

#[tokio::test]
async fn role_model_bindings_reject_invalid_and_unavailable_on_create_and_update() {
    let db = create_test_pool().await.unwrap();
    insert_models(&db.conn).await;
    let role = super::create_role(&db.conn, sample_create_input())
        .await
        .unwrap();
    let cases = vec![
        (vec![binding("")], "ROLE_MODEL_BINDINGS_INVALID"),
        (
            vec![binding("p1"), binding("p1")],
            "ROLE_MODEL_BINDINGS_INVALID",
        ),
        (vec![binding("missing")], "ROLE_MODEL_BINDINGS_UNAVAILABLE"),
        (vec![binding("disabled")], "ROLE_MODEL_BINDINGS_UNAVAILABLE"),
        (
            vec![RoleModelBinding {
                provider_id: "p1".into(),
                model_id: "missing".into(),
            }],
            "ROLE_MODEL_BINDINGS_UNAVAILABLE",
        ),
        (
            vec![RoleModelBinding {
                provider_id: "p1".into(),
                model_id: "disabled-model".into(),
            }],
            "ROLE_MODEL_BINDINGS_UNAVAILABLE",
        ),
        (
            vec![RoleModelBinding {
                provider_id: "p1".into(),
                model_id: "image-model".into(),
            }],
            "ROLE_MODEL_BINDINGS_UNAVAILABLE",
        ),
        (
            vec![RoleModelBinding {
                provider_id: "p1".into(),
                model_id: " ".into(),
            }],
            "ROLE_MODEL_BINDINGS_INVALID",
        ),
    ];
    for (bindings, code) in cases {
        let mut input = sample_create_input();
        input.model_bindings = bindings.clone();
        assert!(super::create_role(&db.conn, input)
            .await
            .unwrap_err()
            .to_string()
            .contains(code));
        let mut update = sample_update_input();
        update.model_bindings = Some(bindings);
        assert!(super::update_role(&db.conn, &role.id, update)
            .await
            .unwrap_err()
            .to_string()
            .contains(code));
    }
    assert_eq!(super::list_roles(&db.conn).await.unwrap().len(), 1);
    assert!(super::get_role(&db.conn, &role.id)
        .await
        .unwrap()
        .model_bindings
        .is_empty());
}

#[tokio::test]
async fn role_model_bindings_corrupt_json_fails_explicitly() {
    let db = create_test_pool().await.unwrap();
    let role = super::create_role(&db.conn, sample_create_input())
        .await
        .unwrap();
    db.conn
        .execute_unprepared("UPDATE roles SET model_bindings_json = '{bad-json}'")
        .await
        .unwrap();
    let error = super::get_role(&db.conn, &role.id).await.unwrap_err();
    assert!(error
        .to_string()
        .contains("Invalid role model_bindings JSON"));
    assert!(super::list_roles(&db.conn).await.is_err());
}
