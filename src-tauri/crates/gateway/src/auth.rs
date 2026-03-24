use axum::{
    body::Body,
    extract::State,
    http::{Request, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use sea_orm::DatabaseConnection;
use serde_json::json;

use aqbot_core::types::GatewayKey;

/// Authenticated key injected into request extensions after auth middleware.
#[derive(Clone, Debug)]
pub struct AuthenticatedKey(pub GatewayKey);

/// Auth middleware: extracts Bearer token, verifies against gateway_keys, updates last_used_at.
pub async fn auth_middleware(
    State(pool): State<DatabaseConnection>,
    mut request: Request<Body>,
    next: Next,
) -> Response {
    let auth_header = request
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok());

    let token = match auth_header {
        Some(h) if h.starts_with("Bearer ") => &h[7..],
        _ => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({
                    "error": {
                        "message": "Missing or invalid Authorization header. Expected: Bearer <api-key>",
                        "type": "invalid_request_error",
                        "code": "invalid_api_key"
                    }
                })),
            )
                .into_response();
        }
    };

    match aqbot_core::repo::gateway::verify_key(&pool, token).await {
        Ok(key) => {
            // Update last_used_at in background (non-blocking)
            let pool_bg = pool.clone();
            let key_id = key.id.clone();
            tokio::spawn(async move {
                let _ = aqbot_core::repo::gateway::update_last_used(&pool_bg, &key_id).await;
            });

            request.extensions_mut().insert(AuthenticatedKey(key));
            next.run(request).await
        }
        Err(_) => (
            StatusCode::UNAUTHORIZED,
            Json(json!({
                "error": {
                    "message": "Invalid or disabled API key",
                    "type": "invalid_request_error",
                    "code": "invalid_api_key"
                }
            })),
        )
            .into_response(),
    }
}
