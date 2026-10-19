use super::*;

#[test]
fn startup_settings_control_the_first_presentation_once() {
    for (show, minimized, expected) in [
        (true, false, StartupWindowMode::Visible),
        (true, true, StartupWindowMode::Minimized),
        (false, false, StartupWindowMode::Hidden),
        (false, true, StartupWindowMode::Hidden),
    ] {
        let startup = MainWindowStartup::new(show, minimized);
        assert_eq!(startup.begin_presentation(false).unwrap(), (expected, true));
        assert_eq!(
            startup.begin_presentation(false).unwrap(),
            (expected, false)
        );
    }
}

#[test]
fn explicit_restore_and_error_override_initial_hidden_or_minimized_intent() {
    for (show, minimized) in [(false, false), (true, true)] {
        let startup = MainWindowStartup::new(show, minimized);
        startup.begin_presentation(false).unwrap();
        assert_eq!(
            startup.begin_presentation(true).unwrap(),
            (StartupWindowMode::Visible, true)
        );
        // Recreated WebViews cannot apply the original cold-start preference again.
        assert_eq!(
            startup.begin_presentation(false).unwrap(),
            (StartupWindowMode::Visible, false)
        );
        startup.request_show().unwrap();
        assert_eq!(
            startup.begin_presentation(false).unwrap(),
            (StartupWindowMode::Visible, true)
        );
    }
}

#[test]
fn saved_maximized_or_fullscreen_state_survives_background_startup() {
    for (maximized, fullscreen) in [(true, false), (false, true)] {
        let saved = PersistedWindowState {
            width: 1200.0,
            height: 800.0,
            maximized,
            fullscreen,
            x: None,
            y: None,
        };
        let startup = MainWindowStartup::new(false, false);
        startup.defer_restore(saved).unwrap();
        startup.begin_presentation(false).unwrap();
        assert!(startup.has_deferred_restore().unwrap());
        startup.request_show().unwrap();
        assert_eq!(startup.lock().unwrap().restore.take(), Some(saved));
        assert!(!startup.has_deferred_restore().unwrap());
    }
}

#[test]
fn hidden_launch_without_tray_falls_back_to_minimized_before_presentation() {
    let startup = MainWindowStartup::new(false, false);
    assert_eq!(
        startup.require_reachable_window(true).unwrap(),
        StartupWindowMode::Hidden
    );
    assert_eq!(
        startup.require_reachable_window(false).unwrap(),
        StartupWindowMode::Minimized
    );
    assert_eq!(
        startup.begin_presentation(false).unwrap(),
        (StartupWindowMode::Minimized, true)
    );

    for (show, minimized, expected) in [
        (true, false, StartupWindowMode::Visible),
        (true, true, StartupWindowMode::Minimized),
    ] {
        let startup = MainWindowStartup::new(show, minimized);
        assert_eq!(startup.require_reachable_window(false).unwrap(), expected);
    }

    // A window already presented hidden is not re-presented by a later tray change.
    let startup = MainWindowStartup::new(false, false);
    startup.begin_presentation(false).unwrap();
    assert_eq!(
        startup.require_reachable_window(false).unwrap(),
        StartupWindowMode::Hidden
    );
}
