use crate::error::{AQBotError, Result};
use crate::mcp_client::McpToolResult;
use regex::Regex;
use serde_json::Value;

/// Dispatch a tool call to the appropriate built-in implementation.
pub async fn dispatch(server_name: &str, tool_name: &str, args: Value) -> Result<McpToolResult> {
    match server_name {
        "@aqbot/fetch" => match tool_name {
            "fetch_url" => {
                let url = args.get("url").and_then(|v| v.as_str()).unwrap_or_default();
                let max_length = args
                    .get("max_length")
                    .and_then(|v| v.as_u64())
                    .map(|v| v as usize);
                fetch_url(url, max_length).await
            }
            "fetch_markdown" => {
                let url = args.get("url").and_then(|v| v.as_str()).unwrap_or_default();
                let max_length = args
                    .get("max_length")
                    .and_then(|v| v.as_u64())
                    .map(|v| v as usize);
                fetch_markdown(url, max_length).await
            }
            _ => Err(AQBotError::Gateway(format!(
                "Unknown fetch tool: {}",
                tool_name
            ))),
        },
        "@aqbot/search-file" => match tool_name {
            "read_file" => {
                let path = args
                    .get("path")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default();
                read_file(path).await
            }
            "list_directory" => {
                let path = args.get("path").and_then(|v| v.as_str()).unwrap_or(".");
                list_directory(path).await
            }
            "search_files" => {
                let path = args.get("path").and_then(|v| v.as_str()).unwrap_or(".");
                let pattern = args.get("pattern").and_then(|v| v.as_str()).unwrap_or("*");
                let max_results = args
                    .get("max_results")
                    .and_then(|v| v.as_u64())
                    .map(|v| v as usize);
                search_files(path, pattern, max_results).await
            }
            _ => Err(AQBotError::Gateway(format!(
                "Unknown search-file tool: {}",
                tool_name
            ))),
        },
        _ => Err(AQBotError::Gateway(format!(
            "Unknown builtin server: {}",
            server_name
        ))),
    }
}

// ---------------------------------------------------------------------------
// Fetch tools
// ---------------------------------------------------------------------------

async fn fetch_url(url: &str, max_length: Option<usize>) -> Result<McpToolResult> {
    if url.is_empty() {
        return Ok(McpToolResult {
            content: "Error: url parameter is required".into(),
            is_error: true,
        });
    }

    let client = reqwest::Client::builder()
        .user_agent("AQBot/1.0 (Web Fetch Tool)")
        .timeout(std::time::Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| AQBotError::Gateway(format!("HTTP client error: {}", e)))?;

    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| AQBotError::Gateway(format!("Failed to fetch {}: {}", url, e)))?;

    let status = resp.status();
    if !status.is_success() {
        return Ok(McpToolResult {
            content: format!(
                "HTTP error: {} {}",
                status.as_u16(),
                status.canonical_reason().unwrap_or("Unknown")
            ),
            is_error: true,
        });
    }

    let body = resp
        .text()
        .await
        .map_err(|e| AQBotError::Gateway(format!("Failed to read response body: {}", e)))?;

    let text = html_to_text(&body);
    let max = max_length.unwrap_or(5000);
    let content = truncate_text(&text, max);

    Ok(McpToolResult {
        content,
        is_error: false,
    })
}

async fn fetch_markdown(url: &str, max_length: Option<usize>) -> Result<McpToolResult> {
    if url.is_empty() {
        return Ok(McpToolResult {
            content: "Error: url parameter is required".into(),
            is_error: true,
        });
    }

    let client = reqwest::Client::builder()
        .user_agent("AQBot/1.0 (Web Fetch Tool)")
        .timeout(std::time::Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| AQBotError::Gateway(format!("HTTP client error: {}", e)))?;

    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| AQBotError::Gateway(format!("Failed to fetch {}: {}", url, e)))?;

    let status = resp.status();
    if !status.is_success() {
        return Ok(McpToolResult {
            content: format!(
                "HTTP error: {} {}",
                status.as_u16(),
                status.canonical_reason().unwrap_or("Unknown")
            ),
            is_error: true,
        });
    }

    let body = resp
        .text()
        .await
        .map_err(|e| AQBotError::Gateway(format!("Failed to read response body: {}", e)))?;

    let markdown = html_to_markdown(&body);
    let max = max_length.unwrap_or(10000);
    let content = truncate_text(&markdown, max);

    Ok(McpToolResult {
        content,
        is_error: false,
    })
}

// ---------------------------------------------------------------------------
// File tools
// ---------------------------------------------------------------------------

async fn read_file(path: &str) -> Result<McpToolResult> {
    if path.is_empty() {
        return Ok(McpToolResult {
            content: "Error: path parameter is required".into(),
            is_error: true,
        });
    }

    match tokio::fs::read_to_string(path).await {
        Ok(content) => {
            let truncated = truncate_text(&content, 50000);
            Ok(McpToolResult {
                content: truncated,
                is_error: false,
            })
        }
        Err(e) => Ok(McpToolResult {
            content: format!("Error reading file '{}': {}", path, e),
            is_error: true,
        }),
    }
}

async fn list_directory(path: &str) -> Result<McpToolResult> {
    let mut entries = match tokio::fs::read_dir(path).await {
        Ok(rd) => rd,
        Err(e) => {
            return Ok(McpToolResult {
                content: format!("Error listing directory '{}': {}", path, e),
                is_error: true,
            });
        }
    };

    let mut items = Vec::new();
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name().to_string_lossy().to_string();
        let is_dir = entry
            .file_type()
            .await
            .map(|ft| ft.is_dir())
            .unwrap_or(false);
        let meta = entry.metadata().await.ok();
        let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);

        if is_dir {
            items.push(format!("📁 {}/", name));
        } else {
            items.push(format!("📄 {} ({})", name, human_size(size)));
        }
    }

    items.sort();
    let content = if items.is_empty() {
        format!("Directory '{}' is empty", path)
    } else {
        format!("Contents of '{}':\n{}", path, items.join("\n"))
    };

    Ok(McpToolResult {
        content,
        is_error: false,
    })
}

async fn search_files(
    path: &str,
    pattern: &str,
    max_results: Option<usize>,
) -> Result<McpToolResult> {
    let max = max_results.unwrap_or(50);
    let mut results = Vec::new();

    let pattern_lower = pattern.to_lowercase();
    walk_dir_search(
        std::path::Path::new(path),
        &pattern_lower,
        &mut results,
        max,
    )
    .await;

    let content = if results.is_empty() {
        format!("No files matching '{}' found in '{}'", pattern, path)
    } else {
        format!(
            "Found {} file(s) matching '{}':\n{}",
            results.len(),
            pattern,
            results.join("\n")
        )
    };

    Ok(McpToolResult {
        content,
        is_error: false,
    })
}

async fn walk_dir_search(
    root: &std::path::Path,
    pattern: &str,
    results: &mut Vec<String>,
    max: usize,
) {
    let mut stack = vec![root.to_path_buf()];

    while let Some(dir) = stack.pop() {
        if results.len() >= max {
            return;
        }

        let mut entries = match tokio::fs::read_dir(&dir).await {
            Ok(rd) => rd,
            Err(_) => continue,
        };

        while let Ok(Some(entry)) = entries.next_entry().await {
            if results.len() >= max {
                return;
            }

            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }

            let path = entry.path();
            let is_dir = entry
                .file_type()
                .await
                .map(|ft| ft.is_dir())
                .unwrap_or(false);

            if name.to_lowercase().contains(pattern) {
                results.push(path.to_string_lossy().to_string());
            }

            if is_dir {
                stack.push(path);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// HTML processing
// ---------------------------------------------------------------------------

fn html_to_text(html: &str) -> String {
    let mut text = html.to_string();
    remove_blocks(&mut text, "script");
    remove_blocks(&mut text, "style");
    remove_blocks(&mut text, "noscript");
    remove_blocks(&mut text, "nav");
    remove_blocks(&mut text, "footer");
    remove_blocks(&mut text, "header");

    // Replace block-level tags with newlines
    let re_block = Regex::new(r"(?i)</?(p|div|section|article|main|aside|blockquote|pre|table|tr|ul|ol|dl|dt|dd|figcaption|figure)\s*[^>]*>").unwrap();
    text = re_block.replace_all(&text, "\n").to_string();

    let re_br = Regex::new(r"(?i)<br\s*/?>").unwrap();
    text = re_br.replace_all(&text, "\n").to_string();

    let re_hr = Regex::new(r"(?i)<hr\s*/?>").unwrap();
    text = re_hr.replace_all(&text, "\n---\n").to_string();

    let re_li = Regex::new(r"(?i)<li\s*[^>]*>").unwrap();
    text = re_li.replace_all(&text, "\n• ").to_string();

    // Strip remaining tags
    let re_tags = Regex::new(r"<[^>]+>").unwrap();
    text = re_tags.replace_all(&text, "").to_string();

    decode_entities(&mut text);
    collapse_whitespace(&text)
}

fn html_to_markdown(html: &str) -> String {
    let mut text = html.to_string();
    remove_blocks(&mut text, "script");
    remove_blocks(&mut text, "style");
    remove_blocks(&mut text, "noscript");
    remove_blocks(&mut text, "nav");
    remove_blocks(&mut text, "footer");

    // Headings
    for level in 1..=6 {
        let prefix = "#".repeat(level);
        let re_h = Regex::new(&format!(r"(?is)<h{}\s*[^>]*>(.*?)</h{}>", level, level)).unwrap();
        text = re_h
            .replace_all(&text, |caps: &regex::Captures| {
                let inner = strip_tags(caps.get(1).map_or("", |m| m.as_str()));
                format!("\n\n{} {}\n\n", prefix, inner.trim())
            })
            .to_string();
    }

    // Links
    let re_a = Regex::new(r#"(?is)<a\s[^>]*href\s*=\s*["']([^"']+)["'][^>]*>(.*?)</a>"#).unwrap();
    text = re_a
        .replace_all(&text, |caps: &regex::Captures| {
            let href = caps.get(1).map_or("", |m| m.as_str());
            let inner = strip_tags(caps.get(2).map_or("", |m| m.as_str()));
            format!("[{}]({})", inner.trim(), href)
        })
        .to_string();

    // Images
    let re_img = Regex::new(r#"(?i)<img\s[^>]*src\s*=\s*["']([^"']+)["'][^>]*/?\s*>"#).unwrap();
    text = re_img
        .replace_all(&text, |caps: &regex::Captures| {
            let src = caps.get(1).map_or("", |m| m.as_str());
            format!("![image]({})", src)
        })
        .to_string();

    // Bold
    let re_b = Regex::new(r"(?is)<(b|strong)\s*[^>]*>(.*?)</(b|strong)>").unwrap();
    text = re_b
        .replace_all(&text, |caps: &regex::Captures| {
            let inner = caps.get(2).map_or("", |m| m.as_str());
            format!("**{}**", inner.trim())
        })
        .to_string();

    // Italic
    let re_i = Regex::new(r"(?is)<(i|em)\s*[^>]*>(.*?)</(i|em)>").unwrap();
    text = re_i
        .replace_all(&text, |caps: &regex::Captures| {
            let inner = caps.get(2).map_or("", |m| m.as_str());
            format!("*{}*", inner.trim())
        })
        .to_string();

    // Code
    let re_code = Regex::new(r"(?is)<code\s*[^>]*>(.*?)</code>").unwrap();
    text = re_code.replace_all(&text, "`$1`").to_string();

    // Pre blocks
    let re_pre = Regex::new(r"(?is)<pre\s*[^>]*>(.*?)</pre>").unwrap();
    text = re_pre
        .replace_all(&text, |caps: &regex::Captures| {
            let inner = strip_tags(caps.get(1).map_or("", |m| m.as_str()));
            format!("\n```\n{}\n```\n", inner.trim())
        })
        .to_string();

    // List items
    let re_li = Regex::new(r"(?i)<li\s*[^>]*>").unwrap();
    text = re_li.replace_all(&text, "\n- ").to_string();

    // Block elements → newlines
    let re_block = Regex::new(
        r"(?i)</?(p|div|section|article|main|aside|blockquote|table|tr|ul|ol|dl)\s*[^>]*>",
    )
    .unwrap();
    text = re_block.replace_all(&text, "\n").to_string();

    let re_br = Regex::new(r"(?i)<br\s*/?>").unwrap();
    text = re_br.replace_all(&text, "\n").to_string();

    let re_hr = Regex::new(r"(?i)<hr\s*/?>").unwrap();
    text = re_hr.replace_all(&text, "\n---\n").to_string();

    // Strip remaining tags
    let re_tags = Regex::new(r"<[^>]+>").unwrap();
    text = re_tags.replace_all(&text, "").to_string();

    decode_entities(&mut text);
    collapse_whitespace(&text)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn remove_blocks(html: &mut String, tag: &str) {
    let open = format!("<{}", tag);
    let close = format!("</{}>", tag);
    loop {
        let lower = html.to_lowercase();
        let start = match lower.find(&open) {
            Some(s) => s,
            None => break,
        };
        let search_from = start + open.len();
        let end = match lower[search_from..].find(&close) {
            Some(offset) => search_from + offset + close.len(),
            None => break,
        };
        html.replace_range(start..end, "");
    }
}

fn strip_tags(s: &str) -> String {
    let re = Regex::new(r"<[^>]+>").unwrap();
    re.replace_all(s, "").to_string()
}

fn decode_entities(text: &mut String) {
    let replacements = [
        ("&amp;", "&"),
        ("&lt;", "<"),
        ("&gt;", ">"),
        ("&quot;", "\""),
        ("&#39;", "'"),
        ("&apos;", "'"),
        ("&nbsp;", " "),
        ("&#x27;", "'"),
        ("&#x2F;", "/"),
        ("&mdash;", "—"),
        ("&ndash;", "–"),
        ("&laquo;", "«"),
        ("&raquo;", "»"),
        ("&bull;", "•"),
        ("&hellip;", "…"),
        ("&copy;", "©"),
        ("&reg;", "®"),
        ("&trade;", "™"),
    ];
    for (entity, replacement) in &replacements {
        *text = text.replace(entity, replacement);
    }
    // Numeric entities: &#NNN;
    let re_dec = Regex::new(r"&#(\d+);").unwrap();
    *text = re_dec
        .replace_all(text, |caps: &regex::Captures| {
            caps.get(1)
                .and_then(|m| m.as_str().parse::<u32>().ok())
                .and_then(char::from_u32)
                .map(|c| c.to_string())
                .unwrap_or_default()
        })
        .to_string();
    // Hex entities: &#xHHH;
    let re_hex = Regex::new(r"(?i)&#x([0-9a-f]+);").unwrap();
    *text = re_hex
        .replace_all(text, |caps: &regex::Captures| {
            caps.get(1)
                .and_then(|m| u32::from_str_radix(m.as_str(), 16).ok())
                .and_then(char::from_u32)
                .map(|c| c.to_string())
                .unwrap_or_default()
        })
        .to_string();
}

fn collapse_whitespace(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut consecutive_newlines = 0u32;
    let mut last_was_space = false;

    for c in text.chars() {
        if c == '\n' || c == '\r' {
            if c == '\r' {
                continue;
            }
            consecutive_newlines += 1;
            if consecutive_newlines <= 2 {
                result.push('\n');
            }
            last_was_space = true;
        } else if c.is_whitespace() {
            consecutive_newlines = 0;
            if !last_was_space {
                result.push(' ');
                last_was_space = true;
            }
        } else {
            consecutive_newlines = 0;
            last_was_space = false;
            result.push(c);
        }
    }

    result.trim().to_string()
}

fn truncate_text(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    // Find a clean break point near max
    let boundary = text[..max].rfind('\n').unwrap_or(max);
    format!(
        "{}\n\n... (truncated, showing first {} of {} characters)",
        &text[..boundary],
        boundary,
        text.len()
    )
}

fn human_size(bytes: u64) -> String {
    const UNITS: &[&str] = &["B", "KB", "MB", "GB"];
    let mut size = bytes as f64;
    for unit in UNITS {
        if size < 1024.0 {
            return format!("{:.1} {}", size, unit);
        }
        size /= 1024.0;
    }
    format!("{:.1} TB", size)
}
