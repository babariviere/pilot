//! Bounded finite normalized geometry prepared off UI. No JS/GPU shader execution.
use serde_json::Value;
#[derive(Debug)]
pub(crate) struct Series {
    pub(crate) name: String,
    pub(crate) color: String,
    pub(crate) points: Vec<Option<(f32, f32)>>,
}
#[derive(Debug)]
pub(crate) struct Chart {
    pub(crate) kind: String,
    pub(crate) height: f32,
    pub(crate) series: Vec<Series>,
    pub(crate) baseline: f32,
    pub(crate) range: (f64, f64),
    pub(crate) labels: Vec<String>,
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
impl Chart {
    pub(crate) fn parse(v: &Value) -> Result<Self, &'static str> {
        if v["stacked"] == true {
            return Err("Stacked chart rendering is not wired yet. Data/source retained.");
        }
        let x = v["x"].as_array().ok_or("Invalid chart")?;
        let series = v["series"].as_array().ok_or("Invalid chart")?;
        if x.len() * series.len() > 2048 {
            return Err(
                "Chart exceeds the native 2048-point display budget. Data/source retained.",
            );
        }
        let mut min = 0f64;
        let mut max = 0f64;
        for s in series {
            for n in s["values"]
                .as_array()
                .ok_or("Invalid chart")?
                .iter()
                .filter_map(Value::as_f64)
            {
                min = min.min(n);
                max = max.max(n);
            }
        }
        min = v["yMin"].as_f64().unwrap_or(min);
        max = v["yMax"].as_f64().unwrap_or(max);
        if min > max {
            return Err("Chart range is not supported");
        }
        if series
            .iter()
            .flat_map(|s| s["values"].as_array().into_iter().flatten())
            .filter_map(Value::as_f64)
            .any(|n| n < min || n > max)
        {
            return Err(
                "Out-of-range chart clipping is not implemented yet. Data/source retained.",
            );
        }
        let kind = v["kind"].as_str().unwrap_or("line").to_owned();
        let scatter = kind == "scatter";
        let xmin = x
            .iter()
            .filter_map(Value::as_f64)
            .fold(f64::INFINITY, f64::min);
        let xmax = x
            .iter()
            .filter_map(Value::as_f64)
            .fold(f64::NEG_INFINITY, f64::max);
        let mut output = Vec::new();
        for (i, s) in series.iter().enumerate() {
            let mut points = Vec::new();
            for (j, n) in s["values"].as_array().unwrap().iter().enumerate() {
                points.push(n.as_f64().map(|y| {
                    let x = if scatter {
                        normal(x[j].as_f64().unwrap(), xmin, xmax)
                    } else if kind == "bar" {
                        (j as f32 + 0.5) / x.len().max(1) as f32
                    } else if x.len() < 2 {
                        0.5
                    } else {
                        j as f32 / (x.len() - 1) as f32
                    };
                    (x, normal(y, min, max))
                }));
            }
            output.push(Series {
                name: display_label(s["name"].as_str().unwrap_or("")),
                color: s["color"]
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| format!("chart{}", i % 6 + 1)),
                points,
            });
        }
        let label = |v: &Value| {
            v.as_str()
                .map(display_label)
                .unwrap_or_else(|| display_label(&v.to_string()))
        };
        Ok(Self {
            kind,
            height: v["height"].as_f64().unwrap_or(220.) as f32,
            series: output,
            baseline: normal(0., min, max),
            range: (min, max),
            labels: if (x.len() <= 12 && !scatter) || x.len() <= 1 {
                x.iter().map(&label).collect()
            } else {
                vec![
                    x.first().map(&label).unwrap_or_default(),
                    x.last().map(&label).unwrap_or_default(),
                ]
            },
            unit: display_label(v["unit"].as_str().unwrap_or("")),
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn category_labels_are_finite_bounded_and_sparse_only_above_twelve() {
        let chart=Chart::parse(&json!({"kind":"bar","x":["North","South","West"],"series":[{"name":"s","values":[1,2,3]}]})).unwrap();
        assert_eq!(chart.labels, vec!["North", "South", "West"]);
        let scatter = Chart::parse(
            &json!({"kind":"scatter","x":[1,2,100],"series":[{"name":"s","values":[1,2,3]}]}),
        )
        .unwrap();
        assert_eq!(scatter.labels, vec!["1", "100"]);
        let mut x = vec![json!("middle"); 13];
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
