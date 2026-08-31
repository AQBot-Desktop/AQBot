use aqbot_core::types::SelectionToolbarPlacement;
use tauri::{
    AppHandle, Manager, Monitor, Position, Size, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
#[cfg(target_os = "macos")]
use tauri::{LogicalPosition, LogicalSize};
#[cfg(not(target_os = "macos"))]
use tauri::{PhysicalPosition, PhysicalSize};

use super::{
    clamp_surface_position_with_toolbar_width, place_overflow_from_toolbar,
    place_result_from_toolbar, place_surface_scaled_with_toolbar_width, OverflowPlacement,
    ScreenPoint, ScreenRect, SelectionAnchorKind, SurfacePlacement, SurfaceSize, TOOLBAR_HEIGHT,
    TOOLBAR_WIDTH,
};

pub const SELECTION_TOOLBAR_WINDOW_LABEL: &str = "selection-toolbar";
/// Extra padding around the toolbar hit-test box so Retina/scale rounding does not
/// treat edge clicks as outside clicks.
const HIT_TEST_PADDING: f64 = 4.0;

pub fn ensure_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(SELECTION_TOOLBAR_WINDOW_LABEL) {
        #[cfg(target_os = "macos")]
        // NSPanel conversion must run on the main thread (AppKit).
        super::macos_panel::ensure_panel(app)?;
        return Ok(window);
    }
    let window = WebviewWindowBuilder::new(
        app,
        SELECTION_TOOLBAR_WINDOW_LABEL,
        WebviewUrl::App("index.html".into()),
    )
    .title("AQBot Selection Toolbar")
    .inner_size(TOOLBAR_WIDTH, TOOLBAR_HEIGHT)
    .visible(false)
    .focused(false)
    .focusable(false)
    .accept_first_mouse(true)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .shadow(false)
    .build()
    .map_err(|error| error.to_string())?;

    #[cfg(target_os = "macos")]
    super::macos_panel::ensure_panel(app)?;

    Ok(window)
}

/// Pre-create the toolbar webview (and macOS panel) while the feature is enabled
/// so the first selection does not race a cold WebView load.
pub fn precreate(app: &AppHandle) -> Result<(), String> {
    let _ = ensure_window(app)?;
    Ok(())
}

pub fn show_surface(
    app: &AppHandle,
    anchor: ScreenRect,
    anchor_kind: SelectionAnchorKind,
    surface: SurfaceSize,
    toolbar_width: f64,
    preferred_placement: SelectionToolbarPlacement,
) -> Result<SurfacePlacement, String> {
    let window = ensure_window(app)?;
    let center_x = anchor.x + anchor.width / 2.0;
    let center_y = anchor.y + anchor.height / 2.0;
    let monitor = monitor_for_point(
        app,
        ScreenPoint {
            x: center_x,
            y: center_y,
        },
    )?;
    let monitor_rect = work_area(&monitor);
    let scale_factor = coordinate_scale_factor(&monitor);
    let placement = place_surface_scaled_with_toolbar_width(
        anchor,
        anchor_kind,
        monitor_rect,
        surface,
        scale_factor,
        toolbar_width,
        preferred_placement,
    );
    set_window_surface(
        app,
        &window,
        placement.window_position,
        surface,
        scale_factor,
        toolbar_width,
    )?;
    Ok(placement)
}

pub fn show_result_at_toolbar(
    app: &AppHandle,
    toolbar_position: ScreenPoint,
    toolbar_width: f64,
    preferred_placement: SelectionToolbarPlacement,
) -> Result<SurfacePlacement, String> {
    let window = ensure_window(app)?;
    let monitor = monitor_for_point(
        app,
        ScreenPoint {
            x: toolbar_position.x + toolbar_width / 2.0,
            y: toolbar_position.y + TOOLBAR_HEIGHT / 2.0,
        },
    )?;
    let scale_factor = coordinate_scale_factor(&monitor);
    let placement = place_result_from_toolbar(
        toolbar_position,
        toolbar_width,
        preferred_placement,
        work_area(&monitor),
        scale_factor,
    );
    set_window_surface(
        app,
        &window,
        placement.window_position,
        SurfaceSize::Result,
        scale_factor,
        toolbar_width,
    )?;
    Ok(placement)
}

pub fn show_surface_at_position(
    app: &AppHandle,
    requested_position: ScreenPoint,
    surface: SurfaceSize,
    toolbar_width: f64,
) -> Result<ScreenPoint, String> {
    let window = ensure_window(app)?;
    let monitor = monitor_for_point(app, requested_position)?;
    let position = clamp_surface_position_with_toolbar_width(
        requested_position,
        work_area(&monitor),
        surface,
        coordinate_scale_factor(&monitor),
        toolbar_width,
    );
    set_window_surface(
        app,
        &window,
        position,
        surface,
        coordinate_scale_factor(&monitor),
        toolbar_width,
    )?;
    Ok(position)
}

pub fn show_overflow_at_toolbar(
    app: &AppHandle,
    toolbar_position: ScreenPoint,
    toolbar_width: f64,
    overflow_height: f64,
) -> Result<OverflowPlacement, String> {
    let window = ensure_window(app)?;
    let (placement, scale_factor) =
        overflow_placement(app, toolbar_position, toolbar_width, overflow_height)?;
    set_window_frame(
        app,
        &window,
        placement.window_position,
        SurfaceSize::Overflow,
        scale_factor,
        toolbar_width,
        overflow_height,
    )?;
    Ok(placement)
}

pub fn overflow_placement(
    app: &AppHandle,
    toolbar_position: ScreenPoint,
    toolbar_width: f64,
    overflow_height: f64,
) -> Result<(OverflowPlacement, f64), String> {
    let monitor = monitor_for_point(
        app,
        ScreenPoint {
            x: toolbar_position.x + toolbar_width / 2.0,
            y: toolbar_position.y + TOOLBAR_HEIGHT / 2.0,
        },
    )?;
    let scale_factor = coordinate_scale_factor(&monitor);
    let placement = place_overflow_from_toolbar(
        toolbar_position,
        toolbar_width,
        overflow_height,
        work_area(&monitor),
        scale_factor,
    );
    Ok((placement, scale_factor))
}

pub fn current_screen_position(app: &AppHandle) -> Option<ScreenPoint> {
    let window = app.get_webview_window(SELECTION_TOOLBAR_WINDOW_LABEL)?;
    let position = window.outer_position().ok()?;
    #[cfg(target_os = "macos")]
    let scale_factor = window.scale_factor().ok()?;
    #[cfg(not(target_os = "macos"))]
    let scale_factor = 1.0;
    Some(ScreenPoint {
        x: f64::from(position.x) / scale_factor,
        y: f64::from(position.y) / scale_factor,
    })
}

fn set_window_surface(
    app: &AppHandle,
    window: &WebviewWindow,
    position: ScreenPoint,
    surface: SurfaceSize,
    _scale_factor: f64,
    toolbar_width: f64,
) -> Result<(), String> {
    let (width, height) = surface.dimensions_with_toolbar_width(toolbar_width);
    set_window_frame(app, window, position, surface, _scale_factor, width, height)
}

fn set_window_frame(
    app: &AppHandle,
    window: &WebviewWindow,
    position: ScreenPoint,
    _surface: SurfaceSize,
    _scale_factor: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    super::macos_panel::set_result_interactive(matches!(_surface, SurfaceSize::Result));
    #[cfg(target_os = "macos")]
    window
        .set_size(Size::Logical(LogicalSize::new(width, height)))
        .map_err(|error| error.to_string())?;
    #[cfg(not(target_os = "macos"))]
    window
        .set_size(Size::Physical(PhysicalSize::new(
            (width * _scale_factor).round() as u32,
            (height * _scale_factor).round() as u32,
        )))
        .map_err(|error| error.to_string())?;
    #[cfg(target_os = "macos")]
    window
        .set_position(Position::Logical(LogicalPosition::new(
            position.x, position.y,
        )))
        .map_err(|error| error.to_string())?;
    #[cfg(not(target_os = "macos"))]
    window
        .set_position(Position::Physical(PhysicalPosition::new(
            position.x.round() as i32,
            position.y.round() as i32,
        )))
        .map_err(|error| error.to_string())?;
    #[cfg(not(target_os = "macos"))]
    // The result surface hosts clickable/scrollable content and must accept
    // focus; the plain toolbar strip must never steal it from the source app.
    window
        .set_focusable(matches!(_surface, SurfaceSize::Result))
        .map_err(|error| error.to_string())?;
    show_without_activating(app, window)
}

/// Give the toolbar window keyboard/click focus so the result surface's
/// controls respond to the very first click. On macOS the nonactivating panel
/// becomes key without activating AQBot; elsewhere the window takes focus.
pub fn focus_surface(app: &AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        return super::macos_panel::make_key_window(app);
    }

    #[cfg(not(target_os = "macos"))]
    {
        let window = app
            .get_webview_window(SELECTION_TOOLBAR_WINDOW_LABEL)
            .ok_or_else(|| "Selection toolbar window is not available".to_string())?;
        window.set_focus().map_err(|error| error.to_string())
    }
}

/// Release keyboard focus after a pinned result receives an outside click.
/// Other platforms transfer focus through the native click itself.
pub fn release_surface_focus(app: &AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        return super::macos_panel::resign_key_window(app);
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Ok(())
    }
}

/// Show the toolbar without making AQBot the frontmost application when possible.
fn show_without_activating(app: &AppHandle, window: &WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let _ = window;
        return super::macos_panel::order_front(app);
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        window.show().map_err(|error| error.to_string())?;
        let _ = window.set_always_on_top(false);
        let _ = window.set_always_on_top(true);
        Ok(())
    }
}

fn monitor_for_point(app: &AppHandle, point: ScreenPoint) -> Result<Monitor, String> {
    app.available_monitors()
        .map_err(|error| error.to_string())?
        .into_iter()
        .find(|monitor| {
            let position = monitor.position();
            let size = monitor.size();
            coordinate_rect(
                ScreenRect {
                    x: f64::from(position.x),
                    y: f64::from(position.y),
                    width: f64::from(size.width),
                    height: f64::from(size.height),
                },
                monitor.scale_factor(),
            )
            .contains(point)
        })
        .or_else(|| app.primary_monitor().ok().flatten())
        .ok_or_else(|| "No display is available for the selection toolbar".to_string())
}

fn work_area(monitor: &Monitor) -> ScreenRect {
    let work_area = monitor.work_area();
    coordinate_rect(
        ScreenRect {
            x: f64::from(work_area.position.x),
            y: f64::from(work_area.position.y),
            width: f64::from(work_area.size.width),
            height: f64::from(work_area.size.height),
        },
        monitor.scale_factor(),
    )
}

#[cfg(target_os = "macos")]
fn coordinate_scale_factor(_monitor: &Monitor) -> f64 {
    1.0
}

#[cfg(not(target_os = "macos"))]
fn coordinate_scale_factor(monitor: &Monitor) -> f64 {
    monitor.scale_factor()
}

#[cfg(target_os = "macos")]
fn coordinate_rect(rect: ScreenRect, scale_factor: f64) -> ScreenRect {
    ScreenRect {
        x: rect.x / scale_factor,
        y: rect.y / scale_factor,
        width: rect.width / scale_factor,
        height: rect.height / scale_factor,
    }
}

#[cfg(not(target_os = "macos"))]
fn coordinate_rect(rect: ScreenRect, _scale_factor: f64) -> ScreenRect {
    rect
}

pub fn hide(app: &AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        super::macos_panel::set_result_interactive(false);
        return super::macos_panel::hide_panel(app);
    }
    #[cfg(not(target_os = "macos"))]
    {
        if let Some(window) = app.get_webview_window(SELECTION_TOOLBAR_WINDOW_LABEL) {
            window.hide().map_err(|error| error.to_string())?;
        }
        Ok(())
    }
}

pub fn contains_screen_point(app: &AppHandle, point: ScreenPoint) -> bool {
    toolbar_screen_rect(app)
        .map(|rect| rect_contains_with_padding(rect, point, HIT_TEST_PADDING))
        .unwrap_or(false)
}

/// True when the pointer is over the selection toolbar and the click must not dismiss it.
pub fn is_pointer_over_toolbar(app: &AppHandle, point: ScreenPoint) -> bool {
    if !is_toolbar_visible(app) {
        return false;
    }
    if native_pointer_belongs_to_app(point) {
        tracing::debug!("selection toolbar self-hit via native window/process");
        return true;
    }
    if contains_screen_point(app, point) {
        tracing::debug!("selection toolbar self-hit via geometry");
        return true;
    }
    false
}

pub fn is_toolbar_visible_for_suppress(app: &AppHandle) -> bool {
    is_toolbar_visible(app)
}

fn is_toolbar_visible(app: &AppHandle) -> bool {
    #[cfg(target_os = "macos")]
    {
        return super::macos_panel::is_panel_visible(app);
    }
    #[cfg(not(target_os = "macos"))]
    {
        app.get_webview_window(SELECTION_TOOLBAR_WINDOW_LABEL)
            .and_then(|window| window.is_visible().ok())
            .unwrap_or(false)
    }
}

fn toolbar_screen_rect(app: &AppHandle) -> Option<ScreenRect> {
    let window = app.get_webview_window(SELECTION_TOOLBAR_WINDOW_LABEL)?;
    let (Ok(position), Ok(size)) = (window.outer_position(), window.outer_size()) else {
        return None;
    };
    let scale_factor = window.scale_factor().unwrap_or(1.0);
    Some(coordinate_rect(
        ScreenRect {
            x: f64::from(position.x),
            y: f64::from(position.y),
            width: f64::from(size.width),
            height: f64::from(size.height),
        },
        scale_factor,
    ))
}

fn rect_contains_with_padding(rect: ScreenRect, point: ScreenPoint, padding: f64) -> bool {
    ScreenRect {
        x: rect.x - padding,
        y: rect.y - padding,
        width: rect.width + padding * 2.0,
        height: rect.height + padding * 2.0,
    }
    .contains(point)
}

#[cfg(target_os = "macos")]
fn native_pointer_belongs_to_app(point: ScreenPoint) -> bool {
    use axuielement::SystemWideElement;

    let own_pid = std::process::id() as i32;
    let Some(system) = SystemWideElement::new() else {
        return false;
    };
    match system.element_at_position(point.x as f32, point.y as f32) {
        Ok(Some(element)) => element.pid().ok() == Some(own_pid),
        _ => false,
    }
}

#[cfg(target_os = "windows")]
fn native_pointer_belongs_to_app(point: ScreenPoint) -> bool {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowThreadProcessId, WindowFromPoint};

    let hwnd = unsafe {
        WindowFromPoint(POINT {
            x: point.x.round() as i32,
            y: point.y.round() as i32,
        })
    };
    if hwnd.is_invalid() {
        return false;
    }
    let mut process_id = 0u32;
    let _ = unsafe { GetWindowThreadProcessId(hwnd, Some(&mut process_id)) };
    process_id == std::process::id()
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn native_pointer_belongs_to_app(_point: ScreenPoint) -> bool {
    false
}

/// True when the only visible app window is the selection toolbar (do not restore main).
pub fn only_toolbar_visible(app: &AppHandle) -> bool {
    let toolbar_visible = is_toolbar_visible(app);
    if !toolbar_visible {
        return false;
    }
    let other_visible = app
        .webview_windows()
        .into_iter()
        .filter(|(label, _)| label != SELECTION_TOOLBAR_WINDOW_LABEL)
        .any(|(_, window)| window.is_visible().unwrap_or(false));
    !other_visible
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "macos")]
    use super::coordinate_rect;
    use super::{rect_contains_with_padding, ScreenPoint, ScreenRect};

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_window_bounds_are_compared_in_logical_coordinates() {
        assert_eq!(
            coordinate_rect(
                ScreenRect {
                    x: 2048.0,
                    y: 960.0,
                    width: 640.0,
                    height: 72.0,
                },
                2.0,
            ),
            ScreenRect {
                x: 1024.0,
                y: 480.0,
                width: 320.0,
                height: 36.0,
            }
        );
    }

    #[test]
    fn hit_test_padding_accepts_near_edge_clicks() {
        let rect = ScreenRect {
            x: 100.0,
            y: 200.0,
            width: 320.0,
            height: 36.0,
        };
        assert!(rect_contains_with_padding(
            rect,
            ScreenPoint { x: 98.0, y: 218.0 },
            4.0,
        ));
        assert!(!rect_contains_with_padding(
            rect,
            ScreenPoint { x: 90.0, y: 218.0 },
            4.0,
        ));
    }
}
