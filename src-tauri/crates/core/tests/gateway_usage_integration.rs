use aqbot_core::db::create_test_pool;
use aqbot_core::repo::{gateway, provider};
use aqbot_core::types::{CreateProviderInput, ProviderType};

async fn seed_gateway_usage() -> (
    aqbot_core::db::DbHandle,
    aqbot_core::types::GatewayKey,
    aqbot_core::types::ProviderConfig,
) {
    let h = create_test_pool().await.unwrap();
    let db = &h.conn;

    let key = gateway::create_gateway_key(db, "Gateway Usage Test Key", None)
        .await
        .unwrap()
        .gateway_key;
    let provider = provider::create_provider(
        db,
        CreateProviderInput {
            name: "DeepSeek".into(),
            provider_type: ProviderType::OpenAI,
            api_host: "https://api.deepseek.com".into(),
            api_path: None,
            enabled: true,
        },
    )
    .await
    .unwrap();

    gateway::record_usage(db, &key.id, &provider.id, Some("deepseek-chat"), 1500, 500)
        .await
        .unwrap();

    (h, key, provider)
}

#[tokio::test]
async fn gateway_usage_reports_split_request_and_response_tokens() {
    let (h, key, provider) = seed_gateway_usage().await;
    let db = &h.conn;

    let metrics = gateway::get_gateway_metrics(db).await.unwrap();
    assert_eq!(metrics.total_requests, 1);
    assert_eq!(metrics.total_tokens, 2000);
    assert_eq!(metrics.total_request_tokens, 1500);
    assert_eq!(metrics.total_response_tokens, 500);
    assert_eq!(metrics.today_requests, 1);
    assert_eq!(metrics.today_tokens, 2000);
    assert_eq!(metrics.today_request_tokens, 1500);
    assert_eq!(metrics.today_response_tokens, 500);

    let by_key = gateway::get_usage_by_key(db).await.unwrap();
    assert_eq!(by_key.len(), 1);
    assert_eq!(by_key[0].key_id, key.id);
    assert_eq!(by_key[0].request_count, 1);
    assert_eq!(by_key[0].token_count, 2000);
    assert_eq!(by_key[0].request_tokens, 1500);
    assert_eq!(by_key[0].response_tokens, 500);

    let by_provider = gateway::get_usage_by_provider(db).await.unwrap();
    assert_eq!(by_provider.len(), 1);
    assert_eq!(by_provider[0].provider_id, provider.id);
    assert_eq!(by_provider[0].request_count, 1);
    assert_eq!(by_provider[0].token_count, 2000);
    assert_eq!(by_provider[0].request_tokens, 1500);
    assert_eq!(by_provider[0].response_tokens, 500);

    let by_day = gateway::get_usage_by_day(db, 30).await.unwrap();
    assert_eq!(by_day.len(), 1);
    assert_eq!(by_day[0].request_count, 1);
    assert_eq!(by_day[0].token_count, 2000);
    assert_eq!(by_day[0].request_tokens, 1500);
    assert_eq!(by_day[0].response_tokens, 500);
}

#[tokio::test]
async fn connected_programs_report_split_today_tokens() {
    let (h, key, _provider) = seed_gateway_usage().await;
    let db = &h.conn;

    let programs = gateway::get_connected_programs(db).await.unwrap();
    let program = programs.iter().find(|p| p.key_id == key.id).unwrap();

    assert_eq!(program.today_requests, 1);
    assert_eq!(program.today_tokens, 2000);
    assert_eq!(program.today_request_tokens, 1500);
    assert_eq!(program.today_response_tokens, 500);
}
