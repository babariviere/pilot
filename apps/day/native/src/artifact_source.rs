//! Single saved-source preparation and the publish-time check, not a host-action capability.
use std::{
    ffi::CString,
    fs::File,
    io::Read,
    os::fd::{AsRawFd, FromRawFd},
    path::Path,
};

use oxc::{
    allocator::Allocator,
    ast::ast::*,
    ast_visit::{Visit, walk},
    parser::Parser,
    span::SourceType,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const SOURCE_BYTES: usize = 512 * 1024;
const OUTPUT_BYTES: usize = 2 * 1024 * 1024;
const KIT_EXPORTS: &[&str] = &[
    "BarChart",
    "BarSpec",
    "CHART_LIMITS",
    "EventState",
    "Timeline",
    "TimelineEvent",
    "TrendChart",
    "TrendSpec",
    "FlowDiagram",
    "SequenceDiagram",
    "FLOW_LIMITS",
    "FlowEdge",
    "FlowNode",
    "FlowSpec",
    "Tone",
    "SEQUENCE_LIMITS",
    "SequenceMessage",
    "SequenceNote",
    "SequenceParticipant",
    "SequenceSpec",
    "SequenceStep",
    "Card",
    "ChoiceOption",
    "Choices",
    "ComparisonRow",
    "ComparisonSpec",
    "ComparisonTable",
    "DataProblem",
    "Page",
    "Section",
    "Stat",
    "TABLE_LIMITS",
];
/// The modules an artifact may import from. Everything they export is allowed except \`REFUSED\`.
/// `pilot-day/ui` is Day's component library (`artifact_library`).
const MODULES: &[&str] = &[
    "nsh",
    "nsh/base",
    "nsh/base/plot",
    "pilot-day/ui",
    "pilot-artifact/ui",
];
/// Names an artifact may not import, and why. Each one reaches outside the preview: the host app, the
/// computer, the network, or Pilot's own window. The deny-all policy also stops the capabilities at run
/// time (\`artifact_runtime\`); this list says why before anything is published.
pub(crate) const REFUSED: &[(&str, &str, &str)] = &[
    ("nsh", "mount", "Pilot mounts the default export itself"),
    ("nsh", "host", "it calls the app that hosts the preview"),
    (
        "nsh",
        "nativeComponent",
        "it reaches native code outside the preview",
    ),
    (
        "nsh",
        "nativeModule",
        "it reaches native code outside the preview",
    ),
    (
        "nsh",
        "Clipboard",
        "it reads and writes the computer's clipboard",
    ),
    ("nsh", "Storage", "it saves data outside the preview"),
    (
        "nsh",
        "openUrl",
        "it opens links and apps outside the preview",
    ),
    ("nsh", "UrlScheme", "it receives links sent to the app"),
    ("nsh", "Notifications", "it sends system notifications"),
    (
        "nsh",
        "Picker",
        "it opens files and photos from the computer",
    ),
    ("nsh", "WebView", "it loads web pages from the network"),
    ("nsh", "Speech", "it uses the microphone"),
    ("nsh", "SpeechSession", "it uses the microphone"),
    ("nsh", "AudioPlayer", "it plays sound on the computer"),
    ("nsh", "Sound", "it plays sound on the computer"),
    (
        "nsh",
        "setColorScheme",
        "it changes the appearance of Pilot's window",
    ),
    ("nsh", "Shader", SHADER),
    ("nsh", "ShaderEffect", SHADER),
    ("nsh", "ShaderTransition", SHADER),
    ("nsh", "ScreenEffect", SHADER),
    ("nsh", "ScreenTransition", SHADER),
    ("nsh/base", "Link", "it opens links outside the preview"),
    ("nsh/base", "Terminal", "it runs programs on the computer"),
    (
        "nsh/base",
        "ColorEyeDropper",
        "it reads colors from the whole screen",
    ),
    (
        "nsh/base",
        "AlertDialog",
        "it opens a system alert over Pilot's window; use Dialog",
    ),
    (
        "pilot-artifact/ui",
        "mountArtifact",
        "Pilot mounts the default export itself",
    ),
];
const SHADER: &str = "Pilot cannot limit a shader's GPU time, and a shader can read what is drawn behind the preview";
/// Why other modules do not load.
fn module_refusal(module: &str) -> &'static str {
    match module {
        "nsh/desktop" => "it controls Pilot's windows, menus, tray and global shortcuts",
        "nsh/mobile" => "it is for phones; previews run on macOS",
        "nsh/updater" => "it updates the app",
        "nsh/test" => "it is for test files",
        "nsh/web" => "it is for web pages",
        "nsh/i18n" => "a preview has no translation files; write the text itself",
        "fs" | "fs/promises" => "it reads and writes files",
        "net" | "websocket" => "it opens network connections",
        "process" | "os" => "it reaches programs and the computer",
        "pilot-day/native" => "it is Pilot's own native bridge",
        m if m.starts_with("pilot-day/") => "import Pilot's parts from \"pilot-day/ui\"",
        _ => "a preview has no other packages or files",
    }
}

/// The exact source identity supplied by a saved canonical revision, never authored bytecode.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapturedSource {
    pub artifact_id: String,
    pub source_session_id: String,
    pub revision: u64,
    pub entry: String,
    pub source: String,
    pub source_sha256: String,
    pub source_bytes: usize,
}

/// Compilation is syntax/import preparation only. No runtime admission follows from success.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedSource {
    pub artifact_id: String,
    pub source_session_id: String,
    pub revision: u64,
    pub source_sha256: String,
    pub code: String,
    pub rendering: &'static str,
    pub reason: &'static str,
}

fn entry_ok(entry: &str) -> bool {
    entry.len() <= 132
        && entry.ends_with(".tsx")
        && entry
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && entry
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}

/// Checks the exact source identity: ids, revision, entry name, byte count and SHA-256.
///
/// # Errors
/// Returns an error when any field does not match the saved source bytes.
pub fn verify(input: &CapturedSource) -> Result<(), String> {
    if uuid::Uuid::parse_str(&input.artifact_id).is_err()
        || input.artifact_id.len() != 36
        || input.source_session_id.is_empty()
        || input.source_session_id.len() > 128
        || !input
            .source_session_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
        || input.revision == 0
        || input.revision > 9_007_199_254_740_991
        || !entry_ok(&input.entry)
        || input.source.len() > SOURCE_BYTES
        || input.source.trim().is_empty()
        || input.source.len() != input.source_bytes
        || input.source_sha256 != format!("{:x}", Sha256::digest(input.source.as_bytes()))
    {
        return Err("Invalid exact NSH source identity, bytes or digest".into());
    }
    Ok(())
}

/// No filesystem resolution, assets, user bytecode or dynamic import machinery is used here.
pub fn prepare(input: CapturedSource) -> Result<PreparedSource, String> {
    verify(&input)?;
    let code = compile_source(&input.source, &input.entry)?;
    Ok(PreparedSource {
        artifact_id: input.artifact_id,
        source_session_id: input.source_session_id,
        revision: input.revision,
        source_sha256: input.source_sha256,
        code,
        rendering: "unsupported",
        reason: "Native-memory bounds and preview fault containment are not qualified",
    })
}

/// Compile an exact in-memory source string. This neither resolves files nor evaluates code.
pub fn compile_source(source: &str, entry: &str) -> Result<String, String> {
    if !entry_ok(entry) || source.len() > SOURCE_BYTES || source.trim().is_empty() {
        return Err("Invalid NSH source entry or bytes".into());
    }
    check_imports(source)?;
    let sets: Vec<_> = nsh_base::registry()
        .sets()
        .into_iter()
        .map(nsh_core::element::description::SetDescription::from)
        .collect();
    let code = nsh_bundler::compile_module("Artifact.tsx", source, &sets)
        .map_err(|error| error.chars().take(4096).collect::<String>())?;
    if code.len() > OUTPUT_BYTES {
        return Err("Compiled NSH module exceeds limit".into());
    }
    Ok(code)
}

#[derive(Default)]
struct Imports {
    error: Option<String>,
    default_export: bool,
}
impl<'a> Visit<'a> for Imports {
    fn visit_import_declaration(&mut self, it: &ImportDeclaration<'a>) {
        if it.phase.is_some() || it.with_clause.is_some() {
            self.error = Some("Import attributes and phases are unsupported".into());
        }
        let module = it.source.value.as_str();
        if !MODULES.contains(&module) {
            self.error = Some(format!(
                "imports from {module:?} are refused: {}. Import from \"nsh\", \"nsh/base\", \"nsh/base/plot\", \"pilot-day/ui\" and \"pilot-artifact/ui\"",
                module_refusal(module)
            ));
            return;
        }
        let Some(specifiers) = &it.specifiers else {
            self.error = Some("Only named imports are supported".into());
            return;
        };
        for specifier in specifiers {
            let ImportDeclarationSpecifier::ImportSpecifier(specifier) = specifier else {
                self.error = Some("Default and namespace imports are unsupported".into());
                continue;
            };
            let name = match &specifier.imported {
                ModuleExportName::IdentifierName(name) => name.name.as_str(),
                _ => "",
            };
            // Types are erased before the module runs, so any type from an allowed module is fine.
            let type_only = it.import_kind.is_type() || specifier.import_kind.is_type();
            if type_only {
                continue;
            }
            if let Some((_, _, why)) = REFUSED.iter().find(|(m, n, _)| *m == module && *n == name) {
                self.error = Some(format!("{name} from {module:?} is refused: {why}"));
            } else if module == "pilot-artifact/ui" && !KIT_EXPORTS.contains(&name) {
                // NSH modules check their own names when compiling; the kit is linked later, so check it here.
                self.error = Some(format!("pilot-artifact/ui has no {name}"));
            } else if module == crate::artifact_library::MODULE
                && !crate::artifact_library::exports().has(name)
            {
                self.error = Some(format!("pilot-day/ui has no {name}"));
            }
        }
    }
    fn visit_import_expression(&mut self, _: &ImportExpression<'a>) {
        self.error = Some("Dynamic imports are unsupported".into());
    }
    fn visit_import_meta(&mut self, _: &ImportMeta) {
        self.error = Some("Import metadata is unsupported".into());
    }
    fn visit_export_all_declaration(&mut self, _: &ExportAllDeclaration<'a>) {
        self.error = Some("Module re-exports are unsupported".into());
    }
    fn visit_export_from_declaration(&mut self, _: &ExportFromDeclaration<'a>) {
        self.error = Some("Module re-exports are unsupported".into());
    }
    fn visit_ts_import_equals_declaration(&mut self, _: &TSImportEqualsDeclaration<'a>) {
        self.error = Some("Import aliases are unsupported".into());
    }
    fn visit_ts_import_type(&mut self, _: &TSImportType<'a>) {
        self.error = Some("Import types are unsupported".into());
    }
    fn visit_export_default_declaration(&mut self, it: &ExportDefaultDeclaration<'a>) {
        self.default_export = true;
        walk::walk_export_default_declaration(self, it);
    }
}
fn check_imports(source: &str) -> Result<(), String> {
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, source, SourceType::tsx()).parse();
    if let Some(error) = parsed.diagnostics.first() {
        let offset = error
            .labels
            .first()
            .map_or(0, |label| {
                usize::try_from(label.offset()).unwrap_or(source.len())
            })
            .min(source.len());
        let mut boundary = offset;
        while !source.is_char_boundary(boundary) {
            boundary -= 1;
        }
        let prefix = &source[..boundary];
        let line = prefix.bytes().filter(|b| *b == b'\n').count() + 1;
        let column = prefix
            .rsplit('\n')
            .next()
            .unwrap_or_default()
            .encode_utf16()
            .count()
            + 1;
        return Err(format!("Artifact.tsx:{line}:{column}: {}", error.message)
            .chars()
            .take(4096)
            .collect());
    }
    if parsed.fatal_error {
        return Err("Artifact.tsx:1:1: malformed TypeScript/TSX".into());
    }
    let mut imports = Imports::default();
    imports.visit_program(&parsed.program);
    if let Some(error) = imports.error {
        return Err(format!("Artifact.tsx: {error}"));
    }
    if !imports.default_export {
        return Err(
            "Artifact.tsx: export the component as default (export default function Artifact() {...}). Do not call mount"
                .into(),
        );
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
pub enum Request {
    #[serde(rename_all = "camelCase")]
    Ensure {
        session_directory: String,
    },
    #[serde(rename_all = "camelCase")]
    Capture {
        session_directory: String,
        entry: String,
    },
    Compile {
        source: String,
        entry: String,
    },
}

/// The helper's only operations. Capture also runs the entry once headless, as Day's preview
/// would (`artifact_check`), and refuses one that fails. Ensure and Compile never evaluate code.
pub fn handle(request: Request) -> Result<Value, String> {
    match request {
        Request::Compile { source, entry } => {
            compile_source(&source, &entry)?;
            Ok(Value::Null)
        }
        Request::Ensure { session_directory } => {
            directories(&session_directory, true)?;
            Ok(json!(null))
        }
        Request::Capture {
            session_directory,
            entry,
        } => {
            if !entry_ok(&entry) {
                return Err("Invalid NSH sourcePath basename".into());
            }
            let directory = directories(&session_directory, false)?;
            let mut file = open_at(&directory, &entry, false)?;
            let before = file.metadata().map_err(|_| "NSH source metadata failed")?;
            use std::os::unix::fs::MetadataExt;
            // SAFETY: geteuid has no arguments or memory preconditions.
            let uid = unsafe { libc::geteuid() };
            if !before.is_file()
                || before.nlink() != 1
                || before.uid() != uid
                || before.mode() & 0o022 != 0
            {
                return Err("Unsafe NSH source file".into());
            }
            if before.len() > SOURCE_BYTES as u64 {
                return Err("NSH source exceeds 512 KiB".into());
            }
            let mut bytes = Vec::new();
            (&mut file)
                .take(SOURCE_BYTES as u64 + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| "NSH source read failed")?;
            let after = file.metadata().map_err(|_| "NSH source metadata failed")?;
            if bytes.len() as u64 != before.len()
                || after.mtime() != before.mtime()
                || after.mtime_nsec() != before.mtime_nsec()
                || after.ctime() != before.ctime()
                || after.ctime_nsec() != before.ctime_nsec()
            {
                return Err("NSH source changed during capture".into());
            }
            let source = String::from_utf8(bytes).map_err(|_| "Invalid NSH source UTF-8")?;
            if source.trim().is_empty() {
                return Err("Empty NSH source".into());
            }
            let code = compile_source(&source, &entry)?;
            let rendered = crate::artifact_check::run(code)?;
            Ok(json!({"source": source, "rendered": rendered}))
        }
    }
}
fn directories(root: &str, create: bool) -> Result<File, String> {
    if !Path::new(root).is_absolute() || Path::new(root).components().count() < 2 {
        return Err("Invalid host session directory".into());
    }
    // Walk from the OS root so no intermediate symlink can redirect the host-selected root.
    // Do not resolve symlinks as a fallback. The host must supply its canonical session root.
    let mut directory = File::open("/").map_err(|_| "Session directory unavailable")?;
    for component in Path::new(root).components() {
        match component {
            std::path::Component::RootDir => {}
            std::path::Component::Normal(name) => {
                directory = open_at(
                    &directory,
                    name.to_str().ok_or("Invalid session directory")?,
                    true,
                )?;
            }
            _ => return Err("Invalid host session directory".into()),
        }
    }
    owned_directory(&directory)?;
    for name in ["scratch", "artifacts"] {
        if create {
            let name = CString::new(name).map_err(|_| "Invalid directory")?;
            // SAFETY: owned directory descriptor and fixed basename. EEXIST is checked by open_at below.
            unsafe {
                libc::mkdirat(directory.as_raw_fd(), name.as_ptr(), 0o700);
            }
        }
        directory = open_at(&directory, name, true)?;
        owned_directory(&directory)?;
    }
    Ok(directory)
}
fn owned_directory(directory: &File) -> Result<(), String> {
    use std::os::unix::fs::MetadataExt;
    let info = directory
        .metadata()
        .map_err(|_| "Session directory unavailable")?;
    // SAFETY: geteuid has no arguments or memory preconditions.
    if info.uid() != unsafe { libc::geteuid() } || info.mode() & 0o022 != 0 {
        return Err("Unsafe session directory ownership or permissions".into());
    }
    Ok(())
}
fn open_at(directory: &File, name: &str, is_directory: bool) -> Result<File, String> {
    let name = CString::new(name).map_err(|_| "Invalid source basename")?;
    let flags = libc::O_RDONLY
        | libc::O_NOFOLLOW
        | libc::O_CLOEXEC
        | libc::O_NONBLOCK
        | if is_directory { libc::O_DIRECTORY } else { 0 };
    // SAFETY: owned directory descriptor, NUL-terminated basename, no traversal or symlink following.
    let fd = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), flags) };
    if fd < 0 {
        return Err("NSH source path unavailable or unsafe".into());
    }
    // SAFETY: openat returned a fresh, owned descriptor.
    Ok(unsafe { File::from_raw_fd(fd) })
}

#[cfg(test)]
mod tests {
    use super::{REFUSED, compile_source};

    /// What NSH's compiler says of \`source\` without the artifact import rules.
    fn nsh_compiles(source: &str) -> Result<String, String> {
        let sets: Vec<_> = nsh_base::registry()
            .sets()
            .into_iter()
            .map(nsh_core::element::description::SetDescription::from)
            .collect();
        nsh_bundler::compile_module("Artifact.tsx", source, &sets)
    }

    #[test]
    fn every_refused_name_exists_and_says_why() {
        for (module, name, why) in REFUSED {
            let source = format!("import {{{name}}} from '{module}'; export default () => {name};");
            if *module != "pilot-artifact/ui" {
                nsh_compiles(&source)
                    .unwrap_or_else(|error| panic!("{module} {name} no longer exists: {error}"));
            }
            let error = compile_source(&source, "Artifact.tsx").unwrap_err();
            assert!(
                error.contains(&format!("{name} from {module:?} is refused: {why}")),
                "{error}"
            );
        }
        let missing = "import {NoSuchPart} from 'nsh/base'; export default () => NoSuchPart;";
        assert!(compile_source(missing, "Artifact.tsx").is_err());
    }

    #[test]
    fn components_hooks_animation_gestures_editors_and_charts_are_allowed() {
        for (module, names) in [
            (
                "nsh",
                "View, Text, Scroll, List, Canvas, Image, Video, Overlay, LayoutAnimation, Animated, createAnimatedValue, createMotion, Easing, motions, PanResponder, keymap, Keyboard, lifecycle, resource, split, setTheme, announce, appInfo, platform, safeArea, shadersAvailable, registerFont",
            ),
            (
                "nsh/base",
                "Button, Dialog, Sheet, Editor, RichEditor, createRichEditor, starterKit, TextView, DiffView, DockArea, EmojiPicker, DataTable, Tree, Toast, ResizablePanelGroup",
            ),
            (
                "nsh/base/plot",
                "Plot, Line, Bar, Area, Pie, Sankey, Treemap, PlotAxis",
            ),
        ] {
            let source =
                format!("import {{{names}}} from '{module}'; export default () => [{names}];");
            compile_source(&source, "Artifact.tsx")
                .unwrap_or_else(|error| panic!("{module}: {error}"));
        }
        let typed =
            "import type {SpeechSession} from 'nsh'; export default (s: SpeechSession) => null;";
        assert!(
            compile_source(typed, "Artifact.tsx").is_ok(),
            "types are erased"
        );
        for (module, why) in [
            ("nsh/desktop", "it controls Pilot's windows"),
            ("fs/promises", "it reads and writes files"),
            ("react", "a preview has no other packages or files"),
        ] {
            let error = compile_source(
                &format!("import {{x}} from '{module}'; export default () => x;"),
                "Artifact.tsx",
            )
            .unwrap_err();
            assert!(
                error.contains(&format!("imports from {module:?} are refused: {why}")),
                "{error}"
            );
        }
    }
}
