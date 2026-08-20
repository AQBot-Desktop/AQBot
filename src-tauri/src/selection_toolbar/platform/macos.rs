use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::Path;
use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::Duration;

use axuielement::async_api::AXNotificationStream;
use axuielement::ax_action::AX_PRESS_ACTION;
use axuielement::ax_attribute::{
    AX_BOUNDS_FOR_RANGE_PARAMETERIZED_ATTRIBUTE, AX_ENABLED_ATTRIBUTE,
    AX_FOCUSED_UI_ELEMENT_ATTRIBUTE, AX_FOCUSED_WINDOW_ATTRIBUTE, AX_IDENTIFIER_ATTRIBUTE,
    AX_MENU_BAR_ATTRIBUTE, AX_MENU_ITEM_CMD_CHAR_ATTRIBUTE, AX_PARENT_ATTRIBUTE,
    AX_SELECTED_TEXT_ATTRIBUTE, AX_SELECTED_TEXT_RANGE_ATTRIBUTE, AX_TITLE_ATTRIBUTE,
};
use axuielement::ax_notification::{
    AX_FOCUSED_UI_ELEMENT_CHANGED_NOTIFICATION, AX_FOCUSED_WINDOW_CHANGED_NOTIFICATION,
    AX_SELECTED_TEXT_CHANGED_NOTIFICATION, AX_WINDOW_MINIATURIZED_NOTIFICATION,
};
use axuielement::{
    is_process_trusted, is_process_trusted_with_prompt, AXObserverEvent, AXRange,
    AXTextMarkerRange, AXUIElement, AXValue, SystemWideElement,
};
use block2::RcBlock;
use core_foundation::{base::TCFType, runloop::CFRunLoop};
use core_foundation_sys::mach_port::CFMachPortRef;
use core_foundation_sys::runloop::{kCFRunLoopCommonModes, CFRunLoopRef, CFRunLoopStop};
use core_graphics::event::{
    CGEvent, CGEventFlags, CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement,
    CGEventType, CallbackResult, EventField, KeyCode,
};
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
use core_graphics::geometry::CGPoint;
use objc2::{
    rc::Retained,
    runtime::{AnyObject, ProtocolObject},
};
use objc2_app_kit::{
    NSApplicationActivationPolicy, NSPasteboard, NSPasteboardTypeString, NSRunningApplication,
    NSWorkspace, NSWorkspaceApplicationKey, NSWorkspaceDidActivateApplicationNotification,
    NSWorkspaceDidDeactivateApplicationNotification, NSWorkspaceDidHideApplicationNotification,
    NSWorkspaceDidTerminateApplicationNotification,
};
use objc2_foundation::{NSNotification, NSNotificationCenter, NSObjectProtocol, NSString};
use tokio::sync::{
    mpsc::{UnboundedReceiver, UnboundedSender},
    oneshot,
};

use super::{DismissReason, PlatformEvent, PlatformMonitorHandle, PlatformStartError};
use crate::selection_toolbar::{
    is_actionable_selection_text, PermissionSettingsOutcome, PermissionState, RuntimeError,
    ScreenPoint, ScreenRect, SelectionAnchorKind, SelectionObservation,
};

const MAX_SELECTION_ANCESTORS: usize = 16;
/// Chromium/WebKit publish the AX selection asynchronously after mouse-up — often
/// ~50ms, but heavy pages can take several hundred ms. Probe repeatedly with
/// backoff (cumulative 80/230/630ms) until a selection is readable; applications
/// with AX notifications still take their faster event-driven path, and the
/// controller drops re-announcements of the selection that is already live.
const SELECTION_PROBE_DELAYS_MS: [u64; 3] = [80, 150, 400];
/// Poll the pasteboard after menu/shortcut copy. SelectedTextKit uses ~5ms
/// intervals and ~200ms total; WeChat occasionally needs a bit longer.
const CLIPBOARD_FALLBACK_INTERVAL_MS: u64 = 5;
const CLIPBOARD_FALLBACK_TIMEOUT_MS: u64 = 350;
/// Depth limit when searching the app menu bar for the Copy item.
const COPY_MENU_SEARCH_MAX_DEPTH: usize = 6;
const COPY_MENU_SEARCH_MAX_NODES: usize = 256;
/// Apps known to omit AXSelectedText for custom-drawn message lists. For these
/// we escalate to clipboard fallback after the first AX miss instead of waiting
/// for the full probe budget.
const WEAK_AX_SOURCE_APP_MARKERS: &[&str] = &[
    "wechat",
    "xinwechat",
    "weixin",
    "wework",
    "wwmax",
    "tencent.xinwechat",
    "tencent.wework",
];
const AX_SELECTED_TEXT_MARKER_RANGE_ATTRIBUTE: &str = "AXSelectedTextMarkerRange";
const AX_STRING_FOR_TEXT_MARKER_RANGE_PARAMETERIZED_ATTRIBUTE: &str = "AXStringForTextMarkerRange";
const AX_TEXT_MARKER_RANGE_FOR_UNORDERED_TEXT_MARKERS_PARAMETERIZED_ATTRIBUTE: &str =
    "AXTextMarkerRangeForUnorderedTextMarkers";
const AX_NEXT_TEXT_MARKER_FOR_TEXT_MARKER_PARAMETERIZED_ATTRIBUTE: &str =
    "AXNextTextMarkerForTextMarker";
const AX_BOUNDS_FOR_TEXT_MARKER_RANGE_PARAMETERIZED_ATTRIBUTE: &str = "AXBoundsForTextMarkerRange";
const AX_FRAME_ATTRIBUTE: &str = "AXFrame";
/// Standard AppKit selector identifier for Edit → Copy.
const COPY_MENU_IDENTIFIER: &str = "copy:";
const COPY_MENU_TITLES: &[&str] = &[
    "Copy",
    "拷贝",
    "复制",
    "拷貝",
    "複製",
    "コピー",
    "복사",
    "Copier",
    "Copiar",
    "Copia",
    "Kopieren",
    "Копировать",
];

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn CGEventTapEnable(tap: CFMachPortRef, enable: bool);
}

#[derive(Debug, Clone)]
struct WorkspaceApplication {
    pid: i32,
    source_app: String,
    /// Regular activation policy (Dock app). Accessory/prohibited processes are
    /// transient overlays — the screenshot UI, Spotlight, launchers — whose
    /// activation and clicks must not dismiss the toolbar or steal the binding.
    is_regular: bool,
}

#[derive(Debug, Clone, Copy)]
struct LogicalPoint {
    x: f64,
    y: f64,
}

#[derive(Debug)]
enum MacSignal {
    ApplicationActivated(WorkspaceApplication),
    ApplicationDismissed(i32),
    SelectionProbeRequested(LogicalPoint),
    SelectionProbeReady {
        point: LogicalPoint,
        attempt: usize,
        source_pid: Option<i32>,
    },
}

#[derive(Debug, Default)]
struct MonitorLifecycle {
    active_pid: Option<i32>,
    generation: u64,
}

impl MonitorLifecycle {
    fn activate(&mut self, pid: i32, own_pid: i32) -> Option<u64> {
        if pid == own_pid {
            return None;
        }
        self.generation = self.generation.wrapping_add(1);
        self.active_pid = Some(pid);
        Some(self.generation)
    }

    fn dismiss(&mut self, pid: i32) -> bool {
        if self.active_pid != Some(pid) {
            return false;
        }
        self.generation = self.generation.wrapping_add(1);
        self.active_pid = None;
        true
    }

    fn refresh(&mut self, pid: i32) -> Option<u64> {
        if self.active_pid != Some(pid) {
            return None;
        }
        self.generation = self.generation.wrapping_add(1);
        Some(self.generation)
    }

    #[cfg(test)]
    fn accepts(&self, pid: i32, generation: u64) -> bool {
        self.active_pid == Some(pid) && self.generation == generation
    }
}

pub fn start_monitor(
    sender: UnboundedSender<PlatformEvent>,
) -> Result<PlatformMonitorHandle, PlatformStartError> {
    if !is_process_trusted() {
        return Err(PlatformStartError {
            permission: PermissionState::Denied,
            error: RuntimeError {
                code: "macos_accessibility_permission_required".into(),
                message: "macOS Accessibility permission is required".into(),
            },
        });
    }

    let (ready_tx, ready_rx) = mpsc::sync_channel(1);
    let (stop_tx, stop_rx) = oneshot::channel();
    let (mac_sender, mac_receiver) = tokio::sync::mpsc::unbounded_channel();
    // True while a non-regular (overlay) app — screenshot UI, Spotlight — is
    // frontmost; global mouse/Esc events then belong to the overlay.
    let overlay_active = Arc::new(AtomicBool::new(false));
    let ax_sender = sender.clone();
    let ax_mac_sender = mac_sender.clone();
    let ax_overlay = Arc::clone(&overlay_active);
    let ax_thread = thread::Builder::new()
        .name("aqbot-selection-ax".into())
        .spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build();
            let result = runtime
                .map_err(|error| error.to_string())
                .and_then(|runtime| {
                    runtime.block_on(run_monitor(
                        ax_sender,
                        ax_mac_sender,
                        mac_receiver,
                        stop_rx,
                        ready_tx,
                        ax_overlay,
                    ));
                    Ok(())
                });
            if let Err(error) = result {
                tracing::error!(%error, "macOS selection monitor stopped");
            }
        })
        .map_err(|error| PlatformStartError {
            permission: PermissionState::Granted,
            error: RuntimeError {
                code: "macos_monitor_thread_failed".into(),
                message: error.to_string(),
            },
        })?;

    if let Err(error) = ready_rx
        .recv()
        .map_err(|error| PlatformStartError {
            permission: PermissionState::Granted,
            error: RuntimeError {
                code: "macos_monitor_start_failed".into(),
                message: error.to_string(),
            },
        })
        .and_then(|result| result)
    {
        let _ = stop_tx.send(());
        let _ = ax_thread.join();
        return Err(error);
    }

    let (global_stop, global_thread) =
        match start_global_dismiss_listener(sender, mac_sender, overlay_active) {
            Ok(listener) => listener,
            Err(error) => {
                let _ = stop_tx.send(());
                let _ = ax_thread.join();
                return Err(error);
            }
        };

    Ok(PlatformMonitorHandle::new(move || {
        let _ = stop_tx.send(());
        global_stop();
        let _ = ax_thread.join();
        let _ = global_thread.join();
    }))
}

pub fn permission_state() -> PermissionState {
    if is_process_trusted() {
        PermissionState::Granted
    } else {
        PermissionState::Denied
    }
}

fn start_global_dismiss_listener(
    sender: UnboundedSender<PlatformEvent>,
    mac_sender: UnboundedSender<MacSignal>,
    overlay_active: Arc<AtomicBool>,
) -> Result<(impl FnOnce() + Send + 'static, thread::JoinHandle<()>), PlatformStartError> {
    let (ready_sender, ready_receiver) = mpsc::sync_channel(1);
    let thread = thread::Builder::new()
        .name("aqbot-selection-global-events".into())
        .spawn(move || {
            let event_sender = sender;
            let event_tap_ref = Arc::new(AtomicUsize::new(0));
            let callback_event_tap_ref = Arc::clone(&event_tap_ref);
            let event_tap = match CGEventTap::new(
                CGEventTapLocation::Session,
                CGEventTapPlacement::HeadInsertEventTap,
                CGEventTapOptions::ListenOnly,
                vec![
                    CGEventType::KeyDown,
                    CGEventType::LeftMouseDown,
                    CGEventType::LeftMouseUp,
                    CGEventType::RightMouseDown,
                    CGEventType::OtherMouseDown,
                ],
                move |_, event_type, event| {
                    if let Some(reason) = event_tap_disable_reason(event_type) {
                        let tap_ref = callback_event_tap_ref.load(Ordering::Acquire);
                        if tap_ref == 0 {
                            tracing::error!(
                                reason,
                                "macOS global event tap was disabled before initialization"
                            );
                        } else {
                            // SAFETY: The pointer belongs to the live CGEventTap retained by this
                            // event thread and is only used while its run loop callback is active.
                            unsafe {
                                CGEventTapEnable(tap_ref as CFMachPortRef, true);
                            }
                            tracing::warn!(
                                reason,
                                "macOS global event tap was disabled and re-enabled"
                            );
                        }
                        return CallbackResult::Keep;
                    }
                    // While a screenshot/launcher overlay is frontmost, its
                    // clicks and Esc belong to the overlay — not to us.
                    if overlay_active.load(Ordering::Relaxed) {
                        return CallbackResult::Keep;
                    }
                    if matches!(event_type, CGEventType::KeyDown)
                        && event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE) == 53
                    {
                        let _ = event_sender.send(PlatformEvent::Dismiss(DismissReason::Escape));
                    } else if matches!(event_type, CGEventType::LeftMouseUp) {
                        let location = event.location();
                        let _ = mac_sender.send(MacSignal::SelectionProbeRequested(LogicalPoint {
                            x: location.x,
                            y: location.y,
                        }));
                    } else if matches!(
                        event_type,
                        CGEventType::LeftMouseDown
                            | CGEventType::RightMouseDown
                            | CGEventType::OtherMouseDown
                    ) {
                        let location = event.location();
                        let _ = event_sender.send(PlatformEvent::GlobalPointerDown(
                            screen_point_from_cg(location),
                        ));
                    }
                    CallbackResult::Keep
                },
            ) {
                Ok(event_tap) => event_tap,
                Err(()) => {
                    let _ = ready_sender.send(Err(
                        "Could not create the macOS read-only global event tap".to_string(),
                    ));
                    return;
                }
            };
            event_tap_ref.store(
                event_tap.mach_port().as_concrete_TypeRef() as usize,
                Ordering::Release,
            );
            let source = match event_tap.mach_port().create_runloop_source(0) {
                Ok(source) => source,
                Err(()) => {
                    let _ = ready_sender.send(Err(
                        "Could not create the macOS global event run loop source".to_string(),
                    ));
                    return;
                }
            };
            let run_loop = CFRunLoop::get_current();
            run_loop.add_source(&source, unsafe { kCFRunLoopCommonModes });
            event_tap.enable();
            let run_loop_ref = run_loop.as_concrete_TypeRef() as usize;
            let _ = ready_sender.send(Ok(run_loop_ref));
            CFRunLoop::run_current();
        })
        .map_err(|error| start_error("macos_global_event_thread_failed", &error.to_string()))?;
    let run_loop_ref = ready_receiver
        .recv()
        .map_err(|error| start_error("macos_global_event_start_failed", &error.to_string()))?
        .map_err(|message| start_error("macos_global_event_unavailable", &message))?;
    let stop = move || unsafe {
        CFRunLoopStop(run_loop_ref as CFRunLoopRef);
    };
    Ok((stop, thread))
}

fn event_tap_disable_reason(event_type: CGEventType) -> Option<&'static str> {
    match event_type {
        CGEventType::TapDisabledByTimeout => Some("timeout"),
        CGEventType::TapDisabledByUserInput => Some("user_input"),
        _ => None,
    }
}

type WorkspaceObserverToken = Retained<ProtocolObject<dyn NSObjectProtocol>>;

struct WorkspaceObserver {
    center: Retained<NSNotificationCenter>,
    tokens: Vec<WorkspaceObserverToken>,
}

#[derive(Debug, Clone, Copy)]
enum WorkspaceEventKind {
    Activated,
    Deactivated,
    Dismissed,
}

impl WorkspaceObserver {
    fn new(
        sender: UnboundedSender<MacSignal>,
        overlay_active: Arc<AtomicBool>,
    ) -> (Self, Option<WorkspaceApplication>) {
        let workspace = NSWorkspace::sharedWorkspace();
        let center = workspace.notificationCenter();
        let tokens = vec![
            add_workspace_observer(
                &center,
                unsafe { NSWorkspaceDidActivateApplicationNotification },
                WorkspaceEventKind::Activated,
                sender.clone(),
                Some(Arc::clone(&overlay_active)),
            ),
            add_workspace_observer(
                &center,
                unsafe { NSWorkspaceDidDeactivateApplicationNotification },
                WorkspaceEventKind::Deactivated,
                sender.clone(),
                None,
            ),
            add_workspace_observer(
                &center,
                unsafe { NSWorkspaceDidHideApplicationNotification },
                WorkspaceEventKind::Dismissed,
                sender.clone(),
                None,
            ),
            add_workspace_observer(
                &center,
                unsafe { NSWorkspaceDidTerminateApplicationNotification },
                WorkspaceEventKind::Dismissed,
                sender,
                None,
            ),
        ];
        let initial = workspace
            .frontmostApplication()
            .as_deref()
            .and_then(workspace_application);
        if let Some(initial) = initial.as_ref() {
            overlay_active.store(!initial.is_regular, Ordering::Relaxed);
        }
        (Self { center, tokens }, initial)
    }
}

impl Drop for WorkspaceObserver {
    fn drop(&mut self) {
        for token in &self.tokens {
            // SAFETY: Every token was returned by this notification center and remains valid.
            unsafe {
                let protocol: &ProtocolObject<dyn NSObjectProtocol> = token;
                let observer: &AnyObject = protocol.as_ref();
                self.center.removeObserver(observer);
            }
        }
    }
}

fn add_workspace_observer(
    center: &NSNotificationCenter,
    name: &NSString,
    kind: WorkspaceEventKind,
    sender: UnboundedSender<MacSignal>,
    overlay_active: Option<Arc<AtomicBool>>,
) -> WorkspaceObserverToken {
    let block = RcBlock::new(move |notification: NonNull<NSNotification>| {
        let notification = unsafe { notification.as_ref() };
        let Some(application) = workspace_application_from_notification(notification) else {
            return;
        };
        if let Some(overlay) = overlay_active.as_ref() {
            overlay.store(!application.is_regular, Ordering::Relaxed);
        }
        if let Some(signal) = workspace_signal(kind, application) {
            let _ = sender.send(signal);
        }
    });
    // SAFETY: The block is sendable, notification names are static, and the returned token is
    // retained until it is explicitly removed by WorkspaceObserver::drop.
    unsafe { center.addObserverForName_object_queue_usingBlock(Some(name), None, None, &block) }
}

fn workspace_signal(
    kind: WorkspaceEventKind,
    application: WorkspaceApplication,
) -> Option<MacSignal> {
    match kind {
        // Overlay processes (screenshot UI, Spotlight, …) come and go without
        // meaning an app switch — never dismiss or rebind for them.
        WorkspaceEventKind::Activated if !application.is_regular => None,
        WorkspaceEventKind::Activated => Some(MacSignal::ApplicationActivated(application)),
        // AQBot's panel may transiently activate the process. The paired source-app
        // deactivation does not mean its AX element is gone; hide/terminate events do.
        WorkspaceEventKind::Deactivated => None,
        WorkspaceEventKind::Dismissed => Some(MacSignal::ApplicationDismissed(application.pid)),
    }
}

fn workspace_application_from_notification(
    notification: &NSNotification,
) -> Option<WorkspaceApplication> {
    let user_info = notification.userInfo()?;
    let user_info = unsafe { user_info.cast_unchecked::<NSString, AnyObject>() };
    let application = user_info
        .objectForKey(unsafe { NSWorkspaceApplicationKey })?
        .downcast::<NSRunningApplication>()
        .ok()?;
    workspace_application(&application)
}

fn workspace_application(application: &NSRunningApplication) -> Option<WorkspaceApplication> {
    let pid = application.processIdentifier();
    if pid <= 0 {
        return None;
    }
    let source_app = application
        .bundleIdentifier()
        .or_else(|| application.localizedName())
        .map(|value| value.to_string())
        .unwrap_or_else(|| format!("pid:{pid}"));
    Some(WorkspaceApplication {
        pid,
        source_app,
        is_regular: application.activationPolicy() == NSApplicationActivationPolicy::Regular,
    })
}

fn workspace_application_for_pid(pid: i32) -> Option<WorkspaceApplication> {
    NSRunningApplication::runningApplicationWithProcessIdentifier(pid)
        .as_deref()
        .and_then(workspace_application)
}

fn frontmost_application_pid() -> Option<i32> {
    let pid = NSWorkspace::sharedWorkspace()
        .frontmostApplication()?
        .processIdentifier();
    (pid > 0).then_some(pid)
}

fn is_copy_target_active(target_pid: i32) -> bool {
    is_macos_copy_target_active(target_pid, frontmost_application_pid())
}

async fn run_monitor(
    sender: UnboundedSender<PlatformEvent>,
    mac_sender: UnboundedSender<MacSignal>,
    mut mac_receiver: UnboundedReceiver<MacSignal>,
    mut stop_rx: oneshot::Receiver<()>,
    ready: mpsc::SyncSender<Result<(), PlatformStartError>>,
    overlay_active: Arc<AtomicBool>,
) {
    let system = match SystemWideElement::new() {
        Some(system) => system,
        None => {
            let _ = ready.send(Err(start_error(
                "macos_system_element_unavailable",
                "Could not create the macOS system accessibility element",
            )));
            return;
        }
    };
    let (workspace_observer, initial_application) =
        WorkspaceObserver::new(mac_sender.clone(), overlay_active);
    let _workspace_observer = workspace_observer;
    let own_pid = i32::try_from(std::process::id()).unwrap_or(i32::MAX);
    let mut lifecycle = MonitorLifecycle::default();
    let mut active = initial_application
        .and_then(|application| bind_application(application, own_pid, &mut lifecycle));

    let _ = ready.send(Ok(()));
    if let Some(active) = active.as_ref() {
        emit_current_selection(active, &sender);
    }

    loop {
        tokio::select! {
            _ = &mut stop_rx => break,
            signal = mac_receiver.recv() => {
                let Some(signal) = signal else {
                    break;
                };
                if !is_process_trusted() {
                    let _ = sender.send(PlatformEvent::Error(RuntimeError {
                        code: "macos_accessibility_permission_revoked".into(),
                        message: "macOS Accessibility permission was revoked while monitoring".into(),
                    }));
                    break;
                }
                handle_mac_signal(
                    signal,
                    &system,
                    own_pid,
                    &sender,
                    &mac_sender,
                    &mut lifecycle,
                    &mut active,
                );
            }
            event = wait_notification(active.as_ref().and_then(|value| value.subscriptions.focused_element.as_ref())) => {
                if event.is_some() {
                    refresh_active_application(&mut active, &mut lifecycle);
                    if let Some(active) = active.as_ref() {
                        emit_current_selection(active, &sender);
                    }
                } else if let Some(active) = active.as_mut() {
                    active.subscriptions.focused_element = None;
                }
            }
            event = wait_notification(active.as_ref().and_then(|value| value.subscriptions.focused_window.as_ref())) => {
                if event.is_some() {
                    refresh_active_application(&mut active, &mut lifecycle);
                    if let Some(active) = active.as_ref() {
                        emit_current_selection(active, &sender);
                    }
                } else if let Some(active) = active.as_mut() {
                    active.subscriptions.focused_window = None;
                }
            }
            event = wait_notification(active.as_ref().and_then(|value| value.subscriptions.window_minimized.as_ref())) => {
                if event.is_some() {
                    let _ = sender.send(PlatformEvent::Dismiss(DismissReason::AppChanged));
                    refresh_active_application(&mut active, &mut lifecycle);
                } else if let Some(active) = active.as_mut() {
                    active.subscriptions.window_minimized = None;
                }
            }
            event = wait_notification(active.as_ref().and_then(|value| value.subscriptions.app_selection.as_ref())) => {
                if let Some(event) = event {
                    emit_event_selection(active.as_ref(), &event, &sender);
                } else if let Some(active) = active.as_mut() {
                    active.subscriptions.app_selection = None;
                }
            }
            event = wait_notification(active.as_ref().and_then(|value| value.subscriptions.element_selection.as_ref())) => {
                if let Some(event) = event {
                    emit_event_selection(active.as_ref(), &event, &sender);
                } else if let Some(active) = active.as_mut() {
                    active.subscriptions.element_selection = None;
                }
            }
        }
    }
}

fn handle_mac_signal(
    signal: MacSignal,
    system: &SystemWideElement,
    own_pid: i32,
    sender: &UnboundedSender<PlatformEvent>,
    mac_sender: &UnboundedSender<MacSignal>,
    lifecycle: &mut MonitorLifecycle,
    active: &mut Option<ActiveApplication>,
) {
    match signal {
        MacSignal::ApplicationActivated(application) => {
            tracing::debug!(
                pid = application.pid,
                source_app = %application.source_app,
                "macOS foreground application activated"
            );
            // Showing or clicking the non-activating toolbar must not dismiss the session.
            // Keep the previous external-app AX subscription until a real third-party app
            // becomes frontmost (or the source app is dismissed).
            if application.pid == own_pid {
                tracing::debug!("Ignoring own-application activation for selection toolbar");
                return;
            }
            let _ = sender.send(PlatformEvent::Dismiss(DismissReason::AppChanged));
            *active = bind_application(application, own_pid, lifecycle);
            if let Some(active) = active.as_ref() {
                emit_current_selection(active, sender);
            }
        }
        MacSignal::ApplicationDismissed(pid) => {
            let dismissed = lifecycle.dismiss(pid);
            if dismissed {
                *active = None;
                let _ = sender.send(PlatformEvent::Dismiss(DismissReason::AppChanged));
            }
        }
        MacSignal::SelectionProbeRequested(point) => {
            let source_pid = active.as_ref().map(|active| active.info.pid);
            tracing::debug!(
                pid = source_pid,
                point_x = point.x,
                point_y = point.y,
                "Scheduling macOS mouse selection probe"
            );
            schedule_selection_probe(mac_sender, point, 0, source_pid);
        }
        MacSignal::SelectionProbeReady {
            point,
            attempt,
            source_pid,
        } => {
            let active_pid = active.as_ref().map(|active| active.info.pid);
            if !probe_source_matches_active_app(source_pid, active_pid) {
                tracing::debug!(
                    source_pid,
                    active_pid,
                    "Ignoring stale macOS selection probe after application switch"
                );
                return;
            }
            probe_selection(
                system, active, lifecycle, own_pid, point, attempt, source_pid, sender, mac_sender,
            );
        }
    }
}

fn schedule_selection_probe(
    sender: &UnboundedSender<MacSignal>,
    point: LogicalPoint,
    attempt: usize,
    source_pid: Option<i32>,
) {
    let Some(delay_ms) = SELECTION_PROBE_DELAYS_MS.get(attempt).copied() else {
        return;
    };
    let delayed_sender = sender.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(delay_ms)).await;
        let _ = delayed_sender.send(MacSignal::SelectionProbeReady {
            point,
            attempt,
            source_pid,
        });
    });
}

fn is_last_probe_attempt(attempt: usize) -> bool {
    attempt + 1 >= SELECTION_PROBE_DELAYS_MS.len()
}

fn should_try_macos_clipboard_fallback(attempt: usize, source_app: &str) -> bool {
    // This path can synthesize Cmd+C, so it must never be a generic final probe.
    attempt == 0 && is_weak_ax_source_app(source_app)
}

fn is_macos_copy_target_active(target_pid: i32, foreground_pid: Option<i32>) -> bool {
    target_pid > 0 && foreground_pid == Some(target_pid)
}

fn probe_source_matches_active_app(source_pid: Option<i32>, active_pid: Option<i32>) -> bool {
    source_pid.is_none() || source_pid == active_pid
}

fn probe_source_allows_clipboard(source_pid: Option<i32>, target_pid: i32) -> bool {
    target_pid > 0 && source_pid == Some(target_pid)
}

struct ActiveApplication {
    info: WorkspaceApplication,
    element: AXUIElement,
    subscriptions: FocusedSubscriptions,
    generation: u64,
}

#[derive(Default)]
struct FocusedSubscriptions {
    focused_element: Option<AXNotificationStream>,
    focused_window: Option<AXNotificationStream>,
    window_minimized: Option<AXNotificationStream>,
    app_selection: Option<AXNotificationStream>,
    element_selection: Option<AXNotificationStream>,
}

/// Bundle-id prefixes of Chromium-family browsers that predate the
/// `AXManualAccessibility` switch or still honour the VoiceOver-era flag.
/// `AXEnhancedUserInterface` has window-animation side effects in unrelated
/// apps, so it is only asserted for this allowlist.
const ENHANCED_UI_BUNDLE_PREFIXES: &[&str] = &[
    "com.google.Chrome",
    "com.microsoft.edgemac",
    "com.brave.Browser",
    "org.chromium",
    "com.vivaldi",
    "com.operasoftware",
    "company.thebrowser.Browser",
    "ru.yandex.desktop.yandex-browser",
];

/// Chromium builds its accessibility tree lazily and only for detected
/// assistive clients, so `AXSelectedText` reads return nothing until the tree
/// is switched on. `AXManualAccessibility` (Chromium ≥ 90 / Electron) is safe
/// to assert on every app — non-Chromium targets answer AttributeUnsupported.
fn enable_browser_accessibility(application: &AXUIElement, source_app: &str) {
    if let Err(error) = application.set_bool_attribute("AXManualAccessibility", true) {
        tracing::trace!(source_app, %error, "AXManualAccessibility is unavailable");
    }
    if ENHANCED_UI_BUNDLE_PREFIXES
        .iter()
        .any(|prefix| source_app.starts_with(prefix))
    {
        if let Err(error) = application.set_bool_attribute("AXEnhancedUserInterface", true) {
            tracing::trace!(source_app, %error, "AXEnhancedUserInterface is unavailable");
        }
    }
}

fn bind_application(
    application: WorkspaceApplication,
    own_pid: i32,
    lifecycle: &mut MonitorLifecycle,
) -> Option<ActiveApplication> {
    let generation = lifecycle.activate(application.pid, own_pid)?;
    let Some(element) = AXUIElement::from_pid(application.pid) else {
        lifecycle.dismiss(application.pid);
        tracing::debug!(
            pid = application.pid,
            "Could not create an accessibility element for the active macOS application"
        );
        return None;
    };
    // Flip on Chromium's lazily-built AX tree before subscribing, so the
    // selection attributes exist by the time the user selects text.
    enable_browser_accessibility(&element, &application.source_app);
    let subscriptions = subscribe_focused(&element);
    tracing::debug!(
        pid = application.pid,
        generation,
        "Bound macOS accessibility subscriptions to foreground application"
    );
    Some(ActiveApplication {
        info: application,
        element,
        subscriptions,
        generation,
    })
}

fn subscribe_focused(application: &AXUIElement) -> FocusedSubscriptions {
    let element = application
        .element_attribute(AX_FOCUSED_UI_ELEMENT_ATTRIBUTE)
        .ok()
        .flatten();
    let window = application
        .element_attribute(AX_FOCUSED_WINDOW_ATTRIBUTE)
        .ok()
        .flatten();
    FocusedSubscriptions {
        focused_element: subscribe_optional(
            Some(application),
            AX_FOCUSED_UI_ELEMENT_CHANGED_NOTIFICATION,
        ),
        focused_window: subscribe_optional(
            Some(application),
            AX_FOCUSED_WINDOW_CHANGED_NOTIFICATION,
        ),
        window_minimized: subscribe_optional(window.as_ref(), AX_WINDOW_MINIATURIZED_NOTIFICATION),
        app_selection: subscribe_optional(Some(application), AX_SELECTED_TEXT_CHANGED_NOTIFICATION),
        element_selection: subscribe_optional(
            element.as_ref(),
            AX_SELECTED_TEXT_CHANGED_NOTIFICATION,
        ),
    }
}

fn subscribe_optional(
    element: Option<&AXUIElement>,
    notification: &str,
) -> Option<AXNotificationStream> {
    let element = element?;
    AXNotificationStream::subscribe_many(element, &[notification], 32)
        .map_err(|error| {
            tracing::debug!(notification, %error, "macOS AX notification is unavailable");
        })
        .ok()
}

fn refresh_active_application(
    active: &mut Option<ActiveApplication>,
    lifecycle: &mut MonitorLifecycle,
) {
    if let Some(active) = active.as_mut() {
        active.subscriptions = subscribe_focused(&active.element);
        if let Some(generation) = lifecycle.refresh(active.info.pid) {
            active.generation = generation;
        }
    }
}

async fn wait_notification(stream: Option<&AXNotificationStream>) -> Option<AXObserverEvent> {
    match stream {
        Some(stream) => stream.next().await,
        None => std::future::pending().await,
    }
}

fn emit_current_selection(active: &ActiveApplication, sender: &UnboundedSender<PlatformEvent>) {
    match active
        .element
        .element_attribute(AX_FOCUSED_UI_ELEMENT_ATTRIBUTE)
    {
        Ok(Some(element)) => {
            emit_selection_from_candidates_with_pointer(active, [element], sender, None, true);
        }
        Ok(None) => {
            let _ = sender.send(PlatformEvent::Clear);
        }
        Err(error) => {
            tracing::debug!(
                pid = active.info.pid,
                %error,
                "Could not read the focused macOS accessibility element"
            );
        }
    }
}

fn emit_event_selection(
    active: Option<&ActiveApplication>,
    event: &AXObserverEvent,
    sender: &UnboundedSender<PlatformEvent>,
) {
    let Some(active) = active else {
        return;
    };
    let focused = active
        .element
        .element_attribute(AX_FOCUSED_UI_ELEMENT_ATTRIBUTE)
        .ok()
        .flatten();
    // Chromium may deliver the notification from a renderer/XPC element while
    // exposing the actual selection only on the browser application's focused
    // element. Resolve both candidates before deciding that the selection cleared.
    emit_selection_from_candidates_with_pointer(
        active,
        std::iter::once(event.element.clone()).chain(focused),
        sender,
        None,
        true,
    );
}

#[allow(clippy::too_many_arguments)]
fn probe_selection(
    system: &SystemWideElement,
    active: &mut Option<ActiveApplication>,
    lifecycle: &mut MonitorLifecycle,
    own_pid: i32,
    point: LogicalPoint,
    attempt: usize,
    source_pid: Option<i32>,
    sender: &UnboundedSender<PlatformEvent>,
    mac_sender: &UnboundedSender<MacSignal>,
) {
    match system.element_at_position(point.x as f32, point.y as f32) {
        Ok(Some(element)) => {
            let hit_pid = element.pid().ok();
            match selection_probe_action(
                active.as_ref().map(|value| value.info.pid),
                hit_pid,
                own_pid,
            ) {
                SelectionProbeAction::Ignore => {
                    tracing::debug!(
                        hit_pid,
                        own = hit_pid == Some(own_pid),
                        source_pid = active.as_ref().map(|value| value.info.pid),
                        "Ignoring macOS selection probe for AQBot or an invalid element"
                    );
                    return;
                }
                SelectionProbeAction::Reuse => {}
                SelectionProbeAction::Rebind(pid) => {
                    let Some(application) = workspace_application_for_pid(pid) else {
                        tracing::error!(
                            pid,
                            "Could not resolve the macOS application hit by selection probe"
                        );
                        return;
                    };
                    if !application.is_regular {
                        // Never steal the binding for overlay processes
                        // (screenshot UI, Spotlight, input methods).
                        tracing::debug!(
                            pid,
                            source_app = %application.source_app,
                            "Ignoring macOS selection probe over an overlay application"
                        );
                        return;
                    }
                    tracing::debug!(
                        previous_pid = active.as_ref().map(|value| value.info.pid),
                        pid,
                        "Rebinding macOS accessibility subscriptions to mouse-hit application"
                    );
                    *active = bind_application(application, own_pid, lifecycle);
                }
            }
            let Some(active) = active.as_ref() else {
                tracing::error!(
                    hit_pid,
                    "macOS selection probe has no bound source application"
                );
                return;
            };
            tracing::debug!(
                pid = active.info.pid,
                "Reading macOS selection from mouse hit-test element"
            );
            // Prefer the mouse-up point so the toolbar appears near the user's hand,
            // not at the first glyph of a long selection (TextGO / pot pattern).
            let focused = active
                .element
                .element_attribute(AX_FOCUSED_UI_ELEMENT_ATTRIBUTE)
                .ok()
                .flatten();
            let pointer = ScreenPoint {
                x: point.x,
                y: point.y,
            };
            let found = emit_selection_from_candidates_with_pointer(
                active,
                std::iter::once(element).chain(focused),
                sender,
                Some(pointer),
                // Chromium/WebKit may still be propagating the selection. The final
                // failed attempt may clear a real deselection, while the clipboard
                // path is separately gated to weak-AX apps.
                false,
            );
            if found {
                return;
            }
            let try_clipboard = probe_source_allows_clipboard(source_pid, active.info.pid)
                && should_try_macos_clipboard_fallback(attempt, &active.info.source_app);
            if try_clipboard && try_clipboard_selection_fallback(active, pointer, sender) {
                return;
            }
            if is_last_probe_attempt(attempt) {
                tracing::debug!(
                    pid = active.info.pid,
                    clipboard_attempted = try_clipboard,
                    "macOS selection probe exhausted the allowed fallbacks"
                );
                let _ = sender.send(PlatformEvent::Clear);
            } else {
                tracing::debug!(
                    pid = active.info.pid,
                    attempt,
                    "macOS selection probe found no selection yet; retrying"
                );
                schedule_selection_probe(mac_sender, point, attempt + 1, Some(active.info.pid));
            }
        }
        Ok(None) => {
            // Empty hit-tests include toolbar clicks and UI chrome. The clipboard
            // path remains restricted to a known weak-AX source on its first attempt.
            tracing::debug!(
                pid = active.as_ref().map(|value| value.info.pid),
                attempt,
                "macOS selection probe hit-test returned no element"
            );
            finish_probe_without_hit(active, point, attempt, source_pid, sender, mac_sender);
        }
        Err(error) => {
            tracing::debug!(
                pid = active.as_ref().map(|value| value.info.pid),
                attempt,
                %error,
                "Could not hit-test the macOS selection endpoint"
            );
            finish_probe_without_hit(active, point, attempt, source_pid, sender, mac_sender);
        }
    }
}

fn finish_probe_without_hit(
    active: &Option<ActiveApplication>,
    point: LogicalPoint,
    attempt: usize,
    source_pid: Option<i32>,
    sender: &UnboundedSender<PlatformEvent>,
    mac_sender: &UnboundedSender<MacSignal>,
) {
    let pointer = ScreenPoint {
        x: point.x,
        y: point.y,
    };
    if let Some(active) = active.as_ref() {
        let escalate_clipboard = probe_source_allows_clipboard(source_pid, active.info.pid)
            && should_try_macos_clipboard_fallback(attempt, &active.info.source_app);
        if escalate_clipboard && try_clipboard_selection_fallback(active, pointer, sender) {
            return;
        }
    }
    if is_last_probe_attempt(attempt) {
        // Do not Clear: empty hit-tests often mean chrome/toolbar clicks, not
        // a real deselect. AX notifications still clear real deselections.
        return;
    }
    schedule_selection_probe(
        mac_sender,
        point,
        attempt + 1,
        active.as_ref().map(|active| active.info.pid),
    );
}

fn is_weak_ax_source_app(source_app: &str) -> bool {
    let lowered = source_app.to_ascii_lowercase();
    WEAK_AX_SOURCE_APP_MARKERS
        .iter()
        .any(|marker| lowered.contains(marker))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SelectionProbeAction {
    Ignore,
    Reuse,
    Rebind(i32),
}

fn selection_probe_action(
    active_pid: Option<i32>,
    hit_pid: Option<i32>,
    own_pid: i32,
) -> SelectionProbeAction {
    match hit_pid {
        Some(pid) if pid == own_pid => SelectionProbeAction::Ignore,
        Some(pid) if active_pid == Some(pid) => SelectionProbeAction::Reuse,
        Some(pid) => SelectionProbeAction::Rebind(pid),
        None => SelectionProbeAction::Ignore,
    }
}

fn emit_selection_from_candidates_with_pointer(
    active: &ActiveApplication,
    candidates: impl IntoIterator<Item = AXUIElement>,
    sender: &UnboundedSender<PlatformEvent>,
    pointer: Option<ScreenPoint>,
    clear_on_empty: bool,
) -> bool {
    let payload = best_value_in_candidate_chains(
        candidates,
        MAX_SELECTION_ANCESTORS,
        read_selection_payload,
        |candidate| {
            candidate
                .element_attribute(AX_PARENT_ATTRIBUTE)
                .ok()
                .flatten()
        },
        |payload| selection_payload_rank(payload.source),
    );
    match selection_payload_outcome(payload, pointer) {
        SelectionPayloadOutcome::Ready(payload) => {
            tracing::debug!(
                pid = active.info.pid,
                text_len = payload.text.chars().count(),
                candidate_source = ?payload.source,
                anchor_kind = ?payload.anchor_kind,
                anchor_x = payload.anchor.x,
                anchor_y = payload.anchor.y,
                anchor_width = payload.anchor.width,
                anchor_height = payload.anchor.height,
                "macOS accessibility selection read succeeded"
            );
            let observation = selection_observation(active, payload);
            let _ = sender.send(PlatformEvent::Selection(observation));
            true
        }
        SelectionPayloadOutcome::Unpositionable => true,
        SelectionPayloadOutcome::Empty => {
            tracing::debug!(
                pid = active.info.pid,
                "macOS accessibility element did not expose a selection"
            );
            // AX notification path may legitimately clear; the mouse probe only
            // clears on its final attempt when the hit element is the source app,
            // so a persistent empty selection means deselect.
            if clear_on_empty {
                let _ = sender.send(PlatformEvent::Clear);
            }
            false
        }
    }
}

enum SelectionPayloadOutcome {
    Ready(SelectionPayload),
    Unpositionable,
    Empty,
}

fn selection_payload_outcome(
    payload: Option<SelectionPayload>,
    pointer: Option<ScreenPoint>,
) -> SelectionPayloadOutcome {
    match payload {
        Some(payload) => finalize_selection_payload(payload, pointer)
            .map(SelectionPayloadOutcome::Ready)
            .unwrap_or(SelectionPayloadOutcome::Unpositionable),
        None => SelectionPayloadOutcome::Empty,
    }
}

fn finalize_selection_payload(
    mut payload: SelectionPayload,
    pointer: Option<ScreenPoint>,
) -> Option<SelectionPayload> {
    if let Some(pointer) = pointer {
        // Keep a small rect at the release point so place_surface still centers
        // and flips above/below correctly.
        payload.anchor = ScreenRect {
            x: pointer.x,
            y: pointer.y,
            width: 1.0,
            height: 1.0,
        };
        payload.anchor_kind = SelectionAnchorKind::Pointer;
        return Some(payload);
    }
    if payload.source == SelectionPayloadSource::MissingBounds {
        tracing::debug!(
            text_len = payload.text.chars().count(),
            candidate_source = ?payload.source,
            "Ignoring macOS selection text without usable bounds or a pointer"
        );
        return None;
    }
    Some(payload)
}

fn best_value_in_candidate_chains<T, U>(
    candidates: impl IntoIterator<Item = T>,
    max_depth: usize,
    mut read: impl FnMut(&T) -> Option<U>,
    mut parent: impl FnMut(&T) -> Option<T>,
    rank: impl Fn(&U) -> u8,
) -> Option<U> {
    let mut best: Option<(u8, U)> = None;
    for candidate in candidates {
        let mut current = Some(candidate);
        for _ in 0..max_depth {
            let Some(node) = current else {
                break;
            };
            if let Some(value) = read(&node) {
                let value_rank = rank(&value);
                // The caller reserves the maximum rank for a terminal exact match.
                if value_rank == u8::MAX {
                    return Some(value);
                }
                if best
                    .as_ref()
                    .is_none_or(|(best_rank, _)| value_rank > *best_rank)
                {
                    best = Some((value_rank, value));
                }
            }
            current = parent(&node);
        }
    }
    best.map(|(_, value)| value)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SelectionPayloadSource {
    RangeBounds,
    TextMarkerBounds,
    ElementFrameFallback,
    MissingBounds,
    Clipboard,
}

struct SelectionPayload {
    text: String,
    range_signature: String,
    anchor: ScreenRect,
    anchor_kind: SelectionAnchorKind,
    source: SelectionPayloadSource,
}

fn selection_payload_rank(source: SelectionPayloadSource) -> u8 {
    match source {
        SelectionPayloadSource::RangeBounds => u8::MAX,
        SelectionPayloadSource::TextMarkerBounds => 2,
        SelectionPayloadSource::ElementFrameFallback => 1,
        SelectionPayloadSource::MissingBounds | SelectionPayloadSource::Clipboard => 0,
    }
}

fn read_selection_payload(element: &AXUIElement) -> Option<SelectionPayload> {
    resolve_selection_payload(read_range_selection(element), || {
        read_marker_selection(element)
    })
}

fn resolve_selection_payload(
    range: Option<SelectionPayload>,
    read_marker: impl FnOnce() -> Option<SelectionPayload>,
) -> Option<SelectionPayload> {
    if range
        .as_ref()
        .is_some_and(|payload| payload.source == SelectionPayloadSource::RangeBounds)
    {
        return range;
    }
    let marker = read_marker();
    match (range, marker) {
        (Some(range), Some(marker))
            if selection_payload_rank(marker.source) > selection_payload_rank(range.source) =>
        {
            Some(marker)
        }
        (Some(range), _) => Some(range),
        (None, marker) => marker,
    }
}

fn read_range_selection(element: &AXUIElement) -> Option<SelectionPayload> {
    let text = read_string_attribute(element, AX_SELECTED_TEXT_ATTRIBUTE)?;
    if !is_actionable_selection_text(&text) {
        return None;
    }
    // Prefer range + bounds when the app exposes them; WeChat and similar UIs
    // often return SelectedText without a usable range/bounds. Keep the text.
    let range = match element.range_attribute(AX_SELECTED_TEXT_RANGE_ATTRIBUTE) {
        Ok(range) => range.filter(|value| value.length > 0),
        Err(error) => {
            trace_ax_read_error(element, AX_SELECTED_TEXT_RANGE_ATTRIBUTE, &error);
            None
        }
    };
    let rect = range.and_then(|range| {
        let first_character = AXValue::from_range(first_character_range(range)?)?;
        match element.parameterized_attribute(
            AX_BOUNDS_FOR_RANGE_PARAMETERIZED_ATTRIBUTE,
            &first_character,
        ) {
            Ok(value) => usable_selection_rect(value?.as_rect()?),
            Err(error) => {
                trace_ax_read_error(element, AX_BOUNDS_FOR_RANGE_PARAMETERIZED_ATTRIBUTE, &error);
                None
            }
        }
    });
    Some(match (range, rect) {
        (Some(range), Some(rect)) => SelectionPayload {
            text,
            range_signature: format!("range:{}:{}", range.location, range.length),
            anchor: ScreenRect {
                x: rect.origin.x,
                y: rect.origin.y,
                width: rect.size.width,
                height: rect.size.height,
            },
            anchor_kind: SelectionAnchorKind::SelectionRect,
            source: SelectionPayloadSource::RangeBounds,
        },
        _ => text_only_selection_payload(element, text),
    })
}

fn text_only_selection_payload(element: &AXUIElement, text: String) -> SelectionPayload {
    let mut hasher = DefaultHasher::new();
    text.hash(&mut hasher);
    let (anchor, source) = match element_frame_anchor(element) {
        Some(anchor) => (anchor, SelectionPayloadSource::ElementFrameFallback),
        None => (
            ScreenRect {
                x: 0.0,
                y: 0.0,
                width: 1.0,
                height: 1.0,
            },
            SelectionPayloadSource::MissingBounds,
        ),
    };
    SelectionPayload {
        text,
        range_signature: format!("text:{:016x}", hasher.finish()),
        anchor,
        anchor_kind: SelectionAnchorKind::SelectionRect,
        source,
    }
}

fn element_frame_anchor(element: &AXUIElement) -> Option<ScreenRect> {
    let rect = match element.attribute(AX_FRAME_ATTRIBUTE) {
        Ok(value) => usable_selection_rect(value?.as_rect()?)?,
        Err(error) => {
            trace_ax_read_error(element, AX_FRAME_ATTRIBUTE, &error);
            return None;
        }
    };
    Some(ScreenRect {
        x: rect.origin.x,
        y: rect.origin.y,
        width: rect.size.width.max(1.0),
        height: rect.size.height.max(1.0),
    })
}

fn first_character_range(range: AXRange) -> Option<AXRange> {
    (range.length > 0).then_some(AXRange {
        location: range.location,
        length: 1,
    })
}

fn read_marker_selection(element: &AXUIElement) -> Option<SelectionPayload> {
    let selected_range =
        match element.text_marker_range_attribute(AX_SELECTED_TEXT_MARKER_RANGE_ATTRIBUTE) {
            Ok(range) => range?,
            Err(error) => {
                trace_ax_read_error(element, AX_SELECTED_TEXT_MARKER_RANGE_ATTRIBUTE, &error);
                return None;
            }
        };
    let selected_range = ordered_marker_range(element, &selected_range).unwrap_or(selected_range);
    // Collapsed caret ranges are not selections; some apps still return a
    // non-empty string (often format-only) for equal start/end markers.
    if selected_range.start_marker().bytes() == selected_range.end_marker().bytes() {
        return None;
    }
    let selected_value = AXValue::from_text_marker_range(&selected_range)?;
    let text = match element.parameterized_attribute(
        AX_STRING_FOR_TEXT_MARKER_RANGE_PARAMETERIZED_ATTRIBUTE,
        &selected_value,
    ) {
        Ok(value) => value?.as_string()?,
        Err(error) => {
            trace_ax_read_error(
                element,
                AX_STRING_FOR_TEXT_MARKER_RANGE_PARAMETERIZED_ATTRIBUTE,
                &error,
            );
            return None;
        }
    };
    if !is_actionable_selection_text(&text) {
        return None;
    }
    let rect = first_marker_rect(element, &selected_range)
        .or_else(|| marker_range_rect(element, &selected_range))
        .and_then(usable_selection_rect);
    Some(match rect {
        Some(rect) => SelectionPayload {
            text,
            range_signature: marker_range_signature(&selected_range),
            anchor: ScreenRect {
                x: rect.origin.x,
                y: rect.origin.y,
                width: rect.size.width,
                height: rect.size.height,
            },
            anchor_kind: SelectionAnchorKind::SelectionRect,
            source: SelectionPayloadSource::TextMarkerBounds,
        },
        None => text_only_selection_payload(element, text),
    })
}

/// Last-resort selection reader for apps that do not expose AX selected text
/// (notably WeChat). Strategy order mirrors Easydict/SelectedTextKit:
/// 1. AXPress Edit → Copy when the menu item is enabled
/// 2. Full synthetic ⌘C key sequence
/// Then read the pasteboard and restore the previous text contents.
fn try_clipboard_selection_fallback(
    active: &ActiveApplication,
    pointer: ScreenPoint,
    sender: &UnboundedSender<PlatformEvent>,
) -> bool {
    if !is_copy_target_active(active.info.pid) {
        tracing::debug!(
            pid = active.info.pid,
            "Skipping macOS clipboard fallback because the target is no longer frontmost"
        );
        return false;
    }
    let Some(snapshot) = snapshot_pasteboard() else {
        tracing::debug!(
            pid = active.info.pid,
            "macOS clipboard fallback could not snapshot the pasteboard"
        );
        return false;
    };

    let mut obtained = None;
    if let Some(copy_item) = find_enabled_copy_menu_item(&active.element) {
        tracing::debug!(
            pid = active.info.pid,
            "macOS clipboard fallback trying Edit → Copy menu action"
        );
        if copy_item.perform_action(AX_PRESS_ACTION).is_ok() {
            obtained = wait_for_pasteboard_text(&snapshot);
        } else {
            tracing::debug!(
                pid = active.info.pid,
                "macOS clipboard fallback menu AXPress failed"
            );
        }
    } else {
        tracing::debug!(
            pid = active.info.pid,
            "macOS clipboard fallback found no enabled Copy menu item"
        );
    }

    if obtained.is_none() {
        tracing::debug!(
            pid = active.info.pid,
            "macOS clipboard fallback trying synthetic Cmd+C"
        );
        // Re-snapshot so a failed menu press that dirtied the pasteboard does
        // not poison the change-count wait for the shortcut path.
        let snapshot_for_shortcut = snapshot_pasteboard().unwrap_or_else(|| PasteboardSnapshot {
            change_count: snapshot.change_count,
            text: snapshot.text.clone(),
        });
        if !post_command_copy(active.info.pid) {
            restore_pasteboard(&snapshot);
            tracing::debug!(
                pid = active.info.pid,
                "macOS clipboard fallback failed to post Cmd+C"
            );
            return false;
        }
        obtained = wait_for_pasteboard_text(&snapshot_for_shortcut);
    }

    let Some(text) = obtained else {
        restore_pasteboard(&snapshot);
        tracing::debug!(
            pid = active.info.pid,
            "macOS clipboard fallback did not observe a pasteboard change"
        );
        return false;
    };
    restore_pasteboard(&snapshot);
    if !is_actionable_selection_text(&text) {
        return false;
    }
    tracing::debug!(
        pid = active.info.pid,
        text_len = text.chars().count(),
        candidate_source = ?SelectionPayloadSource::Clipboard,
        anchor_kind = ?SelectionAnchorKind::Pointer,
        anchor_x = pointer.x,
        anchor_y = pointer.y,
        anchor_width = 1.0,
        anchor_height = 1.0,
        "macOS clipboard selection fallback succeeded"
    );
    let mut hasher = DefaultHasher::new();
    text.hash(&mut hasher);
    let observation = selection_observation(
        active,
        SelectionPayload {
            text,
            range_signature: format!("clipboard:{:016x}", hasher.finish()),
            anchor: ScreenRect {
                x: pointer.x,
                y: pointer.y,
                width: 1.0,
                height: 1.0,
            },
            anchor_kind: SelectionAnchorKind::Pointer,
            source: SelectionPayloadSource::Clipboard,
        },
    );
    let _ = sender.send(PlatformEvent::Selection(observation));
    true
}

struct PasteboardSnapshot {
    change_count: isize,
    text: Option<String>,
}

fn snapshot_pasteboard() -> Option<PasteboardSnapshot> {
    let pasteboard = NSPasteboard::generalPasteboard();
    let change_count = pasteboard.changeCount();
    let text = pasteboard
        .stringForType(unsafe { NSPasteboardTypeString })
        .map(|value| value.to_string());
    Some(PasteboardSnapshot { change_count, text })
}

fn restore_pasteboard(snapshot: &PasteboardSnapshot) {
    let pasteboard = NSPasteboard::generalPasteboard();
    pasteboard.clearContents();
    if let Some(text) = snapshot.text.as_ref() {
        let ns_text = NSString::from_str(text);
        let _ = pasteboard.setString_forType(&ns_text, unsafe { NSPasteboardTypeString });
    }
}

fn wait_for_pasteboard_text(snapshot: &PasteboardSnapshot) -> Option<String> {
    let mut elapsed = 0u64;
    while elapsed < CLIPBOARD_FALLBACK_TIMEOUT_MS {
        thread::sleep(Duration::from_millis(CLIPBOARD_FALLBACK_INTERVAL_MS));
        elapsed = elapsed.saturating_add(CLIPBOARD_FALLBACK_INTERVAL_MS);
        let pasteboard = NSPasteboard::generalPasteboard();
        if pasteboard.changeCount() == snapshot.change_count {
            continue;
        }
        // changeCount can advance before the string type is published; keep polling.
        let Some(text) = pasteboard
            .stringForType(unsafe { NSPasteboardTypeString })
            .map(|value| value.to_string())
        else {
            continue;
        };
        if is_actionable_selection_text(&text) {
            return Some(text);
        }
    }
    None
}

/// Full ⌘C sequence (Command down → C down/up with Command flag → Command up).
/// Flag-only C events are ignored by some custom-rendered apps including WeChat.
/// Revalidate focus immediately before posting, then target every event to the original process.
fn post_command_copy(target_pid: i32) -> bool {
    let Ok(source) = CGEventSource::new(CGEventSourceStateID::CombinedSessionState)
        .or_else(|_| CGEventSource::new(CGEventSourceStateID::HIDSystemState))
    else {
        return false;
    };
    let Ok(cmd_down) = CGEvent::new_keyboard_event(source.clone(), KeyCode::COMMAND, true) else {
        return false;
    };
    let Ok(c_down) = CGEvent::new_keyboard_event(source.clone(), KeyCode::ANSI_C, true) else {
        return false;
    };
    let Ok(c_up) = CGEvent::new_keyboard_event(source.clone(), KeyCode::ANSI_C, false) else {
        return false;
    };
    let Ok(cmd_up) = CGEvent::new_keyboard_event(source, KeyCode::COMMAND, false) else {
        return false;
    };
    cmd_down.set_flags(CGEventFlags::CGEventFlagCommand);
    c_down.set_flags(CGEventFlags::CGEventFlagCommand);
    c_up.set_flags(CGEventFlags::CGEventFlagCommand);
    cmd_up.set_flags(CGEventFlags::CGEventFlagNull);
    if !is_copy_target_active(target_pid) {
        return false;
    }
    cmd_down.post_to_pid(target_pid);
    c_down.post_to_pid(target_pid);
    c_up.post_to_pid(target_pid);
    cmd_up.post_to_pid(target_pid);
    true
}

/// Locate an enabled Edit → Copy menu item via AX (identifier `copy:` preferred).
fn find_enabled_copy_menu_item(application: &AXUIElement) -> Option<AXUIElement> {
    let menu_bar = application
        .element_attribute(AX_MENU_BAR_ATTRIBUTE)
        .ok()
        .flatten()?;
    let mut stack: Vec<(AXUIElement, usize)> = match menu_bar.children() {
        Ok(children) => {
            // Prefer the typical Edit menu (index 3) first, then the rest.
            let mut ordered = Vec::with_capacity(children.len());
            if children.len() > 3 {
                ordered.push((children[3].clone(), 0));
            }
            for (index, child) in children.into_iter().enumerate() {
                if index != 3 {
                    ordered.push((child, 0));
                }
            }
            ordered
        }
        Err(_) => return None,
    };
    let mut visited = 0usize;
    while let Some((element, depth)) = stack.pop() {
        if visited >= COPY_MENU_SEARCH_MAX_NODES || depth > COPY_MENU_SEARCH_MAX_DEPTH {
            continue;
        }
        visited += 1;
        if is_copy_menu_item(&element) {
            let enabled = element
                .bool_attribute(AX_ENABLED_ATTRIBUTE)
                .ok()
                .flatten()
                .unwrap_or(true);
            if enabled {
                return Some(element);
            }
            continue;
        }
        if let Ok(children) = element.children() {
            for child in children.into_iter().rev() {
                stack.push((child, depth + 1));
            }
        }
    }
    None
}

fn is_copy_menu_item(element: &AXUIElement) -> bool {
    if element
        .string_attribute(AX_IDENTIFIER_ATTRIBUTE)
        .ok()
        .flatten()
        .is_some_and(|id| id == COPY_MENU_IDENTIFIER)
    {
        return true;
    }
    let cmd_char = element
        .string_attribute(AX_MENU_ITEM_CMD_CHAR_ATTRIBUTE)
        .ok()
        .flatten()
        .map(|value| value.to_ascii_uppercase());
    if cmd_char.as_deref() != Some("C") {
        return false;
    }
    element
        .string_attribute(AX_TITLE_ATTRIBUTE)
        .ok()
        .flatten()
        .is_some_and(|title| COPY_MENU_TITLES.iter().any(|known| title == *known))
}

fn ordered_marker_range(
    element: &AXUIElement,
    range: &AXTextMarkerRange,
) -> Option<AXTextMarkerRange> {
    let start = AXValue::from_text_marker(&range.start_marker())?;
    let end = AXValue::from_text_marker(&range.end_marker())?;
    let markers = AXValue::from_array(&[&start, &end])?;
    element
        .parameterized_attribute(
            AX_TEXT_MARKER_RANGE_FOR_UNORDERED_TEXT_MARKERS_PARAMETERIZED_ATTRIBUTE,
            &markers,
        )
        .ok()
        .flatten()
        .and_then(|value| value.as_text_marker_range())
}

fn first_marker_rect(
    element: &AXUIElement,
    range: &AXTextMarkerRange,
) -> Option<axuielement::AXRect> {
    let start = range.start_marker();
    let start_value = AXValue::from_text_marker(&start)?;
    let next = element
        .parameterized_attribute(
            AX_NEXT_TEXT_MARKER_FOR_TEXT_MARKER_PARAMETERIZED_ATTRIBUTE,
            &start_value,
        )
        .ok()
        .flatten()
        .and_then(|value| value.as_text_marker())?;
    let first_range = AXTextMarkerRange::new(&start, &next)?;
    marker_range_rect(element, &first_range)
}

fn marker_range_rect(
    element: &AXUIElement,
    range: &AXTextMarkerRange,
) -> Option<axuielement::AXRect> {
    let range = AXValue::from_text_marker_range(range)?;
    element
        .parameterized_attribute(
            AX_BOUNDS_FOR_TEXT_MARKER_RANGE_PARAMETERIZED_ATTRIBUTE,
            &range,
        )
        .ok()
        .flatten()
        .and_then(|value| value.as_rect())
}

fn usable_selection_rect(rect: axuielement::AXRect) -> Option<axuielement::AXRect> {
    (rect.origin.x.is_finite()
        && rect.origin.y.is_finite()
        && rect.size.width.is_finite()
        && rect.size.height.is_finite()
        && rect.size.width > 0.0
        && rect.size.height > 0.0)
        .then_some(rect)
}

fn marker_range_signature(range: &AXTextMarkerRange) -> String {
    let mut hasher = DefaultHasher::new();
    range.start_marker().bytes().hash(&mut hasher);
    range.end_marker().bytes().hash(&mut hasher);
    format!("marker:{:016x}", hasher.finish())
}

fn read_string_attribute(element: &AXUIElement, attribute: &str) -> Option<String> {
    match element.string_attribute(attribute) {
        Ok(value) => value,
        Err(error) => {
            trace_ax_read_error(element, attribute, &error);
            None
        }
    }
}

fn trace_ax_read_error(element: &AXUIElement, attribute: &str, error: &axuielement::AXError) {
    tracing::debug!(
        pid = element.pid().unwrap_or_default(),
        attribute,
        %error,
        "macOS accessibility selection attribute is unavailable"
    );
}

fn selection_observation(
    active: &ActiveApplication,
    payload: SelectionPayload,
) -> SelectionObservation {
    let source_window = active
        .element
        .element_attribute(AX_FOCUSED_WINDOW_ATTRIBUTE)
        .ok()
        .flatten()
        .and_then(|window| window.string_attribute(AX_TITLE_ATTRIBUTE).ok().flatten())
        .unwrap_or_default();
    SelectionObservation {
        text: payload.text,
        source_app: active.info.source_app.clone(),
        source_window,
        range_signature: payload.range_signature,
        anchor: payload.anchor,
        anchor_kind: payload.anchor_kind,
    }
}

fn screen_point_from_cg(point: CGPoint) -> ScreenPoint {
    ScreenPoint {
        x: point.x,
        y: point.y,
    }
}

fn start_error(code: &str, message: &str) -> PlatformStartError {
    PlatformStartError {
        permission: PermissionState::Granted,
        error: RuntimeError {
            code: code.into(),
            message: message.into(),
        },
    }
}

const MODERN_ACCESSIBILITY_SETTINGS_URL: &str =
    "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Accessibility";
const LEGACY_ACCESSIBILITY_SETTINGS_URL: &str =
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PermissionAction {
    OpenPermissionPane,
    OpenForManualAdd,
}

fn permission_action(bundled_app: bool) -> PermissionAction {
    if bundled_app {
        PermissionAction::OpenPermissionPane
    } else {
        PermissionAction::OpenForManualAdd
    }
}

fn is_bundled_app_executable(executable: &Path) -> bool {
    executable.ancestors().any(|ancestor| {
        ancestor
            .extension()
            .is_some_and(|extension| extension == "app")
    })
}

fn open_accessibility_settings() -> Result<(), String> {
    open::that(MODERN_ACCESSIBILITY_SETTINGS_URL)
        .or_else(|_| open::that(LEGACY_ACCESSIBILITY_SETTINGS_URL))
        .map_err(|error| error.to_string())
}

pub fn open_permission_settings() -> Result<PermissionSettingsOutcome, String> {
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    open_accessibility_settings()?;
    match permission_action(is_bundled_app_executable(&executable)) {
        PermissionAction::OpenForManualAdd => Ok(PermissionSettingsOutcome::ManualAddRequired {
            executable_path: executable.to_string_lossy().into_owned(),
        }),
        PermissionAction::OpenPermissionPane => Ok(PermissionSettingsOutcome::PermissionPaneOpened),
    }
}

pub fn request_permission() -> Result<PermissionState, String> {
    let _ = is_process_trusted_with_prompt();
    Ok(permission_state())
}

#[cfg(test)]
mod macos_tests {
    use std::path::Path;
    use std::time::Duration;

    use super::{
        best_value_in_candidate_chains, event_tap_disable_reason, finalize_selection_payload,
        first_character_range, is_bundled_app_executable, is_macos_copy_target_active,
        is_weak_ax_source_app, marker_range_signature, permission_action,
        probe_source_allows_clipboard, probe_source_matches_active_app, screen_point_from_cg,
        selection_payload_outcome, selection_probe_action, should_try_macos_clipboard_fallback,
        usable_selection_rect, workspace_signal, MacSignal, MonitorLifecycle, PermissionAction,
        SelectionPayload, SelectionPayloadOutcome, SelectionPayloadSource, SelectionProbeAction,
        WorkspaceApplication, WorkspaceEventKind,
    };
    use axuielement::{AXPoint, AXRange, AXRect, AXSize, AXTextMarkerRange};
    use core_graphics::event::CGEventType;
    use core_graphics::geometry::CGPoint;

    #[test]
    fn macos_event_points_stay_in_tauri_logical_coordinates() {
        assert_eq!(
            screen_point_from_cg(CGPoint::new(1058.5, 598.25)),
            crate::selection_toolbar::ScreenPoint {
                x: 1058.5,
                y: 598.25,
            }
        );
    }

    #[test]
    fn monitor_lifecycle_starts_without_an_active_application() {
        let mut lifecycle = MonitorLifecycle::default();

        assert_eq!(lifecycle.active_pid, None);
        let generation = lifecycle.activate(42, 7).expect("external app binds");

        assert!(lifecycle.accepts(42, generation));
    }

    #[test]
    fn monitor_lifecycle_ignores_self_and_stale_application_events() {
        let mut lifecycle = MonitorLifecycle::default();

        assert_eq!(lifecycle.activate(7, 7), None);
        let old_generation = lifecycle.activate(42, 7).expect("first app binds");
        let current_generation = lifecycle.activate(84, 7).expect("second app binds");

        assert!(!lifecycle.dismiss(42));
        assert!(!lifecycle.accepts(42, old_generation));
        assert!(lifecycle.accepts(84, current_generation));
    }

    #[test]
    fn own_application_activation_keeps_external_subscription() {
        let mut lifecycle = MonitorLifecycle::default();
        let generation = lifecycle.activate(42, 7).expect("external app binds");

        assert_eq!(lifecycle.activate(7, 7), None);
        assert!(lifecycle.accepts(42, generation));
    }

    #[test]
    fn mouse_hit_rebinds_a_stale_external_application() {
        assert_eq!(
            selection_probe_action(Some(42), Some(84), 7),
            SelectionProbeAction::Rebind(84)
        );
        assert_eq!(
            selection_probe_action(Some(42), Some(7), 7),
            SelectionProbeAction::Ignore
        );
    }

    #[test]
    fn wechat_bundle_ids_are_treated_as_weak_ax_sources() {
        assert!(is_weak_ax_source_app("com.tencent.xinWeChat"));
        assert!(is_weak_ax_source_app("com.tencent.WeWorkMac"));
        assert!(is_weak_ax_source_app("WeChat"));
        assert!(!is_weak_ax_source_app("com.apple.TextEdit"));
        assert!(!is_weak_ax_source_app("com.google.Chrome"));
    }

    #[test]
    fn regular_apps_never_request_clipboard_fallback() {
        for attempt in 0..super::SELECTION_PROBE_DELAYS_MS.len() {
            assert!(!should_try_macos_clipboard_fallback(
                attempt,
                "com.apple.finder"
            ));
            assert!(!should_try_macos_clipboard_fallback(
                attempt,
                "com.google.Chrome"
            ));
        }
    }

    #[test]
    fn weak_ax_clipboard_fallback_is_attempted_once() {
        assert!(should_try_macos_clipboard_fallback(
            0,
            "com.tencent.xinWeChat"
        ));
        for attempt in 1..super::SELECTION_PROBE_DELAYS_MS.len() {
            assert!(!should_try_macos_clipboard_fallback(
                attempt,
                "com.tencent.xinWeChat"
            ));
        }
    }

    #[test]
    fn copy_target_validation_rejects_a_frontmost_application_change() {
        assert!(is_macos_copy_target_active(42, Some(42)));
        assert!(!is_macos_copy_target_active(42, Some(84)));
        assert!(!is_macos_copy_target_active(42, None));
    }

    #[test]
    fn stale_probe_does_not_match_a_new_active_application() {
        assert!(probe_source_matches_active_app(Some(42), Some(42)));
        assert!(!probe_source_matches_active_app(Some(42), Some(84)));
        assert!(!probe_source_matches_active_app(Some(42), None));
        assert!(probe_source_matches_active_app(None, Some(84)));
    }

    #[test]
    fn clipboard_fallback_requires_a_known_matching_probe_source() {
        assert!(probe_source_allows_clipboard(Some(42), 42));
        assert!(!probe_source_allows_clipboard(Some(42), 84));
        assert!(!probe_source_allows_clipboard(None, 84));
    }

    #[test]
    fn source_app_deactivation_does_not_clear_selection_subscription() {
        let application = WorkspaceApplication {
            pid: 42,
            source_app: "TextEdit".into(),
            is_regular: true,
        };

        assert!(workspace_signal(WorkspaceEventKind::Deactivated, application).is_none());
    }

    #[test]
    fn overlay_application_activation_is_ignored() {
        let screenshot_ui = WorkspaceApplication {
            pid: 77,
            source_app: "com.apple.screencaptureui".into(),
            is_regular: false,
        };
        let browser = WorkspaceApplication {
            pid: 78,
            source_app: "com.google.Chrome".into(),
            is_regular: true,
        };

        assert!(workspace_signal(WorkspaceEventKind::Activated, screenshot_ui).is_none());
        assert!(matches!(
            workspace_signal(WorkspaceEventKind::Activated, browser),
            Some(MacSignal::ApplicationActivated(_))
        ));
    }

    #[test]
    fn disabled_global_event_tap_requests_reenable() {
        assert_eq!(
            event_tap_disable_reason(CGEventType::TapDisabledByTimeout),
            Some("timeout")
        );
        assert_eq!(
            event_tap_disable_reason(CGEventType::TapDisabledByUserInput),
            Some("user_input")
        );
        assert_eq!(event_tap_disable_reason(CGEventType::LeftMouseUp), None);
    }

    #[test]
    fn selection_candidate_walks_to_the_first_readable_parent() {
        let selected = best_value_in_candidate_chains(
            [0],
            16,
            |node| (*node == 3).then_some("selection"),
            |node| Some(node + 1),
            |_| 1,
        );

        assert_eq!(selected, Some("selection"));
    }

    #[test]
    fn selection_candidate_walk_is_bounded() {
        let selected = best_value_in_candidate_chains(
            [0],
            3,
            |node| (*node == 3).then_some("selection"),
            |node| Some(node + 1),
            |_| 1,
        );

        assert_eq!(selected, None);
    }

    #[test]
    fn selection_candidate_walk_uses_focused_element_after_xpc_event_element() {
        let selected = best_value_in_candidate_chains(
            [0, 10],
            3,
            |node| (*node == 12).then_some("selection"),
            |node| Some(node + 1),
            |_| 1,
        );

        assert_eq!(selected, Some("selection"));
    }

    #[test]
    fn precise_selection_wins_across_candidate_chains() {
        let selected = best_value_in_candidate_chains(
            [0, 10],
            3,
            |node| match *node {
                0 => Some(("child frame", 1)),
                12 => Some(("focused range", 3)),
                _ => None,
            },
            |node| Some(node + 1),
            |value| value.1,
        );

        assert_eq!(selected, Some(("focused range", 3)));
    }

    #[test]
    fn first_real_frame_is_kept_when_no_candidate_has_precise_bounds() {
        let selected = best_value_in_candidate_chains(
            [0, 10],
            2,
            |node| match *node {
                0 => Some(("event frame", 1)),
                10 => Some(("focused frame", 1)),
                _ => None,
            },
            |node| Some(node + 1),
            |value| value.1,
        );

        assert_eq!(selected, Some(("event frame", 1)));
    }

    #[test]
    fn range_selection_anchors_to_the_first_character() {
        assert_eq!(
            first_character_range(AXRange {
                location: 19,
                length: 8,
            }),
            Some(AXRange {
                location: 19,
                length: 1,
            })
        );
        assert_eq!(
            first_character_range(AXRange {
                location: 19,
                length: 0,
            }),
            None
        );
    }

    #[test]
    fn browser_placeholder_bounds_fall_through_to_text_markers() {
        assert_eq!(
            usable_selection_rect(AXRect {
                origin: AXPoint { x: 0.0, y: 1440.0 },
                size: AXSize {
                    width: 0.0,
                    height: 0.0,
                },
            }),
            None
        );
        assert!(usable_selection_rect(AXRect {
            origin: AXPoint { x: 600.0, y: 729.0 },
            size: AXSize {
                width: 5.0,
                height: 16.0,
            },
        })
        .is_some());
    }

    #[test]
    fn precise_marker_bounds_win_over_range_frame_fallback() {
        let fallback = SelectionPayload {
            text: "selection".into(),
            range_signature: "text:fallback".into(),
            anchor: crate::selection_toolbar::ScreenRect {
                x: 40.0,
                y: 80.0,
                width: 1_200.0,
                height: 800.0,
            },
            anchor_kind: crate::selection_toolbar::SelectionAnchorKind::SelectionRect,
            source: SelectionPayloadSource::ElementFrameFallback,
        };
        let marker = SelectionPayload {
            text: "selection".into(),
            range_signature: "marker:precise".into(),
            anchor: crate::selection_toolbar::ScreenRect {
                x: 980.0,
                y: 640.0,
                width: 6.0,
                height: 18.0,
            },
            anchor_kind: crate::selection_toolbar::SelectionAnchorKind::SelectionRect,
            source: SelectionPayloadSource::TextMarkerBounds,
        };

        let chosen = super::resolve_selection_payload(Some(fallback), || Some(marker))
            .expect("selection payload");

        assert_eq!(chosen.range_signature, "marker:precise");
        assert_eq!(chosen.anchor.x, 980.0);
        assert_eq!(chosen.source, SelectionPayloadSource::TextMarkerBounds);
    }

    #[test]
    fn precise_range_bounds_win_over_precise_marker_bounds() {
        let range = SelectionPayload {
            text: "selection".into(),
            range_signature: "range:4:9".into(),
            anchor: crate::selection_toolbar::ScreenRect {
                x: 400.0,
                y: 300.0,
                width: 8.0,
                height: 18.0,
            },
            anchor_kind: crate::selection_toolbar::SelectionAnchorKind::SelectionRect,
            source: SelectionPayloadSource::RangeBounds,
        };
        let marker = SelectionPayload {
            text: "selection".into(),
            range_signature: "marker:precise".into(),
            anchor: crate::selection_toolbar::ScreenRect {
                x: 980.0,
                y: 640.0,
                width: 6.0,
                height: 18.0,
            },
            anchor_kind: crate::selection_toolbar::SelectionAnchorKind::SelectionRect,
            source: SelectionPayloadSource::TextMarkerBounds,
        };

        let chosen = super::resolve_selection_payload(Some(range), || Some(marker))
            .expect("selection payload");

        assert_eq!(chosen.range_signature, "range:4:9");
        assert_eq!(chosen.source, SelectionPayloadSource::RangeBounds);
    }

    #[test]
    fn text_without_bounds_requires_a_pointer_anchor() {
        let missing_bounds = || SelectionPayload {
            text: "selection".into(),
            range_signature: "text:no-bounds".into(),
            anchor: crate::selection_toolbar::ScreenRect {
                x: 0.0,
                y: 0.0,
                width: 1.0,
                height: 1.0,
            },
            anchor_kind: crate::selection_toolbar::SelectionAnchorKind::SelectionRect,
            source: SelectionPayloadSource::MissingBounds,
        };

        assert!(finalize_selection_payload(missing_bounds(), None).is_none());
        assert!(matches!(
            selection_payload_outcome(Some(missing_bounds()), None),
            SelectionPayloadOutcome::Unpositionable
        ));
        let pointer = crate::selection_toolbar::ScreenPoint { x: 640.0, y: 480.0 };
        let chosen = finalize_selection_payload(missing_bounds(), Some(pointer))
            .expect("pointer can anchor text-only selection");
        assert_eq!(
            chosen.anchor_kind,
            crate::selection_toolbar::SelectionAnchorKind::Pointer
        );
        assert_eq!(chosen.anchor.x, 640.0);
        assert_eq!(chosen.anchor.y, 480.0);
    }

    #[test]
    fn text_marker_signature_uses_both_marker_boundaries() {
        let first = AXTextMarkerRange::from_bytes(&[1, 2], &[3, 4]).expect("marker range");
        let second = AXTextMarkerRange::from_bytes(&[1, 2], &[3, 5]).expect("marker range");

        assert_ne!(
            marker_range_signature(&first),
            marker_range_signature(&second)
        );
    }

    #[test]
    fn collapsed_text_marker_range_has_equal_boundary_bytes() {
        let collapsed = AXTextMarkerRange::from_bytes(&[1, 2, 3], &[1, 2, 3]).expect("marker");
        assert_eq!(
            collapsed.start_marker().bytes(),
            collapsed.end_marker().bytes()
        );
        let open = AXTextMarkerRange::from_bytes(&[1, 2, 3], &[1, 2, 4]).expect("marker");
        assert_ne!(open.start_marker().bytes(), open.end_marker().bytes());
    }

    #[tokio::test]
    async fn mouse_up_probe_is_scheduled_before_an_application_is_bound() {
        let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        let point = super::LogicalPoint { x: 320.0, y: 180.0 };

        super::schedule_selection_probe(&sender, point, 0, None);

        let signal = tokio::time::timeout(
            Duration::from_millis(super::SELECTION_PROBE_DELAYS_MS[0] + 100),
            receiver.recv(),
        )
        .await
        .expect("selection probe should settle")
        .expect("selection probe channel should stay open");
        match signal {
            super::MacSignal::SelectionProbeReady {
                point: actual,
                attempt,
                source_pid,
            } => {
                assert_eq!(actual.x, point.x);
                assert_eq!(actual.y, point.y);
                assert_eq!(attempt, 0);
                assert_eq!(source_pid, None);
            }
            other => panic!("unexpected macOS signal: {other:?}"),
        }
    }

    #[tokio::test]
    async fn probe_retries_stop_after_the_last_configured_attempt() {
        let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        let point = super::LogicalPoint { x: 320.0, y: 180.0 };
        let last_attempt = super::SELECTION_PROBE_DELAYS_MS.len() - 1;

        assert!(super::is_last_probe_attempt(last_attempt));
        assert!(!super::is_last_probe_attempt(0));

        super::schedule_selection_probe(
            &sender,
            point,
            super::SELECTION_PROBE_DELAYS_MS.len(),
            None,
        );
        drop(sender);
        assert!(receiver.recv().await.is_none());
    }

    #[test]
    fn packaged_app_opens_the_permission_pane() {
        assert_eq!(
            permission_action(true),
            PermissionAction::OpenPermissionPane
        );
    }

    #[test]
    fn unbundled_development_binary_exposes_a_manual_add_path() {
        assert_eq!(permission_action(false), PermissionAction::OpenForManualAdd);
    }

    #[test]
    fn app_bundle_detection_distinguishes_tauri_dev_from_packaged_apps() {
        assert!(is_bundled_app_executable(Path::new(
            "/Applications/AQBot.app/Contents/MacOS/AQBot"
        )));
        assert!(!is_bundled_app_executable(Path::new(
            "/workspace/src-tauri/target/debug/AQBot"
        )));
    }
}
