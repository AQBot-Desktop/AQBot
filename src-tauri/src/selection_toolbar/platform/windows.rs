use std::{
    cell::RefCell,
    collections::hash_map::DefaultHasher,
    hash::{Hash, Hasher},
    thread,
    time::Duration,
};

use aqbot_core::types::SelectionToolbarSettings;
use tokio::sync::{mpsc::UnboundedSender, watch};
use uiautomation::{
    events::{
        CustomEventHandlerFn, CustomFocusChangedEventHandlerFn, UIEventHandler, UIEventType,
        UIFocusChangedEventHandler,
    },
    patterns::{UITextPattern, UITextRange},
    types::{Point, TreeScope},
    variants::SafeArray,
    UIAutomation, UIElement,
};
use windows::core::PWSTR;
use windows::Win32::{
    Foundation::{CloseHandle, HANDLE, HGLOBAL, LPARAM, LRESULT, WPARAM},
    System::{
        DataExchange::{
            CloseClipboard, EmptyClipboard, GetClipboardData, GetClipboardSequenceNumber,
            IsClipboardFormatAvailable, OpenClipboard, SetClipboardData,
        },
        Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE},
        Threading::{GetCurrentThreadId, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
        Variant::VT_R8,
    },
    UI::{
        Input::KeyboardAndMouse::{
            MapVirtualKeyW, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT,
            KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, KEYEVENTF_SCANCODE, MAPVK_VK_TO_VSC, VIRTUAL_KEY,
            VK_C, VK_CONTROL, VK_ESCAPE,
        },
        WindowsAndMessaging::{
            CallNextHookEx, GetForegroundWindow, GetMessageW, GetWindowThreadProcessId,
            PeekMessageW, PostThreadMessageW, SendMessageW, SetWindowsHookExW, UnhookWindowsHookEx,
            KBDLLHOOKSTRUCT, MSG, MSLLHOOKSTRUCT, PM_NOREMOVE, WH_KEYBOARD_LL, WH_MOUSE_LL,
            WM_COPY, WM_KEYDOWN, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MBUTTONDOWN, WM_QUIT,
            WM_RBUTTONDOWN,
        },
    },
};

use super::{
    is_windows_copy_target_active, should_try_windows_clipboard_fallback, DismissReason,
    PlatformEvent, PlatformMonitorHandle, PlatformStartError,
};
use crate::selection_toolbar::{
    is_actionable_selection_text, PermissionSettingsOutcome, PermissionState, RuntimeError,
    ScreenPoint, ScreenRect, SelectionAnchorKind, SelectionObservation,
};

const SELECTION_PROBE_DELAYS_MS: [u64; 3] = [80, 150, 400];
const CLIPBOARD_FALLBACK_INTERVAL_MS: u64 = 5;
const CLIPBOARD_FALLBACK_TIMEOUT_MS: u64 = 350;
const CF_UNICODETEXT: u32 = 13;
thread_local! {
    static GLOBAL_EVENT_SENDER: RefCell<Option<UnboundedSender<PlatformEvent>>> =
        const { RefCell::new(None) };
}

pub fn start_monitor(
    sender: UnboundedSender<PlatformEvent>,
    _settings: watch::Receiver<SelectionToolbarSettings>,
) -> Result<PlatformMonitorHandle, PlatformStartError> {
    let (stop_sender, stop_receiver) = std::sync::mpsc::channel();
    let (ready_sender, ready_receiver) = std::sync::mpsc::sync_channel(1);
    let uia_sender = sender.clone();
    let thread = thread::Builder::new()
        .name("selection-toolbar-uia".into())
        .spawn(move || {
            let automation = match UIAutomation::new() {
                Ok(automation) => automation,
                Err(error) => {
                    let _ = ready_sender.send(Err(error.to_string()));
                    return;
                }
            };
            let root = match automation.get_root_element() {
                Ok(root) => root,
                Err(error) => {
                    let _ = ready_sender.send(Err(error.to_string()));
                    return;
                }
            };

            let event_sender = uia_sender.clone();
            let event_handler_fn: Box<CustomEventHandlerFn> = Box::new(move |element, _| {
                publish_selection(element, &event_sender);
                Ok(())
            });
            let event_handler = UIEventHandler::from(event_handler_fn);
            if let Err(error) = automation.add_automation_event_handler(
                UIEventType::Text_TextSelectionChanged,
                &root,
                TreeScope::Subtree,
                None,
                &event_handler,
            ) {
                let _ = ready_sender.send(Err(error.to_string()));
                return;
            }

            let focus_sender = uia_sender;
            let focus_handler_fn: Box<CustomFocusChangedEventHandlerFn> =
                Box::new(move |element| {
                    publish_selection(element, &focus_sender);
                    Ok(())
                });
            let focus_handler = UIFocusChangedEventHandler::from(focus_handler_fn);
            if let Err(error) = automation.add_focus_changed_event_handler(None, &focus_handler) {
                let _ = automation.remove_automation_event_handler(
                    UIEventType::Text_TextSelectionChanged,
                    &root,
                    &event_handler,
                );
                let _ = ready_sender.send(Err(error.to_string()));
                return;
            }
            let _ = ready_sender.send(Ok(()));

            let _ = stop_receiver.recv();
            let _ = automation.remove_focus_changed_event_handler(&focus_handler);
            let _ = automation.remove_automation_event_handler(
                UIEventType::Text_TextSelectionChanged,
                &root,
                &event_handler,
            );
        })
        .map_err(|error| start_error("uia_thread_failed", error.to_string()))?;

    match ready_receiver.recv() {
        Ok(Ok(())) => {
            let (global_stop, global_thread) = match start_global_dismiss_listener(sender) {
                Ok(listener) => listener,
                Err(error) => {
                    let _ = stop_sender.send(());
                    let _ = thread.join();
                    return Err(error);
                }
            };
            Ok(PlatformMonitorHandle::new(move || {
                let _ = stop_sender.send(());
                global_stop();
                let _ = thread.join();
                let _ = global_thread.join();
            }))
        }
        Ok(Err(message)) => {
            let _ = thread.join();
            Err(start_error("uia_unavailable", message))
        }
        Err(error) => {
            let _ = thread.join();
            Err(start_error("uia_start_failed", error.to_string()))
        }
    }
}

fn start_global_dismiss_listener(
    sender: UnboundedSender<PlatformEvent>,
) -> Result<(impl FnOnce() + Send + 'static, thread::JoinHandle<()>), PlatformStartError> {
    let (ready_sender, ready_receiver) = std::sync::mpsc::sync_channel(1);
    let thread = thread::Builder::new()
        .name("selection-toolbar-global-events".into())
        .spawn(move || {
            GLOBAL_EVENT_SENDER.with(|slot| {
                *slot.borrow_mut() = Some(sender);
            });
            let keyboard_hook =
                match unsafe { SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_hook), None, 0) } {
                    Ok(hook) => hook,
                    Err(error) => {
                        let _ = ready_sender.send(Err(error.to_string()));
                        return;
                    }
                };
            let mouse_hook =
                match unsafe { SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook), None, 0) } {
                    Ok(hook) => hook,
                    Err(error) => {
                        let _ = unsafe { UnhookWindowsHookEx(keyboard_hook) };
                        let _ = ready_sender.send(Err(error.to_string()));
                        return;
                    }
                };
            let mut message = MSG::default();
            unsafe {
                let _ = PeekMessageW(&mut message, None, 0, 0, PM_NOREMOVE);
            }
            let thread_id = unsafe { GetCurrentThreadId() };
            let _ = ready_sender.send(Ok(thread_id));
            while unsafe { GetMessageW(&mut message, None, 0, 0) }.0 > 0 {}
            let _ = unsafe { UnhookWindowsHookEx(mouse_hook) };
            let _ = unsafe { UnhookWindowsHookEx(keyboard_hook) };
            GLOBAL_EVENT_SENDER.with(|slot| {
                *slot.borrow_mut() = None;
            });
        })
        .map_err(|error| start_error("windows_global_event_thread_failed", error.to_string()))?;
    let thread_id = ready_receiver
        .recv()
        .map_err(|error| start_error("windows_global_event_start_failed", error.to_string()))?
        .map_err(|message| start_error("windows_global_event_unavailable", message))?;
    let stop = move || unsafe {
        let _ = PostThreadMessageW(thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
    };
    Ok((stop, thread))
}

unsafe extern "system" fn keyboard_hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 && wparam.0 as u32 == WM_KEYDOWN {
        let event = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };
        if event.vkCode == u32::from(VK_ESCAPE.0) {
            GLOBAL_EVENT_SENDER.with(|slot| {
                if let Some(sender) = slot.borrow().as_ref() {
                    let _ = sender.send(PlatformEvent::Dismiss(DismissReason::Escape));
                }
            });
        }
    }
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

unsafe extern "system" fn mouse_hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let event = unsafe { &*(lparam.0 as *const MSLLHOOKSTRUCT) };
        let point = ScreenPoint {
            x: f64::from(event.pt.x),
            y: f64::from(event.pt.y),
        };
        match wparam.0 as u32 {
            WM_LBUTTONDOWN | WM_RBUTTONDOWN | WM_MBUTTONDOWN => {
                GLOBAL_EVENT_SENDER.with(|slot| {
                    if let Some(sender) = slot.borrow().as_ref() {
                        let _ = sender.send(PlatformEvent::GlobalPointerDown(point));
                    }
                });
            }
            WM_LBUTTONUP => {
                GLOBAL_EVENT_SENDER.with(|slot| {
                    if let Some(sender) = slot.borrow().as_ref() {
                        schedule_selection_probe(sender.clone(), point);
                    }
                });
            }
            _ => {}
        }
    }
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

fn schedule_selection_probe(sender: UnboundedSender<PlatformEvent>, point: ScreenPoint) {
    thread::spawn(move || {
        for (attempt, delay_ms) in SELECTION_PROBE_DELAYS_MS.iter().copied().enumerate() {
            thread::sleep(Duration::from_millis(delay_ms));
            match probe_selection_at(point) {
                Some(observation) => {
                    let _ = sender.send(PlatformEvent::Selection(observation));
                    return;
                }
                None => {
                    // WeChat 4.x often has no TextPattern at all — escalate to
                    // clipboard after the first miss instead of waiting ~630ms.
                    let process_id = foreground_process_id();
                    let process_name = process_id.and_then(process_image_basename);
                    let escalate =
                        should_try_windows_clipboard_fallback(attempt, process_name.as_deref());
                    if escalate {
                        if let Some(observation) =
                            try_clipboard_selection_fallback(point, process_id.unwrap_or_default())
                        {
                            let _ = sender.send(PlatformEvent::Selection(observation));
                            return;
                        }
                    }
                }
            }
        }
    });
}

fn probe_selection_at(point: ScreenPoint) -> Option<SelectionObservation> {
    let automation = UIAutomation::new().ok()?;
    let element = automation
        .element_from_point(Point::new(point.x as i32, point.y as i32))
        .ok()?;
    match read_selection_with_pointer(&element, Some(point)) {
        Ok(observation) => observation,
        Err(error) => {
            tracing::debug!(%error, "Windows mouse selection probe failed");
            None
        }
    }
}

pub fn open_permission_settings() -> Result<PermissionSettingsOutcome, String> {
    Ok(PermissionSettingsOutcome::PermissionPaneOpened)
}

pub fn permission_state() -> PermissionState {
    PermissionState::NotRequired
}

pub fn request_permission() -> Result<PermissionState, String> {
    Ok(PermissionState::NotRequired)
}

fn publish_selection(element: &UIElement, sender: &UnboundedSender<PlatformEvent>) {
    match read_selection_with_pointer(element, None) {
        Ok(Some(observation)) => {
            let _ = sender.send(PlatformEvent::Selection(observation));
        }
        Ok(None) => {
            let _ = sender.send(PlatformEvent::Clear);
        }
        Err(error) => {
            let _ = sender.send(PlatformEvent::Error(RuntimeError {
                code: "uia_selection_failed".into(),
                message: error.to_string(),
            }));
        }
    }
}

fn read_selection_with_pointer(
    element: &UIElement,
    pointer: Option<ScreenPoint>,
) -> uiautomation::Result<Option<SelectionObservation>> {
    let pattern = match element.get_pattern::<UITextPattern>() {
        Ok(pattern) => pattern,
        Err(_) => return Ok(None),
    };
    let Some(range) = pattern.get_selection()?.into_iter().next() else {
        return Ok(None);
    };
    let text = range.get_text(-1)?;
    if !is_actionable_selection_text(&text) {
        return Ok(None);
    }
    // Prefer mouse-up pointer placement; otherwise use UIA bounds when present.
    // WeChat-like UIs may omit bounding rects while still exposing text.
    let (anchor, anchor_kind) = if let Some(pointer) = pointer {
        (
            ScreenRect {
                x: pointer.x,
                y: pointer.y,
                width: 1.0,
                height: 1.0,
            },
            SelectionAnchorKind::Pointer,
        )
    } else if let Some(anchor) = first_bounding_rect(&range)? {
        (anchor, SelectionAnchorKind::SelectionRect)
    } else {
        (
            ScreenRect {
                x: 0.0,
                y: 0.0,
                width: 1.0,
                height: 1.0,
            },
            SelectionAnchorKind::SelectionRect,
        )
    };
    let process_id = element.get_process_id()?;
    let source_window = element
        .get_name()
        .ok()
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| format!("window:{process_id}"));
    let runtime_id = element
        .get_runtime_id()?
        .into_iter()
        .map(|part| part.to_string())
        .collect::<Vec<_>>()
        .join(".");
    let source_app =
        process_image_basename(process_id).unwrap_or_else(|| format!("process:{process_id}"));

    Ok(Some(SelectionObservation {
        text,
        source_app,
        source_window,
        range_signature: runtime_id,
        anchor,
        anchor_kind,
    }))
}

fn try_clipboard_selection_fallback(
    pointer: ScreenPoint,
    target_process_id: u32,
) -> Option<SelectionObservation> {
    let previous = read_clipboard_text();

    // Prefer Ctrl+C (works for most custom UIs). Try virtual-key then scan-code
    // forms, then WM_COPY for classic edit controls.
    let mut text = None;
    for use_scancode in [false, true] {
        if !is_copy_target_active(target_process_id) {
            break;
        }
        let sequence_before = unsafe { GetClipboardSequenceNumber() };
        if !post_control_copy(target_process_id, use_scancode) {
            continue;
        }
        text = wait_for_clipboard_text(sequence_before);
        if text.is_some() {
            break;
        }
    }
    if text.is_none() {
        let sequence_before_wm = unsafe { GetClipboardSequenceNumber() };
        if post_wm_copy(target_process_id) {
            text = wait_for_clipboard_text(sequence_before_wm);
        }
    }

    let Some(text) = text else {
        restore_clipboard_text(previous.as_deref());
        return None;
    };
    restore_clipboard_text(previous.as_deref());
    if !is_actionable_selection_text(&text) {
        return None;
    }
    let source_app = process_image_basename(target_process_id)
        .unwrap_or_else(|| format!("process:{target_process_id}"));
    let mut hasher = DefaultHasher::new();
    text.hash(&mut hasher);
    Some(SelectionObservation {
        text,
        source_app,
        source_window: format!("window:{target_process_id}"),
        range_signature: format!("clipboard:{:016x}", hasher.finish()),
        anchor: ScreenRect {
            x: pointer.x,
            y: pointer.y,
            width: 1.0,
            height: 1.0,
        },
        anchor_kind: SelectionAnchorKind::Pointer,
    })
}

fn foreground_process_id() -> Option<u32> {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return None;
        }
        let mut process_id = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut process_id));
        (process_id != 0).then_some(process_id)
    }
}

fn is_copy_target_active(target_process_id: u32) -> bool {
    is_windows_copy_target_active(target_process_id, foreground_process_id())
}

fn post_control_copy(target_process_id: u32, use_scancode: bool) -> bool {
    if !is_copy_target_active(target_process_id) {
        return false;
    }
    // Virtual-key and scan-code forms: some apps only honour one of the two.
    let mut inputs = [
        keyboard_input(VK_CONTROL, false, use_scancode),
        keyboard_input(VK_C, false, use_scancode),
        keyboard_input(VK_C, true, use_scancode),
        keyboard_input(VK_CONTROL, true, use_scancode),
    ];
    unsafe { SendInput(&mut inputs, std::mem::size_of::<INPUT>() as i32) == inputs.len() as u32 }
}

fn post_wm_copy(target_process_id: u32) -> bool {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return false;
        }
        let mut foreground_process_id = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut foreground_process_id));
        if !is_windows_copy_target_active(target_process_id, Some(foreground_process_id)) {
            return false;
        }
        // WM_COPY is handled by standard edit controls; custom UIs may ignore it.
        // windows 0.62+ takes Option for unused WPARAM/LPARAM (None == 0).
        let _ = SendMessageW(hwnd, WM_COPY, None, None);
        true
    }
}

fn keyboard_input(vk: VIRTUAL_KEY, key_up: bool, use_scancode: bool) -> INPUT {
    let scan = unsafe { MapVirtualKeyW(u32::from(vk.0), MAPVK_VK_TO_VSC) as u16 };
    let mut flags = if key_up {
        KEYEVENTF_KEYUP
    } else {
        KEYBD_EVENT_FLAGS(0)
    };
    if use_scancode {
        flags |= KEYEVENTF_SCANCODE;
    }
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: if use_scancode { VIRTUAL_KEY(0) } else { vk },
                wScan: scan,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn wait_for_clipboard_text(sequence_before: u32) -> Option<String> {
    let mut elapsed = 0u64;
    while elapsed < CLIPBOARD_FALLBACK_TIMEOUT_MS {
        thread::sleep(Duration::from_millis(CLIPBOARD_FALLBACK_INTERVAL_MS));
        elapsed = elapsed.saturating_add(CLIPBOARD_FALLBACK_INTERVAL_MS);
        if unsafe { GetClipboardSequenceNumber() } == sequence_before {
            continue;
        }
        let Some(text) = read_clipboard_text() else {
            continue;
        };
        if is_actionable_selection_text(&text) {
            return Some(text);
        }
    }
    None
}

fn read_clipboard_text() -> Option<String> {
    unsafe {
        OpenClipboard(None).ok()?;
        let result = (|| {
            if IsClipboardFormatAvailable(CF_UNICODETEXT).is_err() {
                return None;
            }
            let handle = GetClipboardData(CF_UNICODETEXT).ok()?;
            if handle.0.is_null() {
                return None;
            }
            let locked = GlobalLock(HGLOBAL(handle.0));
            if locked.is_null() {
                return None;
            }
            let wide = locked as *const u16;
            let mut len = 0usize;
            while *wide.add(len) != 0 {
                len += 1;
                if len > 1_000_000 {
                    break;
                }
            }
            let text = String::from_utf16_lossy(std::slice::from_raw_parts(wide, len));
            let _ = GlobalUnlock(HGLOBAL(handle.0));
            Some(text)
        })();
        let _ = CloseClipboard();
        result
    }
}

fn restore_clipboard_text(previous: Option<&str>) {
    unsafe {
        if OpenClipboard(None).is_err() {
            return;
        }
        let _ = EmptyClipboard();
        if let Some(text) = previous {
            let mut wide: Vec<u16> = text.encode_utf16().collect();
            wide.push(0);
            let bytes = wide.len() * 2;
            if let Ok(handle) = GlobalAlloc(GMEM_MOVEABLE, bytes) {
                if !handle.0.is_null() {
                    let locked = GlobalLock(handle);
                    if !locked.is_null() {
                        std::ptr::copy_nonoverlapping(
                            wide.as_ptr() as *const u8,
                            locked as *mut u8,
                            bytes,
                        );
                        let _ = GlobalUnlock(handle);
                        let _ = SetClipboardData(CF_UNICODETEXT, Some(HANDLE(handle.0)));
                    }
                }
            }
        }
        let _ = CloseClipboard();
    }
}

/// Stable filter key for Windows: lower-case executable basename (e.g. `notepad.exe`).
fn process_image_basename(process_id: u32) -> Option<String> {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id).ok()?;
        let path = process_image_path(handle);
        let _ = CloseHandle(handle);
        let path = path?;
        std::path::Path::new(&path)
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| name.to_ascii_lowercase())
    }
}

fn process_image_path(handle: HANDLE) -> Option<String> {
    use windows::Win32::System::Threading::QueryFullProcessImageNameW;
    unsafe {
        let mut buffer = vec![0u16; 1024];
        let mut size = buffer.len() as u32;
        QueryFullProcessImageNameW(
            handle,
            Default::default(),
            PWSTR(buffer.as_mut_ptr()),
            &mut size,
        )
        .ok()?;
        if size == 0 {
            return None;
        }
        Some(String::from_utf16_lossy(&buffer[..size as usize]))
    }
}

fn first_bounding_rect(range: &UITextRange) -> uiautomation::Result<Option<ScreenRect>> {
    let raw = unsafe { range.as_ref().GetBoundingRectangles()? };
    let values: Vec<f64> = SafeArray::from(raw).into_vector(VT_R8)?;
    Ok(values.chunks_exact(4).next().and_then(|rect| {
        (rect[2] > 0.0 && rect[3] > 0.0).then_some(ScreenRect {
            x: rect[0],
            y: rect[1],
            width: rect[2],
            height: rect[3],
        })
    }))
}

fn start_error(code: &str, message: String) -> PlatformStartError {
    PlatformStartError {
        permission: PermissionState::NotRequired,
        error: RuntimeError {
            code: code.into(),
            message,
        },
    }
}
