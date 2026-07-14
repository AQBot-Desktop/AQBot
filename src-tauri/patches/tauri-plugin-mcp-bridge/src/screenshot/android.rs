use super::{Screenshot, ScreenshotError};
use tauri::{Runtime, WebviewWindow};

/// Android-specific screenshot implementation using WebView's draw method
///
/// This implementation captures only the visible viewport.
/// Uses the WebView's draw method to render the current viewport to a bitmap.
pub fn capture_viewport<R: Runtime>(
    window: &WebviewWindow<R>,
) -> Result<Screenshot, ScreenshotError> {
    #[cfg(target_os = "android")]
    {
        use jni::objects::{JObject, JValue};
        use jni::sys::jbyteArray;
        use jni::{AttachGuard, JNIEnv};

        // Android integration through Tauri's activity access
        let activity = window.android_activity().map_err(|e| {
            ScreenshotError::CaptureFailed(format!("Failed to get activity: {}", e))
        })?;

        // Get JNI environment from Tauri's runtime
        let vm = tauri::android::vm();
        let env = vm.attach_current_thread().map_err(|e| {
            ScreenshotError::CaptureFailed(format!("Failed to attach thread: {}", e))
        })?;

        capture_android_webview(&env, activity)
    }

    #[cfg(not(target_os = "android"))]
    {
        Err(ScreenshotError::PlatformUnsupported)
    }
}

#[cfg(target_os = "android")]
fn capture_android_webview(
    env: &jni::JNIEnv,
    activity: jni::sys::jobject,
) -> Result<Screenshot, ScreenshotError> {
    use jni::objects::{JClass, JObject, JValue};
    use jni::sys::jbyteArray;

    unsafe {
        let activity_obj = JObject::from_raw(activity);

        // Find the WebView in the activity's view hierarchy
        // Get the content view (android.R.id.content = 0x01020002)
        let content_id = 0x01020002i32;
        let content_view = env
            .call_method(
                activity_obj,
                "findViewById",
                "(I)Landroid/view/View;",
                &[JValue::Int(content_id)],
            )
            .map_err(|e| {
                ScreenshotError::CaptureFailed(format!("Failed to get content view: {}", e))
            })?
            .l()
            .map_err(|e| {
                ScreenshotError::CaptureFailed(format!("Failed to convert content view: {}", e))
            })?;

        // Find the WebView in the hierarchy
        let webview_class = env.find_class("android/webkit/WebView").map_err(|e| {
            ScreenshotError::CaptureFailed(format!("Failed to find WebView class: {}", e))
        })?;

        let webview = find_webview_recursive(&env, content_view, webview_class)?;

        if webview.is_null() {
            return Err(ScreenshotError::CaptureFailed(
                "Could not find WebView in activity".to_string(),
            ));
        }

        // Get viewport dimensions
        let width = env
            .call_method(webview, "getWidth", "()I", &[])
            .map_err(|e| ScreenshotError::CaptureFailed(format!("Failed to get width: {}", e)))?
            .i()
            .map_err(|e| {
                ScreenshotError::CaptureFailed(format!("Failed to convert width: {}", e))
            })?;

        let height = env
            .call_method(webview, "getHeight", "()I", &[])
            .map_err(|e| ScreenshotError::CaptureFailed(format!("Failed to get height: {}", e)))?
            .i()
            .map_err(|e| {
                ScreenshotError::CaptureFailed(format!("Failed to convert height: {}", e))
            })?;

        // Create bitmap for viewport
        let bitmap_class = env.find_class("android/graphics/Bitmap").map_err(|e| {
            ScreenshotError::CaptureFailed(format!("Failed to find Bitmap class: {}", e))
        })?;

        let config_class = env
            .find_class("android/graphics/Bitmap$Config")
            .map_err(|e| {
                ScreenshotError::CaptureFailed(format!("Failed to find Config class: {}", e))
            })?;

        let config = env
            .get_static_field(
                config_class,
                "ARGB_8888",
                "Landroid/graphics/Bitmap$Config;",
            )
            .map_err(|e| {
                ScreenshotError::CaptureFailed(format!("Failed to get ARGB_8888: {}", e))
            })?;

        let bitmap = env
            .call_static_method(
                bitmap_class,
                "createBitmap",
                "(IILandroid/graphics/Bitmap$Config;)Landroid/graphics/Bitmap;",
                &[JValue::Int(width), JValue::Int(height), config],
            )
            .map_err(|e| ScreenshotError::CaptureFailed(format!("Failed to create bitmap: {}", e)))?
            .l()
            .map_err(|e| {
                ScreenshotError::CaptureFailed(format!("Failed to convert bitmap: {}", e))
            })?;

        // Create canvas and draw webview
        let canvas_class = env.find_class("android/graphics/Canvas").map_err(|e| {
            ScreenshotError::CaptureFailed(format!("Failed to find Canvas class: {}", e))
        })?;

        let canvas = env
            .new_object(
                canvas_class,
                "(Landroid/graphics/Bitmap;)V",
                &[JValue::Object(bitmap)],
            )
            .map_err(|e| {
                ScreenshotError::CaptureFailed(format!("Failed to create canvas: {}", e))
            })?;

        // Draw only the viewport (no scrolling)
        env.call_method(
            webview,
            "draw",
            "(Landroid/graphics/Canvas;)V",
            &[JValue::Object(canvas)],
        )
        .map_err(|e| ScreenshotError::CaptureFailed(format!("Failed to draw webview: {}", e)))?;

        // Compress to PNG
        let baos_class = env
            .find_class("java/io/ByteArrayOutputStream")
            .map_err(|e| {
                ScreenshotError::CaptureFailed(format!(
                    "Failed to find ByteArrayOutputStream: {}",
                    e
                ))
            })?;

        let output_stream = env.new_object(baos_class, "()V", &[]).map_err(|e| {
            ScreenshotError::CaptureFailed(format!("Failed to create output stream: {}", e))
        })?;

        let format_class = env
            .find_class("android/graphics/Bitmap$CompressFormat")
            .map_err(|e| {
                ScreenshotError::CaptureFailed(format!("Failed to find CompressFormat: {}", e))
            })?;

        let png_format = env
            .get_static_field(
                format_class,
                "PNG",
                "Landroid/graphics/Bitmap$CompressFormat;",
            )
            .map_err(|e| {
                ScreenshotError::CaptureFailed(format!("Failed to get PNG format: {}", e))
            })?;

        let success = env
            .call_method(
                bitmap,
                "compress",
                "(Landroid/graphics/Bitmap$CompressFormat;ILjava/io/OutputStream;)Z",
                &[png_format, JValue::Int(100), JValue::Object(output_stream)],
            )
            .map_err(|e| {
                ScreenshotError::CaptureFailed(format!("Failed to compress bitmap: {}", e))
            })?
            .z()
            .map_err(|e| {
                ScreenshotError::CaptureFailed(format!("Failed to convert compress result: {}", e))
            })?;

        if !success {
            return Err(ScreenshotError::EncodeFailed(
                "Failed to compress bitmap to PNG".to_string(),
            ));
        }

        // Get bytes
        let byte_array = env
            .call_method(output_stream, "toByteArray", "()[B", &[])
            .map_err(|e| {
                ScreenshotError::CaptureFailed(format!("Failed to get byte array: {}", e))
            })?
            .l()
            .map_err(|e| {
                ScreenshotError::CaptureFailed(format!("Failed to convert byte array: {}", e))
            })?;

        // Convert Java byte array to Rust Vec<u8>
        let byte_array = byte_array.into_inner() as jbyteArray;
        let length = env.get_array_length(byte_array).map_err(|e| {
            ScreenshotError::CaptureFailed(format!("Failed to get array length: {}", e))
        })? as usize;

        let mut buffer = vec![0i8; length];
        env.get_byte_array_region(byte_array, 0, &mut buffer[..])
            .map_err(|e| ScreenshotError::CaptureFailed(format!("Failed to copy bytes: {}", e)))?;

        // Convert from i8 to u8
        let buffer: Vec<u8> = buffer.iter().map(|&b| b as u8).collect();

        Ok(Screenshot { data: buffer })
    }
}

#[cfg(target_os = "android")]
fn find_webview_recursive(
    env: &jni::JNIEnv,
    view: jni::objects::JObject,
    webview_class: jni::objects::JClass,
) -> Result<jni::objects::JObject, ScreenshotError> {
    use jni::objects::{JObject, JValue};

    // Check if this view is a WebView
    let is_webview = env
        .is_instance_of(view, webview_class)
        .map_err(|e| ScreenshotError::CaptureFailed(format!("Failed to check instance: {}", e)))?;

    if is_webview {
        return Ok(view);
    }

    // If it's a ViewGroup, search children
    let viewgroup_class = env.find_class("android/view/ViewGroup").map_err(|e| {
        ScreenshotError::CaptureFailed(format!("Failed to find ViewGroup class: {}", e))
    })?;

    let is_viewgroup = env
        .is_instance_of(view, viewgroup_class)
        .map_err(|e| ScreenshotError::CaptureFailed(format!("Failed to check ViewGroup: {}", e)))?;

    if is_viewgroup {
        let child_count = env
            .call_method(view, "getChildCount", "()I", &[])
            .map_err(|e| {
                ScreenshotError::CaptureFailed(format!("Failed to get child count: {}", e))
            })?
            .i()
            .map_err(|e| {
                ScreenshotError::CaptureFailed(format!("Failed to convert count: {}", e))
            })?;

        for i in 0..child_count {
            let child = env
                .call_method(
                    view,
                    "getChildAt",
                    "(I)Landroid/view/View;",
                    &[JValue::Int(i)],
                )
                .map_err(|e| ScreenshotError::CaptureFailed(format!("Failed to get child: {}", e)))?
                .l()
                .map_err(|e| {
                    ScreenshotError::CaptureFailed(format!("Failed to convert child: {}", e))
                })?;

            if !child.is_null() {
                if let Ok(found) = find_webview_recursive(env, child, webview_class) {
                    if !found.is_null() {
                        return Ok(found);
                    }
                }
            }
        }
    }

    Ok(JObject::null())
}
