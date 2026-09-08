//! Shared SSE framing for HTTP chat streams.

use aqbot_core::error::{AQBotError, Result};
use futures::{Stream, StreamExt};
use std::collections::VecDeque;

#[derive(Debug, Default)]
pub struct SseParser {
    raw: Vec<u8>,
    event_name: String,
    data_lines: Vec<String>,
    started: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseEvent {
    pub event: String,
    pub data: String,
}

impl SseParser {
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<SseEvent>> {
        self.raw.extend_from_slice(bytes);
        if let Err(error) = std::str::from_utf8(&self.raw) {
            if error.error_len().is_some() {
                return Err(invalid_utf8());
            }
        }
        let mut events = Vec::new();
        while let Some(end) = self
            .raw
            .iter()
            .position(|byte| matches!(byte, b'\r' | b'\n'))
        {
            // A CR at the packet boundary may be followed by LF in the next packet.
            if self.raw[end] == b'\r' && end + 1 == self.raw.len() {
                break;
            }
            let width = if self.raw[end..].starts_with(b"\r\n") {
                2
            } else {
                1
            };
            let line = std::str::from_utf8(&self.raw[..end])
                .map_err(|_| invalid_utf8())?
                .to_string();
            self.raw.drain(..end + width);
            if let Some(event) = self.push_line(&line) {
                events.push(event);
            }
        }
        Ok(events)
    }

    pub fn finish(&mut self) -> Result<Option<SseEvent>> {
        let trailing =
            String::from_utf8(std::mem::take(&mut self.raw)).map_err(|_| invalid_utf8())?;
        if !trailing.is_empty() {
            if let Some(event) = self.push_line(trailing.trim_end_matches('\r')) {
                return Ok(Some(event));
            }
        }
        Ok(self.take_event())
    }

    fn push_line(&mut self, line: &str) -> Option<SseEvent> {
        let line = if !self.started {
            self.started = true;
            line.trim_start_matches('\u{feff}')
        } else {
            line
        };
        if line.is_empty() {
            return self.take_event();
        }
        if line.starts_with(':') {
            return None;
        }
        let (field, value) = line.split_once(':').unwrap_or((line, ""));
        let value = value.strip_prefix(' ').unwrap_or(value);
        match field {
            "event" => self.event_name = value.to_string(),
            "data" => self.data_lines.push(value.to_string()),
            _ => {}
        }
        None
    }

    fn take_event(&mut self) -> Option<SseEvent> {
        let event = std::mem::take(&mut self.event_name);
        if self.data_lines.is_empty() {
            return None;
        }
        let data = self.data_lines.join("\n");
        self.data_lines.clear();
        Some(SseEvent { event, data })
    }
}

fn invalid_utf8() -> AQBotError {
    AQBotError::Provider("Invalid UTF-8 in stream event".into())
}

/// EOF-flushed events use exactly the same consumer path as framed events.
pub fn parse_sse_stream<S, B>(stream: S) -> impl Stream<Item = Result<SseEvent>>
where
    S: Stream<Item = std::result::Result<B, reqwest::Error>> + Unpin,
    B: AsRef<[u8]>,
{
    futures::stream::unfold(
        (stream, SseParser::default(), VecDeque::new(), false),
        |(mut stream, mut parser, mut pending, mut finished)| async move {
            loop {
                if let Some(event) = pending.pop_front() {
                    return Some((Ok(event), (stream, parser, pending, finished)));
                }
                if finished {
                    return None;
                }
                let result = match stream.next().await {
                    Some(Ok(bytes)) => parser.push(bytes.as_ref()),
                    Some(Err(error)) => Err(AQBotError::Provider(format!(
                        "Stream error: {}",
                        error.without_url()
                    ))),
                    None => {
                        finished = true;
                        parser.finish().map(|event| event.into_iter().collect())
                    }
                };
                match result {
                    Ok(events) => pending.extend(events),
                    Err(error) => return Some((Err(error), (stream, parser, pending, true))),
                }
            }
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn joins_multiline_data_and_ignores_comments() {
        let events = SseParser::default()
            .push(b": keep-alive\nevent: delta\ndata: {\"a\":1}\ndata: {\"b\":2}\n\n")
            .unwrap();
        assert_eq!(
            events,
            vec![SseEvent {
                event: "delta".into(),
                data: "{\"a\":1}\n{\"b\":2}".into(),
            }]
        );
    }

    #[test]
    fn handles_every_packet_boundary_and_line_ending() {
        for ending in ["\n", "\r\n", "\r"] {
            let input = format!("\u{feff}event: delta{ending}data: café你好{ending}{ending}");
            for split in 0..=input.len() {
                let mut parser = SseParser::default();
                let mut events = parser.push(&input.as_bytes()[..split]).unwrap();
                events.extend(parser.push(&input.as_bytes()[split..]).unwrap());
                events.extend(parser.finish().unwrap());
                assert_eq!(
                    events,
                    vec![SseEvent {
                        event: "delta".into(),
                        data: "café你好".into(),
                    }],
                    "ending={ending:?}, split={split}"
                );
            }
        }
    }

    #[test]
    fn finish_flushes_trailing_data_line() {
        let mut parser = SseParser::default();
        parser.push(b"event: completed\ndata: [DONE]").unwrap();
        assert_eq!(
            parser.finish().unwrap(),
            Some(SseEvent {
                event: "completed".into(),
                data: "[DONE]".into(),
            })
        );
    }

    #[test]
    fn rejects_invalid_and_truncated_utf8() {
        assert!(SseParser::default().push(b"data: \xff").is_err());
        let mut parser = SseParser::default();
        assert!(parser.push(b"data: \xc3").unwrap().is_empty());
        assert!(parser.finish().is_err());
    }

    #[tokio::test]
    async fn byte_stream_flushes_tail_through_normal_event_path() {
        let bytes = vec![Ok::<_, reqwest::Error>(
            b"data: first\n\ndata: tail".to_vec(),
        )];
        let events = parse_sse_stream(futures::stream::iter(bytes))
            .collect::<Vec<_>>()
            .await;
        assert_eq!(events.len(), 2);
        assert_eq!(events[1].as_ref().unwrap().data, "tail");
    }
}

#[cfg(test)]
mod adapter_tests {
    use super::*;
    use crate::{ProviderAdapter, ProviderRequestContext};
    use aqbot_core::types::{ChatFinishReason, ChatRequest, ChatStreamChunk, ProviderProxyConfig};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn adapter(name: &str) -> Box<dyn ProviderAdapter> {
        match name {
            "openai" => Box::new(crate::openai::OpenAIAdapter::new()),
            "responses" => Box::new(crate::openai_responses::OpenAIResponsesAdapter::new()),
            "anthropic" => Box::new(crate::anthropic::AnthropicAdapter::new()),
            "gemini" => Box::new(crate::gemini::GeminiAdapter::new()),
            _ => panic!("unknown test adapter"),
        }
    }

    fn context(base_url: String) -> ProviderRequestContext {
        ProviderRequestContext {
            api_key: "test-key".into(),
            key_id: "key".into(),
            provider_id: "provider".into(),
            base_url: Some(base_url),
            api_path: None,
            aws_region: None,
            proxy_config: None,
            custom_headers: None,
        }
    }

    fn request() -> ChatRequest {
        serde_json::from_value(serde_json::json!({
            "model": "test-model", "messages": [{ "role": "user", "content": "hi" }], "stream": true,
        })).unwrap()
    }

    async fn read_request(socket: &mut tokio::net::TcpStream) {
        let mut received = Vec::new();
        let mut buffer = [0u8; 4096];
        loop {
            let count = socket.read(&mut buffer).await.unwrap();
            assert_ne!(count, 0, "request closed before body");
            received.extend_from_slice(&buffer[..count]);
            if let Some(end) = received.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
                let headers = std::str::from_utf8(&received[..end]).unwrap();
                let length: usize = headers
                    .lines()
                    .filter_map(|line| line.split_once(':'))
                    .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                    .map(|(_, value)| value.trim().parse().unwrap())
                    .unwrap_or(0);
                if received.len() >= end + 4 + length {
                    return;
                }
            }
        }
    }

    async fn collect(name: &str, body: &[u8], truncated: bool) -> Vec<Result<ChatStreamChunk>> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let ctx = context(format!("http://{}", listener.local_addr().unwrap()));
        let body = body.to_vec();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            read_request(&mut socket).await;
            let headers = format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len() + usize::from(truncated));
            socket.write_all(headers.as_bytes()).await.unwrap();
            socket.write_all(&body).await.unwrap();
        });
        let results = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            adapter(name)
                .chat_stream(&ctx, request())
                .collect::<Vec<_>>(),
        )
        .await
        .unwrap();
        server.await.unwrap();
        for chunk in results.iter().filter_map(|result| result.as_ref().ok()) {
            if !chunk.done {
                assert_eq!(
                    chunk.finish_reason, None,
                    "{name}: nonterminal finish reason"
                );
            }
        }
        results
    }

    fn text_event(name: &str) -> &'static str {
        match name {
            "openai" => "data: {\"choices\":[{\"delta\":{\"content\":\"Hi\"}}]}\n\n",
            "responses" => "event: response.output_text.delta\ndata: {\"delta\":\"Hi\"}\n\n",
            "anthropic" => "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"Hi\"}}\n\n",
            "gemini" => "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"Hi\"}]}}]}\n\n",
            _ => panic!("unknown test adapter"),
        }
    }

    #[tokio::test]
    async fn all_http_adapters_reject_missing_terminal_corruption_and_disconnect() {
        for name in ["openai", "responses", "anthropic", "gemini"] {
            for (suffix, truncated) in [("", false), ("data: {broken}\n\n", false), ("", true)] {
                let body = format!("{}{suffix}", text_event(name));
                let results = collect(name, body.as_bytes(), truncated).await;
                assert_eq!(
                    results[0].as_ref().unwrap().content.as_deref(),
                    Some("Hi"),
                    "{name}"
                );
                assert!(results.last().unwrap().is_err(), "{name}: {results:?}");
                assert!(
                    !results
                        .iter()
                        .any(|result| result.as_ref().is_ok_and(|chunk| chunk.done)),
                    "{name}"
                );
            }
            let result = collect(name, b"data: \xff\n\n", false).await;
            assert!(
                result
                    .last()
                    .unwrap()
                    .as_ref()
                    .unwrap_err()
                    .to_string()
                    .contains("UTF-8"),
                "{name}"
            );
        }
    }

    #[tokio::test]
    async fn openai_preserves_usage_after_finish_reason_with_done_or_clean_eof() {
        let suffix = "data: {\"error\":null,\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: {\"choices\":[],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":2,\"total_tokens\":5}}";
        for ending in ["\n\ndata: [DONE]\n\n", "\n\ndata: [DONE]", ""] {
            let body = format!("{}{suffix}{ending}", text_event("openai"));
            let results = collect("openai", body.as_bytes(), false).await;
            let final_chunk = results.last().unwrap().as_ref().unwrap();
            assert!(final_chunk.done);
            assert_eq!(final_chunk.finish_reason, Some(ChatFinishReason::Stop));
            assert_eq!(final_chunk.usage.as_ref().unwrap().total_tokens, 5);
        }
    }

    #[tokio::test]
    async fn responses_typed_terminals_preserve_usage_and_tool_calls_at_eof() {
        for (event, reason, expected) in [
            ("response.completed", "", ChatFinishReason::ToolCalls),
            (
                "response.incomplete",
                "max_output_tokens",
                ChatFinishReason::OutputLimit,
            ),
            (
                "response.incomplete",
                "content_filter",
                ChatFinishReason::ContentFilter,
            ),
        ] {
            let payload = serde_json::json!({ "error": null, "response": {
                "incomplete_details": { "reason": reason },
                "usage": { "input_tokens": 3, "output_tokens": 2, "total_tokens": 5 },
                "output": [{ "type": "function_call", "call_id": "call-1", "name": "test", "arguments": "{}" }],
            }});
            let body = format!("{}event: {event}\ndata: {payload}", text_event("responses"));
            let results = collect("responses", body.as_bytes(), false).await;
            let final_chunk = results.last().unwrap().as_ref().unwrap();
            assert!(final_chunk.done);
            assert_eq!(final_chunk.finish_reason, Some(expected));
            assert_eq!(final_chunk.usage.as_ref().unwrap().total_tokens, 5);
            assert_eq!(final_chunk.tool_calls.as_ref().unwrap()[0].id, "call-1");
        }
        for tail in ["data: [DONE]", "event: response.completed\ndata: {}", "event: response.output_text.delta\ndata: {\"delta\":4}", "event: response.incomplete\ndata: {\"response\":{\"incomplete_details\":{\"reason\":\"unknown\"}}}"] {
            let results = collect("responses", tail.as_bytes(), false).await;
            assert!(results.last().unwrap().is_err(), "{tail}");
        }
    }

    #[tokio::test]
    async fn anthropic_eof_message_stop_keeps_final_usage_and_tools() {
        let body = concat!(
            "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":3}}}\n\n",
            "data: {\"type\":\"content_block_start\",\"content_block\":{\"type\":\"tool_use\",\"id\":\"tool-1\",\"name\":\"test\"}}\n\n",
            "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{}\"}}\n\n",
            "data: {\"type\":\"content_block_stop\"}\n\n",
            "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":2}}\n\n",
            "event: message_stop\ndata: {\"type\":\"message_stop\"}"
        );
        let results = collect("anthropic", body.as_bytes(), false).await;
        let final_chunk = results.last().unwrap().as_ref().unwrap();
        assert!(final_chunk.done);
        assert_eq!(final_chunk.finish_reason, Some(ChatFinishReason::ToolCalls));
        assert_eq!(final_chunk.usage.as_ref().unwrap().total_tokens, 5);
        assert_eq!(
            final_chunk.tool_calls.as_ref().unwrap()[0]
                .function
                .arguments,
            "{}"
        );
    }

    #[tokio::test]
    async fn gemini_splits_thought_appends_parts_and_keeps_tail_usage() {
        let body = concat!(
            "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"Think\",\"thought\":true},{\"text\":\"Hi\"},{\"text\":\" there\"}]},\"finishReason\":\"STOP\"}]}\n\n",
            "data: {\"usageMetadata\":{\"promptTokenCount\":3,\"candidatesTokenCount\":2,\"totalTokenCount\":5}}"
        );
        let results = collect("gemini", body.as_bytes(), false).await;
        let first = results[0].as_ref().unwrap();
        assert_eq!(first.thinking.as_deref(), Some("Think"));
        assert_eq!(first.content.as_deref(), Some("Hi there"));
        let final_chunk = results.last().unwrap().as_ref().unwrap();
        assert!(final_chunk.done);
        assert_eq!(final_chunk.finish_reason, Some(ChatFinishReason::Stop));
        assert_eq!(final_chunk.usage.as_ref().unwrap().total_tokens, 5);
        let results = collect(
            "gemini",
            b"data: {\"promptFeedback\":{\"blockReason\":\"SAFETY\"}}",
            false,
        )
        .await;
        assert_eq!(
            results.last().unwrap().as_ref().unwrap().finish_reason,
            Some(ChatFinishReason::ContentFilter)
        );
    }

    #[tokio::test]
    async fn all_http_adapters_propagate_explicit_stream_errors() {
        for (name, event) in [
            ("openai", ""),
            ("responses", "event: error\n"),
            ("anthropic", "event: error\n"),
            ("gemini", ""),
        ] {
            let body = format!(
                "{}{}data: {{\"type\":\"error\",\"error\":{{\"message\":\"explicit failure\"}}}}",
                text_event(name),
                event
            );
            let results = collect(name, body.as_bytes(), false).await;
            assert!(
                results
                    .last()
                    .unwrap()
                    .as_ref()
                    .unwrap_err()
                    .to_string()
                    .contains("explicit failure"),
                "{name}"
            );
        }
    }

    #[tokio::test]
    async fn invalid_proxy_is_an_error_before_any_request() {
        for name in ["openai", "responses", "anthropic", "gemini"] {
            let mut ctx = context("http://127.0.0.1:1".into());
            ctx.proxy_config = Some(ProviderProxyConfig {
                proxy_type: Some("http".into()),
                proxy_address: Some("[invalid".into()),
                proxy_port: Some(8080),
            });
            let results = adapter(name)
                .chat_stream(&ctx, request())
                .collect::<Vec<_>>()
                .await;
            assert_eq!(results.len(), 1);
            assert!(
                results[0]
                    .as_ref()
                    .unwrap_err()
                    .to_string()
                    .contains("Invalid proxy URL"),
                "{name}"
            );
        }
    }

    #[tokio::test]
    async fn dropping_each_http_stream_closes_request_during_headers_or_body() {
        for name in ["openai", "responses", "anthropic", "gemini"] {
            for send_body in [false, true] {
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                let ctx = context(format!("http://{}", listener.local_addr().unwrap()));
                let (started_tx, started_rx) = tokio::sync::oneshot::channel();
                let server = tokio::spawn(async move {
                    let (mut socket, _) = listener.accept().await.unwrap();
                    read_request(&mut socket).await;
                    if send_body {
                        socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: 99999\r\n\r\n").await.unwrap();
                        socket.write_all(text_event(name).as_bytes()).await.unwrap();
                    }
                    started_tx.send(()).unwrap();
                    let count = socket.read(&mut [0u8; 1]).await;
                    assert!(
                        matches!(count, Ok(0) | Err(_)),
                        "stream socket remained active"
                    );
                });
                let mut stream = adapter(name).chat_stream(&ctx, request());
                tokio::time::timeout(std::time::Duration::from_secs(3), started_rx)
                    .await
                    .unwrap()
                    .unwrap();
                if send_body {
                    let chunk =
                        tokio::time::timeout(std::time::Duration::from_secs(3), stream.next())
                            .await
                            .unwrap()
                            .unwrap()
                            .unwrap();
                    assert_eq!(chunk.content.as_deref(), Some("Hi"));
                }
                drop(stream);
                tokio::time::timeout(std::time::Duration::from_secs(3), server)
                    .await
                    .unwrap()
                    .unwrap();
            }
        }
    }
}
