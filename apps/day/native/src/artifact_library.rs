//! Pilot Day's component library (`apps/day/ui`), embedded as it is for NSH
//! artifacts. Its files become trusted chunks `pilot-day/ui/<file>`; its icons
//! and fonts become small chunks of their own (`pilot-day/icons/<name>.svg`,
//! `pilot-day/fonts/<file>.ttf`), because a preview has no asset reader. An
//! artifact imports the library from `pilot-day/ui`, a facade that re-exports
//! [`Exports::values`] only. Nothing here reads a path at run time: the bytes
//! are compiled into the binary.
use std::{collections::BTreeSet, sync::OnceLock};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use oxc::{
    allocator::Allocator,
    ast::ast::{Declaration, ExportSpecifier, Statement},
    parser::Parser,
    span::SourceType,
};

macro_rules! day {
    ($path:literal) => {
        include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../", $path))
    };
}

/// The library's files: name, extension and source. A test keeps this list
/// equal to `apps/day/ui`.
pub const FILES: &[(&str, &str, &str)] = &[
    ("agent", "ts", day!("ui/agent.ts")),
    ("button", "tsx", day!("ui/button.tsx")),
    ("chat", "tsx", day!("ui/chat.tsx")),
    ("choice", "tsx", day!("ui/choice.tsx")),
    ("data", "tsx", day!("ui/data.tsx")),
    ("diff", "tsx", day!("ui/diff.tsx")),
    ("disclosure", "tsx", day!("ui/disclosure.tsx")),
    ("field", "tsx", day!("ui/field.tsx")),
    ("fonts", "ts", day!("ui/fonts.ts")),
    ("icon", "tsx", day!("ui/icon.tsx")),
    ("index", "ts", day!("ui/index.ts")),
    ("keys", "tsx", day!("ui/keys.tsx")),
    ("layout", "tsx", day!("ui/layout.tsx")),
    ("markdown", "tsx", day!("ui/markdown.tsx")),
    ("motion", "tsx", day!("ui/motion.tsx")),
    ("notice", "tsx", day!("ui/notice.tsx")),
    ("panel", "tsx", day!("ui/panel.tsx")),
    ("path", "tsx", day!("ui/path.tsx")),
    ("picker", "tsx", day!("ui/picker.tsx")),
    ("question", "tsx", day!("ui/question.tsx")),
    ("quiet", "tsx", day!("ui/quiet.tsx")),
    ("section", "tsx", day!("ui/section.tsx")),
    ("state", "tsx", day!("ui/state.tsx")),
    ("tabs", "tsx", day!("ui/tabs.tsx")),
    ("text", "tsx", day!("ui/text.tsx")),
];

/// The icons the library imports (`../icons/<name>.svg`).
pub const ICONS: &[(&str, &str)] = &[
    ("archive", day!("icons/archive.svg")),
    ("back", day!("icons/back.svg")),
    ("changes", day!("icons/changes.svg")),
    ("chat", day!("icons/chat.svg")),
    ("check", day!("icons/check.svg")),
    ("chevron", day!("icons/chevron.svg")),
    ("document", day!("icons/document.svg")),
    ("fullscreen-exit", day!("icons/fullscreen-exit.svg")),
    ("fullscreen", day!("icons/fullscreen.svg")),
    ("mark-check", day!("icons/mark-check.svg")),
    ("mark-ready", day!("icons/mark-ready.svg")),
    ("moon", day!("icons/moon.svg")),
    ("more", day!("icons/more.svg")),
    ("notes", day!("icons/notes.svg")),
    ("pause", day!("icons/pause.svg")),
    ("play", day!("icons/play.svg")),
    ("plus", day!("icons/plus.svg")),
    ("pointer", day!("icons/pointer.svg")),
    ("refresh", day!("icons/refresh.svg")),
    ("rename", day!("icons/rename.svg")),
    ("right", day!("icons/right.svg")),
    ("search", day!("icons/search.svg")),
    ("settings", day!("icons/settings.svg")),
    ("share", day!("icons/share.svg")),
    ("sun", day!("icons/sun.svg")),
    ("update", day!("icons/update.svg")),
];

/// The font files `ui/fonts.ts` imports and the family each registers.
/// A preview cannot register fonts: it names the family, which Day's own
/// window registered for the whole process when it imported the same files.
pub const FONTS: &[(&str, &str)] = &[
    ("Geist-Regular.ttf", "Geist"),
    ("Geist-Medium.ttf", "Geist"),
    ("Geist-SemiBold.ttf", "Geist"),
    ("Geist-Bold.ttf", "Geist"),
    ("GeistMono-Regular.ttf", "Geist Mono"),
    ("GeistMono-Medium.ttf", "Geist Mono"),
    ("GeistMono-SemiBold.ttf", "Geist Mono"),
];

/// Day's theme (`apps/day/theme.json`). Previews start with it, so token
/// classes and fonts resolve as in the app.
pub const THEME: &str = day!("theme.json");

/// The specifier artifacts import the library from.
pub const MODULE: &str = "pilot-day/ui";

/// What `agent.ts` gives artifacts: a control's registration, which every
/// interactive part calls. Its other functions read and drive the screen
/// agent's registry (`snapshot`, `query`, `act` and the like) and stay out.
const AGENT_VALUES: &[&str] = &["useAgent", "AgentScope"];

/// The names `pilot-day/ui` exports: what `ui/index.ts` exports, without the
/// screen agent's registry functions.
#[derive(Debug, Default)]
pub struct Exports {
    /// Components, functions and constants: the facade re-exports these.
    pub values: BTreeSet<String>,
    /// Types, erased before the module runs.
    pub types: BTreeSet<String>,
}

impl Exports {
    /// Whether an artifact may import `name` from `pilot-day/ui`.
    pub fn has(&self, name: &str) -> bool {
        self.values.contains(name) || self.types.contains(name)
    }
}

/// The library's exports, read once from the embedded sources.
///
/// # Panics
/// When an embedded file does not parse or `index.ts` re-exports something
/// other than a library file. Tests run this on every build.
pub fn exports() -> &'static Exports {
    static EXPORTS: OnceLock<Exports> = OnceLock::new();
    EXPORTS.get_or_init(|| {
        let mut exports = Exports::default();
        add_exports("index", &mut exports).unwrap_or_else(|error| panic!("{error}"));
        exports
    })
}

fn source(name: &str) -> Result<(&'static str, &'static str), String> {
    FILES
        .iter()
        .find(|(file, _, _)| *file == name)
        .map(|(_, extension, source)| (*extension, *source))
        .ok_or_else(|| format!("ui/{name} is not embedded"))
}

/// Adds what `ui/<name>` exports, following `export * from "./<file>"`.
fn add_exports(name: &str, exports: &mut Exports) -> Result<(), String> {
    let (extension, text) = source(name)?;
    let allocator = Allocator::default();
    let path = format!("{name}.{extension}");
    let source_type = SourceType::from_path(&path).map_err(|error| error.to_string())?;
    let parsed = Parser::new(&allocator, text, source_type).parse();
    if !parsed.diagnostics.is_empty() {
        return Err(format!("ui/{path} does not parse"));
    }
    for statement in &parsed.program.body {
        match statement {
            Statement::ExportAllDeclaration(all) => {
                let from = all.source.value.as_str();
                let file = from
                    .strip_prefix("./")
                    .ok_or_else(|| format!("ui/{path} re-exports {from:?}"))?;
                if let Some(exported) = &all.exported {
                    exports.values.insert(exported.name().to_string());
                } else if file == "agent" {
                    let mut agent = Exports::default();
                    add_exports(file, &mut agent)?;
                    exports.types.append(&mut agent.types);
                    exports.values.extend(
                        agent
                            .values
                            .into_iter()
                            .filter(|value| AGENT_VALUES.contains(&value.as_str())),
                    );
                } else {
                    add_exports(file, exports)?;
                }
            }
            Statement::ExportNamedDeclaration(named) => {
                add_specifiers(&named.specifiers, named.export_kind.is_type(), exports);
            }
            Statement::ExportFromDeclaration(from) => {
                add_specifiers(&from.specifiers, from.export_kind.is_type(), exports);
            }
            Statement::ExportDeclaration(export) => match &export.declaration {
                Declaration::VariableDeclaration(variables) => {
                    for declarator in &variables.declarations {
                        for id in declarator.id.get_binding_identifiers() {
                            exports.values.insert(id.name.to_string());
                        }
                    }
                }
                Declaration::FunctionDeclaration(function) => {
                    exports
                        .values
                        .extend(function.id.as_ref().map(|id| id.name.to_string()));
                }
                Declaration::ClassDeclaration(class) => {
                    exports
                        .values
                        .extend(class.id.as_ref().map(|id| id.name.to_string()));
                }
                Declaration::TSEnumDeclaration(declaration) => {
                    exports.values.insert(declaration.id.name.to_string());
                }
                Declaration::TSTypeAliasDeclaration(declaration) => {
                    exports.types.insert(declaration.id.name.to_string());
                }
                Declaration::TSInterfaceDeclaration(declaration) => {
                    exports.types.insert(declaration.id.name.to_string());
                }
                _ => return Err(format!("ui/{path} exports a declaration Pilot cannot read")),
            },
            Statement::ExportDefaultDeclaration(_) => {
                return Err(format!(
                    "ui/{path} has a default export; the library exports names"
                ));
            }
            _ => {}
        }
    }
    Ok(())
}

fn add_specifiers(specifiers: &[ExportSpecifier<'_>], type_only: bool, exports: &mut Exports) {
    for specifier in specifiers {
        let set = if type_only || specifier.export_kind.is_type() {
            &mut exports.types
        } else {
            &mut exports.values
        };
        set.insert(specifier.exported.name().to_string());
    }
}

/// The library's chunks, by id: each file compiled, each icon as an image
/// (a `data:` URL and its size in points), each font as its family name, and
/// the `pilot-day/ui` facade.
///
/// # Errors
/// Returns a compile error of an embedded file or an icon that is no SVG.
pub fn chunks(
    sets: &[nsh_core::element::description::SetDescription],
) -> Result<Vec<(String, String)>, String> {
    let mut chunks = Vec::with_capacity(FILES.len() + ICONS.len() + FONTS.len() + 1);
    for (name, extension, source) in FILES {
        let id = format!("{MODULE}/{name}");
        let code = nsh_bundler::compile_module(&format!("{id}.{extension}"), source, sets)?;
        chunks.push((id, code));
    }
    for (name, svg) in ICONS {
        let size = nsh_core::svg::size(svg.as_bytes())
            .map_err(|error| format!("icons/{name}.svg: {error}"))?;
        let url = format!("data:image/svg+xml;base64,{}", STANDARD.encode(svg));
        chunks.push((
            format!("pilot-day/icons/{name}.svg"),
            format!(
                "export default {{url: {url:?}, size: {{width: {}, height: {}}}}};",
                size.width.0, size.height.0
            ),
        ));
    }
    for (file, family) in FONTS {
        chunks.push((
            format!("pilot-day/fonts/{file}"),
            format!("export default {family:?};"),
        ));
    }
    let names: Vec<&str> = exports().values.iter().map(String::as_str).collect();
    chunks.push((
        MODULE.to_owned(),
        format!("export {{{}}} from '{MODULE}/index';", names.join(", ")),
    ));
    Ok(chunks)
}

#[cfg(test)]
mod tests {
    use std::{collections::BTreeSet, path::Path};

    use oxc::{
        allocator::Allocator,
        ast::ast::{ImportDeclarationSpecifier, Statement},
        parser::Parser,
        span::SourceType,
    };

    use super::{AGENT_VALUES, FILES, FONTS, ICONS, exports};

    fn day() -> &'static Path {
        Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/.."))
    }

    fn listed(directory: &str, keep: impl Fn(&str) -> bool) -> BTreeSet<String> {
        std::fs::read_dir(day().join(directory))
            .expect("Day directory")
            .map(|entry| {
                entry
                    .expect("entry")
                    .file_name()
                    .to_string_lossy()
                    .into_owned()
            })
            .filter(|name| keep(name))
            .collect()
    }

    #[test]
    fn the_embedded_files_are_the_library_its_icons_and_its_fonts() {
        assert_eq!(
            FILES
                .iter()
                .map(|(name, extension, _)| format!("{name}.{extension}"))
                .collect::<BTreeSet<_>>(),
            listed("ui", |name| name.ends_with(".ts") || name.ends_with(".tsx")),
            "embed every file of apps/day/ui in artifact_library::FILES"
        );
        assert_eq!(
            ICONS
                .iter()
                .map(|(name, _)| format!("{name}.svg"))
                .collect::<BTreeSet<_>>(),
            listed("icons", |name| name.ends_with(".svg")),
            "embed every icon of apps/day/icons in artifact_library::ICONS"
        );
        assert_eq!(
            FONTS
                .iter()
                .map(|(file, _)| (*file).to_owned())
                .collect::<BTreeSet<_>>(),
            listed("fonts", |name| name.ends_with(".ttf")),
        );
        for (file, family) in FONTS {
            let data = std::fs::read(day().join("fonts").join(file)).expect("font file");
            assert_eq!(
                nsh_core::font_family(&data).as_deref(),
                Ok(*family),
                "{file}"
            );
        }
    }

    /// Every import of a library file: its module and the names it takes.
    fn imports(name: &str, extension: &str, source: &str) -> Vec<(String, Vec<String>)> {
        let allocator = Allocator::default();
        let path = format!("{name}.{extension}");
        let parsed = Parser::new(
            &allocator,
            source,
            SourceType::from_path(&path).expect("source type"),
        )
        .parse();
        assert!(parsed.diagnostics.is_empty(), "ui/{path} parses");
        let mut found = Vec::new();
        for statement in &parsed.program.body {
            match statement {
                Statement::ImportDeclaration(import) => {
                    let names = import
                        .specifiers
                        .iter()
                        .flatten()
                        .map(|specifier| match specifier {
                            ImportDeclarationSpecifier::ImportSpecifier(s) => {
                                s.imported.name().to_string()
                            }
                            other => other.name().to_string(),
                        })
                        .collect();
                    found.push((import.source.value.to_string(), names));
                }
                Statement::ExportAllDeclaration(all) => {
                    found.push((all.source.value.to_string(), Vec::new()));
                }
                Statement::ExportFromDeclaration(from) => {
                    found.push((from.source.value.to_string(), Vec::new()));
                }
                _ => {}
            }
        }
        assert!(
            !source.contains("import(") && !source.contains("import.meta"),
            "ui/{path} loads modules dynamically"
        );
        found
    }

    #[test]
    fn the_library_reaches_only_nsh_its_own_files_icons_and_fonts() {
        let own: BTreeSet<String> = FILES
            .iter()
            .map(|(name, _, _)| format!("./{name}"))
            .collect();
        let icons: BTreeSet<String> = ICONS
            .iter()
            .map(|(name, _)| format!("../icons/{name}.svg"))
            .collect();
        let fonts: BTreeSet<String> = FONTS
            .iter()
            .map(|(file, _)| format!("../fonts/{file}"))
            .collect();
        let mut used_icons = BTreeSet::new();
        for (name, extension, source) in FILES {
            for (module, names) in imports(name, extension, source) {
                if icons.contains(&module) {
                    used_icons.insert(module);
                    continue;
                }
                assert!(
                    ["nsh", "nsh/base", "nsh/base/plot"].contains(&module.as_str())
                        || own.contains(&module)
                        || fonts.contains(&module),
                    "ui/{name}.{extension} imports {module:?}: the library reaches only nsh, nsh/base, nsh/base/plot, its own files, ../icons and ../fonts"
                );
                for imported in names {
                    assert!(
                        !crate::artifact_source::REFUSED
                            .iter()
                            .any(|(m, n, _)| *m == module && *n == imported),
                        "ui/{name}.{extension} imports {imported} from {module:?}, which artifacts may not reach"
                    );
                }
            }
        }
        assert!(!used_icons.is_empty());
    }

    /// The names a file exports, read from its lines: a check of the parser in `exports`.
    fn exported_lines(source: &str) -> (BTreeSet<String>, BTreeSet<String>) {
        let word = |rest: &str| -> String {
            rest.chars()
                .take_while(|c| c.is_alphanumeric() || *c == '_')
                .collect()
        };
        let (mut values, mut types) = (BTreeSet::new(), BTreeSet::new());
        for line in source.lines() {
            let Some(rest) = line.strip_prefix("export ") else {
                continue;
            };
            let rest = rest.strip_prefix("async ").unwrap_or(rest);
            if let Some(list) = rest.strip_prefix("type {") {
                types.extend(
                    list.split('}')
                        .next()
                        .unwrap_or_default()
                        .split(',')
                        .map(|name| name.trim().to_owned()),
                );
            } else if let Some(name) = ["type ", "interface "]
                .iter()
                .find_map(|prefix| rest.strip_prefix(prefix))
            {
                types.insert(word(name));
            } else if let Some(name) = ["function ", "const ", "class "]
                .iter()
                .find_map(|prefix| rest.strip_prefix(prefix))
            {
                values.insert(word(name));
            } else if !rest.starts_with("* from") {
                panic!("an export this check does not read: {line}");
            }
        }
        (values, types)
    }

    #[test]
    fn pilot_day_ui_exports_the_index_without_the_agent_registry() {
        let index = FILES
            .iter()
            .find(|(name, _, _)| *name == "index")
            .expect("index")
            .2;
        let (mut values, mut types) = (BTreeSet::new(), BTreeSet::new());
        let mut files = 0;
        for line in index.lines() {
            let Some(file) = line
                .strip_prefix("export * from \"./")
                .and_then(|rest| rest.strip_suffix("\";"))
            else {
                continue;
            };
            files += 1;
            let source = FILES
                .iter()
                .find(|(name, _, _)| *name == file)
                .expect("re-exported file")
                .2;
            let (file_values, file_types) = exported_lines(source);
            types.extend(file_types);
            values.extend(
                file_values
                    .into_iter()
                    .filter(|value| file != "agent" || AGENT_VALUES.contains(&value.as_str())),
            );
        }
        assert!(files >= 20, "index.ts re-exports the library's files");
        assert_eq!(exports().values, values);
        assert_eq!(exports().types, types);
        for name in [
            "Page",
            "PageHead",
            "Panel",
            "Tabs",
            "Tab",
            "Section",
            "Row",
            "Rows",
            "Button",
            "Icon",
            "Notice",
            "Question",
            "useAgent",
            "AgentScope",
        ] {
            assert!(exports().values.contains(name), "{name}");
        }
        for registry in [
            "snapshot",
            "query",
            "act",
            "glance",
            "setScreenHeader",
            "noteBlockedWrite",
            "setBusyProbe",
            "agentActing",
            "frameOf",
            "controlFrames",
            "controlAt",
            "onActed",
        ] {
            assert!(
                !exports().has(registry),
                "{registry} reaches the screen agent's registry"
            );
        }
    }

    #[test]
    fn every_icon_and_font_the_library_imports_has_a_chunk() {
        let sets: Vec<_> = nsh_base::registry()
            .sets()
            .into_iter()
            .map(nsh_core::element::description::SetDescription::from)
            .collect();
        let chunks = super::chunks(&sets).expect("the library compiles");
        for (name, extension, source) in FILES {
            for (module, _) in imports(name, extension, source) {
                let Some(id) = module
                    .strip_prefix("../")
                    .map(|asset| format!("pilot-day/{asset}"))
                    .or_else(|| {
                        module
                            .strip_prefix("./")
                            .map(|file| format!("pilot-day/ui/{file}"))
                    })
                else {
                    continue;
                };
                assert!(
                    chunks.iter().any(|(chunk, _)| *chunk == id),
                    "ui/{name}.{extension} imports {module}, which has no chunk"
                );
            }
        }
        for (name, svg) in ICONS {
            use base64::Engine as _;
            let (_, code) = chunks
                .iter()
                .find(|(id, _)| *id == format!("pilot-day/icons/{name}.svg"))
                .expect("icon chunk");
            let url = code
                .split('"')
                .nth(1)
                .and_then(|url| url.strip_prefix("data:image/svg+xml;base64,"))
                .expect("a data URL");
            let decoded = base64::engine::general_purpose::STANDARD
                .decode(url)
                .expect("base64");
            assert_eq!(decoded, svg.as_bytes(), "{name}");
            let size = nsh_core::svg::size(svg.as_bytes()).expect("an SVG");
            assert!(size.width.0 >= 14.0 && size.height.0 >= 14.0, "{name}");
            assert!(
                code.ends_with(&format!(
                    "size: {{width: {}, height: {}}}}};",
                    size.width.0, size.height.0
                )),
                "{name}: {code}"
            );
        }
    }
}
