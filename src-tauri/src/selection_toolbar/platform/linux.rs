use std::thread;

use aqbot_core::types::SelectionToolbarSettings;
use atspi::{
    events::{
        focus::FocusEvent,
        mouse::ButtonEvent,
        object::TextSelectionChangedEvent,
        window::{DeactivateEvent, MinimizeEvent},
    },
    proxy::{accessible::ObjectRefExt, proxy_ext::ProxyExt},
    AccessibilityConnection, CoordType, Event, FocusEvents, Granularity, MouseEvents, ObjectEvents,
    ObjectRefOwned, WindowEvents,
};
use futures::StreamExt;
use tokio::sync::{mpsc::UnboundedSender, oneshot, watch};

use super::{DismissReason, PlatformEvent, PlatformMonitorHandle, PlatformStartError};
use crate::selection_toolbar::{
    is_actionable_selection_text, PermissionSettingsOutcome, PermissionState, RuntimeError,
    ScreenPoint, ScreenRect, SelectionAnchorKind, SelectionObservation,
};

pub fn start_monitor(
    sender: UnboundedSender<PlatformEvent>,
    _settings: watch::Receiver<SelectionToolbarSettings>,
) -> Result<PlatformMonitorHandle, PlatformStartError> {
    let (stop_sender, stop_receiver) = oneshot::channel();
    let (ready_sender, ready_receiver) = std::sync::mpsc::sync_channel(1);
    let thread = thread::Builder::new()
        .name("selection-toolbar-atspi".into())
        .spawn(move || {
            let runtime = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(runtime) => runtime,
                Err(error) => {
                    let _ = ready_sender.send(Err(error.to_string()));
                    return;
                }
            };
            runtime.block_on(run_monitor(sender, stop_receiver, ready_sender));
        })
        .map_err(|error| start_error("atspi_thread_failed", error.to_string()))?;

    match ready_receiver.recv() {
        Ok(Ok(())) => Ok(PlatformMonitorHandle::new(move || {
            let _ = stop_sender.send(());
            let _ = thread.join();
        })),
        Ok(Err(message)) => {
            let _ = thread.join();
            Err(start_error("atspi_unavailable", message))
        }
        Err(error) => {
            let _ = thread.join();
            Err(start_error("atspi_start_failed", error.to_string()))
        }
    }
}

pub fn open_permission_settings() -> Result<PermissionSettingsOutcome, String> {
    Err(
        "AT-SPI has no platform permission settings page; enable the desktop accessibility bus"
            .into(),
    )
}

pub fn permission_state() -> PermissionState {
    PermissionState::NotRequired
}

pub fn request_permission() -> Result<PermissionState, String> {
    Err("AT-SPI does not use a user-granted accessibility permission".into())
}

async fn run_monitor(
    sender: UnboundedSender<PlatformEvent>,
    mut stop: oneshot::Receiver<()>,
    ready: std::sync::mpsc::SyncSender<Result<(), String>>,
) {
    let connection = match connect_and_register().await {
        Ok(connection) => connection,
        Err(error) => {
            let _ = ready.send(Err(error));
            return;
        }
    };
    let _ = ready.send(Ok(()));
    let events = connection.event_stream();
    tokio::pin!(events);

    loop {
        tokio::select! {
            _ = &mut stop => break,
            event = events.next() => {
                match event {
                    Some(Ok(event)) => handle_event(&connection, &sender, event).await,
                    Some(Err(error)) => {
                        let _ = sender.send(PlatformEvent::Error(RuntimeError {
                            code: "atspi_event_failed".into(),
                            message: error.to_string(),
                        }));
                        break;
                    }
                    None => {
                        let _ = sender.send(PlatformEvent::Error(RuntimeError {
                            code: "atspi_bus_closed".into(),
                            message: "AT-SPI event stream closed".into(),
                        }));
                        break;
                    }
                }
            }
        }
    }
}

async fn connect_and_register() -> Result<AccessibilityConnection, String> {
    let connection = AccessibilityConnection::new()
        .await
        .map_err(|error| error.to_string())?;
    connection
        .register_event::<TextSelectionChangedEvent>()
        .await
        .map_err(|error| error.to_string())?;
    connection
        .register_event::<FocusEvent>()
        .await
        .map_err(|error| error.to_string())?;
    connection
        .register_event::<MinimizeEvent>()
        .await
        .map_err(|error| error.to_string())?;
    connection
        .register_event::<DeactivateEvent>()
        .await
        .map_err(|error| error.to_string())?;
    connection
        .register_event::<ButtonEvent>()
        .await
        .map_err(|error| error.to_string())?;
    Ok(connection)
}

async fn handle_event(
    connection: &AccessibilityConnection,
    sender: &UnboundedSender<PlatformEvent>,
    event: Event,
) {
    let item = match event {
        Event::Object(ObjectEvents::TextSelectionChanged(event)) => Some(event.item),
        Event::Focus(FocusEvents::Focus(event)) => Some(event.item),
        Event::Window(WindowEvents::Minimize(_) | WindowEvents::Deactivate(_)) => {
            let _ = sender.send(PlatformEvent::Dismiss(DismissReason::AppChanged));
            None
        }
        Event::Mouse(MouseEvents::Button(event)) => {
            if event.detail.ends_with('p') {
                let _ = sender.send(PlatformEvent::GlobalPointerDown(ScreenPoint {
                    x: f64::from(event.mouse_x),
                    y: f64::from(event.mouse_y),
                }));
            }
            None
        }
        _ => None,
    };
    let Some(item) = item else {
        return;
    };
    match read_selection(connection, &item).await {
        Ok(Some(observation)) => {
            let _ = sender.send(PlatformEvent::Selection(observation));
        }
        Ok(None) => {
            let _ = sender.send(PlatformEvent::Clear);
        }
        Err(message) => {
            let _ = sender.send(PlatformEvent::Error(RuntimeError {
                code: "atspi_selection_failed".into(),
                message,
            }));
        }
    }
}

async fn read_selection(
    connection: &AccessibilityConnection,
    item: &ObjectRefOwned,
) -> Result<Option<SelectionObservation>, String> {
    let accessible = item
        .as_accessible_proxy(connection.connection())
        .await
        .map_err(|error| error.to_string())?;
    let proxies = accessible
        .proxies()
        .await
        .map_err(|error| error.to_string())?;
    let text_proxy = match proxies.text().await {
        Ok(proxy) => proxy,
        Err(atspi::AtspiError::InterfaceNotAvailable(_)) => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    if text_proxy
        .get_n_selections()
        .await
        .map_err(|error| error.to_string())?
        < 1
    {
        return Ok(None);
    }
    let (start, end) = text_proxy
        .get_selection(0)
        .await
        .map_err(|error| error.to_string())?;
    if start < 0 || end <= start {
        return Ok(None);
    }
    let text = text_proxy
        .get_text(start, end)
        .await
        .map_err(|error| error.to_string())?;
    if !is_actionable_selection_text(&text) {
        return Ok(None);
    }
    let (_, line_start, line_end) = text_proxy
        .get_string_at_offset(start, Granularity::Line)
        .await
        .map_err(|error| error.to_string())?;
    let first_line_end = end.min(line_end).max(start + 1);
    let (x, y, width, height) = text_proxy
        .get_range_extents(start.max(line_start), first_line_end, CoordType::Screen)
        .await
        .map_err(|error| error.to_string())?;
    if width <= 0 || height <= 0 {
        return Ok(None);
    }
    let source_app = application_name(connection, &accessible, item).await;
    let source_window = window_name(connection, item)
        .await
        .unwrap_or_else(|| item.path_as_str().to_string());

    Ok(Some(SelectionObservation {
        text,
        source_app,
        source_window,
        range_signature: format!("{start}:{end}"),
        anchor: ScreenRect {
            x: f64::from(x),
            y: f64::from(y),
            width: f64::from(width),
            height: f64::from(height),
        },
        anchor_kind: SelectionAnchorKind::SelectionRect,
    }))
}

async fn application_name(
    connection: &AccessibilityConnection,
    accessible: &atspi::proxy::accessible::AccessibleProxy<'_>,
    item: &ObjectRefOwned,
) -> String {
    let name = match accessible.get_application().await {
        Ok(application) => match application
            .as_accessible_proxy(connection.connection())
            .await
        {
            Ok(proxy) => proxy.name().await.ok(),
            Err(_) => None,
        },
        Err(_) => None,
    };
    name.filter(|value| !value.trim().is_empty())
        .or_else(|| item.name_as_str().map(str::to_string))
        .unwrap_or_else(|| "unknown-application".into())
}

async fn window_name(
    connection: &AccessibilityConnection,
    item: &ObjectRefOwned,
) -> Option<String> {
    let mut current = item.clone();
    let mut fallback = None;
    for _ in 0..16 {
        let proxy = current
            .as_accessible_proxy(connection.connection())
            .await
            .ok()?;
        let name = proxy
            .name()
            .await
            .ok()
            .filter(|value| !value.trim().is_empty());
        if fallback.is_none() {
            fallback = name.clone();
        }
        let role = proxy.get_role_name().await.unwrap_or_default();
        if matches!(role.as_str(), "window" | "frame" | "dialog") {
            return name.or(fallback);
        }
        let parent = proxy.parent().await.ok()?;
        if parent.is_null() || parent == current {
            break;
        }
        current = parent;
    }
    fallback
}

fn start_error(code: &str, message: String) -> PlatformStartError {
    PlatformStartError {
        permission: PermissionState::Unknown,
        error: RuntimeError {
            code: code.into(),
            message,
        },
    }
}
