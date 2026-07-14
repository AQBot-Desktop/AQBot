use super::{Screenshot, ScreenshotError};
use tauri::{Runtime, WebviewWindow};

/// iOS-specific screenshot implementation using WKWebView's takeSnapshot
///
/// This implementation captures only the visible viewport, not the full document.
/// Similar to macOS but works with UIImage instead of NSImage.
///
/// Note: We use raw objc2 msg_send! calls instead of typed WKWebView because
/// objc2-web-kit's WKWebView requires objc2-app-kit which is macOS-only.
/// On iOS, WKWebView inherits from UIView (via objc2-ui-kit), not NSView.
/// The takeSnapshotWithConfiguration:completionHandler: method returns UIImage on iOS.
pub fn capture_viewport<R: Runtime>(
    window: &WebviewWindow<R>,
) -> Result<Screenshot, ScreenshotError> {
    #[cfg(target_os = "ios")]
    {
        use block2::RcBlock;
        use objc2::runtime::AnyObject;
        use objc2_foundation::NSError;
        use objc2_ui_kit::UIImage;
        use objc2_web_kit::WKSnapshotConfiguration;
        use std::cell::RefCell;
        use std::sync::mpsc;

        let (tx, rx) = mpsc::channel::<Result<Screenshot, ScreenshotError>>();

        // Use Tauri's with_webview to access the platform-specific webview
        window
            .with_webview(move |webview| {
                unsafe {
                    // Get the WKWebView as a raw AnyObject pointer
                    // We can't use the typed WKWebView because objc2-web-kit requires
                    // objc2-app-kit (macOS only). On iOS, we use raw msg_send! instead.
                    let wkwebview: *mut AnyObject = webview.inner().cast();

                    // Create snapshot configuration (captures visible viewport)
                    let config = WKSnapshotConfiguration::new();

                    // Create completion handler block using RcBlock
                    // RcBlock is reference-counted and stays alive until the callback completes
                    // We use RefCell to make the closure FnOnce-like (only sends once)
                    //
                    // IMPORTANT: The block signature must match what iOS expects:
                    // - First param: UIImage* (nullable) - the snapshot image
                    // - Second param: NSError* (nullable) - any error that occurred
                    // We use Retained<T> for nullable object pointers in completion handlers
                    let tx = RefCell::new(Some(tx));
                    let handler = RcBlock::new(move |image: *mut UIImage, error: *mut NSError| {
                        if let Some(tx) = tx.borrow_mut().take() {
                            if !error.is_null() {
                                // Get error description
                                let err = &*error;
                                let desc = err.localizedDescription();
                                let error_string = desc.to_string();
                                let _ = tx.send(Err(ScreenshotError::CaptureFailed(error_string)));
                            } else if !image.is_null() {
                                // Convert UIImage to PNG data
                                let img = &*image;
                                match convert_uiimage_to_png(img) {
                                    Ok(data) => {
                                        let _ = tx.send(Ok(Screenshot { data }));
                                    }
                                    Err(e) => {
                                        let _ = tx.send(Err(e));
                                    }
                                }
                            } else {
                                let _ = tx.send(Err(ScreenshotError::CaptureFailed(
                                    "No image returned from snapshot".to_string(),
                                )));
                            }
                        }
                    });

                    // Take snapshot using raw msg_send!
                    // Selector: takeSnapshotWithConfiguration:completionHandler:
                    let _: () = objc2::msg_send![
                        wkwebview,
                        takeSnapshotWithConfiguration: &*config,
                        completionHandler: &*handler
                    ];
                }
            })
            .map_err(|e| {
                ScreenshotError::CaptureFailed(format!("Failed to access webview: {e}"))
            })?;

        // Wait for result while running the event loop
        // This is necessary because the completion handler is called asynchronously
        unsafe { wait_for_blocking_operation(rx) }
    }

    #[cfg(not(target_os = "ios"))]
    {
        Err(ScreenshotError::PlatformUnsupported)
    }
}

/// Wait synchronously for the NSRunLoop to run until a receiver has a message.
/// This is necessary for async completion handlers on iOS.
#[cfg(target_os = "ios")]
unsafe fn wait_for_blocking_operation(
    rx: std::sync::mpsc::Receiver<Result<Screenshot, ScreenshotError>>,
) -> Result<Screenshot, ScreenshotError> {
    use objc2_foundation::{NSDate, NSRunLoop, NSString};

    let interval = std::time::Duration::from_millis(10);
    let interval_as_secs = interval.as_secs_f64();
    let limit = 10.0; // 10 second timeout
    let mut elapsed = 0.0;

    loop {
        if let Ok(response) = rx.recv_timeout(interval) {
            return response;
        }
        elapsed += interval_as_secs;
        if elapsed >= limit {
            return Err(ScreenshotError::Timeout);
        }

        // Progress the event loop if we didn't get the result yet
        let rl = NSRunLoop::mainRunLoop();
        let limit_date = NSDate::dateWithTimeIntervalSinceNow(interval_as_secs);
        let mode = NSString::from_str("NSDefaultRunLoopMode");
        let _ = rl.runMode_beforeDate(&mode, &limit_date);
    }
}

/// Convert UIImage to PNG data using UIImagePNGRepresentation
#[cfg(target_os = "ios")]
unsafe fn convert_uiimage_to_png(
    image: &objc2_ui_kit::UIImage,
) -> Result<Vec<u8>, ScreenshotError> {
    use objc2_foundation::NSData;

    // Use UIImagePNGRepresentation function (available since iOS 2.0)
    // This is more reliable than the pngData() method
    extern "C" {
        fn UIImagePNGRepresentation(image: &objc2_ui_kit::UIImage) -> *mut NSData;
    }

    let png_data = UIImagePNGRepresentation(image);

    if png_data.is_null() {
        return Err(ScreenshotError::EncodeFailed(
            "Failed to create PNG data".to_string(),
        ));
    }

    let data = &*png_data;
    let length = data.len();
    let bytes = data.bytes();
    let buffer = std::slice::from_raw_parts(bytes.as_ptr(), length).to_vec();

    Ok(buffer)
}
