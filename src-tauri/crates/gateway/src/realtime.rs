use axum::{
    extract::{
        ws::{Message, WebSocket},
        Query, State, WebSocketUpgrade,
    },
    response::Response,
};
use sea_orm::DatabaseConnection;
use serde::{Deserialize, Serialize};

use crate::server::GatewayAppState;

// --- Client → Server messages ---

#[derive(Deserialize)]
#[serde(tag = "type")]
enum RealtimeClientMessage {
    #[serde(rename = "session.create")]
    SessionCreate { model: String },
    #[serde(rename = "input_audio_buffer.append")]
    AudioAppend { audio: String },
    #[serde(rename = "input_audio_buffer.commit")]
    AudioCommit,
    #[serde(rename = "session.close")]
    SessionClose,
}

// --- Server → Client messages ---

#[derive(Serialize)]
#[serde(tag = "type")]
#[allow(dead_code)]
enum RealtimeServerMessage {
    #[serde(rename = "session.created")]
    SessionCreated { session_id: String },
    #[serde(rename = "response.audio.delta")]
    AudioDelta { delta: String },
    #[serde(rename = "response.text.delta")]
    TextDelta { delta: String },
    #[serde(rename = "response.done")]
    ResponseDone,
    #[serde(rename = "error")]
    Error { message: String },
}

#[derive(Deserialize)]
pub struct RealtimeQuery {
    api_key: Option<String>,
}

/// GET /v1/realtime — WebSocket upgrade with query-param auth
pub async fn realtime_handler(
    State(state): State<GatewayAppState>,
    Query(params): Query<RealtimeQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    let api_key = match params.api_key {
        Some(k) if !k.is_empty() => k,
        _ => {
            return Response::builder()
                .status(401)
                .body(axum::body::Body::from(
                    r#"{"error":{"message":"Missing api_key query parameter","type":"invalid_request_error","code":"invalid_api_key"}}"#,
                ))
                .unwrap();
        }
    };

    // Verify key before upgrading
    match aqbot_core::repo::gateway::verify_key(&state.db, &api_key).await {
        Ok(key) => {
            // Update last_used_at in background
            let pool_bg = state.db.clone();
            let key_id = key.id.clone();
            tokio::spawn(async move {
                let _ = aqbot_core::repo::gateway::update_last_used(&pool_bg, &key_id).await;
            });

            ws.on_upgrade(move |socket| handle_realtime_session(socket, state.db))
        }
        Err(_) => Response::builder()
            .status(401)
            .body(axum::body::Body::from(
                r#"{"error":{"message":"Invalid or disabled API key","type":"invalid_request_error","code":"invalid_api_key"}}"#,
            ))
            .unwrap(),
    }
}

async fn handle_realtime_session(mut socket: WebSocket, _db: DatabaseConnection) {
    let session_id = uuid::Uuid::new_v4().to_string();
    let mut audio_buffer: Vec<String> = Vec::new();
    let mut _model: Option<String> = None;
    let mut session_created = false;

    while let Some(msg_result) = socket.recv().await {
        let msg = match msg_result {
            Ok(m) => m,
            Err(e) => {
                tracing::debug!("WebSocket recv error: {}", e);
                break;
            }
        };

        let text = match msg {
            Message::Text(t) => t,
            Message::Close(_) => break,
            Message::Ping(data) => {
                if socket.send(Message::Pong(data)).await.is_err() {
                    break;
                }
                continue;
            }
            _ => continue,
        };

        let client_msg: RealtimeClientMessage = match serde_json::from_str(&text) {
            Ok(m) => m,
            Err(e) => {
                let _ = send_msg(
                    &mut socket,
                    &RealtimeServerMessage::Error {
                        message: format!("Invalid message: {}", e),
                    },
                )
                .await;
                continue;
            }
        };

        match client_msg {
            RealtimeClientMessage::SessionCreate { model } => {
                _model = Some(model);
                session_created = true;
                if send_msg(
                    &mut socket,
                    &RealtimeServerMessage::SessionCreated {
                        session_id: session_id.clone(),
                    },
                )
                .await
                .is_err()
                {
                    break;
                }
            }

            RealtimeClientMessage::AudioAppend { audio } => {
                if !session_created {
                    let _ = send_msg(
                        &mut socket,
                        &RealtimeServerMessage::Error {
                            message: "Session not created. Send session.create first.".into(),
                        },
                    )
                    .await;
                    continue;
                }
                audio_buffer.push(audio);
            }

            RealtimeClientMessage::AudioCommit => {
                if !session_created {
                    let _ = send_msg(
                        &mut socket,
                        &RealtimeServerMessage::Error {
                            message: "Session not created. Send session.create first.".into(),
                        },
                    )
                    .await;
                    continue;
                }

                // Stub: echo back a text response instead of forwarding to a provider
                audio_buffer.clear();

                let send_ok = send_msg(
                    &mut socket,
                    &RealtimeServerMessage::TextDelta {
                        delta: "Realtime voice is not yet connected to a provider".into(),
                    },
                )
                .await
                .is_ok()
                    && send_msg(&mut socket, &RealtimeServerMessage::ResponseDone)
                        .await
                        .is_ok();

                if !send_ok {
                    break;
                }
            }

            RealtimeClientMessage::SessionClose => {
                let _ = socket.send(Message::Close(None)).await;
                break;
            }
        }
    }

    tracing::debug!("Realtime session {} closed", session_id);
}

async fn send_msg(
    socket: &mut WebSocket,
    msg: &RealtimeServerMessage,
) -> Result<(), axum::Error> {
    let json = serde_json::to_string(msg).unwrap();
    socket
        .send(Message::Text(json.into()))
        .await
}
