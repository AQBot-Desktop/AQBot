//! Checks the shared text path after native capture, not OS selection delivery.
use super::*;
use crate::selection_toolbar::{ScreenRect, SelectionAnchorKind};
use aqbot_core::types::{ChatContent, ChatRequest};

fn code_selection(lines: usize) -> SelectionObservation {
    let text = (0..lines)
        .map(|line| match line {
            0 => "\n".into(),
            _ if line + 1 == lines => "\n".into(),
            _ => format!("    const value_{line} = \"长代码 🧪 {{selection}}\";\n"),
        })
        .collect();
    SelectionObservation {
        text,
        source_app: "com.example.editor".into(),
        source_window: "diagnostic fixture".into(),
        range_signature: format!("0:{lines}"),
        anchor: ScreenRect {
            x: -300.0,
            y: 200.0,
            width: 1.0,
            height: 1.0,
        },
        anchor_kind: SelectionAnchorKind::Pointer,
    }
}

fn execution_config() -> ToolExecutionConfig {
    ToolExecutionConfig {
        provider_id: "diagnostic-provider".into(),
        request: ChatRequest {
            model: "diagnostic-model".into(),
            messages: vec![],
            stream: true,
            temperature: None,
            top_p: None,
            max_tokens: None,
            tools: None,
            thinking_budget: None,
            thinking_level: None,
            reasoning_profile: None,
            use_max_completion_tokens: None,
            thinking_param_style: None,
            extra_body: None,
        },
    }
}

fn accept(store: &mut RuntimeStore, observation: SelectionObservation) -> String {
    store.accept_selection(
        observation,
        vec![],
        "light",
        "zh-CN",
        SelectionToolbarDisplayMode::Full,
        None,
        SelectionToolbarPlacement::Below,
        false,
    )
}

#[tokio::test]
async fn long_code_survives_debounce_publication_and_shortcut_cache() {
    for lines in [100, 500, 1000] {
        let observation = code_selection(lines);
        assert_eq!(observation.text.lines().count(), lines);
        let runtime = SelectionToolbarRuntime::new();
        runtime.remember_selection_candidate(&observation).await;
        assert_eq!(
            runtime
                .pending_selection
                .lock()
                .await
                .as_ref()
                .unwrap()
                .observation,
            observation,
        );
        let mut debouncer = SelectionDebouncer::new(SELECTION_OBSERVATION_RACE_MS);
        debouncer.push(observation.clone(), 0);
        assert_eq!(debouncer.take_ready(199), None);
        let Some(SelectionChange::Selected(ready)) = debouncer.take_ready(200) else {
            panic!("long code must be delivered intact after debounce");
        };
        assert_eq!(ready, observation);
        assert_eq!(
            runtime.selection_publish_decision(&ready).await,
            SelectionPublishDecision::PublishNew
        );
    }
}

#[test]
fn long_code_is_preserved_in_copy_input_and_prepared_request() {
    for lines in [100, 500, 1000] {
        let observation = code_selection(lines);
        let original = observation.text.clone();
        let mut store = RuntimeStore::new(SelectionPlatform::current());
        let id = accept(&mut store, observation);
        assert_eq!(store.selection_text(&id), Some(original.as_str()));
        assert_eq!(
            store.input_view(&id).unwrap(),
            ToolbarInputView::Text {
                text: original.clone()
            }
        );
        let input = store.input(&id).unwrap();
        assert_eq!(input.source_text(None).unwrap(), original);
        let content = input.content(input.source_text(None).unwrap().to_owned());
        let prepared = store
            .begin_new_tool_run(
                &id,
                "explain",
                execution_config(),
                InitialToolInput {
                    content,
                    user_input: None,
                },
            )
            .unwrap();
        assert_eq!(prepared.config.request.messages.len(), 1);
        let ChatContent::Text(request_text) = &prepared.config.request.messages[0].content else {
            panic!("a text selection must produce text request content");
        };
        assert_eq!(request_text, &original);
    }
}

#[tokio::test]
async fn late_long_selection_survives_clear_and_preserves_pointer_anchor() {
    let runtime = SelectionToolbarRuntime::new();
    let pointer = code_selection(1000);
    let mut range = pointer.clone();
    range.anchor_kind = SelectionAnchorKind::SelectionRect;
    range.anchor.y = -10_000.0;
    let mut debouncer = SelectionDebouncer::new(SELECTION_OBSERVATION_RACE_MS);
    debouncer.push(range.clone(), 0);
    debouncer.clear();
    assert_eq!(debouncer.take_ready(200), None);
    // Replay a successful mouse observation followed by a late native notification.
    debouncer.push(pointer.clone(), 630);
    debouncer.push(range.clone(), 650);
    let Some(SelectionChange::Selected(ready)) = debouncer.take_ready(850) else {
        panic!("a later selection must remain actionable after clear");
    };
    assert_eq!(ready, pointer);
    let id = accept(&mut *runtime.store.lock().await, range);
    assert_eq!(
        runtime.selection_publish_decision(&ready).await,
        SelectionPublishDecision::ReanchorLive { selection_id: id },
    );
}

#[tokio::test]
async fn diagnostic_events_include_decisions_without_selected_text() {
    // Tracing callsite registration is process-global; isolate the local subscriber
    // from parallel tests that exercise the same callsites without a subscriber.
    if std::env::var_os("AQBOT_TEST_SELECTION_LOG_CAPTURE").is_none() {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "selection_toolbar::controller::long_text_tests::diagnostic_events_include_decisions_without_selected_text"])
            .env("AQBOT_TEST_SELECTION_LOG_CAPTURE", "1")
            .output()
            .unwrap();
        assert!(
            output.status.success()
                && String::from_utf8_lossy(&output.stdout).contains("1 passed; 0 failed"),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    }
    let log = tempfile::NamedTempFile::new().unwrap();
    let subscriber = tracing_subscriber::fmt()
        .without_time()
        .with_ansi(false)
        .with_max_level(tracing::Level::DEBUG)
        .with_writer(std::sync::Mutex::new(log.reopen().unwrap()))
        .finish();
    let _guard = tracing::subscriber::set_default(subscriber);
    let selection = code_selection(500);
    let runtime = SelectionToolbarRuntime::new();
    assert_eq!(
        runtime.selection_publish_decision(&selection).await,
        SelectionPublishDecision::PublishNew,
    );
    let mut debouncer = SelectionDebouncer::new(200);
    debouncer.push(selection.clone(), 0);
    assert!(debouncer.take_ready(199).is_none());
    assert!(debouncer.take_ready(200).is_some());
    debouncer.push(selection, 201);
    assert!(debouncer.take_ready(401).is_none());
    let output = std::fs::read_to_string(log.path()).unwrap();
    assert!(output.contains("[selection-toolbar-diagnostics]"));
    assert!(output.contains("PublishNew"));
    assert!(output.contains("debounce_waiting"));
    assert!(output.contains("debounce_ignored"));
    assert!(!output.contains("长代码"));
    assert!(!output.contains("diagnostic fixture"));
}
