use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, LogicalSize, Manager, Size, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tokio::sync::oneshot;
use tokio::time::{timeout, Duration};

const POPOUT_READY_TIMEOUT: Duration = Duration::from_secs(8);

fn pending_ready_senders() -> &'static Mutex<HashMap<String, oneshot::Sender<()>>> {
    static PENDING: OnceLock<Mutex<HashMap<String, oneshot::Sender<()>>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn report_ready(conversation_id: &str) {
    if let Ok(mut pending) = pending_ready_senders().lock() {
        if let Some(sender) = pending.remove(conversation_id) {
            let _ = sender.send(());
        }
    }
}

const MAIN_WINDOW_LABEL: &str = "main";
const POPOUT_SIZE_RATIO: f64 = 0.9;

pub const CONVERSATION_POPOUT_LABEL_PREFIX: &str = "conversation-popout:";
const MAX_CONVERSATION_ID_LEN: usize = 128;

pub fn is_safe_conversation_id(conversation_id: &str) -> bool {
    if conversation_id.is_empty() || conversation_id.len() > MAX_CONVERSATION_ID_LEN {
        return false;
    }
    let mut chars = conversation_id.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    first.is_ascii_alphanumeric()
        && chars.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | ':' | '/'))
}

pub fn window_label_for_conversation(conversation_id: &str) -> Result<String, String> {
    if !is_safe_conversation_id(conversation_id) {
        return Err("invalid conversation id".into());
    }
    Ok(format!(
        "{CONVERSATION_POPOUT_LABEL_PREFIX}{conversation_id}"
    ))
}

#[cfg_attr(not(test), allow(dead_code))]
pub fn conversation_id_from_label(label: &str) -> Option<&str> {
    let id = label.strip_prefix(CONVERSATION_POPOUT_LABEL_PREFIX)?;
    is_safe_conversation_id(id).then_some(id)
}

pub fn popout_inner_size(main_width: f64, main_height: f64) -> (f64, f64) {
    (
        (main_width * POPOUT_SIZE_RATIO).max(1.0),
        (main_height * POPOUT_SIZE_RATIO).max(1.0),
    )
}

fn popout_size_from_main(app: &AppHandle) -> (f64, f64) {
    let Some(main) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return (1080.0, 720.0);
    };
    let Ok(physical) = main.inner_size() else {
        return (1080.0, 720.0);
    };
    let scale = main.scale_factor().unwrap_or(1.0).max(0.1);
    popout_inner_size(physical.width as f64 / scale, physical.height as f64 / scale)
}

fn apply_popout_bounds(app: &AppHandle, window: &WebviewWindow) {
    let (width, height) = popout_size_from_main(app);
    let _ = window.set_size(Size::Logical(LogicalSize::new(width, height)));
    let _ = window.center();
}

pub fn open_or_focus(app: &AppHandle, conversation_id: &str) -> Result<bool, String> {
    let label = window_label_for_conversation(conversation_id)?;
    if let Some(existing) = app.get_webview_window(&label) {
        apply_popout_bounds(app, &existing);
        let _ = existing.unminimize();
        existing.show().map_err(|err| err.to_string())?;
        existing.set_focus().map_err(|err| err.to_string())?;
        return Ok(true);
    }

    let (width, height) = popout_size_from_main(app);
    let mut builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title("AQBot")
        .inner_size(width, height)
        .min_inner_size(720.0, 480.0)
        .visible(false)
        .resizable(true)
        .center();

    #[cfg(target_os = "macos")]
    {
        builder = builder
            .hidden_title(true)
            .title_bar_style(tauri::TitleBarStyle::Overlay);
    }

    #[cfg(target_os = "windows")]
    {
        builder = builder.decorations(false);
    }

    let window = builder.build().map_err(|err| err.to_string())?;
    configure_popout_window(&window);
    apply_popout_bounds(app, &window);
    Ok(false)
}

pub async fn open_or_focus_and_wait(app: &AppHandle, conversation_id: &str) -> Result<(), String> {
    let (tx, rx) = oneshot::channel();
    {
        let mut pending = pending_ready_senders()
            .lock()
            .map_err(|err| err.to_string())?;
        if let Some(previous) = pending.insert(conversation_id.to_string(), tx) {
            let _ = previous.send(());
        }
    }

    let already_visible = match open_or_focus(app, conversation_id) {
        Ok(visible) => visible,
        Err(error) => {
            if let Ok(mut pending) = pending_ready_senders().lock() {
                pending.remove(conversation_id);
            }
            return Err(error);
        }
    };
    if already_visible {
        if let Ok(mut pending) = pending_ready_senders().lock() {
            pending.remove(conversation_id);
        }
        return Ok(());
    }

    match timeout(POPOUT_READY_TIMEOUT, rx).await {
        Ok(_) => {}
        Err(_) => {
            if let Ok(mut pending) = pending_ready_senders().lock() {
                pending.remove(conversation_id);
            }
        }
    }
    Ok(())
}

fn configure_popout_window(window: &tauri::WebviewWindow) {
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    let _ = window;

    #[cfg(target_os = "linux")]
    if let Err(error) = crate::linux_webkit::enable_input_method_preedit(window) {
        tracing::warn!(
            error = %error,
            "Failed to enable WebKitGTK input method preedit for conversation popout"
        );
    }

    #[cfg(target_os = "windows")]
    {
        let _ = window.set_decorations(false);
        let _ = window.set_minimizable(true);
        let _ = window.set_maximizable(true);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_uuid_conversation_ids() {
        let id = "6f1d2c8a-3b44-4e11-9c0a-12ab34cd56ef";
        assert!(is_safe_conversation_id(id));
        assert_eq!(
            window_label_for_conversation(id).unwrap(),
            format!("{CONVERSATION_POPOUT_LABEL_PREFIX}{id}")
        );
        assert_eq!(
            conversation_id_from_label(&format!("{CONVERSATION_POPOUT_LABEL_PREFIX}{id}")),
            Some(id)
        );
    }

    #[test]
    fn rejects_unsafe_conversation_ids() {
        assert!(!is_safe_conversation_id(""));
        assert!(!is_safe_conversation_id("../secret"));
        assert!(!is_safe_conversation_id("conv id"));
        assert!(window_label_for_conversation("bad id").is_err());
        assert_eq!(conversation_id_from_label("main"), None);
    }

    #[test]
    fn sizes_the_independent_window_to_ninety_percent_of_the_main_window() {
        assert_eq!(popout_inner_size(1200.0, 800.0), (1080.0, 720.0));
        assert_eq!(popout_inner_size(1000.0, 700.0), (900.0, 630.0));
    }

    #[tokio::test]
    async fn report_ready_completes_a_pending_waiter() {
        let (tx, rx) = oneshot::channel();
        pending_ready_senders()
            .lock()
            .expect("pending ready lock")
            .insert("conv-ready".to_string(), tx);
        report_ready("conv-ready");
        rx.await.expect("ready signal");
    }
}