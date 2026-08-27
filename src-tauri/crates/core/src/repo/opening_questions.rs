use serde::{Deserialize, Serialize};

use crate::error::{AQBotError, Result};
use crate::types::RoleOpeningQuestion;

pub struct OpeningQuestionColumns {
    pub legacy_json: String,
    pub v2_json: String,
}

impl OpeningQuestionColumns {
    pub fn empty() -> Self {
        Self {
            legacy_json: "[]".to_string(),
            v2_json: r#"{"version":2,"items":[]}"#.to_string(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct OpeningQuestionsV2 {
    version: u32,
    items: Vec<RoleOpeningQuestion>,
}

enum ParsedField<T> {
    Absent,
    Invalid,
    Ok(T),
}

fn has_newline(value: &str) -> bool {
    value.contains('\n') || value.contains('\r')
}

fn char_count(value: &str) -> usize {
    value.chars().count()
}

pub fn prepare_opening_questions(
    items: Vec<RoleOpeningQuestion>,
) -> Result<Vec<RoleOpeningQuestion>> {
    let mut prepared = Vec::with_capacity(items.len());
    for item in items {
        let title = item
            .title
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned);
        let content = item.content.trim().to_string();
        if title.is_none() && content.is_empty() {
            continue;
        }
        if let Some(title) = title.as_deref() {
            if has_newline(title) {
                return Err(AQBotError::Validation(
                    "opening question title cannot contain newlines".into(),
                ));
            }
            if char_count(title) > RoleOpeningQuestion::TITLE_MAX_CHARS {
                return Err(AQBotError::Validation(
                    "opening question title is too long".into(),
                ));
            }
        }
        if content.is_empty() {
            return Err(AQBotError::Validation(
                "opening question content cannot be empty".into(),
            ));
        }
        prepared.push(RoleOpeningQuestion { title, content });
    }
    Ok(prepared)
}

pub fn encode_columns(items: &[RoleOpeningQuestion]) -> Result<OpeningQuestionColumns> {
    let legacy: Vec<&str> = items.iter().map(|item| item.content.as_str()).collect();
    let v2 = OpeningQuestionsV2 {
        version: 2,
        items: items.to_vec(),
    };
    Ok(OpeningQuestionColumns {
        legacy_json: serde_json::to_string(&legacy)
            .map_err(|err| AQBotError::Validation(format!("Invalid role list JSON: {err}")))?,
        v2_json: serde_json::to_string(&v2)
            .map_err(|err| AQBotError::Validation(format!("Invalid role list JSON: {err}")))?,
    })
}

fn parse_legacy(raw: &str) -> ParsedField<Vec<String>> {
    if raw.trim().is_empty() {
        return ParsedField::Absent;
    }
    match serde_json::from_str::<Vec<String>>(raw) {
        Ok(items) => ParsedField::Ok(items),
        Err(_) => ParsedField::Invalid,
    }
}

fn parse_v2(raw: Option<&str>) -> ParsedField<Vec<RoleOpeningQuestion>> {
    let Some(raw) = raw.map(str::trim).filter(|value| !value.is_empty()) else {
        return ParsedField::Absent;
    };
    match serde_json::from_str::<OpeningQuestionsV2>(raw) {
        Ok(parsed) if parsed.version == 2 => ParsedField::Ok(parsed.items),
        Ok(parsed) => {
            tracing::warn!(
                version = parsed.version,
                "unknown opening questions v2 version; ignoring v2 column"
            );
            ParsedField::Invalid
        }
        Err(err) => {
            tracing::warn!("invalid opening questions v2 JSON: {err}");
            ParsedField::Invalid
        }
    }
}

fn untitled_from_contents(contents: Vec<String>) -> Vec<RoleOpeningQuestion> {
    contents
        .into_iter()
        .map(RoleOpeningQuestion::untitled)
        .collect()
}

fn contents_of(items: &[RoleOpeningQuestion]) -> Vec<&str> {
    items.iter().map(|item| item.content.as_str()).collect()
}

pub fn decode_columns(
    legacy_json: &str,
    v2_json: Option<&str>,
) -> Result<Vec<RoleOpeningQuestion>> {
    let legacy = parse_legacy(legacy_json);
    let v2 = parse_v2(v2_json);

    match (legacy, v2) {
        (ParsedField::Ok(legacy_items), ParsedField::Ok(v2_items)) => {
            let legacy_refs: Vec<&str> = legacy_items.iter().map(String::as_str).collect();
            if contents_of(&v2_items) == legacy_refs {
                Ok(v2_items)
            } else {
                tracing::warn!("opening questions v2 projection mismatch; using legacy content");
                Ok(untitled_from_contents(legacy_items))
            }
        }
        (ParsedField::Invalid, ParsedField::Ok(v2_items)) => {
            tracing::warn!("opening questions legacy JSON invalid; recovering from v2");
            Ok(v2_items)
        }
        (ParsedField::Absent, ParsedField::Ok(v2_items)) => Ok(v2_items),
        (ParsedField::Ok(legacy_items), ParsedField::Invalid) => {
            tracing::warn!("opening questions v2 JSON ignored; using legacy content");
            Ok(untitled_from_contents(legacy_items))
        }
        (ParsedField::Ok(legacy_items), ParsedField::Absent) => {
            Ok(untitled_from_contents(legacy_items))
        }
        (ParsedField::Absent, ParsedField::Absent) => Ok(Vec::new()),
        (ParsedField::Invalid, ParsedField::Invalid)
        | (ParsedField::Invalid, ParsedField::Absent)
        | (ParsedField::Absent, ParsedField::Invalid) => Err(AQBotError::Validation(
            "opening questions JSON is invalid".into(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(title: Option<&str>, content: &str) -> RoleOpeningQuestion {
        RoleOpeningQuestion {
            title: title.map(ToOwned::to_owned),
            content: content.to_string(),
        }
    }

    #[test]
    fn deserialize_accepts_legacy_strings_and_objects() {
        let parsed: Vec<RoleOpeningQuestion> =
            serde_json::from_str(r#"["旧问题",{"title":"短标题","content":"完整\n正文"}]"#)
                .unwrap();
        assert_eq!(parsed[0], item(None, "旧问题"));
        assert_eq!(parsed[1], item(Some("短标题"), "完整\n正文"));
    }

    #[test]
    fn serialize_always_emits_structured_objects() {
        let json = serde_json::to_string(&vec![item(Some("翻译"), "请翻译\n这段话")]).unwrap();
        assert_eq!(json, r#"[{"title":"翻译","content":"请翻译\n这段话"}]"#);
    }

    #[test]
    fn prepare_drops_blank_items_and_keeps_internal_newlines() {
        let prepared = prepare_opening_questions(vec![
            item(None, "  "),
            item(Some(" 翻译 "), "  第一行\n第二行  "),
        ])
        .unwrap();
        assert_eq!(prepared, vec![item(Some("翻译"), "第一行\n第二行")]);
    }

    #[test]
    fn prepare_rejects_title_without_content() {
        let err = prepare_opening_questions(vec![item(Some("只有标题"), "  ")]).unwrap_err();
        assert!(err
            .to_string()
            .contains("opening question content cannot be empty"));
    }

    #[test]
    fn encode_dual_writes_legacy_contents_and_v2_envelope() {
        let encoded = encode_columns(&[item(Some("翻译"), "请翻译\n这段话")]).unwrap();
        assert_eq!(encoded.legacy_json, "[\"请翻译\\n这段话\"]");
        let v2: OpeningQuestionsV2 = serde_json::from_str(&encoded.v2_json).unwrap();
        assert_eq!(v2.version, 2);
        assert_eq!(v2.items, vec![item(Some("翻译"), "请翻译\n这段话")]);
        let legacy: Vec<String> = serde_json::from_str(&encoded.legacy_json).unwrap();
        assert_eq!(legacy, vec!["请翻译\n这段话"]);
    }

    #[test]
    fn decode_keeps_titles_when_projection_matches() {
        let items = decode_columns(
            r#"["请翻译\n这段话"]"#,
            Some(r#"{"version":2,"items":[{"title":"翻译","content":"请翻译\n这段话"}]}"#),
        )
        .unwrap();
        assert_eq!(items, vec![item(Some("翻译"), "请翻译\n这段话")]);
    }

    #[test]
    fn decode_maps_legacy_only_snapshots() {
        let items = decode_columns(r#"["旧问题"]"#, None).unwrap();
        assert_eq!(items, vec![item(None, "旧问题")]);
    }

    #[test]
    fn decode_drops_stale_titles_on_projection_mismatch() {
        let items = decode_columns(
            r#"["旧版本改过的正文"]"#,
            Some(r#"{"version":2,"items":[{"title":"过期标题","content":"新版本正文"}]}"#),
        )
        .unwrap();
        assert_eq!(items, vec![item(None, "旧版本改过的正文")]);
    }

    #[test]
    fn decode_recovers_from_v2_when_legacy_is_unreadable() {
        let items = decode_columns(
            "not-json",
            Some(r#"{"version":2,"items":[{"title":"标题","content":"正文"}]}"#),
        )
        .unwrap();
        assert_eq!(items, vec![item(Some("标题"), "正文")]);
    }

    #[test]
    fn decode_ignores_unknown_v2_version() {
        let items = decode_columns(
            r#"["旧问题"]"#,
            Some(r#"{"version":99,"items":[{"title":"标题","content":"正文"}]}"#),
        )
        .unwrap();
        assert_eq!(items, vec![item(None, "旧问题")]);
    }

    #[test]
    fn decode_errors_when_both_columns_are_invalid() {
        let err = decode_columns("not-json", Some("{bad")).unwrap_err();
        assert!(err
            .to_string()
            .contains("opening questions JSON is invalid"));
    }
}
