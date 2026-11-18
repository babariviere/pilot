//! Copies one Day source into a test's own copy of the app. FeedbackScreen
//! imports one shared, Node-free leaf from the kernel by a path outside the
//! app; the copy moves it beside the sources so it builds on its own.
use std::path::Path;

const SHARED: &str = "../../packages/kernel/src/feedback-paths";

pub fn copy(source: &Path, to: &Path) {
    let text = std::fs::read_to_string(source).unwrap();
    if !text.contains(SHARED) {
        std::fs::copy(source, to).unwrap();
        return;
    }
    std::fs::write(to, text.replace(SHARED, "./feedback-paths")).unwrap();
    let leaf = source.parent().unwrap().join(format!("{SHARED}.ts"));
    std::fs::copy(leaf, to.parent().unwrap().join("feedback-paths.ts")).unwrap();
}
