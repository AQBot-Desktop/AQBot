use aqbot_core::types::SelectionToolbarSettings;

pub(super) const SELECTION_GESTURE_DISTANCE_THRESHOLD: f64 = 4.0;

#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct GesturePoint {
    pub x: f64,
    pub y: f64,
}

impl GesturePoint {
    pub fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }

    fn distance_to(self, other: Self) -> f64 {
        (self.x - other.x).hypot(self.y - other.y)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ClipboardFallbackDecision {
    Allow,
    SkipNotCandidateGesture,
    SkipAppFiltered,
    SkipNotWeakAx,
    SkipNotFirstAttempt,
    SkipSourcePidMismatch,
}

#[derive(Debug)]
struct ActivePress {
    event_number: i64,
    origin: GesturePoint,
    max_displacement: f64,
}

#[derive(Debug, Default)]
pub(super) struct SelectionGestureTracker {
    press: Option<ActivePress>,
}

impl SelectionGestureTracker {
    pub fn reset(&mut self) {
        self.press = None;
    }

    pub fn on_left_mouse_down(
        &mut self,
        event_number: i64,
        point: GesturePoint,
        control_click: bool,
    ) {
        if control_click {
            self.press = None;
            return;
        }
        self.press = Some(ActivePress {
            event_number,
            origin: point,
            max_displacement: 0.0,
        });
    }

    pub fn on_left_mouse_dragged(&mut self, point: GesturePoint) {
        let Some(press) = self.press.as_mut() else {
            return;
        };
        let distance = press.origin.distance_to(point);
        if distance > press.max_displacement {
            press.max_displacement = distance;
        }
    }

    pub fn on_left_mouse_up(
        &mut self,
        event_number: i64,
        click_state: i64,
        control_click: bool,
    ) -> bool {
        let press = self.press.take();
        if control_click {
            return false;
        }
        let Some(press) = press else {
            return false;
        };
        if press.event_number != event_number {
            return false;
        }
        press.max_displacement >= SELECTION_GESTURE_DISTANCE_THRESHOLD || click_state >= 2
    }

    pub fn on_other_mouse_down(&mut self) {
        self.press = None;
    }
}

pub(super) fn clipboard_fallback_decision(
    attempt: usize,
    source_app: &str,
    source_pid: Option<i32>,
    target_pid: i32,
    gesture_eligible: bool,
    settings: &SelectionToolbarSettings,
) -> ClipboardFallbackDecision {
    if !gesture_eligible {
        return ClipboardFallbackDecision::SkipNotCandidateGesture;
    }
    if !settings.allows_source_app(source_app) {
        return ClipboardFallbackDecision::SkipAppFiltered;
    }
    if !super::is_weak_ax_source_app(source_app) {
        return ClipboardFallbackDecision::SkipNotWeakAx;
    }
    if !super::should_try_macos_clipboard_fallback(attempt, source_app) {
        return ClipboardFallbackDecision::SkipNotFirstAttempt;
    }
    if !super::probe_source_allows_clipboard(source_pid, target_pid) {
        return ClipboardFallbackDecision::SkipSourcePidMismatch;
    }
    ClipboardFallbackDecision::Allow
}

pub(super) fn run_clipboard_fallback_policy<E: FnOnce() -> bool>(
    attempt: usize,
    source_app: &str,
    source_pid: Option<i32>,
    target_pid: i32,
    gesture_eligible: bool,
    settings: &SelectionToolbarSettings,
    executor: E,
) -> bool {
    let decision = clipboard_fallback_decision(
        attempt,
        source_app,
        source_pid,
        target_pid,
        gesture_eligible,
        settings,
    );
    tracing::debug!(
        source_app,
        attempt,
        gesture_eligible,
        target_pid,
        source_pid,
        ?decision,
        "macOS clipboard fallback decision"
    );
    if decision != ClipboardFallbackDecision::Allow {
        return false;
    }
    executor()
}

#[cfg(test)]
mod macos_clipboard_fallback_policy {
    use super::{
        run_clipboard_fallback_policy, ClipboardFallbackDecision, GesturePoint,
        SelectionGestureTracker, SELECTION_GESTURE_DISTANCE_THRESHOLD,
    };
    use aqbot_core::types::{
        SelectionToolbarAppEntry, SelectionToolbarAppFilterMode, SelectionToolbarSettings,
    };
    use std::cell::Cell;

    const WECHAT: &str = "com.tencent.xinWeChat";
    const TEXT_EDIT: &str = "com.apple.TextEdit";
    const TARGET_PID: i32 = 42;

    fn point(x: f64, y: f64) -> GesturePoint {
        GesturePoint::new(x, y)
    }

    fn blocked_wechat() -> SelectionToolbarSettings {
        let mut settings = SelectionToolbarSettings::default();
        settings.app_filter_mode = SelectionToolbarAppFilterMode::Blocklist;
        settings.app_filter = vec![SelectionToolbarAppEntry {
            id: WECHAT.into(),
            name: "WeChat".into(),
        }];
        settings
    }

    fn allow_wechat_only() -> SelectionToolbarSettings {
        let mut settings = SelectionToolbarSettings::default();
        settings.app_filter_mode = SelectionToolbarAppFilterMode::Allowlist;
        settings.app_filter = vec![SelectionToolbarAppEntry {
            id: WECHAT.into(),
            name: "WeChat".into(),
        }];
        settings
    }

    fn click_menu(tracker: &mut SelectionGestureTracker) -> bool {
        tracker.on_left_mouse_down(11, point(100.0, 200.0), false);
        tracker.on_left_mouse_up(11, 1, false)
    }

    fn drag_select(tracker: &mut SelectionGestureTracker) -> bool {
        tracker.on_left_mouse_down(21, point(10.0, 10.0), false);
        tracker.on_left_mouse_dragged(point(10.0 + SELECTION_GESTURE_DISTANCE_THRESHOLD, 10.0));
        tracker.on_left_mouse_up(21, 1, false)
    }

    fn run_copy(
        attempt: usize,
        source_app: &str,
        gesture_eligible: bool,
        settings: &SelectionToolbarSettings,
        copies: &Cell<usize>,
    ) -> bool {
        run_clipboard_fallback_policy(
            attempt,
            source_app,
            Some(TARGET_PID),
            TARGET_PID,
            gesture_eligible,
            settings,
            || {
                copies.set(copies.get() + 1);
                true
            },
        )
    }

    #[test]
    fn regular_menu_click_does_not_copy() {
        let mut tracker = SelectionGestureTracker::default();
        let copies = Cell::new(0);
        let eligible = click_menu(&mut tracker);
        assert!(!eligible);
        assert!(!run_copy(
            0,
            WECHAT,
            eligible,
            &SelectionToolbarSettings::default(),
            &copies
        ));
        assert_eq!(copies.get(), 0);
    }

    #[test]
    fn blacklisted_wechat_drag_does_not_copy() {
        let mut tracker = SelectionGestureTracker::default();
        let copies = Cell::new(0);
        let eligible = drag_select(&mut tracker);
        assert!(eligible);
        assert!(!run_copy(0, WECHAT, eligible, &blocked_wechat(), &copies));
        assert_eq!(copies.get(), 0);
    }

    #[test]
    fn allowed_wechat_drag_copies_once() {
        let mut tracker = SelectionGestureTracker::default();
        let copies = Cell::new(0);
        let eligible = drag_select(&mut tracker);
        assert!(eligible);
        assert!(run_copy(
            0,
            WECHAT,
            eligible,
            &SelectionToolbarSettings::default(),
            &copies
        ));
        assert!(!run_copy(
            1,
            WECHAT,
            eligible,
            &SelectionToolbarSettings::default(),
            &copies
        ));
        assert_eq!(copies.get(), 1);
    }

    #[test]
    fn allowlist_miss_does_not_copy() {
        let mut tracker = SelectionGestureTracker::default();
        let copies = Cell::new(0);
        let eligible = drag_select(&mut tracker);
        let mut settings = SelectionToolbarSettings::default();
        settings.app_filter_mode = SelectionToolbarAppFilterMode::Allowlist;
        settings.app_filter = vec![SelectionToolbarAppEntry {
            id: "com.google.Chrome".into(),
            name: "Google Chrome".into(),
        }];
        assert!(eligible);
        assert!(!run_copy(0, WECHAT, eligible, &settings, &copies));
        assert_eq!(copies.get(), 0);
    }

    #[test]
    fn allowlisted_wechat_drag_copies_once() {
        let mut tracker = SelectionGestureTracker::default();
        let copies = Cell::new(0);
        let eligible = drag_select(&mut tracker);
        assert!(run_copy(0, WECHAT, eligible, &allow_wechat_only(), &copies));
        assert_eq!(copies.get(), 1);
    }

    #[test]
    fn jitter_within_threshold_does_not_copy() {
        let mut tracker = SelectionGestureTracker::default();
        tracker.on_left_mouse_down(31, point(0.0, 0.0), false);
        tracker.on_left_mouse_dragged(point(SELECTION_GESTURE_DISTANCE_THRESHOLD - 0.5, 0.0));
        let eligible = tracker.on_left_mouse_up(31, 1, false);
        let copies = Cell::new(0);
        assert!(!eligible);
        assert!(!run_copy(
            0,
            WECHAT,
            eligible,
            &SelectionToolbarSettings::default(),
            &copies
        ));
        assert_eq!(copies.get(), 0);
    }

    #[test]
    fn drag_past_threshold_then_back_still_copies() {
        let mut tracker = SelectionGestureTracker::default();
        tracker.on_left_mouse_down(41, point(0.0, 0.0), false);
        tracker.on_left_mouse_dragged(point(SELECTION_GESTURE_DISTANCE_THRESHOLD + 2.0, 0.0));
        tracker.on_left_mouse_dragged(point(1.0, 0.0));
        let eligible = tracker.on_left_mouse_up(41, 1, false);
        let copies = Cell::new(0);
        assert!(eligible);
        assert!(run_copy(
            0,
            WECHAT,
            eligible,
            &SelectionToolbarSettings::default(),
            &copies
        ));
        assert_eq!(copies.get(), 1);
    }

    #[test]
    fn double_and_triple_click_are_candidate_gestures() {
        for click_state in [2, 3] {
            let mut tracker = SelectionGestureTracker::default();
            tracker.on_left_mouse_down(50 + click_state, point(8.0, 8.0), false);
            let eligible = tracker.on_left_mouse_up(50 + click_state, click_state, false);
            let copies = Cell::new(0);
            assert!(eligible, "click_state={click_state}");
            assert!(run_copy(
                0,
                WECHAT,
                eligible,
                &SelectionToolbarSettings::default(),
                &copies
            ));
            assert_eq!(copies.get(), 1);
        }
    }

    #[test]
    fn mismatched_event_number_does_not_copy() {
        let mut tracker = SelectionGestureTracker::default();
        tracker.on_left_mouse_down(61, point(0.0, 0.0), false);
        tracker.on_left_mouse_dragged(point(12.0, 0.0));
        let eligible = tracker.on_left_mouse_up(62, 1, false);
        let copies = Cell::new(0);
        assert!(!eligible);
        assert!(!run_copy(
            0,
            WECHAT,
            eligible,
            &SelectionToolbarSettings::default(),
            &copies
        ));
        assert_eq!(copies.get(), 0);
    }

    #[test]
    fn overlay_or_tap_reset_clears_in_flight_gesture() {
        let mut tracker = SelectionGestureTracker::default();
        tracker.on_left_mouse_down(71, point(0.0, 0.0), false);
        tracker.on_left_mouse_dragged(point(12.0, 0.0));
        tracker.reset();
        let eligible = tracker.on_left_mouse_up(71, 1, false);
        assert!(!eligible);

        tracker.on_left_mouse_down(72, point(0.0, 0.0), false);
        tracker.on_left_mouse_dragged(point(12.0, 0.0));
        tracker.on_other_mouse_down();
        let eligible = tracker.on_left_mouse_up(72, 1, false);
        assert!(!eligible);
    }

    #[test]
    fn retries_keep_frozen_eligibility_without_copying_again() {
        let mut tracker = SelectionGestureTracker::default();
        let eligible = drag_select(&mut tracker);
        let copies = Cell::new(0);
        assert!(eligible);
        assert!(run_copy(
            0,
            WECHAT,
            eligible,
            &SelectionToolbarSettings::default(),
            &copies
        ));
        assert!(!run_copy(
            1,
            WECHAT,
            eligible,
            &SelectionToolbarSettings::default(),
            &copies
        ));
        assert!(!run_copy(
            2,
            WECHAT,
            eligible,
            &SelectionToolbarSettings::default(),
            &copies
        ));
        assert_eq!(copies.get(), 1);
        assert_eq!(
            super::clipboard_fallback_decision(
                1,
                WECHAT,
                Some(TARGET_PID),
                TARGET_PID,
                eligible,
                &SelectionToolbarSettings::default(),
            ),
            ClipboardFallbackDecision::SkipNotFirstAttempt
        );
    }

    #[test]
    fn missing_mouse_down_and_control_click_fail_closed() {
        let mut tracker = SelectionGestureTracker::default();
        assert!(!tracker.on_left_mouse_up(81, 2, false));

        tracker.on_left_mouse_down(82, point(0.0, 0.0), true);
        tracker.on_left_mouse_dragged(point(20.0, 0.0));
        assert!(!tracker.on_left_mouse_up(82, 2, true));
    }

    #[test]
    fn regular_apps_never_invoke_the_copy_executor() {
        let copies = Cell::new(0);
        assert!(!run_copy(
            0,
            TEXT_EDIT,
            true,
            &SelectionToolbarSettings::default(),
            &copies
        ));
        assert_eq!(copies.get(), 0);
    }

    #[test]
    fn source_pid_mismatch_never_invokes_the_copy_executor() {
        let copies = Cell::new(0);
        assert!(!run_clipboard_fallback_policy(
            0,
            WECHAT,
            Some(7),
            TARGET_PID,
            true,
            &SelectionToolbarSettings::default(),
            || {
                copies.set(copies.get() + 1);
                true
            },
        ));
        assert_eq!(copies.get(), 0);
    }
}
