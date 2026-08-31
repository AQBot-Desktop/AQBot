use aqbot_core::types::SelectionToolbarPlacement;
use serde::{Deserialize, Serialize};

pub const TOOLBAR_WIDTH: f64 = 320.0;
pub const TOOLBAR_HEIGHT: f64 = 36.0;
pub const RESULT_WIDTH: f64 = 400.0;
pub const OVERFLOW_SURFACE_MAX_HEIGHT: f64 = 214.0;
pub const COMPACT_TOOLBAR_BASE_WIDTH: f64 = 52.0;
pub const COMPACT_TOOLBAR_TOOL_WIDTH: f64 = 30.0;
pub const COMPACT_TOOLBAR_MORE_WIDTH: f64 = 28.0;
pub const MAX_VISIBLE_TOOLS: usize = 5;
const SURFACE_GAP: f64 = 8.0;
/// Vertical clearance below a mouse-release point so the surface does not sit
/// under the pointer glyph (macOS/Windows arrow cursors are ~20 logical px tall).
const POINTER_GAP_BELOW: f64 = 18.0;
/// Clearance above the release point when the surface flips upward.
const POINTER_GAP_ABOVE: f64 = 10.0;
const RESULT_PANEL_HEIGHT: f64 = 320.0;
pub const RESULT_HEIGHT: f64 = TOOLBAR_HEIGHT + SURFACE_GAP + RESULT_PANEL_HEIGHT;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct ScreenPoint {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct ScreenRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl ScreenRect {
    pub fn contains(&self, point: ScreenPoint) -> bool {
        point.x >= self.x
            && point.x <= self.x + self.width
            && point.y >= self.y
            && point.y <= self.y + self.height
    }
}

/// What the selection anchor represents, which controls its safety gaps.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SelectionAnchorKind {
    /// Bounds of (the first line of) the selected text.
    #[default]
    SelectionRect,
    /// Mouse-release point, which needs asymmetric cursor clearance.
    Pointer,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SurfaceSize {
    Toolbar,
    Overflow,
    Result,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OverflowDirection {
    Above,
    #[default]
    Below,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct OverflowPlacement {
    pub window_position: ScreenPoint,
    pub toolbar_position: ScreenPoint,
    pub direction: OverflowDirection,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct SurfacePlacement {
    pub window_position: ScreenPoint,
    pub toolbar_position: ScreenPoint,
    pub direction: SelectionToolbarPlacement,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PermissionSettingsOutcome {
    PromptRequested,
    PermissionPaneOpened,
    ManualAddRequired { executable_path: String },
}

impl SurfaceSize {
    pub fn dimensions(self) -> (f64, f64) {
        self.dimensions_with_toolbar_width(TOOLBAR_WIDTH)
    }

    pub fn dimensions_with_toolbar_width(self, toolbar_width: f64) -> (f64, f64) {
        match self {
            Self::Toolbar => (toolbar_width, TOOLBAR_HEIGHT),
            Self::Overflow => (toolbar_width, OVERFLOW_SURFACE_MAX_HEIGHT),
            Self::Result => (RESULT_WIDTH, RESULT_HEIGHT),
        }
    }
}

pub fn compact_toolbar_width(tool_count: usize) -> f64 {
    let visible_count = tool_count.min(MAX_VISIBLE_TOOLS);
    let overflow_width = if tool_count > visible_count {
        COMPACT_TOOLBAR_MORE_WIDTH
    } else {
        0.0
    };
    COMPACT_TOOLBAR_BASE_WIDTH + COMPACT_TOOLBAR_TOOL_WIDTH * visible_count as f64 + overflow_width
}

pub fn place_overflow_from_toolbar(
    toolbar_position: ScreenPoint,
    toolbar_width: f64,
    overflow_height: f64,
    monitor_work_area: ScreenRect,
    scale_factor: f64,
) -> OverflowPlacement {
    let height = overflow_height * scale_factor;
    let toolbar_height = TOOLBAR_HEIGHT * scale_factor;
    let extra_height = (height - toolbar_height).max(0.0);
    let monitor_bottom = monitor_work_area.y + monitor_work_area.height;
    let space_above = toolbar_position.y - monitor_work_area.y;
    let space_below = monitor_bottom - (toolbar_position.y + toolbar_height);
    let direction = if space_below >= extra_height {
        OverflowDirection::Below
    } else if space_above >= extra_height || space_above > space_below {
        OverflowDirection::Above
    } else {
        OverflowDirection::Below
    };
    let requested_y = match direction {
        OverflowDirection::Above => toolbar_position.y - extra_height,
        OverflowDirection::Below => toolbar_position.y,
    };
    let max_x = (monitor_work_area.x + monitor_work_area.width - toolbar_width * scale_factor)
        .max(monitor_work_area.x);
    let max_y = (monitor_work_area.y + monitor_work_area.height - height).max(monitor_work_area.y);
    let window_position = ScreenPoint {
        x: toolbar_position.x.clamp(monitor_work_area.x, max_x),
        y: requested_y.clamp(monitor_work_area.y, max_y),
    };
    let toolbar_position = ScreenPoint {
        x: window_position.x,
        y: match direction {
            OverflowDirection::Above => window_position.y + extra_height,
            OverflowDirection::Below => window_position.y,
        },
    };
    OverflowPlacement {
        window_position,
        toolbar_position,
        direction,
    }
}

#[cfg(test)]
pub fn place_surface(
    anchor: ScreenRect,
    monitor_work_area: ScreenRect,
    surface: SurfaceSize,
) -> ScreenPoint {
    place_surface_scaled(
        anchor,
        SelectionAnchorKind::SelectionRect,
        monitor_work_area,
        surface,
        1.0,
    )
}

#[cfg(test)]
pub fn place_surface_scaled(
    anchor: ScreenRect,
    anchor_kind: SelectionAnchorKind,
    monitor_work_area: ScreenRect,
    surface: SurfaceSize,
    scale_factor: f64,
) -> ScreenPoint {
    place_surface_scaled_with_toolbar_width(
        anchor,
        anchor_kind,
        monitor_work_area,
        surface,
        scale_factor,
        TOOLBAR_WIDTH,
        SelectionToolbarPlacement::Below,
    )
    .window_position
}

pub fn place_surface_scaled_with_toolbar_width(
    anchor: ScreenRect,
    anchor_kind: SelectionAnchorKind,
    monitor_work_area: ScreenRect,
    surface: SurfaceSize,
    scale_factor: f64,
    toolbar_width: f64,
    preferred_placement: SelectionToolbarPlacement,
) -> SurfacePlacement {
    let (width, height) = surface.dimensions_with_toolbar_width(toolbar_width);
    let width = width * scale_factor;
    let height = height * scale_factor;
    let min_x = monitor_work_area.x;
    let max_x = (monitor_work_area.x + monitor_work_area.width - width).max(min_x);
    let x = (anchor.x + anchor.width / 2.0 - width / 2.0).clamp(min_x, max_x);
    let (above_gap, below_gap) = match anchor_kind {
        SelectionAnchorKind::SelectionRect => (SURFACE_GAP, SURFACE_GAP),
        SelectionAnchorKind::Pointer => (
            POINTER_GAP_ABOVE * scale_factor,
            POINTER_GAP_BELOW * scale_factor,
        ),
    };
    let above_y = anchor.y - above_gap - height;
    let below_y = anchor.y + anchor.height + below_gap;
    let min_y = monitor_work_area.y;
    let max_y = (monitor_work_area.y + monitor_work_area.height - height).max(min_y);
    let above_fits = above_y >= min_y;
    let below_fits = below_y <= max_y;
    let direction = resolve_placement(preferred_placement, above_fits, below_fits);
    let window_position = ScreenPoint {
        x,
        y: match direction {
            SelectionToolbarPlacement::Above => above_y,
            SelectionToolbarPlacement::Below => below_y,
        }
        .clamp(min_y, max_y),
    };
    SurfacePlacement {
        window_position,
        toolbar_position: toolbar_position_for_surface(
            window_position,
            surface,
            toolbar_width,
            scale_factor,
            direction,
        ),
        direction,
    }
}

pub fn place_result_from_toolbar(
    toolbar_position: ScreenPoint,
    toolbar_width: f64,
    preferred_placement: SelectionToolbarPlacement,
    monitor_work_area: ScreenRect,
    scale_factor: f64,
) -> SurfacePlacement {
    let (width, height) = SurfaceSize::Result.dimensions();
    let width = width * scale_factor;
    let height = height * scale_factor;
    let toolbar_height = TOOLBAR_HEIGHT * scale_factor;
    let extra_height = height - toolbar_height;
    let monitor_bottom = monitor_work_area.y + monitor_work_area.height;
    let above_fits = toolbar_position.y - extra_height >= monitor_work_area.y;
    let below_fits = toolbar_position.y + height <= monitor_bottom;
    let direction = resolve_placement(preferred_placement, above_fits, below_fits);
    let min_x = monitor_work_area.x;
    let max_x = (monitor_work_area.x + monitor_work_area.width - width).max(min_x);
    let min_y = monitor_work_area.y;
    let max_y = (monitor_bottom - height).max(min_y);
    let requested_position = ScreenPoint {
        x: toolbar_position.x - (width - toolbar_width * scale_factor) / 2.0,
        y: match direction {
            SelectionToolbarPlacement::Above => toolbar_position.y - extra_height,
            SelectionToolbarPlacement::Below => toolbar_position.y,
        },
    };
    let window_position = ScreenPoint {
        x: requested_position.x.clamp(min_x, max_x),
        y: requested_position.y.clamp(min_y, max_y),
    };
    SurfacePlacement {
        window_position,
        toolbar_position: toolbar_position_for_surface(
            window_position,
            SurfaceSize::Result,
            toolbar_width,
            scale_factor,
            direction,
        ),
        direction,
    }
}

fn resolve_placement(
    preferred: SelectionToolbarPlacement,
    above_fits: bool,
    below_fits: bool,
) -> SelectionToolbarPlacement {
    match preferred {
        SelectionToolbarPlacement::Above if above_fits || !below_fits => {
            SelectionToolbarPlacement::Above
        }
        SelectionToolbarPlacement::Above => SelectionToolbarPlacement::Below,
        SelectionToolbarPlacement::Below if below_fits || !above_fits => {
            SelectionToolbarPlacement::Below
        }
        SelectionToolbarPlacement::Below => SelectionToolbarPlacement::Above,
    }
}

fn toolbar_position_for_surface(
    window_position: ScreenPoint,
    surface: SurfaceSize,
    toolbar_width: f64,
    scale_factor: f64,
    direction: SelectionToolbarPlacement,
) -> ScreenPoint {
    let (surface_width, surface_height) = surface.dimensions_with_toolbar_width(toolbar_width);
    ScreenPoint {
        x: window_position.x + (surface_width - toolbar_width) * scale_factor / 2.0,
        y: match direction {
            SelectionToolbarPlacement::Above => {
                window_position.y + (surface_height - TOOLBAR_HEIGHT) * scale_factor
            }
            SelectionToolbarPlacement::Below => window_position.y,
        },
    }
}

#[cfg(test)]
pub fn clamp_surface_position(
    position: ScreenPoint,
    monitor_work_area: ScreenRect,
    surface: SurfaceSize,
    scale_factor: f64,
) -> ScreenPoint {
    clamp_surface_position_with_toolbar_width(
        position,
        monitor_work_area,
        surface,
        scale_factor,
        TOOLBAR_WIDTH,
    )
}

pub fn clamp_surface_position_with_toolbar_width(
    position: ScreenPoint,
    monitor_work_area: ScreenRect,
    surface: SurfaceSize,
    scale_factor: f64,
    toolbar_width: f64,
) -> ScreenPoint {
    let (width, height) = surface.dimensions_with_toolbar_width(toolbar_width);
    let max_x = (monitor_work_area.x + monitor_work_area.width - width * scale_factor)
        .max(monitor_work_area.x);
    let max_y = (monitor_work_area.y + monitor_work_area.height - height * scale_factor)
        .max(monitor_work_area.y);
    ScreenPoint {
        x: position.x.clamp(monitor_work_area.x, max_x),
        y: position.y.clamp(monitor_work_area.y, max_y),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SelectionObservation {
    pub text: String,
    pub source_app: String,
    pub source_window: String,
    pub range_signature: String,
    pub anchor: ScreenRect,
    #[serde(default)]
    pub anchor_kind: SelectionAnchorKind,
}

#[derive(Debug, Clone, PartialEq)]
pub enum SelectionChange {
    Selected(SelectionObservation),
    Cleared,
}

impl SelectionChange {
    fn fingerprint(&self) -> String {
        match self {
            Self::Cleared => "cleared".into(),
            Self::Selected(observation) => format!(
                "{}\u{1f}{}\u{1f}{}\u{1f}{}\u{1f}{:?}",
                observation.source_app,
                observation.source_window,
                observation.range_signature,
                observation.text,
                observation.anchor
            ),
        }
    }
}

/// Whether the selection contains at least one user-perceivable character.
///
/// Accessibility APIs often report non-empty `SelectedText` that is only
/// whitespace, zero-width format marks, control codes, or the object
/// replacement character (selected images). Those must not open the toolbar —
/// translating them yields "special character" style model replies.
pub fn is_actionable_selection_text(text: &str) -> bool {
    text.chars().any(is_actionable_selection_char)
}

fn is_actionable_selection_char(c: char) -> bool {
    if c.is_whitespace() || c.is_control() {
        return false;
    }
    // Object Replacement Character — AX placeholder for selected images/attachments.
    if c == '\u{FFFC}' {
        return false;
    }
    if is_unicode_format_char(c) {
        return false;
    }
    true
}

/// Common Unicode Format (Cf) and related invisible marks that survive `trim()`.
/// Kept as an explicit table so we do not pull a general-category crate only for
/// this gate; the table is locked by unit tests for the selection-toolbar cases.
fn is_unicode_format_char(c: char) -> bool {
    matches!(
        c,
        // Soft hyphen
        '\u{00AD}'
        // Combining grapheme joiner
        | '\u{034F}'
        // Arabic / Syriac / Mongolian format controls
        | '\u{0600}'..='\u{0605}'
        | '\u{061C}'
        | '\u{06DD}'
        | '\u{070F}'
        | '\u{08E2}'
        | '\u{180E}'
        // Zero-width + bidi isolates / embeddings / overrides
        | '\u{200B}'..='\u{200F}'
        | '\u{202A}'..='\u{202E}'
        | '\u{2060}'..='\u{2064}'
        | '\u{2066}'..='\u{206F}'
        // BOM / word joiner siblings already covered above; ZWNBSP
        | '\u{FEFF}'
        // Interlinear annotation controls
        | '\u{FFF9}'..='\u{FFFB}'
        // Language tags
        | '\u{E0001}'
        | '\u{E0020}'..='\u{E007F}'
    )
}

pub struct SelectionDebouncer {
    delay_ms: u64,
    pending: Option<(SelectionChange, u64)>,
    last_emission: Option<(String, u64)>,
}

pub(crate) fn prefer_selection_observation(
    current: SelectionObservation,
    incoming: SelectionObservation,
) -> SelectionObservation {
    let same_selection = current.source_app == incoming.source_app && current.text == incoming.text;
    let keep_pointer = same_selection
        && current.anchor_kind == SelectionAnchorKind::Pointer
        && incoming.anchor_kind == SelectionAnchorKind::SelectionRect;
    tracing::debug!(
        source_app = %incoming.source_app,
        text_len = incoming.text.chars().count(),
        current_anchor_kind = ?current.anchor_kind,
        current_anchor_x = current.anchor.x,
        current_anchor_y = current.anchor.y,
        current_anchor_width = current.anchor.width,
        current_anchor_height = current.anchor.height,
        incoming_anchor_kind = ?incoming.anchor_kind,
        incoming_anchor_x = incoming.anchor.x,
        incoming_anchor_y = incoming.anchor.y,
        incoming_anchor_width = incoming.anchor.width,
        incoming_anchor_height = incoming.anchor.height,
        arbitration = if keep_pointer { "keep_pointer" } else { "use_latest" },
        "debounced selection observation arbitration"
    );
    if keep_pointer {
        current
    } else {
        incoming
    }
}

impl SelectionDebouncer {
    pub fn new(delay_ms: u64) -> Self {
        Self {
            delay_ms,
            pending: None,
            last_emission: None,
        }
    }

    pub fn push(&mut self, observation: SelectionObservation, now_ms: u64) {
        let observation = match self.pending.as_ref() {
            Some((SelectionChange::Selected(current), _)) => {
                prefer_selection_observation(current.clone(), observation)
            }
            _ => observation,
        };
        let change = if is_actionable_selection_text(&observation.text) {
            SelectionChange::Selected(observation)
        } else {
            SelectionChange::Cleared
        };
        self.pending = Some((change, now_ms.saturating_add(self.delay_ms)));
    }

    pub fn take_ready(&mut self, now_ms: u64) -> Option<SelectionChange> {
        let (_, ready_at) = self.pending.as_ref()?;
        if now_ms < *ready_at {
            return None;
        }
        let (change, _) = self.pending.take()?;
        let fingerprint = change.fingerprint();
        let duplicate_window_ms = self.delay_ms.saturating_mul(2);
        if self
            .last_emission
            .as_ref()
            .is_some_and(|(last_fingerprint, emitted_at)| {
                last_fingerprint == &fingerprint
                    && now_ms.saturating_sub(*emitted_at) <= duplicate_window_ms
            })
        {
            return None;
        }
        self.last_emission = Some((fingerprint, now_ms));
        Some(change)
    }

    pub fn clear(&mut self) {
        self.pending = None;
        self.last_emission = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn observation(text: &str, x: f64) -> SelectionObservation {
        SelectionObservation {
            text: text.into(),
            source_app: "editor".into(),
            source_window: "document".into(),
            range_signature: "0:4".into(),
            anchor: ScreenRect {
                x,
                y: 120.0,
                width: 80.0,
                height: 20.0,
            },
            anchor_kind: SelectionAnchorKind::SelectionRect,
        }
    }

    fn pointer_observation(text: &str, x: f64, y: f64) -> SelectionObservation {
        let mut value = observation(text, x);
        value.range_signature = "pointer".into();
        value.anchor = ScreenRect {
            x,
            y,
            width: 1.0,
            height: 1.0,
        };
        value.anchor_kind = SelectionAnchorKind::Pointer;
        value
    }

    #[test]
    fn placement_flips_below_and_clamps_to_monitor_work_area() {
        let monitor = ScreenRect {
            x: 0.0,
            y: 0.0,
            width: 1920.0,
            height: 1080.0,
        };
        let anchor = ScreenRect {
            x: 1880.0,
            y: 2.0,
            width: 80.0,
            height: 20.0,
        };

        assert_eq!(
            place_surface(anchor, monitor, SurfaceSize::Toolbar),
            ScreenPoint { x: 1600.0, y: 30.0 }
        );
    }

    #[test]
    fn placement_preserves_negative_monitor_origins() {
        let monitor = ScreenRect {
            x: -1920.0,
            y: 0.0,
            width: 1920.0,
            height: 1080.0,
        };

        assert_eq!(
            place_surface(
                observation("text", -1700.0).anchor,
                monitor,
                SurfaceSize::Result
            ),
            ScreenPoint {
                x: -1860.0,
                y: 148.0
            }
        );
    }

    #[test]
    fn placement_uses_monitor_scale_factor_for_window_bounds() {
        let monitor = ScreenRect {
            x: 0.0,
            y: 0.0,
            width: 1920.0,
            height: 1080.0,
        };
        let anchor = ScreenRect {
            x: 1800.0,
            y: 500.0,
            width: 80.0,
            height: 20.0,
        };

        assert_eq!(
            place_surface_scaled(
                anchor,
                SelectionAnchorKind::SelectionRect,
                monitor,
                SurfaceSize::Toolbar,
                2.0
            ),
            ScreenPoint {
                x: 1280.0,
                y: 528.0
            }
        );
    }

    #[test]
    fn pointer_anchor_prefers_below_the_release_point() {
        let monitor = ScreenRect {
            x: 0.0,
            y: 0.0,
            width: 1920.0,
            height: 1080.0,
        };
        let pointer = ScreenRect {
            x: 600.0,
            y: 500.0,
            width: 1.0,
            height: 1.0,
        };

        assert_eq!(
            place_surface_scaled(
                pointer,
                SelectionAnchorKind::Pointer,
                monitor,
                SurfaceSize::Toolbar,
                1.0
            ),
            ScreenPoint { x: 440.5, y: 519.0 }
        );
    }

    #[test]
    fn pointer_anchor_flips_above_near_the_bottom_edge() {
        let monitor = ScreenRect {
            x: 0.0,
            y: 0.0,
            width: 1920.0,
            height: 1080.0,
        };
        let pointer = ScreenRect {
            x: 600.0,
            y: 1060.0,
            width: 1.0,
            height: 1.0,
        };

        assert_eq!(
            place_surface_scaled(
                pointer,
                SelectionAnchorKind::Pointer,
                monitor,
                SurfaceSize::Toolbar,
                1.0
            ),
            ScreenPoint {
                x: 440.5,
                y: 1014.0
            }
        );
    }

    #[test]
    fn toolbar_surface_uses_the_compact_height() {
        assert_eq!(SurfaceSize::Toolbar.dimensions(), (320.0, 36.0));
        assert_eq!(
            SurfaceSize::Overflow.dimensions_with_toolbar_width(230.0),
            (230.0, OVERFLOW_SURFACE_MAX_HEIGHT)
        );
    }

    #[test]
    fn compact_toolbar_width_tracks_visible_tools_and_overflow() {
        assert_eq!(compact_toolbar_width(1), 82.0);
        assert_eq!(compact_toolbar_width(5), 202.0);
        assert_eq!(compact_toolbar_width(6), 230.0);
        assert_eq!(compact_toolbar_width(20), 230.0);
    }

    #[test]
    fn compact_toolbar_placement_uses_its_session_width() {
        let monitor = ScreenRect {
            x: 0.0,
            y: 0.0,
            width: 1920.0,
            height: 1080.0,
        };
        let anchor = ScreenRect {
            x: 600.0,
            y: 500.0,
            width: 80.0,
            height: 20.0,
        };

        assert_eq!(
            place_surface_scaled_with_toolbar_width(
                anchor,
                SelectionAnchorKind::SelectionRect,
                monitor,
                SurfaceSize::Toolbar,
                1.0,
                compact_toolbar_width(1),
                SelectionToolbarPlacement::Below,
            )
            .window_position,
            ScreenPoint { x: 599.0, y: 528.0 }
        );
    }

    #[test]
    fn result_surface_keeps_the_toolbar_above_the_panel() {
        assert_eq!(SurfaceSize::Result.dimensions(), (400.0, 364.0));
    }

    #[test]
    fn configured_placement_controls_result_expansion_direction() {
        let monitor = ScreenRect {
            x: 0.0,
            y: 0.0,
            width: 1920.0,
            height: 1080.0,
        };
        let anchor = ScreenRect {
            x: 600.0,
            y: 500.0,
            width: 80.0,
            height: 20.0,
        };

        let below = place_surface_scaled_with_toolbar_width(
            anchor,
            SelectionAnchorKind::SelectionRect,
            monitor,
            SurfaceSize::Result,
            1.0,
            TOOLBAR_WIDTH,
            SelectionToolbarPlacement::Below,
        );
        assert_eq!(below.direction, SelectionToolbarPlacement::Below);
        assert_eq!(below.window_position, ScreenPoint { x: 440.0, y: 528.0 });
        assert_eq!(below.toolbar_position, ScreenPoint { x: 480.0, y: 528.0 });

        let above = place_surface_scaled_with_toolbar_width(
            anchor,
            SelectionAnchorKind::SelectionRect,
            monitor,
            SurfaceSize::Result,
            1.0,
            TOOLBAR_WIDTH,
            SelectionToolbarPlacement::Above,
        );
        assert_eq!(above.direction, SelectionToolbarPlacement::Above);
        assert_eq!(above.window_position, ScreenPoint { x: 440.0, y: 128.0 });
        assert_eq!(above.toolbar_position, ScreenPoint { x: 480.0, y: 456.0 });
    }

    #[test]
    fn configured_placement_applies_to_pointer_anchors_and_flips_at_edges() {
        let monitor = ScreenRect {
            x: 0.0,
            y: 0.0,
            width: 1920.0,
            height: 1080.0,
        };
        let pointer = ScreenRect {
            x: 600.0,
            y: 500.0,
            width: 1.0,
            height: 1.0,
        };
        let above = place_surface_scaled_with_toolbar_width(
            pointer,
            SelectionAnchorKind::Pointer,
            monitor,
            SurfaceSize::Toolbar,
            1.0,
            TOOLBAR_WIDTH,
            SelectionToolbarPlacement::Above,
        );
        assert_eq!(above.direction, SelectionToolbarPlacement::Above);
        assert_eq!(above.window_position.y, 454.0);

        let bottom_anchor = ScreenRect {
            y: 900.0,
            height: 20.0,
            ..pointer
        };
        let flipped = place_surface_scaled_with_toolbar_width(
            bottom_anchor,
            SelectionAnchorKind::SelectionRect,
            monitor,
            SurfaceSize::Result,
            1.0,
            TOOLBAR_WIDTH,
            SelectionToolbarPlacement::Below,
        );
        assert_eq!(flipped.direction, SelectionToolbarPlacement::Above);
        assert_eq!(flipped.window_position.y, 528.0);
    }

    #[test]
    fn dragged_toolbar_position_drives_later_result_expansion() {
        let monitor = ScreenRect {
            x: 0.0,
            y: 0.0,
            width: 1920.0,
            height: 1080.0,
        };
        let toolbar = ScreenPoint { x: 500.0, y: 400.0 };

        let below = place_result_from_toolbar(
            toolbar,
            TOOLBAR_WIDTH,
            SelectionToolbarPlacement::Below,
            monitor,
            1.0,
        );
        assert_eq!(below.window_position, ScreenPoint { x: 460.0, y: 400.0 });
        assert_eq!(below.toolbar_position, toolbar);

        let above = place_result_from_toolbar(
            toolbar,
            TOOLBAR_WIDTH,
            SelectionToolbarPlacement::Above,
            monitor,
            1.0,
        );
        assert_eq!(above.window_position, ScreenPoint { x: 460.0, y: 72.0 });
        assert_eq!(above.toolbar_position, toolbar);
    }

    #[test]
    fn result_placement_preserves_negative_coordinates_and_scale() {
        let placement = place_surface_scaled_with_toolbar_width(
            ScreenRect {
                x: -1700.0,
                y: 500.0,
                width: 80.0,
                height: 20.0,
            },
            SelectionAnchorKind::SelectionRect,
            ScreenRect {
                x: -1920.0,
                y: 0.0,
                width: 1920.0,
                height: 1080.0,
            },
            SurfaceSize::Result,
            1.5,
            TOOLBAR_WIDTH,
            SelectionToolbarPlacement::Below,
        );

        assert_eq!(placement.direction, SelectionToolbarPlacement::Below);
        assert_eq!(
            placement.window_position,
            ScreenPoint {
                x: -1920.0,
                y: 528.0
            }
        );
        assert_eq!(
            placement.toolbar_position,
            ScreenPoint {
                x: -1860.0,
                y: 528.0
            }
        );
    }

    #[test]
    fn dragged_position_is_preserved_and_clamped_for_a_larger_surface() {
        let monitor = ScreenRect {
            x: -1920.0,
            y: 0.0,
            width: 1920.0,
            height: 1080.0,
        };

        assert_eq!(
            clamp_surface_position(
                ScreenPoint {
                    x: -350.0,
                    y: 900.0,
                },
                monitor,
                SurfaceSize::Result,
                1.5,
            ),
            ScreenPoint {
                x: -600.0,
                y: 534.0,
            }
        );
    }

    #[test]
    fn overflow_opens_below_without_moving_the_toolbar() {
        let placement = place_overflow_from_toolbar(
            ScreenPoint { x: 500.0, y: 400.0 },
            compact_toolbar_width(6),
            OVERFLOW_SURFACE_MAX_HEIGHT,
            ScreenRect {
                x: 0.0,
                y: 0.0,
                width: 1920.0,
                height: 1080.0,
            },
            1.0,
        );

        assert_eq!(placement.direction, OverflowDirection::Below);
        assert_eq!(
            placement.window_position,
            ScreenPoint { x: 500.0, y: 400.0 }
        );
        assert_eq!(
            placement.toolbar_position,
            ScreenPoint { x: 500.0, y: 400.0 }
        );
    }

    #[test]
    fn overflow_opens_above_without_moving_the_toolbar() {
        let placement = place_overflow_from_toolbar(
            ScreenPoint {
                x: 500.0,
                y: 1000.0,
            },
            compact_toolbar_width(6),
            OVERFLOW_SURFACE_MAX_HEIGHT,
            ScreenRect {
                x: 0.0,
                y: 0.0,
                width: 1920.0,
                height: 1080.0,
            },
            1.0,
        );

        assert_eq!(placement.direction, OverflowDirection::Above);
        assert_eq!(
            placement.window_position,
            ScreenPoint { x: 500.0, y: 822.0 }
        );
        assert_eq!(
            placement.toolbar_position,
            ScreenPoint {
                x: 500.0,
                y: 1000.0
            }
        );
    }

    #[test]
    fn short_overflow_stays_below_when_its_content_fits() {
        let placement = place_overflow_from_toolbar(
            ScreenPoint { x: 500.0, y: 900.0 },
            compact_toolbar_width(6),
            119.0,
            ScreenRect {
                x: 0.0,
                y: 0.0,
                width: 1920.0,
                height: 1080.0,
            },
            1.0,
        );

        assert_eq!(placement.direction, OverflowDirection::Below);
        assert_eq!(
            placement.toolbar_position,
            ScreenPoint { x: 500.0, y: 900.0 }
        );
    }

    #[test]
    fn debounce_uses_source_range_and_bounds_not_text_alone() {
        let mut debouncer = SelectionDebouncer::new(200);
        debouncer.push(observation("same", 100.0), 0);
        assert!(debouncer.take_ready(199).is_none());
        let Some(SelectionChange::Selected(first)) = debouncer.take_ready(200) else {
            panic!("selection should be published");
        };
        assert_eq!(first.anchor.x, 100.0);

        debouncer.push(observation("same", 100.0), 210);
        assert!(debouncer.take_ready(410).is_none());

        debouncer.push(observation("same", 480.0), 420);
        let Some(SelectionChange::Selected(moved)) = debouncer.take_ready(620) else {
            panic!("moved selection should be published");
        };
        assert_eq!(moved.anchor.x, 480.0);
    }

    #[test]
    fn pointer_anchor_wins_regardless_of_observation_order() {
        let rect = observation("same selection", 80.0);
        let pointer = pointer_observation("same selection", 600.0, 500.0);
        let monitor = ScreenRect {
            x: 0.0,
            y: 0.0,
            width: 1_920.0,
            height: 1_080.0,
        };

        for (first, second) in [
            (rect.clone(), pointer.clone()),
            (pointer.clone(), rect.clone()),
        ] {
            let mut debouncer = SelectionDebouncer::new(200);
            debouncer.push(first, 0);
            debouncer.push(second, 20);
            let Some(SelectionChange::Selected(chosen)) = debouncer.take_ready(220) else {
                panic!("selection should be published");
            };

            assert_eq!(chosen.anchor_kind, SelectionAnchorKind::Pointer);
            assert_eq!(
                place_surface_scaled(
                    chosen.anchor,
                    chosen.anchor_kind,
                    monitor,
                    SurfaceSize::Toolbar,
                    1.0,
                ),
                ScreenPoint { x: 440.5, y: 519.0 }
            );
        }
    }

    #[test]
    fn pointer_anchor_does_not_override_a_different_selection() {
        let pointer = pointer_observation("repeated text", 600.0, 500.0);
        let latest = observation("different text", 80.0);
        let mut debouncer = SelectionDebouncer::new(200);

        debouncer.push(pointer, 0);
        debouncer.push(latest, 20);
        let Some(SelectionChange::Selected(chosen)) = debouncer.take_ready(220) else {
            panic!("selection should be published");
        };

        assert_eq!(chosen.anchor_kind, SelectionAnchorKind::SelectionRect);
        assert_eq!(chosen.text, "different text");
        assert_eq!(chosen.anchor.x, 80.0);
    }

    #[test]
    fn identical_selection_is_published_again_after_the_duplicate_window() {
        let mut debouncer = SelectionDebouncer::new(200);
        debouncer.push(observation("same", 100.0), 0);
        assert!(matches!(
            debouncer.take_ready(200),
            Some(SelectionChange::Selected(_))
        ));

        debouncer.push(observation("same", 100.0), 1_000);

        assert!(matches!(
            debouncer.take_ready(1_200),
            Some(SelectionChange::Selected(_))
        ));
    }

    #[test]
    fn whitespace_selection_is_an_explicit_clear_event() {
        let mut debouncer = SelectionDebouncer::new(200);
        debouncer.push(observation("text", 100.0), 0);
        let _ = debouncer.take_ready(200);
        let mut cleared = observation("  \n", 100.0);
        cleared.range_signature = "4:4".into();
        debouncer.push(cleared, 250);

        assert_eq!(debouncer.take_ready(450), Some(SelectionChange::Cleared));
    }

    #[test]
    fn actionable_selection_rejects_invisible_and_format_only_text() {
        assert!(!is_actionable_selection_text(""));
        assert!(!is_actionable_selection_text("  \n\t"));
        assert!(!is_actionable_selection_text("\u{200B}"));
        assert!(!is_actionable_selection_text("\u{200B}\u{FEFF}"));
        assert!(!is_actionable_selection_text("\u{200E}  "));
        assert!(!is_actionable_selection_text("\u{00AD}"));
        assert!(!is_actionable_selection_text("\u{FFFC}"));
        assert!(!is_actionable_selection_text("\u{0000}"));
        assert!(!is_actionable_selection_text("\u{202A}\u{202C}"));
    }

    #[test]
    fn actionable_selection_accepts_visible_text_even_with_embedded_format() {
        assert!(is_actionable_selection_text("hello"));
        assert!(is_actionable_selection_text("  中文  "));
        assert!(is_actionable_selection_text("a\u{200B}b"));
        assert!(is_actionable_selection_text("🙂"));
    }

    #[test]
    fn format_only_selection_is_an_explicit_clear_event() {
        let mut debouncer = SelectionDebouncer::new(200);
        debouncer.push(observation("text", 100.0), 0);
        let _ = debouncer.take_ready(200);
        let mut cleared = observation("\u{200B}\u{FEFF}", 100.0);
        cleared.range_signature = "ghost".into();
        debouncer.push(cleared, 250);

        assert_eq!(debouncer.take_ready(450), Some(SelectionChange::Cleared));
    }
}
