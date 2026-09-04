use super::*;

#[test]
fn slow_notice_requires_fifteen_seconds_and_is_claimed_once() {
    let phase = StartupPhase::new("webview creation");
    assert!(!phase.claim_slow_notice(Duration::from_secs(14)));
    assert!(phase.claim_slow_notice(Duration::from_secs(15)));
    assert!(!phase.claim_slow_notice(Duration::from_secs(20)));
    assert!(!phase.snapshot().unwrap().finished);
}

#[test]
fn app_and_error_presentation_finish_startup_without_notifications() {
    for surface in [StartupPresentation::App, StartupPresentation::Error] {
        let phase = StartupPhase::new("frontend commit");
        phase.mark_presented(surface);
        assert!(phase.snapshot().unwrap().finished);
        assert!(!phase.claim_slow_notice(Duration::from_secs(30)));
        phase.set("late initialization");
        assert_eq!(phase.get(), "frontend commit");
    }
}

#[test]
fn repeated_completion_is_not_a_second_transition() {
    let phase = StartupPhase::new("startup");
    assert!(phase.finish().is_some());
    assert!(phase.finish().is_none());
}

#[test]
fn slow_notice_does_not_consume_the_fatal_transition() {
    let phase = StartupPhase::new("webview creation");
    assert!(phase.claim_slow_notice(Duration::from_secs(15)));
    assert!(phase.finish().is_some());
    assert!(phase.finish().is_none());
}

#[test]
fn presentation_values_match_the_frontend_protocol() {
    assert_eq!(
        serde_json::from_str::<StartupPresentation>("\"app\"").unwrap(),
        StartupPresentation::App
    );
    assert_eq!(
        serde_json::from_str::<StartupPresentation>("\"error\"").unwrap(),
        StartupPresentation::Error
    );
    assert!(serde_json::from_str::<StartupPresentation>("\"ready\"").is_err());
}

#[test]
fn later_error_is_logged_without_reopening_startup_or_accepting_app_again() {
    let log = tempfile::NamedTempFile::new().unwrap();
    let subscriber = tracing_subscriber::fmt()
        .without_time()
        .with_ansi(false)
        .with_writer(Arc::new(log.reopen().unwrap()))
        .finish();
    let phase = StartupPhase::new("frontend commit");
    tracing::subscriber::with_default(subscriber, || {
        phase.mark_presented(StartupPresentation::App);
        phase.mark_presented(StartupPresentation::Error);
        phase.mark_presented(StartupPresentation::App);
        phase.mark_presented(StartupPresentation::Error);
    });
    let output = std::fs::read_to_string(log.path()).unwrap();
    let presentations: Vec<_> = output
        .lines()
        .filter(|line| line.contains("AQBot startup surface presented"))
        .collect();
    assert_eq!(presentations.len(), 2, "{output}");
    assert!(presentations[0].contains("surface=\"app\""), "{output}");
    assert!(presentations[1].contains("surface=\"error\""), "{output}");
    assert!(phase.snapshot().unwrap().finished);
    assert!(!phase.claim_slow_notice(Duration::from_secs(30)));
    assert_eq!(
        phase.inner.lock().unwrap().last_presented_surface,
        Some(StartupPresentation::Error)
    );
}

#[test]
fn cancelled_presentation_stops_monitoring_without_surface_or_native_failure() {
    let log = tempfile::NamedTempFile::new().unwrap();
    let subscriber = tracing_subscriber::fmt()
        .without_time()
        .with_ansi(false)
        .with_writer(Arc::new(log.reopen().unwrap()))
        .finish();
    let phase = StartupPhase::new("frontend loading");
    tracing::subscriber::with_default(subscriber, || {
        phase.cancel_presentation();
        phase.cancel_presentation();
        phase.mark_presented(StartupPresentation::App);
        phase.mark_presented(StartupPresentation::Error);
        phase.fail(&std::io::Error::other("window hidden by user"));
    });
    let output = std::fs::read_to_string(log.path()).unwrap();
    assert_eq!(output.matches("user_hide_or_close").count(), 1, "{output}");
    assert!(
        !output.contains("AQBot startup surface presented"),
        "{output}"
    );
    assert!(output.contains("during_startup=false"), "{output}");
    assert!(phase.presentation_cancelled());
    assert!(phase.snapshot().unwrap().finished);
    assert!(!phase.claim_slow_notice(Duration::from_secs(30)));
    assert_eq!(phase.inner.lock().unwrap().last_presented_surface, None);
}

#[test]
fn cancelling_after_app_presentation_keeps_late_errors_observable() {
    let phase = StartupPhase::new("frontend commit");
    phase.mark_presented(StartupPresentation::App);
    phase.cancel_presentation();
    assert!(!phase.presentation_cancelled());
    assert!(phase
        .record_presentation(StartupPresentation::Error)
        .is_some());
    assert!(phase.snapshot().unwrap().finished);
}
