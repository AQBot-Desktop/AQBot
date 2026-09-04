use std::sync::Arc;

use aqbot_core::types::{ChatContent, ContentPart, ImageUrl};
use base64::Engine;
use serde::{Deserialize, Serialize};

use super::{ScreenPoint, ScreenRect, SelectionAnchorKind, SelectionObservation};

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ToolbarInputKind {
    #[default]
    Text,
    Screenshot,
}

/// Captured input stays private to the current in-memory toolbar session.
#[derive(Clone)]
pub(crate) enum ToolbarInput {
    Text(SelectionObservation),
    Screenshot {
        png: Arc<[u8]>,
        width: u32,
        height: u32,
        anchor: ScreenPoint,
    },
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ToolbarInputView {
    Text { text: String },
    Screenshot { width: u32, height: u32 },
}

pub(crate) struct InitialToolInput {
    pub content: ChatContent,
    pub user_input: Option<String>,
}

impl From<String> for InitialToolInput {
    fn from(text: String) -> Self {
        Self {
            content: ChatContent::Text(text),
            user_input: None,
        }
    }
}

impl From<&str> for InitialToolInput {
    fn from(text: &str) -> Self {
        text.to_string().into()
    }
}

impl ToolbarInput {
    pub fn kind(&self) -> ToolbarInputKind {
        match self {
            Self::Text(_) => ToolbarInputKind::Text,
            Self::Screenshot { .. } => ToolbarInputKind::Screenshot,
        }
    }

    pub fn view(&self) -> ToolbarInputView {
        match self {
            Self::Text(observation) => ToolbarInputView::Text {
                text: observation.text.clone(),
            },
            Self::Screenshot { width, height, .. } => ToolbarInputView::Screenshot {
                width: *width,
                height: *height,
            },
        }
    }

    pub fn anchor(&self) -> (ScreenRect, SelectionAnchorKind) {
        match self {
            Self::Text(observation) => (observation.anchor, observation.anchor_kind),
            Self::Screenshot { anchor, .. } => (
                ScreenRect {
                    x: anchor.x,
                    y: anchor.y,
                    width: 1.0,
                    height: 1.0,
                },
                SelectionAnchorKind::Pointer,
            ),
        }
    }

    pub fn source_text<'a>(&'a self, edited: Option<&'a str>) -> Result<&'a str, String> {
        match self {
            Self::Text(observation) => {
                let text = edited.unwrap_or(&observation.text);
                if text.trim().is_empty() {
                    return Err("selection_toolbar_source_text_required".into());
                }
                Ok(text)
            }
            Self::Screenshot { .. } if edited.is_some() => {
                Err("Screenshot input cannot have a source text override".into())
            }
            Self::Screenshot { .. } => Ok("the attached screenshot"),
        }
    }

    pub fn content(&self, prompt: String) -> ChatContent {
        match self {
            Self::Text(_) => ChatContent::Text(prompt),
            Self::Screenshot { png, .. } => ChatContent::Multipart(vec![
                ContentPart {
                    r#type: "text".into(),
                    text: Some(prompt),
                    image_url: None,
                },
                ContentPart {
                    r#type: "image_url".into(),
                    text: None,
                    image_url: Some(ImageUrl {
                        url: format!(
                            "data:image/png;base64,{}",
                            base64::engine::general_purpose::STANDARD.encode(png)
                        ),
                    }),
                },
            ]),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edited_text_is_validated_without_changing_the_capture() {
        let input = ToolbarInput::Text(SelectionObservation {
            text: "captured".into(),
            source_app: "editor".into(),
            source_window: "document".into(),
            range_signature: "0:8".into(),
            anchor: ScreenRect {
                x: 0.0,
                y: 0.0,
                width: 1.0,
                height: 1.0,
            },
            anchor_kind: SelectionAnchorKind::SelectionRect,
        });
        assert_eq!(input.source_text(Some("  edited\n")).unwrap(), "  edited\n");
        assert_eq!(input.source_text(None).unwrap(), "captured");
        assert_eq!(
            input.source_text(Some(" \n")).unwrap_err(),
            "selection_toolbar_source_text_required"
        );
    }

    #[test]
    fn screenshot_view_omits_bytes_and_content_contains_one_image() {
        let input = ToolbarInput::Screenshot {
            png: Arc::from(&b"private pixels"[..]),
            width: 2,
            height: 3,
            anchor: ScreenPoint { x: -20.0, y: 10.0 },
        };
        assert_eq!(input.source_text(None).unwrap(), "the attached screenshot");
        assert!(input.source_text(Some("override")).is_err());
        assert!(!serde_json::to_string(&input.view())
            .unwrap()
            .contains("private"));
        let ChatContent::Multipart(parts) = input.content("prompt".into()) else {
            panic!("multipart")
        };
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0].text.as_deref(), Some("prompt"));
        assert!(parts[1]
            .image_url
            .as_ref()
            .unwrap()
            .url
            .starts_with("data:image/png;base64,"));
        assert_eq!(input.anchor().0.x, -20.0);
    }
}
