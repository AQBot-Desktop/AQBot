//! Simple port discovery for multiple Tauri instances.
//!
//! This module provides a lightweight mechanism for multiple Tauri apps
//! to coexist on the same machine by finding available ports dynamically.

/// Finds an available port for the WebSocket server.
///
/// # Arguments
///
/// * `bind_address` - The address to bind to (e.g., "0.0.0.0" or "127.0.0.1")
///
/// # Returns
///
/// An available port number in the range 9223-9322, or 9223 if none are available.
pub fn find_available_port(bind_address: &str) -> u16 {
    let base_port = 9223;
    let max_attempts = 100;

    for offset in 0..max_attempts {
        let port = base_port + offset;
        if is_port_available(bind_address, port) {
            return port;
        }
    }

    // If no ports in the range are available, use default
    // (The app will need to handle port conflicts)
    base_port
}

/// Checks if a port is available on the specified bind address.
fn is_port_available(bind_address: &str, port: u16) -> bool {
    use std::net::TcpListener;

    TcpListener::bind(format!("{bind_address}:{port}")).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_port_availability_all_interfaces() {
        let port = find_available_port("0.0.0.0");
        assert!(port >= 9223);
        assert!(port < 9323);
    }

    #[test]
    fn test_port_availability_localhost() {
        let port = find_available_port("127.0.0.1");
        assert!(port >= 9223);
        assert!(port < 9323);
    }
}
