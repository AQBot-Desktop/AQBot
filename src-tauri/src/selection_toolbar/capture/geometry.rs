use serde::Deserialize;
use tauri::{AppHandle, Manager, Monitor, WebviewWindow};

use super::{validate_dimensions, CaptureError, ScreenPoint};

#[derive(Debug, Clone, PartialEq)]
pub(super) struct CaptureTarget {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale_factor: f64,
    pub name: Option<String>,
}

impl CaptureTarget {
    fn from_monitor(monitor: &Monitor) -> Self {
        Self {
            x: monitor.position().x,
            y: monitor.position().y,
            width: monitor.size().width,
            height: monitor.size().height,
            scale_factor: monitor.scale_factor(),
            name: monitor.name().cloned(),
        }
    }

    pub fn under_cursor(app: &AppHandle) -> Result<Self, CaptureError> {
        let pointer = app.cursor_position().map_err(CaptureError::failed)?;
        let monitor = app
            .monitor_from_point(pointer.x, pointer.y)
            .map_err(CaptureError::failed)?
            .ok_or_else(|| {
                CaptureError::new("capture_unavailable", "No monitor contains the cursor")
            })?;
        let target = Self::from_monitor(&monitor);
        validate_dimensions(target.width, target.height)?;
        Ok(target)
    }

    pub fn ensure_current(&self, app: &AppHandle) -> Result<(), CaptureError> {
        let unchanged = app
            .available_monitors()
            .map_err(CaptureError::failed)?
            .iter()
            .any(|monitor| Self::from_monitor(monitor) == *self);
        if !unchanged {
            return Err(CaptureError::new(
                "capture_unavailable",
                "The display configuration changed during capture",
            ));
        }
        Ok(())
    }

    pub fn ensure_overlay(&self, window: &WebviewWindow) -> Result<(), CaptureError> {
        self.ensure_current(window.app_handle())?;
        let position = window.outer_position().map_err(CaptureError::failed)?;
        let size = window.inner_size().map_err(CaptureError::failed)?;
        let scale_factor = window.scale_factor().map_err(CaptureError::failed)?;
        if position.x != self.x
            || position.y != self.y
            || size.width != self.width
            || size.height != self.height
            || scale_factor != self.scale_factor
        {
            return Err(CaptureError::new(
                "capture_unavailable",
                "The capture overlay no longer matches the captured display",
            ));
        }
        Ok(())
    }

    pub fn anchor(&self, region: CaptureRegion) -> ScreenPoint {
        ScreenPoint {
            x: f64::from(self.x) + f64::from(region.x + region.width - 1),
            y: f64::from(self.y) + f64::from(region.y + region.height - 1),
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize)]
pub struct CaptureRegion {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

impl CaptureRegion {
    pub(super) fn validate(self, width: u32, height: u32) -> Result<(), CaptureError> {
        if self.width == 0
            || self.height == 0
            || self
                .x
                .checked_add(self.width)
                .is_none_or(|right| right > width)
            || self
                .y
                .checked_add(self.height)
                .is_none_or(|bottom| bottom > height)
        {
            return Err(CaptureError::new(
                "capture_invalid_region",
                "The selected rectangle is outside the screenshot",
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn regions_validate_overflow_and_preserve_negative_monitor_origins() {
        let target = CaptureTarget {
            x: -2560,
            y: -1440,
            width: 2560,
            height: 1440,
            scale_factor: 1.5,
            name: None,
        };
        let region = CaptureRegion {
            x: 200,
            y: 100,
            width: 600,
            height: 400,
        };
        region.validate(target.width, target.height).unwrap();
        assert_eq!(
            target.anchor(region),
            ScreenPoint {
                x: -1761.0,
                y: -941.0
            }
        );
        assert!(CaptureRegion { width: 0, ..region }
            .validate(2560, 1440)
            .is_err());
        assert!(CaptureRegion {
            x: u32::MAX,
            ..region
        }
        .validate(2560, 1440)
        .is_err());
        assert!(CaptureRegion {
            height: 1441,
            ..region
        }
        .validate(2560, 1440)
        .is_err());
    }
}
