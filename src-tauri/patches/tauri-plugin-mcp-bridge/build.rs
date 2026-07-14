fn main() {
    tauri_plugin::Builder::new(&[
        "execute_command",
        "get_window_info",
        "get_backend_state",
        "emit_event",
        "start_ipc_monitor",
        "stop_ipc_monitor",
        "get_ipc_events",
    ])
    .build();
}
