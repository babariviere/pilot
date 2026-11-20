//! Copies Day sources and assets into a private app root. Callers write their
//! own nsh.json so a fixture never inherits another app's grants.
use std::{fs, io, path::Path};

#[path = "day_library.rs"]
mod day_library;

const FEATURES: &[&str] = &[
    "app",
    "artifacts",
    "changes",
    "feedback",
    "insights",
    "missions",
    "screen-agent",
    "search",
    "sessions",
    "settings",
    "sources",
    "today",
    "updates",
];

pub fn copy(app: &Path, to: &Path) -> io::Result<()> {
    let shared = app
        .join("../../packages/kernel/src/diagnostics/feedback-paths.ts")
        .canonicalize()?;
    copy_sources(app, to, &shared, false)?;
    for feature in FEATURES {
        copy_sources(&app.join(feature), &to.join(feature), &shared, true)?;
    }
    fs::copy(app.join("theme.json"), to.join("theme.json"))?;
    day_library::copy(app, to);
    Ok(())
}

fn copy_sources(from: &Path, to: &Path, shared: &Path, recurse: bool) -> io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let target = to.join(entry.file_name());
        let source = entry.path();
        if kind.is_dir() && recurse {
            copy_sources(&source, &target, shared, true)?;
        } else if kind.is_file() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if (name.ends_with(".ts") || name.ends_with(".tsx"))
                && !(name.ends_with(".test.ts") || name.ends_with(".test.tsx"))
            {
                copy_source(&source, &target, shared)?;
            }
        }
    }
    Ok(())
}

fn copy_source(source: &Path, to: &Path, shared: &Path) -> io::Result<()> {
    let text = fs::read_to_string(source)?;
    let mut copied = text.clone();
    // Feedback's Node-free helper is the only shared source copied from
    // outside Day. Resolve each import from the original file, not from Rust
    // or from the root of the copied app.
    for specifier in text
        .split(['"', '\''])
        .filter(|part| part.starts_with("../"))
    {
        let name = Path::new(specifier)
            .file_name()
            .and_then(|name| name.to_str());
        if !matches!(name, Some("feedback-paths" | "feedback-paths.ts")) {
            continue;
        }
        let resolved = source
            .parent()
            .unwrap()
            .join(specifier)
            .with_extension("ts");
        if resolved.canonicalize().as_deref().ok() == Some(shared) {
            fs::copy(shared, to.with_file_name("feedback-paths.ts"))?;
            copied = copied.replace(specifier, "./feedback-paths");
        }
    }
    fs::write(to, copied)
}
