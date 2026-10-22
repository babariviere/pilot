//! Bounded finite normalized geometry prepared off UI. No JS/GPU shader execution.
use serde_json::Value;
#[derive(Debug)]
pub(crate) struct Series {
    pub(crate) name: String,
    pub(crate) color: String,
    pub(crate) points: Vec<Option<(f32, f32)>>,
    pub(crate) bases: Vec<f32>,
}
#[derive(Debug)]
pub(crate) struct Chart {
    pub(crate) kind: String,
    pub(crate) stacked: bool,
    pub(crate) height: f32,
    pub(crate) series: Vec<Series>,
    pub(crate) baseline: f32,
    pub(crate) range: (f64, f64),
    pub(crate) labels: Vec<String>,
    pub(crate) label_positions: Vec<f32>,
    pub(crate) x_label: String,
    pub(crate) unit: String,
}
fn normal(value: f64, min: f64, max: f64) -> f32 {
    if min == max {
        return 0.5;
    }
    let scale = min.abs().max(max.abs());
    let scale = if scale == 0. { 1. } else { scale };
    let span = max / scale - min / scale;
    if span == 0. {
        return 0.5;
    }
    ((value.clamp(min, max) / scale - min / scale) / span).clamp(0., 1.) as f32
}
fn display_label(text: &str) -> String {
    let mut chars = text.chars();
    let mut label = chars.by_ref().take(80).collect::<String>();
    if chars.next().is_some() {
        label.push('…');
    }
    label
}
pub(crate) fn format_number(value: f64) -> String {
    if value.abs() > 1e6 || (value != 0. && value.abs() < 0.001) {
        format!("{value:.3e}")
    } else {
        value.to_string()
    }
}
impl Chart {
    pub(crate) fn parse(v: &Value) -> Result<Self, &'static str> {
        let kind = v["kind"].as_str().unwrap_or("line");
        let stacked = v["stacked"] == true;
        if stacked && kind != "bar" {
            return Err("Stacked area rendering is not wired yet. Data/source retained.");
        }
        let x = v["x"].as_array().ok_or("Invalid chart")?;
        let series = v["series"].as_array().ok_or("Invalid chart")?;
        if series.is_empty()
            || series.len() > 12
            || x.len().checked_mul(series.len()).is_none_or(|n| n > 2048)
        {
            return Err(
                "Chart exceeds the native 2048-point display budget. Data/source retained.",
            );
        }
        let scatter = kind == "scatter";
        if scatter {
            if x.iter().any(|v| v.as_f64().is_none_or(|n| !n.is_finite())) {
                return Err("Invalid numeric chart domain");
            }
        } else {
            let mut unique = std::collections::HashSet::new();
            for value in x {
                let label = value.as_str().ok_or("Invalid category")?;
                if !unique.insert(label) {
                    return Err(
                        "Duplicate category grouping is not wired yet. Data/source retained.",
                    );
                }
            }
        }
        let mut min = 0f64;
        let mut max = 0f64;
        let mut positive = vec![0f64; x.len()];
        let mut negative = vec![0f64; x.len()];
        let mut raw = Vec::with_capacity(series.len());
        for s in series {
            let values = s["values"].as_array().ok_or("Invalid chart")?;
            if values.len() != x.len() {
                return Err("Invalid chart lengths");
            }
            let mut bars = Vec::with_capacity(values.len());
            for (j, value) in values.iter().enumerate() {
                if value.is_null() {
                    bars.push(None);
                    continue;
                }
                let n = value
                    .as_f64()
                    .filter(|v| v.is_finite())
                    .ok_or("Invalid chart value")?;
                let stack = if n >= 0. {
                    &mut positive[j]
                } else {
                    &mut negative[j]
                };
                let base = if stacked { *stack } else { 0. };
                let end = base + n;
                if !end.is_finite() {
                    return Err("Stacked chart sum exceeds finite geometry. Data/source retained.");
                }
                if stacked {
                    *stack = end;
                }
                min = min.min(base).min(end);
                max = max.max(base).max(end);
                bars.push(Some((base, end)));
            }
            raw.push(bars);
        }
        min = v["yMin"].as_f64().unwrap_or(min);
        max = v["yMax"].as_f64().unwrap_or(max);
        if !min.is_finite() || !max.is_finite() || min > max {
            return Err("Chart range is not supported");
        }
        if kind != "bar"
            && raw
                .iter()
                .flatten()
                .flatten()
                .any(|(_, n)| *n < min || *n > max)
        {
            return Err(
                "Out-of-range line/area/scatter clipping is not wired yet. Data/source retained.",
            );
        }
        let xmin = x
            .iter()
            .filter_map(Value::as_f64)
            .fold(f64::INFINITY, f64::min);
        let xmax = x
            .iter()
            .filter_map(Value::as_f64)
            .fold(f64::NEG_INFINITY, f64::max);
        let position = |j: usize| {
            if scatter {
                normal(x[j].as_f64().unwrap(), xmin, xmax)
            } else if kind == "bar" {
                (j as f32 + 0.5) / x.len().max(1) as f32
            } else if x.len() < 2 {
                0.5
            } else {
                j as f32 / (x.len() - 1) as f32
            }
        };
        let output = series
            .iter()
            .zip(raw)
            .enumerate()
            .map(|(i, (s, bars))| {
                let bases = if kind == "bar" {
                    bars.iter()
                        .map(|p| normal(p.map_or(0., |p| p.0), min, max))
                        .collect()
                } else {
                    Vec::new()
                };
                let points = bars
                    .into_iter()
                    .enumerate()
                    .map(|(j, p)| p.map(|(_, y)| (position(j), normal(y, min, max))))
                    .collect();
                Series {
                    name: display_label(s["name"].as_str().unwrap_or("")),
                    color: s["color"]
                        .as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| format!("chart{}", i % 6 + 1)),
                    points,
                    bases,
                }
            })
            .collect();
        let label = |v: &Value| {
            v.as_str()
                .map(display_label)
                .unwrap_or_else(|| display_label(&v.to_string()))
        };
        let (labels, label_positions) = if scatter && !x.is_empty() {
            if xmin == xmax {
                (vec![display_label(&format_number(xmin))], vec![0.5])
            } else {
                (
                    vec![
                        display_label(&format_number(xmin)),
                        display_label(&format_number(xmax)),
                    ],
                    vec![0., 1.],
                )
            }
        } else {
            let indices = if x.len() <= 12 {
                (0..x.len()).collect::<Vec<_>>()
            } else {
                vec![0, x.len() - 1]
            };
            (
                indices.iter().map(|&i| label(&x[i])).collect(),
                indices.into_iter().map(position).collect(),
            )
        };
        Ok(Self {
            kind: kind.into(),
            stacked,
            height: v["height"].as_f64().unwrap_or(220.) as f32,
            series: output,
            baseline: normal(0., min, max),
            range: (min, max),
            labels,
            label_positions,
            x_label: display_label(v["xLabel"].as_str().unwrap_or("")),
            unit: display_label(
                v["yLabel"]
                    .as_str()
                    .or_else(|| v["unit"].as_str())
                    .unwrap_or(""),
            ),
        })
    }
}
/// Fixed, network-free native expected-tree cases. No generated source execution.
pub(crate) fn synthetic_fixture(index: usize) -> (&'static str, Value) {
    let mut root = if index == 11 {
        serde_json::json!({"type":"chart","kind":"scatter","height":220,"x":[100,-5,2],"series":[{"name":"Samples","values":[1,2,3]}],"xLabel":"Numeric domain","yLabel":"Value"})
    } else {
        serde_json::json!({"type":"chart","kind":"bar","stacked":true,"height":220,"x":["North","South","Zero"],"series":[{"name":"First","values":[2,-2,0],"color":"chart1"},{"name":"Second","values":[3,-4,0],"color":"chart2"},{"name":"Third","values":[-1,1,null],"color":"chart3"}],"xLabel":"Region","yLabel":"Units"})
    };
    let title = match index {
        11 => "Unsorted numeric scatter",
        12 => {
            root["yMin"] = serde_json::json!(-3);
            root["yMax"] = serde_json::json!(3);
            "Clipped signed stacks"
        }
        _ => "Signed stacked bars",
    };
    if index == 13 {
        root = serde_json::json!({"type":"column","children":[root.clone(),root]});
    }
    (
        if index == 13 {
            "Sibling signed stacks"
        } else {
            title
        },
        serde_json::json!({"api":1,"root":root}),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn stacked_bars_separate_signs_keep_nulls_and_clip_finite_intervals() {
        let mut value = json!({"kind":"bar","stacked":true,"x":["a","b","c"],"series":[{"values":[2,-2,0]},{"values":[3,-4,0]},{"values":[-1,1,null]}]});
        let plan = Chart::parse(&value).unwrap();
        assert_eq!(plan.range, (-6., 5.));
        assert!(plan.stacked);
        assert_eq!(plan.series[1].bases[0], normal(2., -6., 5.));
        assert_eq!(plan.series[1].points[0].unwrap().1, 1.);
        assert_eq!(plan.series[1].bases[1], normal(-2., -6., 5.));
        assert_eq!(plan.series[1].points[1].unwrap().1, 0.);
        assert_eq!(plan.series[2].points[2], None);
        assert_eq!(plan.series[2].bases[0], normal(0., -6., 5.));
        value["yMin"] = json!(-3);
        value["yMax"] = json!(3);
        let clipped = Chart::parse(&value).unwrap();
        assert_eq!(clipped.range, (-3., 3.));
        assert_eq!(clipped.series[1].points[0].unwrap().1, 1.);
        assert_eq!(clipped.series[1].points[1].unwrap().1, 0.);
        assert_eq!(clipped.series[1].bases[1], normal(-2., -3., 3.));
        assert_eq!(plan.label_positions, vec![1. / 6., 0.5, 5. / 6.]);
    }
    #[test]
    fn numeric_ticks_follow_extrema_not_input_order_and_constant_domains_center() {
        let plan =
            Chart::parse(&json!({"kind":"scatter","x":[100,-5,2],"series":[{"values":[1,2,3]}]}))
                .unwrap();
        assert_eq!(plan.label_positions, vec![0., 1.]);
        assert_eq!(
            plan.labels
                .iter()
                .map(|s| s.parse::<f64>().unwrap())
                .collect::<Vec<_>>(),
            vec![-5., 100.]
        );
        assert_eq!(plan.series[0].points[0].unwrap().0, 1.);
        assert_eq!(plan.series[0].points[1].unwrap().0, 0.);
        let plan =
            Chart::parse(&json!({"kind":"scatter","x":[2,2,2],"series":[{"values":[1,2,3]}]}))
                .unwrap();
        assert_eq!(plan.label_positions, vec![0.5]);
        assert_eq!(plan.labels.len(), 1);
    }
    #[test]
    fn unsupported_cases_are_explicit_not_false_geometry() {
        for value in [
            json!({"kind":"bar","stacked":true,"x":["a"],"series":[{"values":[1e308]},{"values":[1e308]}]}),
            json!({"kind":"area","stacked":true,"x":["a"],"series":[{"values":[1]}]}),
            json!({"kind":"bar","x":["a","a"],"series":[{"values":[1,2]}]}),
            json!({"kind":"line","yMax":1,"x":["a","b"],"series":[{"values":[1,2]}]}),
        ] {
            assert!(Chart::parse(&value).is_err());
        }
    }
    #[test]
    fn category_labels_are_finite_bounded_and_sparse_only_above_twelve() {
        let chart=Chart::parse(&json!({"kind":"bar","x":["North","South","West"],"series":[{"name":"s","values":[1,2,3]}]})).unwrap();
        assert_eq!(chart.labels, vec!["North", "South", "West"]);
        let scatter = Chart::parse(
            &json!({"kind":"scatter","x":[1,2,100],"series":[{"name":"s","values":[1,2,3]}]}),
        )
        .unwrap();
        assert_eq!(scatter.labels, vec!["1", "100"]);
        let mut x = (0..13)
            .map(|i| json!(format!("middle{i}")))
            .collect::<Vec<_>>();
        x[0] = json!("First");
        x[12] = json!("界".repeat(10_000));
        let chart=Chart::parse(&json!({"kind":"bar","x":x,"unit":"界".repeat(100),"series":[{"name":"界".repeat(100),"values":vec![1;13]}]})).unwrap();
        assert_eq!(chart.labels.len(), 2);
        assert_eq!(chart.labels[0], "First");
        assert_eq!(chart.labels[1].chars().count(), 81);
        assert!(chart.labels[1].ends_with('…'));
        assert_eq!(chart.series[0].name.chars().count(), 81);
        assert_eq!(chart.unit.chars().count(), 81);
    }
    #[test]
    fn extreme_and_constant_ranges_stay_finite_and_nulls_stay_gaps() {
        for (min, max) in [(-1e308, 1e308), (1e308, 1e308), (5e-324, 1e-323)] {
            for n in [min, 0., max] {
                let p = normal(n, min, max);
                assert!(p.is_finite() && (0.0..=1.0).contains(&p));
            }
        }
        let c=Chart::parse(&json!({"kind":"line","x":["a","b"],"series":[{"name":"s","values":[null,2]}],"height":100})).unwrap();
        assert_eq!(c.series[0].points[0], None);
        assert_eq!(c.series[0].points[1], Some((1., 1.)));
    }
}
