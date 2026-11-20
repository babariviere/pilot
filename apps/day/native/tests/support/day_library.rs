//! Copies Day's component library (`ui/`) into a test's own copy of the app, with everything outside `ui/` that
//! the library imports (`../icons`, `../fonts`). The folders come from the library's own imports, so a new
//! asset folder is copied with no change here, and an import the copy still lacks fails with its name.
use std::path::Path;

/// Copies `app/ui` to `to/ui`, then each top-level folder or file of `app` that `ui/` imports from.
pub fn copy(app: &Path, to: &Path) {
    copy_dir(&app.join("ui"), &to.join("ui"));
    for import in outside_imports(&app.join("ui")) {
        let top = import.split('/').next().unwrap();
        let (from, into) = (app.join(top), to.join(top));
        if !into.exists() {
            if from.is_dir() {
                copy_dir(&from, &into);
            } else {
                std::fs::copy(&from, &into).unwrap();
            }
        }
        assert!(
            to.join(&import).is_file(),
            "ui/ imports \"../{import}\", which this test's copy of Day lacks (tests/support/day_library.rs)"
        );
    }
}

/// What `ui/`'s files import from outside `ui/`, relative to the app (`icons/check.svg`).
fn outside_imports(ui: &Path) -> Vec<String> {
    let mut found = Vec::new();
    for entry in std::fs::read_dir(ui).unwrap() {
        let path = entry.unwrap().path();
        if !path
            .extension()
            .is_some_and(|ext| ext == "ts" || ext == "tsx")
        {
            continue;
        }
        for line in std::fs::read_to_string(&path).unwrap().lines() {
            let line = line.trim();
            if !(line.starts_with("import ")
                || line.starts_with("} from ")
                || line.starts_with("export "))
            {
                continue;
            }
            if let Some(rest) = line.split("\"../").nth(1) {
                found.push(rest.split('"').next().unwrap().to_owned());
            }
        }
    }
    assert!(
        !found.is_empty(),
        "no import from outside ui/ found: the scan no longer reads the library"
    );
    found.sort();
    found.dedup();
    found
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap() {
        let path = entry.unwrap().path();
        let target = to.join(path.file_name().unwrap());
        if path.is_dir() {
            copy_dir(&path, &target);
        } else {
            std::fs::copy(&path, &target).unwrap();
        }
    }
}
