use axum::{
    middleware,
    routing::{get, post},
    Router,
};
use tower_http::cors::{Any, CorsLayer};

use crate::auth::auth_middleware;
use crate::handlers::{chat_completions, health_check, list_models};
use crate::native::{
    anthropic_count_tokens, anthropic_messages, gemini_list_models, gemini_model_operation,
    openai_responses,
};
use crate::realtime::realtime_handler;
use crate::server::GatewayAppState;

pub fn create_router(state: GatewayAppState) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    // Protected routes (require auth)
    let protected = Router::new()
        .route("/v1/chat/completions", post(chat_completions))
        .route("/v1/responses", post(openai_responses))
        .route("/v1/messages", post(anthropic_messages))
        .route("/v1/messages/count_tokens", post(anthropic_count_tokens))
        .route("/v1/models", get(list_models))
        .route("/v1beta/models", get(gemini_list_models))
        .route("/v1beta/models/{model_action}", post(gemini_model_operation))
        .layer(middleware::from_fn_with_state(
            state.db.clone(),
            auth_middleware,
        ));

    // Public routes (auth handled internally for realtime)
    let public = Router::new()
        .route("/health", get(health_check))
        .route("/v1/realtime", get(realtime_handler));

    Router::new()
        .merge(protected)
        .merge(public)
        .layer(cors)
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use aqbot_core::db::create_test_pool;
    use axum::{
        body::Body,
        http::{Method, Request, StatusCode},
    };
    use tower::ServiceExt;

    fn test_state(db: sea_orm::DatabaseConnection) -> GatewayAppState {
        GatewayAppState {
            db,
            master_key: [7u8; 32],
        }
    }

    async fn assert_protected_route_exists(method: Method, uri: &str) {
        let handle = create_test_pool().await.unwrap();
        let app = create_router(test_state(handle.conn));
        let response = app
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(uri)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(
            response.status(),
            StatusCode::UNAUTHORIZED,
            "expected protected route {} {} to reject missing auth instead of 404/405",
            uri,
            response.status()
        );
    }

    #[tokio::test]
    async fn native_protocol_routes_require_auth() {
        assert_protected_route_exists(Method::POST, "/v1/responses").await;
        assert_protected_route_exists(Method::POST, "/v1/messages").await;
        assert_protected_route_exists(Method::POST, "/v1/messages/count_tokens").await;
        assert_protected_route_exists(Method::GET, "/v1beta/models").await;
        assert_protected_route_exists(Method::POST, "/v1beta/models/gemini-2.5-pro:generateContent")
            .await;
        assert_protected_route_exists(
            Method::POST,
            "/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse",
        )
        .await;
        assert_protected_route_exists(Method::POST, "/v1beta/models/gemini-2.5-pro:countTokens")
            .await;
    }
}
