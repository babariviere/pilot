//! Unprivileged bounded capture/compiler helper. It never evaluates authored JavaScript.
#[cfg(unix)]
use std::io::{Read, Write};

#[path = "../artifact_source.rs"]
#[cfg(unix)]
mod artifact_source;

#[cfg(unix)]
fn main() {
    let mut bytes = Vec::new();
    let result = std::io::stdin()
        .take(4 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Artifact host input failed".to_owned())
        .and_then(|_| {
            if bytes.len() > 4 * 1024 * 1024 {
                return Err("Artifact host input exceeds limit".into());
            }
            let request = serde_json::from_slice(&bytes)
                .map_err(|_| "Invalid artifact host request".to_owned())?;
            artifact_source::handle(request)
        });
    let response = match result {
        Ok(value) => serde_json::json!({"value": value}),
        Err(error) => serde_json::json!({"error": error}),
    };
    if let Ok(bytes) = serde_json::to_vec(&response) {
        let _ = std::io::stdout().write_all(&bytes);
    }
}

#[cfg(not(unix))]
fn main() {
    println!("{{\"error\":\"Artifact source host is unsupported on this platform\"}}");
}
