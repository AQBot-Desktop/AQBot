//! Echo the client-requested model name in gateway responses.
//!
//! In provider-prefix mode clients request `prefix/model`, while upstreams
//! answer with their own model id. These helpers rewrite the response `model`
//! field back to the requested name so clients that compare it keep matching.

use axum::body::Bytes;
use axum::http::{header, HeaderMap};
use serde_json::Value;

/// The model name to echo in responses, or `None` to keep upstream values.
pub(crate) fn response_model_name(
    provider_prefix_mode: bool,
    requested: &str,
    upstream: &str,
) -> Option<String> {
    (provider_prefix_mode && requested != upstream).then(|| requested.to_string())
}

/// Whether a passthrough body can be rewritten (i.e. it is not compressed).
pub(crate) fn is_rewritable_body(headers: &HeaderMap) -> bool {
    headers
        .get(header::CONTENT_ENCODING)
        .and_then(|value| value.to_str().ok())
        .map_or(true, |value| value.trim().eq_ignore_ascii_case("identity"))
}

/// Rewrite `model` at the top level and inside `response` / `message` objects
/// (OpenAI Responses and Anthropic stream envelopes). Returns whether anything changed.
pub(crate) fn rewrite_model_fields(value: &mut Value, name: &str) -> bool {
    let mut changed = set_model(value, name);
    for key in ["response", "message"] {
        if let Some(inner) = value.get_mut(key) {
            changed |= set_model(inner, name);
        }
    }
    changed
}

fn set_model(value: &mut Value, name: &str) -> bool {
    match value.get_mut("model") {
        Some(Value::String(model)) if model != name => {
            *model = name.to_string();
            true
        }
        _ => false,
    }
}

/// Rewrite a buffered JSON body; non-JSON bodies are returned unchanged.
pub(crate) fn rewrite_json_body(body: Bytes, name: &str) -> Bytes {
    let Ok(mut value) = serde_json::from_slice::<Value>(&body) else {
        return body;
    };
    if !rewrite_model_fields(&mut value, name) {
        return body;
    }
    serde_json::to_vec(&value).map(Bytes::from).unwrap_or(body)
}

/// Line-buffered rewriter for SSE `data:` JSON payloads.
pub(crate) struct SseModelRewriter {
    name: String,
    pending: Vec<u8>,
}

impl SseModelRewriter {
    pub(crate) fn new(name: String) -> Self {
        Self {
            name,
            pending: Vec::new(),
        }
    }

    /// Feed upstream bytes; returns the complete lines (rewritten) ready to forward.
    /// A trailing partial line is held back until the next chunk or [`Self::finish`].
    pub(crate) fn push(&mut self, bytes: &[u8]) -> Bytes {
        self.pending.extend_from_slice(bytes);
        let Some(last_newline) = self.pending.iter().rposition(|b| *b == b'\n') else {
            return Bytes::new();
        };
        let rest = self.pending.split_off(last_newline + 1);
        let complete = std::mem::replace(&mut self.pending, rest);
        let mut out = Vec::with_capacity(complete.len());
        for line in complete.split_inclusive(|b| *b == b'\n') {
            self.rewrite_line(line, &mut out);
        }
        Bytes::from(out)
    }

    /// Flush any trailing partial line at the end of the stream.
    pub(crate) fn finish(&mut self) -> Bytes {
        let rest = std::mem::take(&mut self.pending);
        let mut out = Vec::with_capacity(rest.len());
        self.rewrite_line(&rest, &mut out);
        Bytes::from(out)
    }

    fn rewrite_line(&self, line: &[u8], out: &mut Vec<u8>) {
        let content_len = line
            .iter()
            .rposition(|b| *b != b'\n' && *b != b'\r')
            .map_or(0, |pos| pos + 1);
        let (content, ending) = line.split_at(content_len);
        let rewritten = content
            .strip_prefix(b"data:")
            .and_then(|payload| serde_json::from_slice::<Value>(payload).ok())
            .and_then(|mut value| rewrite_model_fields(&mut value, &self.name).then_some(value))
            .and_then(|value| serde_json::to_vec(&value).ok());
        match rewritten {
            Some(json) => {
                out.extend_from_slice(b"data: ");
                out.extend_from_slice(&json);
                out.extend_from_slice(ending);
            }
            None => out.extend_from_slice(line),
        }
    }
}

/// Turn on `gateway_model_provider_prefix` (shared by handler test modules).
#[cfg(test)]
pub(crate) async fn enable_provider_prefix_mode(db: &sea_orm::DatabaseConnection) {
    let mut settings = aqbot_core::repo::settings::get_settings(db).await.unwrap();
    settings.gateway_model_provider_prefix = true;
    aqbot_core::repo::settings::save_settings(db, &settings)
        .await
        .unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn response_model_name_only_in_prefix_mode_when_names_differ() {
        assert_eq!(
            response_model_name(true, "ds/deepseek-chat", "deepseek-chat").as_deref(),
            Some("ds/deepseek-chat")
        );
        assert_eq!(response_model_name(true, "gpt-4o", "gpt-4o"), None);
        assert_eq!(
            response_model_name(false, "ds/deepseek-chat", "deepseek-chat"),
            None
        );
    }

    #[test]
    fn rewritable_body_rejects_compressed_responses() {
        let mut headers = HeaderMap::new();
        assert!(is_rewritable_body(&headers));
        headers.insert(header::CONTENT_ENCODING, "identity".parse().unwrap());
        assert!(is_rewritable_body(&headers));
        headers.insert(header::CONTENT_ENCODING, "gzip".parse().unwrap());
        assert!(!is_rewritable_body(&headers));
    }

    #[test]
    fn rewrites_top_level_and_envelope_model_fields() {
        let mut body =
            json!({"model": "real", "response": {"model": "real"}, "message": {"model": "real"}});
        assert!(rewrite_model_fields(&mut body, "p/real"));
        assert_eq!(body["model"], "p/real");
        assert_eq!(body["response"]["model"], "p/real");
        assert_eq!(body["message"]["model"], "p/real");

        let mut untouched = json!({"choices": [{"message": {"role": "assistant"}}]});
        assert!(!rewrite_model_fields(&mut untouched, "p/real"));
    }

    #[test]
    fn json_body_rewrite_keeps_non_json_bytes() {
        let body = Bytes::from_static(b"not json");
        assert_eq!(rewrite_json_body(body.clone(), "p/m"), body);
        let rewritten = rewrite_json_body(Bytes::from_static(br#"{"model":"m","id":"x"}"#), "p/m");
        let value: Value = serde_json::from_slice(&rewritten).unwrap();
        assert_eq!(value, json!({"model": "p/m", "id": "x"}));
    }

    #[test]
    fn sse_rewriter_handles_split_lines_and_preserves_other_lines() {
        let mut rewriter = SseModelRewriter::new("p/claude".into());
        let mut out = Vec::new();
        out.extend_from_slice(
            &rewriter.push(b"event: message_start\r\ndata: {\"type\":\"message_start\",\"mes"),
        );
        out.extend_from_slice(&rewriter.push(b"sage\":{\"model\":\"claude\"}}\r\n\r\n"));
        out.extend_from_slice(&rewriter.push(b"data: {\"type\":\"ping\"}\n\ndata: [DONE]"));
        out.extend_from_slice(&rewriter.finish());

        let text = String::from_utf8(out).unwrap();
        let lines: Vec<&str> = text.split('\n').collect();
        assert_eq!(lines[0], "event: message_start\r");
        let payload = lines[1]
            .strip_prefix("data: ")
            .unwrap()
            .strip_suffix('\r')
            .unwrap();
        let value: Value = serde_json::from_str(payload).unwrap();
        assert_eq!(
            value,
            json!({"type": "message_start", "message": {"model": "p/claude"}})
        );
        assert_eq!(
            &lines[2..],
            ["\r", "data: {\"type\":\"ping\"}", "", "data: [DONE]"]
        );
    }
}
