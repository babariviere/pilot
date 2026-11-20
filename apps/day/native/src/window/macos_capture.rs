//! Pre-disposal capture through public AppKit editors, not NSH internals.
//! No view is stopped here. A failed capture keeps the old engine alive.

use nsh_platform_macos::{
    objc2::{MainThreadMarker, rc::Retained},
    objc2_app_kit::{NSResponder, NSTextField, NSTextInputClient, NSTextView, NSView, NSWindow},
    objc2_foundation::NSRange,
};

use crate::host::Error;

const MAX_VIEWS: usize = 16_384;
const MAX_EDITORS: usize = 512;
const MAX_TEXT_BYTES: usize = 8 * 1024 * 1024;

enum Editor {
    Field(Retained<NSTextField>),
    Area(Retained<NSTextView>),
}

impl Editor {
    fn view(&self) -> &NSView {
        match self {
            Self::Field(v) => v,
            Self::Area(v) => v,
        }
    }
    fn editable(&self) -> bool {
        match self {
            Self::Field(v) => v.isEditable(),
            Self::Area(v) => v.isEditable(),
        }
    }
    fn set_editable(&self, value: bool) {
        match self {
            Self::Field(v) => v.setEditable(value),
            Self::Area(v) => v.setEditable(value),
        }
    }
    fn text(&self, window: &NSWindow) -> String {
        match self {
            Self::Field(v) => v
                .currentEditor()
                .filter(|editor| {
                    window
                        .firstResponder()
                        .is_some_and(|r| std::ptr::eq(&*r, &**editor as &NSResponder))
                })
                .map_or_else(
                    || v.stringValue().to_string(),
                    |editor| editor.string().to_string(),
                ),
            Self::Area(v) => v.string().to_string(),
        }
    }
    fn editing(&self, window: &NSWindow) -> Option<Retained<NSTextView>> {
        match self {
            Self::Field(v) => v
                .currentEditor()
                .filter(|editor| {
                    window
                        .firstResponder()
                        .is_some_and(|r| std::ptr::eq(&*r, &**editor as &NSResponder))
                })
                .and_then(|e| e.downcast::<NSTextView>().ok()),
            Self::Area(v) => Some(v.clone()),
        }
    }
}

fn editors(root: &NSView) -> Result<Vec<Editor>, Error> {
    let mut pending: Vec<Retained<NSView>> = vec![Retained::from(root)];
    let mut count = 0;
    let mut result = Vec::new();
    while let Some(view) = pending.pop() {
        if crate::macos_artifact::is_preview(&view) {
            continue;
        }
        count += 1;
        if count > MAX_VIEWS {
            return Err(Error::Capacity);
        }
        if let Some(field) = view.downcast_ref::<NSTextField>() {
            if field.isEditable() {
                result.push(Editor::Field(Retained::from(field)));
            }
        } else if let Some(area) = view.downcast_ref::<NSTextView>() {
            if area.isEditable() && !area.isFieldEditor() {
                result.push(Editor::Area(Retained::from(area)));
            }
        }
        if result.len() > MAX_EDITORS {
            return Err(Error::Capacity);
        }
        pending.extend(view.subviews());
    }
    Ok(result)
}

struct SavedEditor {
    editor: Editor,
    text: String,
    selection: Option<NSRange>,
}

/// Holds the exact attached input inventory frozen through the all-form barrier.
/// The embedding window must also fence its own menu/navigation/close commands.
/// Drop restores editing, but never acknowledges, stops or closes an engine.
pub(super) struct Capture {
    root: Retained<NSView>,
    window: Retained<NSWindow>,
    focus: Option<usize>,
    saved: Vec<SavedEditor>,
    stopped: bool,
}

impl Capture {
    pub fn begin(root: Retained<NSView>, _main: MainThreadMarker) -> Result<Self, Error> {
        let window = root.window().ok_or(Error::Unavailable)?;
        let bounds = root.bounds();
        if bounds.size.width <= 0.0 || bounds.size.height <= 0.0 {
            return Err(Error::Unavailable);
        }
        let mut total: usize = 0;
        let saved = editors(&root)?
            .into_iter()
            .map(|editor| {
                let text = editor.text(&window);
                total = total.checked_add(text.len()).ok_or(Error::Capacity)?;
                if total > MAX_TEXT_BYTES {
                    return Err(Error::Capacity);
                }
                let selection = editor.editing(&window).map(|e| e.selectedRange());
                Ok(SavedEditor {
                    editor,
                    text,
                    selection,
                })
            })
            .collect::<Result<Vec<_>, Error>>()?;
        let focus = window.firstResponder().and_then(|r| {
            saved.iter().position(|s| {
                std::ptr::eq(&*r, s.editor.view() as &NSResponder)
                    || s.editor
                        .editing(&window)
                        .is_some_and(|e| std::ptr::eq(&*r, &*e as &NSResponder))
            })
        });
        let capture = Self {
            root,
            window,
            focus,
            saved,
            stopped: false,
        };
        for saved in &capture.saved {
            if let Some(editor) = saved.editor.editing(&capture.window) {
                // Marking text does not necessarily emit ChangeText. Report the
                // exact string BEFORE unmark, so an older queued JS value cannot
                // replace it when NSH ends composition. These public AppKit calls
                // enter NSH's ordinary edit-count/delegate/input event path.
                editor.didChangeText();
                editor.unmarkText();
            }
            saved.editor.set_editable(false);
        }
        if capture.focus.is_some() && !capture.window.makeFirstResponder(None) {
            return Err(Error::Busy);
        }
        capture.check()?;
        Ok(capture)
    }

    pub fn check(&self) -> Result<(), Error> {
        if self
            .root
            .window()
            .is_none_or(|w| !std::ptr::eq(&*w, &*self.window))
        {
            return Err(Error::Stale);
        }
        for saved in &self.saved {
            if !saved.editor.view().isDescendantOf(&self.root)
                || saved.editor.editable()
                || saved.editor.text(&self.window) != saved.text
            {
                return Err(Error::Stale);
            }
        }
        // A remount/new editable form during the barrier is not captured.
        if !editors(&self.root)?.is_empty() {
            return Err(Error::Stale);
        }
        Ok(())
    }

    pub fn engine_stopped(&mut self) {
        self.stopped = true;
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        if self.stopped {
            return;
        }
        for saved in &self.saved {
            if saved.editor.view().isDescendantOf(&self.root) {
                saved.editor.set_editable(true);
            }
        }
        if let Some(index) = self.focus {
            let saved = &self.saved[index];
            if saved.editor.view().isDescendantOf(&self.root) {
                self.window.makeFirstResponder(Some(saved.editor.view()));
                if let (Some(editor), Some(selection)) =
                    (saved.editor.editing(&self.window), saved.selection)
                {
                    if selection
                        .location
                        .checked_add(selection.length)
                        .is_some_and(|end| end <= editor.string().length())
                    {
                        editor.setSelectedRange(selection);
                    }
                }
            }
        }
    }
}
