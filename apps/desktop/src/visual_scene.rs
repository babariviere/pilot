//! Closed API-1 validation in the host, independently of the sandbox and runtime.
use serde_json::{Map, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};
type Bad = &'static str;
const COLORS: &[&str] = &[
    "text", "muted", "accent", "success", "warning", "danger", "border", "chart1", "chart2",
    "chart3", "chart4", "chart5", "chart6",
];
/// Literal `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa` as RGBA bytes.
pub(crate) fn hex(value: &str) -> Option<[u8; 4]> {
    let digits = value.strip_prefix('#')?;
    if !matches!(digits.len(), 3 | 4 | 6 | 8) || !digits.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let nibble = |i: usize| u8::from_str_radix(&digits[i..=i], 16).unwrap();
    let byte = |i: usize| u8::from_str_radix(&digits[i..i + 2], 16).unwrap();
    Some(match digits.len() {
        3 | 4 => {
            let a = if digits.len() == 4 {
                nibble(3) * 17
            } else {
                255
            };
            [nibble(0) * 17, nibble(1) * 17, nibble(2) * 17, a]
        }
        _ => {
            let a = if digits.len() == 8 { byte(6) } else { 255 };
            [byte(0), byte(2), byte(4), a]
        }
    })
}
/// A token name or a literal color.
fn color(v: &Value) -> Result<(), Bad> {
    let s = v.as_str().ok_or("Expected color")?;
    if COLORS.contains(&s) || hex(s).is_some() {
        Ok(())
    } else {
        Err("Unknown visual color")
    }
}
const FONTS: &[&str] = &["ui", "display", "mono"];
/// Surface props of column, row and grid (schema.ts `surface`).
const SURFACE: &[&str] = &[
    "padding",
    "width",
    "height",
    "minWidth",
    "maxWidth",
    "minHeight",
    "maxHeight",
    "grow",
    "span",
    "x",
    "y",
    "right",
    "bottom",
    "fill",
    "border",
    "borderWidth",
    "radius",
    "shadow",
    "opacity",
    "clip",
    "scroll",
    "color",
    "id",
];
#[derive(Clone, Debug)]
pub(crate) enum Control {
    Tabs(Vec<String>),
    Toggle,
    Slider { min: f64, max: f64 },
    Button { disabled: bool },
}
impl Control {
    pub(crate) fn accepts(&self, v: &Value) -> bool {
        match self {
            Self::Tabs(options) => v.as_str().is_some_and(|s| options.iter().any(|o| o == s)),
            Self::Toggle => v.is_boolean(),
            Self::Slider { min, max } => v
                .as_f64()
                .is_some_and(|v| v.is_finite() && v >= *min && v <= *max),
            Self::Button { disabled } => !disabled && v.is_null(),
        }
    }
}
#[derive(Clone, Debug)]
pub(crate) struct Scene {
    pub(crate) root: Arc<Value>,
    pub(crate) links: BTreeMap<String, String>,
    pub(crate) controls: BTreeMap<String, Control>,
    pub(crate) sliders: BTreeMap<String, (crate::visual_slider::Spec, f64)>,
    pub(crate) canvases: Vec<(String, f64)>,
    pub(crate) nodes: usize,
    pub(crate) charts: BTreeMap<String, Result<Arc<crate::visual_chart::Chart>, Bad>>,
    pub(crate) mermaids: BTreeMap<String, Arc<crate::native_mermaid::Prepared>>,
    /// Vector drawings, tessellated here in the reader rather than while painting.
    pub(crate) vectors: BTreeMap<String, Result<Arc<crate::visual_canvas_plan::Plan>, Bad>>,
}
struct Check {
    links: BTreeMap<String, String>,
    controls: BTreeMap<String, Control>,
    sliders: BTreeMap<String, (crate::visual_slider::Spec, f64)>,
    canvases: Vec<(String, f64)>,
    nodes: usize,
    text: usize,
    chart_points: usize,
    charts: BTreeMap<String, Result<Arc<crate::visual_chart::Chart>, Bad>>,
    mermaids: BTreeMap<String, Arc<crate::native_mermaid::Prepared>>,
    vectors: BTreeMap<String, Result<Arc<crate::visual_canvas_plan::Plan>, Bad>>,
    vector_commands: usize,
    vector_vertices: usize,
}
fn object<'a>(v: &'a Value, allowed: &[&str]) -> Result<&'a Map<String, Value>, Bad> {
    let o = v.as_object().ok_or("Expected object")?;
    if o.keys().any(|k| !allowed.contains(&k.as_str())) {
        return Err("Unknown visual property");
    }
    Ok(o)
}
fn string(v: &Value, max: usize) -> Result<&str, Bad> {
    let s = v.as_str().ok_or("Expected string")?;
    if s.encode_utf16().count() > max {
        return Err("Visual text exceeds limit");
    }
    Ok(s)
}
fn number(v: &Value) -> Result<f64, Bad> {
    v.as_f64()
        .filter(|n| n.is_finite())
        .ok_or("Expected finite number")
}
fn range(v: &Value, min: f64, max: f64, integer: bool) -> Result<f64, Bad> {
    let n = number(v)?;
    if n < min || n > max || (integer && n.fract() != 0.) {
        return Err("Visual number outside range");
    }
    Ok(n)
}
fn choice(v: &Value, options: &[&str]) -> Result<(), Bad> {
    if !options.contains(&v.as_str().ok_or("Expected choice")?) {
        return Err("Unknown visual choice");
    }
    Ok(())
}
fn boolean(v: &Value) -> Result<(), Bad> {
    v.as_bool().map(|_| ()).ok_or("Expected boolean")
}
fn optional(
    o: &Map<String, Value>,
    key: &str,
    check: impl FnOnce(&Value) -> Result<(), Bad>,
) -> Result<(), Bad> {
    if let Some(v) = o.get(key) {
        check(v)?;
    }
    Ok(())
}
fn array(v: &Value, min: usize, max: usize) -> Result<&Vec<Value>, Bad> {
    let a = v.as_array().ok_or("Expected array")?;
    if a.len() < min || a.len() > max {
        return Err("Visual array exceeds limit");
    }
    Ok(a)
}
fn style(o: &Map<String, Value>) -> Result<(), Bad> {
    optional(o, "weight", |v| {
        let n = number(v)?;
        if !(100. ..=900.).contains(&n) || n % 100. != 0. {
            return Err("Unknown font weight");
        }
        Ok(())
    })?;
    optional(o, "color", color)?;
    optional(o, "font", |v| choice(v, FONTS))?;
    for key in ["mono", "italic", "strike"] {
        optional(o, key, boolean)?;
    }
    Ok(())
}
fn length(v: &Value) -> Result<(), Bad> {
    if v == "fill" {
        return Ok(());
    }
    range(v, 0., 4000., false).map(|_| ())
}
/// Validates surface props. Layout only: no I/O, images or callbacks.
fn surface(o: &Map<String, Value>) -> Result<(), Bad> {
    optional(o, "padding", |v| {
        for n in array(v, 4, 4)? {
            range(n, 0., 256., false)?;
        }
        Ok(())
    })?;
    optional(o, "width", length)?;
    optional(o, "height", length)?;
    for key in ["minWidth", "maxWidth", "minHeight", "maxHeight"] {
        optional(o, key, |v| range(v, 0., 4000., false).map(|_| ()))?;
    }
    for key in ["x", "y", "right", "bottom"] {
        optional(o, key, |v| range(v, -4000., 4000., false).map(|_| ()))?;
    }
    optional(o, "grow", |v| range(v, 0., 100., false).map(|_| ()))?;
    optional(o, "span", |v| range(v, 1., 12., true).map(|_| ()))?;
    optional(o, "fill", |v| {
        if v.is_string() {
            return color(v);
        }
        let g = object(v, &["from", "to", "angle"])?;
        color(&v["from"])?;
        color(&v["to"])?;
        optional(g, "angle", |v| range(v, 0., 360., false).map(|_| ()))
    })?;
    optional(o, "border", color)?;
    optional(o, "color", color)?;
    optional(o, "borderWidth", |v| range(v, 0., 16., false).map(|_| ()))?;
    optional(o, "radius", |v| range(v, 0., 1000., false).map(|_| ()))?;
    optional(o, "opacity", |v| range(v, 0., 1., false).map(|_| ()))?;
    optional(o, "clip", boolean)?;
    optional(o, "scroll", |v| choice(v, &["x", "y"]))?;
    optional(o, "shadow", |v| {
        if v.is_string() {
            return choice(v, &["sm", "md", "lg"]);
        }
        let s = object(v, &["x", "y", "blur", "spread", "color"])?;
        for key in ["x", "y", "spread"] {
            optional(s, key, |v| range(v, -100., 100., false).map(|_| ()))?;
        }
        optional(s, "blur", |v| range(v, 0., 100., false).map(|_| ()))?;
        optional(s, "color", color)
    })?;
    if o.get("scroll").and_then(Value::as_str) == Some("y")
        && !o.contains_key("height")
        && !o.contains_key("maxHeight")
    {
        return Err("Vertical visual scroll needs a height");
    }
    Ok(())
}
/// Embedded Lucide icons by name (`search` for `icons/search.svg`), the only
/// icon or image assets a visual can name.
pub(crate) fn icon(name: &str) -> Option<gpui_kit::assets::IconName> {
    use gpui_kit::AssetSource;
    static ICONS: std::sync::LazyLock<BTreeMap<String, gpui_kit::assets::IconName>> =
        std::sync::LazyLock::new(|| {
            let embedded = crate::ChromeAssets.list("icons/").unwrap_or_default();
            gpui_kit::assets::IconName::ALL
                .iter()
                .filter(|icon| embedded.contains(&icon.path()))
                .filter_map(|icon| {
                    let path = icon.path();
                    let name = path.strip_prefix("icons/")?.strip_suffix(".svg")?;
                    Some((name.to_owned(), *icon))
                })
                .collect()
        });
    ICONS.get(name).copied()
}
impl Scene {
    pub(crate) fn parse(value: Value) -> Result<Self, Bad> {
        object(&value, &["api", "root"])?;
        if value["api"] != 1 {
            return Err("Unsupported visual API");
        }
        let mut c = Check {
            links: BTreeMap::new(),
            controls: BTreeMap::new(),
            sliders: BTreeMap::new(),
            canvases: Vec::new(),
            nodes: 0,
            text: 0,
            chart_points: 0,
            charts: BTreeMap::new(),
            mermaids: BTreeMap::new(),
            vectors: BTreeMap::new(),
            vector_commands: 0,
            vector_vertices: 0,
        };
        c.node(&value["root"], "0", 0)?;
        Ok(Self {
            links: c.links,
            root: Arc::new(value["root"].clone()),
            controls: c.controls,
            sliders: c.sliders,
            canvases: c.canvases,
            nodes: c.nodes,
            charts: c.charts,
            mermaids: c.mermaids,
            vectors: c.vectors,
        })
    }
}
impl Check {
    fn text(&mut self, v: &Value, max: usize) -> Result<(), Bad> {
        let s = string(v, max)?;
        self.text += s.encode_utf16().count();
        if self.text > 64 * 1024 {
            return Err("Visual exceeds 64 Ki text units");
        }
        Ok(())
    }
    fn texts(&mut self, o: &Map<String, Value>, keys: &[&str], max: usize) -> Result<(), Bad> {
        for key in keys {
            if let Some(v) = o.get(*key) {
                self.text(v, max)?;
            }
        }
        Ok(())
    }
    fn node(&mut self, v: &Value, path: &str, depth: usize) -> Result<(), Bad> {
        self.nodes += 1;
        if self.nodes > 5000 || depth > 48 {
            return Err("Visual node/depth limit");
        }
        let kind = v["type"].as_str().ok_or("Missing visual type")?;
        let allowed: &[&str] = match kind {
            "column" | "row" | "grid" => {
                let o = v.as_object().ok_or("Expected object")?;
                let own: &[&str] = match kind {
                    "column" => &["type", "key", "gap", "align", "justify", "children"],
                    "row" => &["type", "key", "gap", "align", "justify", "wrap", "children"],
                    _ => &["type", "key", "gap", "columns", "children"],
                };
                if o.keys()
                    .any(|k| !own.contains(&k.as_str()) && !SURFACE.contains(&k.as_str()))
                {
                    return Err("Unknown visual property");
                }
                &[]
            }
            "text" => &[
                "type",
                "key",
                "runs",
                "size",
                "weight",
                "color",
                "mono",
                "italic",
                "align",
                "lines",
                "font",
                "lineHeight",
            ],
            "stat" => &[
                "type", "key", "label", "value", "unit", "delta", "tone", "caption",
            ],
            "table" => &["type", "key", "columns", "rows"],
            "chart" => &[
                "type", "key", "kind", "x", "series", "height", "unit", "stacked", "yMin", "yMax",
                "xLabel", "yLabel",
            ],
            "rule" => &["type", "key"],
            "space" => &["type", "key", "size"],
            "link" => &["type", "key", "label", "href"],
            "tabs" => &["type", "key", "id", "options", "value"],
            "toggle" => &["type", "key", "id", "label", "value"],
            "slider" => &[
                "type", "key", "id", "label", "min", "max", "step", "value", "unit",
            ],
            "button" => &["type", "key", "id", "label", "primary", "disabled"],
            "canvas" => &["type", "key", "id", "width", "height", "animated", "label"],
            "vector" => &[
                "type", "key", "width", "height", "label", "commands", "ops", "strings",
            ],
            "icon" => &["type", "key", "name", "size", "color"],
            "shader" => &[
                "type", "key", "height", "animated", "label", "glsl", "inputs",
            ],
            "mermaid" => &["type", "key", "source"],
            _ => return Err("Unknown visual node"),
        };
        let o = if allowed.is_empty() {
            v.as_object().ok_or("Expected object")?
        } else {
            object(v, allowed)?
        };
        optional(o, "key", |v| {
            let s = string(v, 200)?;
            if s.is_empty() {
                return Err("Empty visual key");
            }
            Ok(())
        })?;
        match kind {
            "column" | "row" | "grid" => {
                optional(o, "gap", |v| range(v, 0., 64., false).map(|_| ()))?;
                optional(o, "align", |v| {
                    choice(
                        v,
                        if kind == "row" {
                            &["start", "center", "end", "baseline"]
                        } else {
                            &["start", "center", "end"]
                        },
                    )
                })?;
                optional(o, "justify", |v| {
                    choice(v, &["start", "center", "end", "between"])
                })?;
                optional(o, "wrap", boolean)?;
                surface(o)?;
                if o.contains_key("id") {
                    self.control(v, path, Control::Button { disabled: false })?;
                }
                if kind == "grid" {
                    range(&v["columns"], 1., 12., true)?;
                }
                let children = array(&v["children"], 0, 5000)?;
                let mut keys = BTreeSet::new();
                for (i, child) in children.iter().enumerate() {
                    if let Some(key) = child.get("key") {
                        let key = string(key, 200)?;
                        if !keys.insert(key) {
                            return Err("Duplicate visual key");
                        }
                    }
                    self.node(child, &format!("{path}.{i}"), depth + 1)?;
                }
            }
            "text" => {
                style(o)?;
                optional(o, "size", |v| {
                    if v.is_number() {
                        range(v, 6., 200., false).map(|_| ())
                    } else {
                        choice(v, &["xs", "sm", "md", "lg", "xl"])
                    }
                })?;
                optional(o, "align", |v| choice(v, &["start", "center", "end"]))?;
                optional(o, "lines", |v| range(v, 1., 50., true).map(|_| ()))?;
                optional(o, "lineHeight", |v| range(v, 0.8, 3., false).map(|_| ()))?;
                for run in array(&v["runs"], 0, 500)? {
                    let r = object(
                        run,
                        &[
                            "text", "weight", "color", "font", "mono", "italic", "strike",
                        ],
                    )?;
                    self.text(&run["text"], 10_000)?;
                    style(r)?;
                }
            }
            "stat" => {
                self.text(&v["label"], 500)?;
                self.text(&v["value"], 500)?;
                self.texts(o, &["unit", "delta", "caption"], 500)?;
                optional(o, "tone", |v| {
                    choice(v, &["neutral", "success", "warning", "danger"])
                })?;
            }
            "table" => {
                let columns = array(&v["columns"], 1, 24)?;
                for column in columns {
                    let c = object(column, &["label", "align"])?;
                    self.text(&column["label"], 500)?;
                    optional(c, "align", |v| choice(v, &["start", "center", "end"]))?;
                }
                for row in array(&v["rows"], 0, 500)? {
                    for cell in array(row, columns.len(), columns.len())? {
                        if cell.is_string() {
                            self.text(cell, 10_000)?;
                        } else if !cell.is_null() {
                            number(cell)?;
                        }
                    }
                }
            }
            "chart" => {
                choice(&v["kind"], &["bar", "line", "area", "scatter"])?;
                range(&v["height"], 80., 480., false)?;
                let x = array(&v["x"], 0, 2000)?;
                for label in x {
                    if v["kind"] == "scatter" {
                        number(label)?;
                    } else {
                        self.text(label, 500)?;
                    }
                }
                for series in array(&v["series"], 1, 12)? {
                    let s = object(series, &["name", "values", "color"])?;
                    self.text(&series["name"], 500)?;
                    optional(s, "color", color)?;
                    for val in array(&series["values"], x.len(), x.len())? {
                        if !val.is_null() {
                            number(val)?;
                        }
                    }
                }
                self.texts(o, &["unit", "xLabel", "yLabel"], 500)?;
                optional(o, "yMin", |v| number(v).map(|_| ()))?;
                optional(o, "yMax", |v| number(v).map(|_| ()))?;
                if let (Some(min), Some(max)) = (v["yMin"].as_f64(), v["yMax"].as_f64())
                    && min >= max
                {
                    return Err("Invalid chart range");
                }
                optional(o, "stacked", boolean)?;
                if v["stacked"] == true && !matches!(v["kind"].as_str(), Some("bar" | "area")) {
                    return Err("Invalid stacked chart");
                }
                let points = x.len() * v["series"].as_array().unwrap().len();
                let plan = if points <= 2048 && self.chart_points + points > 4096 {
                    Err("Scene too large to display (4,096 points). Source is kept.")
                } else {
                    crate::visual_chart::Chart::parse(v).map(Arc::new)
                };
                if plan.is_ok() {
                    self.chart_points += points;
                }
                self.charts.insert(path.into(), plan);
            }
            "rule" => {}
            "space" => {
                optional(o, "size", |v| range(v, 0., 96., false).map(|_| ()))?;
            }
            "link" => {
                self.text(&v["label"], 500)?;
                let href = string(&v["href"], 2048)?;
                if !["https://", "http://"].iter().any(|prefix| {
                    href.get(..prefix.len())
                        .is_some_and(|s| s.eq_ignore_ascii_case(prefix))
                }) {
                    return Err("Invalid visual link");
                }
                self.links.insert(path.into(), href.into());
            }
            "tabs" => {
                let mut options = Vec::new();
                for option in array(&v["options"], 1, 12)? {
                    object(option, &["value", "label"])?;
                    self.text(&option["label"], 500)?;
                    string(&option["value"], 500)?;
                    let key = option["value"].as_str().ok_or("Invalid tab")?.to_owned();
                    if options.contains(&key) {
                        return Err("Duplicate tab value");
                    }
                    options.push(key);
                }
                string(&v["value"], 500)?;
                if !options
                    .iter()
                    .any(|s| Some(s.as_str()) == v["value"].as_str())
                {
                    return Err("Invalid tab selection");
                }
                self.control(v, path, Control::Tabs(options))?;
            }
            "toggle" => {
                self.text(&v["label"], 500)?;
                boolean(&v["value"])?;
                self.control(v, path, Control::Toggle)?;
            }
            "slider" => {
                let min = number(&v["min"])?;
                let max = number(&v["max"])?;
                if min >= max {
                    return Err("Invalid slider range");
                }
                range(&v["value"], min, max, false)?;
                optional(o, "step", |v| {
                    if number(v)? <= 0. {
                        return Err("Invalid slider step");
                    }
                    Ok(())
                })?;
                self.texts(o, &["label", "unit"], 500)?;
                self.control(v, path, Control::Slider { min, max })?;
                self.sliders.insert(
                    path.into(),
                    (
                        crate::visual_slider::Spec::checked_node(v),
                        v["value"].as_f64().unwrap(),
                    ),
                );
            }
            "button" => {
                self.text(&v["label"], 500)?;
                optional(o, "primary", boolean)?;
                optional(o, "disabled", boolean)?;
                self.control(
                    v,
                    path,
                    Control::Button {
                        disabled: v["disabled"] == true,
                    },
                )?;
            }
            "canvas" => {
                let height = range(&v["height"], 24., 600., false)?;
                optional(o, "width", |v| range(v, 1., 2000., false).map(|_| ()))?;
                self.texts(o, &["label"], 500)?;
                optional(o, "animated", boolean)?;
                if v["id"].as_str() != Some(path) {
                    return Err("Invalid canvas path");
                }
                if self.canvases.len() >= 8 {
                    return Err("Too many canvas nodes");
                }
                self.canvases.push((path.into(), height));
            }
            "vector" => {
                let width = range(&v["width"], 1., 2000., false)?;
                let height = range(&v["height"], 1., 2000., false)?;
                self.texts(o, &["label"], 500)?;
                let commands = range(&v["commands"], 0., 20_000., true)? as usize;
                self.vector_commands += commands;
                if self.vector_commands > 20_000 {
                    return Err("Visual vectors exceed 20,000 commands");
                }
                let ops = array(&v["ops"], 0, 2 * 1024 * 1024 / 8)?
                    .iter()
                    .map(number)
                    .collect::<Result<Vec<_>, _>>()?;
                let mut strings = Vec::new();
                for s in array(&v["strings"], 0, 20_000)? {
                    self.text(s, 64 * 1024)?;
                    strings.push(s.as_str().unwrap().to_owned());
                }
                let drawing = crate::visual_drawing::Drawing::checked(commands, ops, strings)
                    .map_err(|_| "Invalid vector drawing")?;
                // Planned here, in the isolated reader, so painting only places vertices.
                // A refused plan shows its error locally; siblings still render.
                let plan = crate::visual_canvas_plan::Plan::vector(&drawing, width, height)
                    .and_then(|plan| {
                        let vertices = plan.vertices();
                        if self.vector_vertices + vertices > crate::visual_canvas_plan::MAX_VERTICES
                        {
                            return Err("Visual vectors exceed the native geometry limit");
                        }
                        self.vector_vertices += vertices;
                        Ok(Arc::new(plan))
                    });
                self.vectors.insert(path.into(), plan);
            }
            "icon" => {
                let name = v["name"].as_str().ok_or("Expected icon name")?;
                if icon(name).is_none() {
                    return Err("Unknown visual icon");
                }
                optional(o, "size", |v| range(v, 8., 128., false).map(|_| ()))?;
                optional(o, "color", color)?;
            }
            "shader" => {
                range(&v["height"], 24., 600., false)?;
                self.texts(o, &["label"], 500)?;
                string(&v["glsl"], 16 * 1024)?;
                optional(o, "animated", boolean)?;
                if let Some(inputs) = o.get("inputs") {
                    let inputs = inputs.as_object().ok_or("Invalid shader inputs")?;
                    if inputs.len() > 16 {
                        return Err("Shader input limit");
                    }
                    for (k, v) in inputs {
                        if k.is_empty()
                            || k.len() > 32
                            || !k.bytes().enumerate().all(|(i, c)| {
                                c.is_ascii_alphabetic()
                                    || c == b'_'
                                    || (i > 0 && c.is_ascii_digit())
                            })
                        {
                            return Err("Invalid shader input");
                        }
                        number(v)?;
                    }
                }
            }
            "mermaid" => {
                self.text(&v["source"], 20 * 1024)?;
                // Scene validation/preparation runs in the isolated reader, not render.
                // A local diagram refusal must not blank charts or sibling controls.
                if self.mermaids.len() < 8 {
                    self.mermaids.insert(
                        path.into(),
                        Arc::new(crate::native_mermaid::Prepared::new(
                            v["source"].as_str().unwrap(),
                        )),
                    );
                }
            }
            _ => unreachable!(),
        }
        Ok(())
    }
    fn control(&mut self, v: &Value, path: &str, control: Control) -> Result<(), Bad> {
        if v["id"].as_str() != Some(path) {
            return Err("Invalid control path");
        }
        if self.controls.insert(path.into(), control).is_some() {
            return Err("Duplicate control path");
        }
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn chart_plan_admission_bounds_aggregate_geometry_and_keeps_source_nodes() {
        let chart = json!({"type":"chart","kind":"scatter","height":120,"x":(0..2000).collect::<Vec<_>>(),"series":[{"name":"Synthetic","values":vec![1;2000]}]});
        let scene =
            Scene::parse(json!({"api":1,"root":{"type":"column","children":vec![chart;5]}}))
                .unwrap();
        assert_eq!(scene.charts.len(), 5);
        assert_eq!(scene.charts.values().filter(|v| v.is_ok()).count(), 2);
        assert!(
            scene.charts["0.4"]
                .as_ref()
                .unwrap_err()
                .contains("4,096 points")
        );
        assert_eq!(
            scene.root["children"][4]["x"].as_array().unwrap().len(),
            2000
        );
        // Unsupported plans do not consume geometry admission for later siblings.
        let bad = json!({"type":"chart","kind":"area","height":120,"stacked":true,"x":["a"],"series":[{"name":"s","values":[1e308]},{"name":"t","values":[1e308]}]});
        let good = crate::visual_chart::synthetic_fixture(10).1["root"].clone();
        let scene =
            Scene::parse(json!({"api":1,"root":{"type":"column","children":[bad,good]}})).unwrap();
        assert!(scene.charts["0.0"].is_err());
        assert!(scene.charts["0.1"].is_ok());
    }
    #[test]
    fn closed_schema_paths_limits_and_shader_siblings() {
        let scene=Scene::parse(json!({"api":1,"root":{"type":"column","children":[{"type":"text","runs":[{"text":"Kept"}]},{"type":"shader","height":80,"glsl":"preserved"},{"type":"toggle","id":"0.2","label":"Local state","value":false}]}})).unwrap();
        assert_eq!(scene.nodes, 4);
        assert!(scene.canvases.is_empty());
        assert!(scene.controls["0.2"].accepts(&json!(true)));
        assert!(!scene.controls["0.2"].accepts(&json!("true")));
        for root in [
            json!({"type":"column","children":[],"url":"file:///private"}),
            json!({"type":"toggle","id":"0.2","label":"wrong path","value":false}),
            json!({"type":"grid","columns":13,"children":[]}),
            json!({"type":"text","runs":[{"text":"x","exec":"bad"}]}),
            json!({"type":"column","children":[{"type":"rule","key":"same"},{"type":"rule","key":"same"}]}),
        ] {
            assert!(Scene::parse(json!({"api":1,"root":root})).is_err());
        }
    }
    #[test]
    fn surfaces_literal_colors_icons_and_pressables_validate_like_the_runtime() {
        assert_eq!(hex("#0f172a"), Some([0x0f, 0x17, 0x2a, 255]));
        assert_eq!(hex("#fff8"), Some([255, 255, 255, 0x88]));
        assert_eq!(hex("#11223344"), Some([0x11, 0x22, 0x33, 0x44]));
        for bad in ["#12", "#12345", "red", "0f172a", "#gggggg", "#+12345"] {
            assert_eq!(hex(bad), None, "{bad}");
        }
        let card = json!({"type":"column","id":"0","padding":[12,16,12,16],"width":"fill","maxWidth":420,
        "grow":1,"x":4,"y":-2,"fill":{"from":"#4f46e5","to":"accent","angle":135},"border":"#ffffff1f",
        "borderWidth":2,"radius":14,"shadow":{"y":8,"blur":24,"color":"#00000040"},"opacity":0.9,
        "clip":true,"scroll":"y","height":300,"color":"#e2e8f0","children":[
            {"type":"text","runs":[{"text":"Plan","font":"mono","weight":300}],"size":30,"weight":800,
                "font":"display","lineHeight":1.1,"color":"#ffffff"},
            {"type":"icon","name":"circle-check","size":18,"color":"#a5b4fc"},
            {"type":"row","wrap":false,"justify":"between","span":2,"shadow":"lg","children":[]},
        ]});
        let scene = Scene::parse(json!({"api":1,"root":card})).unwrap();
        assert!(scene.controls["0"].accepts(&Value::Null));
        assert!(!scene.controls["0"].accepts(&json!(true)));
        for (key, value) in [
            ("padding", json!([1, 2, 3])),
            ("fill", json!("#12")),
            ("fill", json!({"from":"#fff"})),
            ("shadow", json!("xl")),
            ("width", json!("auto")),
            ("radius", json!(-1)),
            ("id", json!("0.3")),
            ("onClick", json!(true)),
            ("image", json!("file:///private.png")),
        ] {
            let mut node = json!({"type":"row","children":[]});
            node[key] = value;
            assert!(Scene::parse(json!({"api":1,"root":node})).is_err(), "{key}");
        }
        for root in [
            json!({"type":"column","scroll":"y","children":[]}),
            json!({"type":"icon","name":"rocket"}),
            json!({"type":"icon","name":"search","size":4}),
            json!({"type":"text","runs":[],"size":300}),
            json!({"type":"text","runs":[],"weight":450}),
            json!({"type":"text","runs":[],"font":"Comic Sans"}),
            json!({"type":"grid","columns":2,"justify":"center","children":[]}),
        ] {
            assert!(
                Scene::parse(json!({"api":1,"root":root.clone()})).is_err(),
                "{root}"
            );
        }
    }
    /// The runtime's icon names (the shared JSON Schema) are exactly the icons the
    /// app embeds, so a published icon always has a glyph.
    #[test]
    fn published_icon_names_are_exactly_the_embedded_icons() {
        let schema: Value = serde_json::from_str(include_str!(
            "../../../packages/protocol/fixtures/visual/api-1.schema.json"
        ))
        .unwrap();
        let node = schema["$defs"]["Node"]["anyOf"]
            .as_array()
            .unwrap()
            .iter()
            .find(|n| n["properties"]["type"]["const"] == "icon")
            .unwrap();
        let published: BTreeSet<&str> = node["properties"]["name"]["enum"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        use gpui_kit::AssetSource;
        let embedded: BTreeSet<String> = crate::ChromeAssets
            .list("icons/")
            .unwrap()
            .iter()
            .filter_map(|p| Some(p.strip_prefix("icons/")?.strip_suffix(".svg")?.to_owned()))
            .collect();
        assert_eq!(
            published,
            embedded.iter().map(String::as_str).collect::<BTreeSet<_>>()
        );
        assert!(published.iter().all(|name| icon(name).is_some()));
    }
    #[test]
    fn vectors_plan_in_the_reader_and_fail_locally() {
        // A square with a square hole, as SVG subpaths (PATHS 15) in a literal color.
        let hole = vec![
            15.,
            1.,
            256. + 0x0f172aff_u32 as f64,
            1.,
            0.,
            2.,
            1.,
            4.,
            0.,
            0.,
            24.,
            0.,
            24.,
            24.,
            0.,
            24.,
            1.,
            4.,
            6.,
            6.,
            6.,
            18.,
            18.,
            18.,
            18.,
            6.,
        ];
        let vector = |ops: Vec<f64>, commands: usize| json!({"type":"vector","width":24,"height":24,"commands":commands,"ops":ops,"strings":[]});
        let scene = Scene::parse(json!({"api":1,"root":{"type":"row","children":[
            vector(hole.clone(), 1),
            vector(vec![11., 1., 7., 1., 0., 12., 12., 4.], 1),
        ]}}))
        .unwrap();
        let plan = scene.vectors["0.0"].as_ref().unwrap();
        assert_eq!((plan.width, plan.height), (24., 24.));
        let area: f32 = plan
            .primitives
            .iter()
            .filter_map(|p| match p {
                crate::visual_canvas_plan::Primitive::Triangles { vertices, .. } => Some(vertices),
                _ => None,
            })
            .flat_map(|v| v.as_chunks::<3>().0)
            .map(|t| {
                ((t[1][0] - t[0][0]) * (t[2][1] - t[0][1])
                    - (t[2][0] - t[0][0]) * (t[1][1] - t[0][1]))
                    .abs()
                    / 2.
            })
            .sum();
        assert!(
            (area - (576. - 144.)).abs() < 0.5,
            "the hole stays open: {area}"
        );
        // Color index 13 is neither a token nor a literal; a wrong command count is refused.
        assert!(
            Scene::parse(
                json!({"api":1,"root":vector(vec![11., 1., 13., 1., 0., 12., 12., 4.], 1)})
            )
            .is_err()
        );
        assert!(
            Scene::parse(
                json!({"api":1,"root":vector(vec![11., 1., 12., 1., 0., 12., 12., 4.], 2)})
            )
            .is_err()
        );
        assert!(
            Scene::parse(json!({"api":1,"root":{"type":"vector","width":0,"height":24,"commands":0,"ops":[],"strings":[]}}))
                .is_err()
        );
        // Views share one 20,000-command budget across vectors.
        let mut many = Vec::new();
        for _ in 0..10_001 {
            many.extend([11., 1., 7., 1., 0., 1., 1., 1.]);
        }
        assert!(
            Scene::parse(json!({"api":1,"root":{"type":"row","children":[
                vector(many.clone(), 10_001),
                vector(many, 10_001),
            ]}}))
            .is_err()
        );
    }
}
