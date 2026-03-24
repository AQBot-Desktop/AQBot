use std::io;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct PersistedWindowState {
    pub width: f64,
    pub height: f64,
}

pub fn window_state_path(aqbot_home: &Path) -> PathBuf {
    aqbot_home.join("window-state.json")
}

pub fn load_window_state(aqbot_home: &Path) -> Option<PersistedWindowState> {
    let path = window_state_path(aqbot_home);
    let json = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&json).ok()
}

pub fn save_window_state(aqbot_home: &Path, state: PersistedWindowState) -> io::Result<()> {
    std::fs::create_dir_all(aqbot_home)?;
    let json = serde_json::to_vec_pretty(&state)
        .map_err(|error| io::Error::new(io::ErrorKind::Other, error))?;
    std::fs::write(window_state_path(aqbot_home), json)
}

pub fn logical_window_state_from_physical(
    physical_width: u32,
    physical_height: u32,
    scale_factor: f64,
) -> PersistedWindowState {
    PersistedWindowState {
        width: physical_width as f64 / scale_factor,
        height: physical_height as f64 / scale_factor,
    }
}

pub fn clamp_window_state_to_monitor(
    state: PersistedWindowState,
    monitor_width: f64,
    monitor_height: f64,
) -> PersistedWindowState {
    let max_width = monitor_width * 0.9;
    let max_height = monitor_height * 0.9;
    PersistedWindowState {
        width: state.width.clamp(640.0, max_width),
        height: state.height.clamp(480.0, max_height),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        clamp_window_state_to_monitor, load_window_state, logical_window_state_from_physical, save_window_state,
        PersistedWindowState,
    };

    #[test]
    fn round_trips_window_state_in_aqbot_home() {
        let test_dir = std::env::temp_dir().join(format!(
            "aqbot-window-state-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system time before unix epoch")
                .as_nanos()
        ));

        std::fs::create_dir_all(&test_dir).expect("failed to create temp dir");
        let state = PersistedWindowState {
            width: 1440.0,
            height: 960.0,
        };

        save_window_state(&test_dir, state).expect("failed to save window state");

        let restored = load_window_state(&test_dir).expect("failed to load saved window state");
        assert_eq!(restored, state);

        let _ = std::fs::remove_dir_all(&test_dir);
    }

    #[test]
    fn converts_physical_pixels_to_logical_window_size() {
        let logical = logical_window_state_from_physical(3024, 1964, 2.0);
        assert_eq!(
            logical,
            PersistedWindowState {
                width: 1512.0,
                height: 982.0,
            }
        );
    }

    #[test]
    fn clamps_oversized_window_state_to_visible_monitor_bounds() {
        let clamped = clamp_window_state_to_monitor(
            PersistedWindowState {
                width: 2200.0,
                height: 1600.0,
            },
            1512.0,
            982.0,
        );

        assert!((clamped.width - 1360.8).abs() < f64::EPSILON);
        assert!((clamped.height - 883.8).abs() < 1e-9);
    }
}
