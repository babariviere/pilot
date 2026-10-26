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
    pub(crate) controls: BTreeMap<String, Control>,
    pub(crate) sliders: BTreeMap<String, (crate::visual_slider::Spec, f64)>,
    pub(crate) canvases: Vec<(String, f64)>,
    pub(crate) nodes: usize,
    pub(crate) charts: BTreeMap<String, Result<Arc<crate::visual_chart::Chart>, Bad>>,
    pub(crate) mermaids: BTreeMap<String, Arc<crate::native_mermaid::Prepared>>,
}
struct Check {
    controls: BTreeMap<String, Control>,
    sliders: BTreeMap<String, (crate::visual_slider::Spec, f64)>,
    canvases: Vec<(String, f64)>,
    nodes: usize,
    text: usize,
    chart_points: usize,
    charts: BTreeMap<String, Result<Arc<crate::visual_chart::Chart>, Bad>>,
    mermaids: BTreeMap<String, Arc<crate::native_mermaid::Prepared>>,
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
        if ![400., 500., 600., 700.].contains(&n) {
            return Err("Unknown font weight");
        }
        Ok(())
    })?;
    optional(o, "color", |v| choice(v, COLORS))?;
    for key in ["mono", "italic", "strike"] {
        optional(o, key, boolean)?;
    }
    Ok(())
}
impl Scene {
    pub(crate) fn parse(value: Value) -> Result<Self, Bad> {
        object(&value, &["api", "root"])?;
        if value["api"] != 1 {
            return Err("Unsupported visual API");
        }
        let mut c = Check {
            controls: BTreeMap::new(),
            sliders: BTreeMap::new(),
            canvases: Vec::new(),
            nodes: 0,
            text: 0,
            chart_points: 0,
            charts: BTreeMap::new(),
            mermaids: BTreeMap::new(),
        };
        c.node(&value["root"], "0", 0)?;
        Ok(Self {
            root: Arc::new(value["root"].clone()),
            controls: c.controls,
            sliders: c.sliders,
            canvases: c.canvases,
            nodes: c.nodes,
            charts: c.charts,
            mermaids: c.mermaids,
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
            "column" => &["type", "key", "gap", "align", "children"],
            "row" => &["type", "key", "gap", "align", "justify", "children"],
            "grid" => &["type", "key", "gap", "columns", "children"],
            "text" => &[
                "type", "key", "runs", "size", "weight", "color", "mono", "italic", "align",
                "lines",
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
            "canvas" => &["type", "key", "id", "height", "animated", "label"],
            "shader" => &[
                "type", "key", "height", "animated", "label", "glsl", "inputs",
            ],
            "mermaid" => &["type", "key", "source"],
            _ => return Err("Unknown visual node"),
        };
        let o = object(v, allowed)?;
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
                optional(o, "size", |v| choice(v, &["xs", "sm", "md", "lg", "xl"]))?;
                optional(o, "align", |v| choice(v, &["start", "center", "end"]))?;
                optional(o, "lines", |v| range(v, 1., 50., true).map(|_| ()))?;
                for run in array(&v["runs"], 0, 500)? {
                    let r = object(
                        run,
                        &["text", "weight", "color", "mono", "italic", "strike"],
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
                    optional(s, "color", |v| choice(v, COLORS))?;
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
                    Err(
                        "Scene exceeds the native 4096-point chart-plan budget. Data/source retained.",
                    )
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
                if !href.starts_with("https://") && !href.starts_with("http://") {
                    return Err("Invalid visual link");
                }
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
                .contains("4096-point")
        );
        assert_eq!(
            scene.root["children"][4]["x"].as_array().unwrap().len(),
            2000
        );
        // Unsupported plans do not consume geometry admission for later siblings.
        let bad = json!({"type":"chart","kind":"area","height":120,"stacked":true,"x":["a"],"series":[{"name":"s","values":[1]}]});
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
}
