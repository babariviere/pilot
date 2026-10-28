//! Bounded finite normalized geometry prepared off UI. No JS/GPU shader execution.
use serde_json::Value;
/// Normalized plot points joined by straight segments.
pub(crate) type Polyline = Vec<(f32, f32)>;
#[derive(Debug)]
pub(crate) struct Series {
    pub(crate) name: String,
    pub(crate) color: String,
    /// Bar ends, or in-domain line/area/scatter points; `None` is a gap or a
    /// point outside the y domain.
    pub(crate) points: Vec<Option<(f32, f32)>>,
    pub(crate) bases: Vec<f32>,
    /// Line/area strokes clipped to the y domain. A single point is a run of one value.
    pub(crate) strokes: Vec<Polyline>,
    /// Closed area outlines, one per gap-free run: the clipped top edge, then the
    /// clipped bottom edge (baseline, or the band below when stacked) reversed.
    /// Both are held at the domain edges with crossings added, so filling each
    /// covers exactly the visible area.
    pub(crate) fills: Vec<Polyline>,
    /// Published values, one per x; `None` is a gap. Read by the hover readout.
    pub(crate) values: Vec<Option<f64>>,
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
    /// Distinct categories, in first-seen order like Swift's categorical domain.
    /// Entries that repeat a label share its position.
    pub(crate) categories: usize,
    pub(crate) x_label: String,
    pub(crate) unit: String,
    /// Display label and normalized plot position of every x entry.
    pub(crate) x: Vec<String>,
    pub(crate) positions: Vec<f32>,
    /// The published `unit`, appended to readout values.
    pub(crate) value_unit: String,
}
/// The values at one x entry, for the hover readout.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Readout {
    pub(crate) label: String,
    /// Series index, name and formatted value. Series with a gap here are omitted.
    pub(crate) rows: Vec<(usize, String, String)>,
}
/// A keyboard move between readout entries.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Step {
    Previous,
    Next,
    First,
    Last,
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
/// Where the segment from `a` to `b` crosses `edge`, as a fraction of its
/// length. Scaled like `normal`, so extreme finite values stay finite.
fn crossing(a: f64, b: f64, edge: f64) -> f32 {
    let scale = a.abs().max(b.abs()).max(edge.abs());
    ((edge / scale - a / scale) / (b / scale - a / scale)).clamp(0., 1.) as f32
}
/// Clips one gap-free run of (x, value) points to the y domain, returning its
/// visible strokes and its fill outline.
fn clip(run: &[(f32, f64)], min: f64, max: f64) -> (Vec<Polyline>, Polyline) {
    let mut vertices = Vec::with_capacity(run.len());
    for (k, &(x, v)) in run.iter().enumerate() {
        if let Some(&(px, pv)) = k.checked_sub(1).map(|k| &run[k]) {
            let mut cuts = [min, max]
                .into_iter()
                .filter(|&edge| (pv < edge && v > edge) || (pv > edge && v < edge))
                .map(|edge| (crossing(pv, v, edge), edge))
                .collect::<Vec<_>>();
            cuts.sort_by(|a, b| a.0.total_cmp(&b.0));
            vertices.extend(cuts.into_iter().map(|(s, edge)| (px + (x - px) * s, edge)));
        }
        vertices.push((x, v));
    }
    // Crossings split every segment at the edges, so a piece is visible exactly
    // when both of its ends are inside the domain.
    let mut strokes = Vec::new();
    let mut piece = Vec::new();
    for &(x, v) in &vertices {
        if (min..=max).contains(&v) {
            piece.push((x, normal(v, min, max)));
        } else if !piece.is_empty() {
            strokes.push(std::mem::take(&mut piece));
        }
    }
    strokes.push(piece);
    // A line that only touches an edge has no visible length; a lone value does.
    strokes.retain(|p| p.len() > 1 || (run.len() == 1 && p.len() == 1));
    let fill = vertices
        .into_iter()
        .map(|(x, v)| (x, normal(v, min, max)))
        .collect();
    (strokes, fill)
}
/// Splits a run of (x, value) points where its x direction turns or stays put
/// (a revisited category), so each piece fills as a simple band. Pieces share
/// their turning points.
fn monotone<T>(run: &[(f32, T)]) -> Vec<&[(f32, T)]> {
    if run.len() < 2 {
        return vec![run];
    }
    let mut pieces = Vec::new();
    let mut start = 0;
    for k in 1..run.len() {
        let step = run[k].0 - run[k - 1].0;
        if step == 0. {
            pieces.push(&run[start..k]);
            start = k;
        } else if k - start >= 2 && (step > 0.) != (run[k - 1].0 > run[k - 2].0) {
            pieces.push(&run[start..k]);
            start = k - 1;
        }
    }
    pieces.push(&run[start..]);
    pieces.retain(|p| p.len() > 1);
    pieces
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
    /// The x entry nearest a normalized plot position that has at least one value,
    /// matching Swift's readout: the category under the pointer, or the nearest
    /// scatter x.
    pub(crate) fn nearest(&self, at: f32) -> Option<usize> {
        (0..self.positions.len())
            .filter(|&j| self.series.iter().any(|s| s.values[j].is_some()))
            .min_by(|&a, &b| {
                (self.positions[a] - at)
                    .abs()
                    .total_cmp(&(self.positions[b] - at).abs())
            })
    }
    /// The x entry a key moves to from `from`, among entries with a value in
    /// left-to-right plot order (scatter input order may differ). Without a
    /// current entry, Next starts at the first and Previous at the last.
    pub(crate) fn step(&self, from: Option<usize>, step: Step) -> Option<usize> {
        let mut order = (0..self.positions.len())
            .filter(|&j| self.series.iter().any(|s| s.values[j].is_some()))
            .collect::<Vec<_>>();
        order.sort_by(|&a, &b| self.positions[a].total_cmp(&self.positions[b]));
        let last = order.len().checked_sub(1)?;
        let at = from.and_then(|i| order.iter().position(|&j| j == i));
        let k = match (step, at) {
            (Step::First, _) | (Step::Next, None) => 0,
            (Step::Last, _) | (Step::Previous, None) => last,
            (Step::Next, Some(k)) => (k + 1).min(last),
            (Step::Previous, Some(k)) => k.saturating_sub(1),
        };
        Some(order[k])
    }
    pub(crate) fn readout(&self, index: usize) -> Option<Readout> {
        let label = self.x.get(index)?.clone();
        let rows = self
            .series
            .iter()
            .enumerate()
            .filter_map(|(i, s)| {
                let value = (*s.values.get(index)?)?;
                let mut text = format_number(value);
                if !self.value_unit.is_empty() {
                    text.push(' ');
                    text.push_str(&self.value_unit);
                }
                Some((i, s.name.clone(), text))
            })
            .collect::<Vec<_>>();
        (!rows.is_empty()).then_some(Readout { label, rows })
    }
    /// Weighted interpolation keeps even the widest finite signed domain finite.
    pub(crate) fn ticks(&self) -> Vec<(f32, String)> {
        let (low, high) = self.range;
        let steps = if low == high {
            0
        } else if self.height < 160. {
            2
        } else {
            4
        };
        let mut values = (0..=steps)
            .map(|i| {
                let t = if steps == 0 {
                    0.5
                } else {
                    i as f64 / steps as f64
                };
                (t as f32, low * (1. - t) + high * t)
            })
            .collect::<Vec<_>>();
        values.dedup_by(|a, b| a.1 == b.1);
        let mut ticks = values
            .iter()
            .map(|&(t, value)| {
                let label = if value != 0. && (value.abs() < 0.001 || value.abs() >= 10000.) {
                    format!("{value:.3e}")
                } else {
                    let text = format!("{value:.3}");
                    let text = text.trim_end_matches('0').trim_end_matches('.');
                    if text == "-0" {
                        "0".into()
                    } else {
                        text.into()
                    }
                };
                (t, label)
            })
            .collect::<Vec<_>>();
        // Close explicit bounds need more precision than ordinary axis labels.
        if ticks.windows(2).any(|pair| pair[0].1 == pair[1].1) {
            for (tick, (_, value)) in ticks.iter_mut().zip(values) {
                tick.1 = format!("{value:e}");
            }
        }
        ticks
    }
    pub(crate) fn parse(v: &Value) -> Result<Self, &'static str> {
        let kind = v["kind"].as_str().unwrap_or("line");
        let stacked = v["stacked"] == true;
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
        // Each entry's category: labels in first-seen order, like Swift's
        // categorical domain. Entries sharing a label share its position.
        let mut category = Vec::with_capacity(x.len());
        let mut firsts = Vec::new();
        if scatter {
            if x.iter().any(|v| v.as_f64().is_none_or(|n| !n.is_finite())) {
                return Err("Invalid numeric chart domain");
            }
            category.extend(0..x.len());
            firsts.extend(0..x.len());
        } else {
            let mut seen = std::collections::HashMap::new();
            for (j, value) in x.iter().enumerate() {
                let label = value.as_str().ok_or("Invalid category")?;
                category.push(*seen.entry(label).or_insert_with(|| {
                    firsts.push(j);
                    firsts.len() - 1
                }));
            }
        }
        let categories = firsts.len();
        // Like Swift Charts, bars sharing a category stack: across series when
        // stacked, otherwise within each series' own bar.
        let accumulate = stacked || kind == "bar";
        let mut min = 0f64;
        let mut max = 0f64;
        let mut positive = vec![0f64; categories];
        let mut negative = vec![0f64; categories];
        let mut raw = Vec::with_capacity(series.len());
        for s in series {
            let values = s["values"].as_array().ok_or("Invalid chart")?;
            if values.len() != x.len() {
                return Err("Invalid chart lengths");
            }
            if !stacked {
                positive.fill(0.);
                negative.fill(0.);
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
                    &mut positive[category[j]]
                } else {
                    &mut negative[category[j]]
                };
                let base = if accumulate { *stack } else { 0. };
                let end = base + n;
                if !end.is_finite() {
                    return Err("Stacked chart sum exceeds finite geometry. Data/source retained.");
                }
                if accumulate {
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
                (category[j] as f32 + 0.5) / categories.max(1) as f32
            } else if categories < 2 {
                0.5
            } else {
                category[j] as f32 / (categories - 1) as f32
            }
        };
        let output = series
            .iter()
            .zip(raw)
            .enumerate()
            .map(|(i, (s, bars))| {
                let (mut bases, mut strokes, mut fills) = (Vec::new(), Vec::new(), Vec::new());
                if kind == "bar" {
                    bases = bars
                        .iter()
                        .map(|p| normal(p.map_or(0., |p| p.0), min, max))
                        .collect();
                } else if !scatter {
                    // Like Swift's stacking, each value stacks on the earlier values of
                    // its sign at that x, and a null adds nothing. Unlike Swift, which
                    // bridges a null and overlaps the bands above it, a null is a gap.
                    // A revisited category turns the line back, like Swift's marks in
                    // data order; the area fills each direction as its own band.
                    let points = bars
                        .iter()
                        .enumerate()
                        .map(|(j, p)| p.map(|p| (position(j), p)))
                        .collect::<Vec<_>>();
                    for run in points.split(Option::is_none).filter(|r| !r.is_empty()) {
                        let run = run.iter().flatten().copied().collect::<Vec<_>>();
                        let top = run.iter().map(|&(x, (_, y))| (x, y)).collect::<Vec<_>>();
                        strokes.extend(clip(&top, min, max).0);
                        if kind == "area" {
                            for piece in monotone(&run) {
                                let edge = |f: fn((f64, f64)) -> f64| {
                                    let edge = piece.iter().map(|&(x, p)| (x, f(p)));
                                    clip(&edge.collect::<Vec<_>>(), min, max).1
                                };
                                let mut fill = edge(|p| p.1);
                                fill.extend(edge(|p| p.0).into_iter().rev());
                                fills.push(fill);
                            }
                        }
                    }
                }
                let points = bars
                    .into_iter()
                    .enumerate()
                    .map(|(j, p)| {
                        p.filter(|&(_, y)| kind == "bar" || (min..=max).contains(&y))
                            .map(|(_, y)| (position(j), normal(y, min, max)))
                    })
                    .collect();
                Series {
                    name: display_label(s["name"].as_str().unwrap_or("")),
                    color: s["color"]
                        .as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| format!("chart{}", i % 6 + 1)),
                    points,
                    bases,
                    strokes,
                    fills,
                    values: s["values"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .map(Value::as_f64)
                        .collect(),
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
            let indices = if categories <= 12 {
                firsts
            } else {
                vec![firsts[0], firsts[categories - 1]]
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
            categories,
            x_label: display_label(v["xLabel"].as_str().unwrap_or("")),
            unit: display_label(
                v["yLabel"]
                    .as_str()
                    .or_else(|| v["unit"].as_str())
                    .unwrap_or(""),
            ),
            x: x.iter().map(label).collect(),
            positions: (0..x.len()).map(position).collect(),
            value_unit: display_label(v["unit"].as_str().unwrap_or("")),
        })
    }
}
/// Fixed, network-free native expected-tree cases. No generated source execution.
pub(crate) fn synthetic_fixture(index: usize) -> (&'static str, Value) {
    let mut root = if index == 11 {
        serde_json::json!({"type":"chart","kind":"scatter","height":220,"x":[100,-5,2],"series":[{"name":"Samples","values":[1,2,3]}],"xLabel":"Numeric domain","yLabel":"Value"})
    } else if index == 15 {
        serde_json::json!({"type":"chart","kind":"area","height":220,"yMin":0,"yMax":10,"unit":"%","x":["Mon","Tue","Wed","Thu","Fri"],"series":[{"name":"Load","values":[4,40,6,-30,5],"color":"chart1"}]})
    } else if index == 16 {
        serde_json::json!({"type":"chart","kind":"area","stacked":true,"height":220,"yMin":-4,"yMax":8,"unit":"GB","x":["Mon","Tue","Wed","Thu","Fri"],"series":[{"name":"Cache","values":[2,3,-2,2,3],"color":"chart1"},{"name":"Logs","values":[3,2,1,null,2],"color":"chart2"},{"name":"Media","values":[4,5,-1,2,6],"color":"chart3"}],"xLabel":"Day","yLabel":"Storage"})
    } else if index == 17 {
        serde_json::json!({"type":"column","children":[
            {"type":"chart","kind":"bar","height":220,"unit":"GB","x":["Mon","Tue","Mon","Wed"],"series":[{"name":"Cache","values":[2,3,1,null],"color":"chart1"},{"name":"Logs","values":[-1,2,-2,4],"color":"chart2"}],"xLabel":"Day","yLabel":"Storage"},
            {"type":"chart","kind":"line","height":160,"unit":"%","x":["Mon","Tue","Mon"],"series":[{"name":"Load","values":[0,8,4],"color":"chart1"}]}
        ]})
    } else {
        serde_json::json!({"type":"chart","kind":"bar","stacked":true,"height":220,"x":["North","South","Zero"],"series":[{"name":"First","values":[2,-2,0],"color":"chart1"},{"name":"Second","values":[3,-4,0],"color":"chart2"},{"name":"Third","values":[-1,1,null],"color":"chart3"}],"xLabel":"Region","yLabel":"Units"})
    };
    let title = match index {
        11 => "Unsorted numeric scatter",
        15 => "Clipped out-of-range area",
        16 => "Stacked signed area",
        17 => "Repeated categories",
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
    fn close(actual: &[Vec<(f32, f32)>], expected: &[Vec<(f32, f32)>]) {
        assert_eq!(actual.len(), expected.len(), "{actual:?}");
        for (a, e) in actual.iter().flatten().zip(expected.iter().flatten()) {
            assert!(
                (a.0 - e.0).abs() < 1e-6 && (a.1 - e.1).abs() < 1e-6,
                "{actual:?}"
            );
        }
        let lengths = |v: &[Vec<(f32, f32)>]| v.iter().map(Vec::len).collect::<Vec<_>>();
        assert_eq!(lengths(actual), lengths(expected));
    }
    #[test]
    fn scale_ticks_are_readable_and_finite_for_signed_constant_and_extreme_domains() {
        for (low, high) in [(-6., 10.), (3., 3.), (-1e308, 1e308), (5e-324, 1e-323)] {
            let chart = Chart::parse(
                &json!({"kind":"bar","x":["a"],"yMin":low,"yMax":high,"series":[{"values":[1]}]}),
            )
            .unwrap();
            let ticks = chart.ticks();
            assert!(!ticks.is_empty());
            assert!(ticks.len() <= 5);
            for (at, label) in &ticks {
                assert!((0.0..=1.0).contains(at));
                assert!(label.parse::<f64>().unwrap().is_finite(), "{label}");
                assert!(label.len() <= 12, "{label}");
            }
            if low == high {
                assert_eq!(ticks[0], (0.5, "3".into()));
            }
        }
        let chart = Chart::parse(&json!({"height":100,"kind":"bar","x":["a"],"yMin":-2,"yMax":2,"series":[{"values":[1]}]})).unwrap();
        assert_eq!(
            chart.ticks(),
            vec![(0., "-2".into()), (0.5, "0".into()), (1., "2".into())]
        );
        let close = Chart::parse(
            &json!({"kind":"bar","x":["a"],"yMin":100000,"yMax":100001,"series":[{"values":[1]}]}),
        )
        .unwrap();
        assert!(close.ticks().windows(2).all(|p| p[0].1 != p[1].1));
    }
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
            json!({"kind":"area","stacked":true,"x":["a"],"series":[{"values":[1e308]},{"values":[1e308]}]}),
            json!({"kind":"bar","x":["a","a"],"series":[{"values":[1e308,1e308]}]}),
        ] {
            assert!(Chart::parse(&value).is_err());
        }
    }
    #[test]
    fn stacked_areas_stack_by_sign_break_at_nulls_and_keep_values() {
        // Stacks: a 0..2, 2..3, 3..6; b 0..-2, 0..1, 1..4; c 0..2, gap, 2..5.
        let mut value = json!({"kind":"area","stacked":true,"unit":"GB","x":["a","b","c"],
            "series":[{"name":"s","values":[2,-2,2]},{"name":"t","values":[1,1,null]},{"name":"u","values":[3,3,3]}]});
        let c = Chart::parse(&value).unwrap();
        assert_eq!(c.range, (-2., 6.));
        let n = |v: f32| (v + 2.) / 8.;
        // A band whose value changes sign crosses its own base; it is one outline.
        close(
            &c.series[0].fills,
            &[vec![
                (0., n(2.)),
                (0.5, n(-2.)),
                (1., n(2.)),
                (1., n(0.)),
                (0.5, n(0.)),
                (0., n(0.)),
            ]],
        );
        close(
            &c.series[0].strokes,
            &[vec![(0., n(2.)), (0.5, n(-2.)), (1., n(2.))]],
        );
        // Positive values stack on positives only; the null ends the band and adds
        // nothing to the stack at c.
        close(
            &c.series[1].fills,
            &[vec![(0., n(3.)), (0.5, n(1.)), (0.5, n(0.)), (0., n(2.))]],
        );
        assert_eq!(c.series[1].points[2], None);
        close(
            &c.series[2].fills,
            &[vec![
                (0., n(6.)),
                (0.5, n(4.)),
                (1., n(5.)),
                (1., n(2.)),
                (0.5, n(1.)),
                (0., n(3.)),
            ]],
        );
        // Hover dots sit on each band's top; readouts keep published values.
        assert_eq!(c.series[2].points[0], Some((0., 1.)));
        let r = c.readout(1).unwrap();
        assert_eq!(
            r.rows.iter().map(|r| r.2.as_str()).collect::<Vec<_>>(),
            ["-2 GB", "1 GB", "3 GB"]
        );
        assert_eq!(c.readout(2).unwrap().rows.len(), 2, "gaps are omitted");
        assert_eq!(c.step(Some(1), Step::Next), Some(2));
        assert_eq!(c.nearest(0.9), Some(2));

        // An explicit domain clips bands at its edges with exact crossings.
        value["yMin"] = json!(-1);
        value["yMax"] = json!(4);
        let c = Chart::parse(&value).unwrap();
        let n = |v: f32| (v + 1.) / 5.;
        close(
            &c.series[0].strokes,
            &[
                vec![(0., n(2.)), (0.375, 0.)],
                vec![(0.625, 0.), (1., n(2.))],
            ],
        );
        close(
            &c.series[0].fills,
            &[vec![
                (0., n(2.)),
                (0.375, 0.),
                (0.5, 0.),
                (0.625, 0.),
                (1., n(2.)),
                (1., n(0.)),
                (0.5, n(0.)),
                (0., n(0.)),
            ]],
        );
        // The top band leaves the domain: its fill holds at the top edge.
        close(
            &c.series[2].fills,
            &[vec![
                (0., 1.),
                (0.5, 1.),
                (1., 1.),
                (1., n(2.)),
                (0.5, n(1.)),
                (0., n(3.)),
            ]],
        );
        assert!(c.series[2].strokes.is_empty());
        assert_eq!(c.series[2].points[0], None);
        assert_eq!(c.readout(0).unwrap().rows[2].2, "3 GB");

        // Signed stacks at the widest finite values stay finite and inside the plot.
        let c = Chart::parse(&json!({"kind":"area","stacked":true,"x":["a","b"],
            "series":[{"values":[1e308,-1e308]},{"values":[-1e308,1e308]},{"values":[5e-324,null]}]}))
        .unwrap();
        assert_eq!(c.range, (-1e308, 1e308));
        for p in c
            .series
            .iter()
            .flat_map(|s| s.fills.iter().chain(&s.strokes))
            .flatten()
        {
            assert!(
                (0.0..=1.0).contains(&p.0) && (0.0..=1.0).contains(&p.1),
                "{p:?}"
            );
        }
    }
    #[test]
    fn duplicate_categories_share_a_position_stack_bars_and_revisit_lines() {
        // Stacked bars: a repeated label stacks onto the category by sign, in
        // series then entry order, and keeps one axis label.
        let c = Chart::parse(&json!({"kind":"bar","stacked":true,"x":["a","b","a"],
            "series":[{"name":"s","values":[2,1,-1]},{"name":"t","values":[3,null,4]}]}))
        .unwrap();
        assert_eq!(c.categories, 2);
        assert_eq!(c.labels, ["a", "b"]);
        assert_eq!(c.label_positions, [0.25, 0.75]);
        assert_eq!(c.positions, [0.25, 0.75, 0.25]);
        assert_eq!(c.range, (-1., 9.));
        let n = |v: f32| (v + 1.) / 10.;
        assert_eq!(c.series[0].points[2], Some((0.25, n(-1.))));
        assert_eq!(c.series[0].bases[2], n(0.));
        assert_eq!(c.series[1].bases[0], n(2.));
        assert_eq!(c.series[1].bases[2], n(5.));
        assert_eq!(c.series[1].points[2], Some((0.25, n(9.))));
        // The pointer reads the category's first entry; keys reach every entry in
        // plot order, and each readout keeps its own published values.
        assert_eq!(c.nearest(0.2), Some(0));
        let values = |i: usize| {
            let r = c.readout(i).unwrap();
            assert_eq!(r.label, ["a", "b", "a"][i]);
            r.rows.into_iter().map(|r| r.2).collect::<Vec<_>>()
        };
        assert_eq!(values(0), ["2", "3"]);
        assert_eq!(values(2), ["-1", "4"]);
        assert_eq!(values(1), ["1"]);
        assert_eq!(c.step(None, Step::Next), Some(0));
        assert_eq!(c.step(Some(0), Step::Next), Some(2));
        assert_eq!(c.step(Some(2), Step::Next), Some(1));
        assert_eq!(c.step(Some(1), Step::Previous), Some(2));
        assert_eq!(c.step(Some(1), Step::Last), Some(1));

        // Unstacked bars stack only within their own series' bar.
        let c =
            Chart::parse(&json!({"kind":"bar","x":["a","a"],"series":[{"values":[2,3]}]})).unwrap();
        assert_eq!(c.range, (0., 5.));
        assert_eq!(c.series[0].bases, [0., 0.4]);
        assert_eq!(c.series[0].points[1], Some((0.5, 1.)));
        let c = Chart::parse(&json!({"kind":"bar","x":["a","b","a"],
            "series":[{"values":[1,1,1]},{"values":[2,2,-2]}]}))
        .unwrap();
        assert_eq!(c.range, (-2., 2.));
        let n = |v: f32| (v + 2.) / 4.;
        assert_eq!(c.series[0].bases[2], n(1.));
        assert_eq!(c.series[0].points[2], Some((0.25, n(2.))));
        assert_eq!(c.series[1].bases[2], n(0.));
        assert_eq!(c.series[1].points[2], Some((0.25, n(-2.))));
        // The widest finite values stack finitely (an overflowing sum is refused).
        let c =
            Chart::parse(&json!({"kind":"bar","x":["a","a"],"series":[{"values":[1e308,-1e308]}]}))
                .unwrap();
        assert_eq!(c.range, (-1e308, 1e308));
        assert_eq!(c.series[0].bases, [0.5, 0.5]);

        // A line revisits its category in data order; a null still ends the run.
        let mut value = json!({"kind":"line","x":["a","b","a","c","b"],
            "series":[{"name":"s","values":[0,4,2,null,4]}]});
        let line = Chart::parse(&value).unwrap();
        assert_eq!(line.labels, ["a", "b", "c"]);
        assert_eq!(line.label_positions, [0., 0.5, 1.]);
        close(
            &line.series[0].strokes,
            &[vec![(0., 0.), (0.5, 1.), (0., 0.5)], vec![(0.5, 1.)]],
        );
        assert_eq!(line.series[0].points[2], Some((0., 0.5)));
        assert_eq!(line.nearest(0.), Some(0));
        assert_eq!(line.nearest(1.), Some(1), "c has no value; b's first entry");
        let mut at = None;
        let order = std::iter::from_fn(|| {
            let next = line.step(at, Step::Next);
            (next != at).then(|| {
                at = next;
                next.unwrap()
            })
        })
        .collect::<Vec<_>>();
        assert_eq!(order, [0, 2, 1, 4]);
        // The area fills each direction of the turn as its own band.
        value["kind"] = json!("area");
        let area = Chart::parse(&value).unwrap();
        assert_eq!(area.series[0].strokes, line.series[0].strokes);
        close(
            &area.series[0].fills,
            &[
                vec![(0., 0.), (0.5, 1.), (0.5, 0.), (0., 0.)],
                vec![(0.5, 1.), (0., 0.5), (0., 0.), (0.5, 0.)],
                vec![(0.5, 1.), (0.5, 0.)],
            ],
        );
        // Consecutive entries at one category draw a vertical stroke and no fill.
        let area = Chart::parse(&json!({"kind":"area","x":["a","a","b"],
            "series":[{"values":[1,3,2]}]}))
        .unwrap();
        let n = |v: f32| v / 3.;
        close(
            &area.series[0].strokes,
            &[vec![(0., n(1.)), (0., n(3.)), (1., n(2.))]],
        );
        close(
            &area.series[0].fills,
            &[vec![(0., n(3.)), (1., n(2.)), (1., 0.), (0., 0.)]],
        );
        // Stacked areas stack a revisited category on its earlier values.
        let area = Chart::parse(&json!({"kind":"area","stacked":true,"x":["a","b","a"],
            "series":[{"values":[1,1,1]},{"values":[1,1,1]}]}))
        .unwrap();
        assert_eq!(area.range, (0., 4.));
        let n = |v: f32| v / 4.;
        close(
            &area.series[0].fills,
            &[
                vec![(0., n(1.)), (1., n(1.)), (1., 0.), (0., 0.)],
                vec![(1., n(1.)), (0., n(2.)), (0., n(1.)), (1., 0.)],
            ],
        );
        close(
            &area.series[1].fills,
            &[
                vec![(0., n(3.)), (1., n(2.)), (1., n(1.)), (0., n(2.))],
                vec![(1., n(2.)), (0., n(4.)), (0., n(3.)), (1., n(1.))],
            ],
        );

        // Dense axes count distinct categories, not entries.
        let x = (0..20)
            .map(|i| json!(format!("c{}", i % 4)))
            .collect::<Vec<_>>();
        let c =
            Chart::parse(&json!({"kind":"line","x":x,"series":[{"values":vec![1;20]}]})).unwrap();
        assert_eq!(c.labels, ["c0", "c1", "c2", "c3"]);
        let x = (0..26)
            .map(|i| json!(format!("c{}", i % 13)))
            .collect::<Vec<_>>();
        let c =
            Chart::parse(&json!({"kind":"bar","x":x,"series":[{"values":vec![1;26]}]})).unwrap();
        assert_eq!(c.labels, ["c0", "c12"]);
        assert_eq!(c.label_positions, [0.5 / 13., 12.5 / 13.]);
    }
    #[test]
    fn out_of_domain_lines_areas_and_points_clip_at_the_edges_and_keep_values() {
        // x at 0, 0.25, 0.5, 0.75, 1; domain [0, 10].
        let value = json!({"kind":"line","yMin":0,"yMax":10,"x":["a","b","c","d","e"],
            "series":[{"name":"s","values":[5,15,5,null,20]},{"name":"t","values":[-10,20,-10,8,8]}]});
        let line = Chart::parse(&value).unwrap();
        let s = &line.series[0];
        // 5 -> 15 leaves at 10 halfway; 15 -> 5 returns halfway. A lone out-of-range
        // value after the gap draws nothing.
        close(
            &s.strokes,
            &[vec![(0., 0.5), (0.125, 1.)], vec![(0.375, 1.), (0.5, 0.5)]],
        );
        assert!(s.fills.is_empty(), "lines have no fill");
        assert_eq!(s.points[1], None, "no hover dot outside the plot");
        assert_eq!(s.points[2], Some((0.5, 0.5)));
        assert_eq!(s.values[1], Some(15.), "source values stay");
        assert_eq!(s.values[4], Some(20.));
        // A segment crossing the whole domain draws edge to edge, both ways; the
        // in-range tail continues. Every stroke stays inside the plot.
        let t = &line.series[1];
        close(
            &t.strokes,
            &[
                vec![(1. / 12., 0.), (1. / 6., 1.)],
                vec![(1. / 3., 1.), (5. / 12., 0.)],
                vec![(0.5 + 0.25 * 10. / 18., 0.), (0.75, 0.8), (1., 0.8)],
            ],
        );
        let r = line.readout(4).unwrap();
        assert_eq!(r.rows[0].2, "20");
        assert_eq!(line.nearest(1.), Some(4), "out-of-range values still read");
        assert_eq!(line.step(Some(3), Step::Next), Some(4));

        let mut value = value;
        value["kind"] = json!("area");
        let area = Chart::parse(&value).unwrap();
        assert_eq!(area.series[0].strokes, line.series[0].strokes);
        // Fill outlines hold at the edges, so they reach only the plot's edge, and
        // close along the baseline.
        close(
            &area.series[0].fills,
            &[
                vec![
                    (0., 0.5),
                    (0.125, 1.),
                    (0.25, 1.),
                    (0.375, 1.),
                    (0.5, 0.5),
                    (0.5, 0.),
                    (0.25, 0.),
                    (0., 0.),
                ],
                vec![(1., 1.), (1., 0.)],
            ],
        );
        assert_eq!(area.baseline, 0.);
        for p in area
            .series
            .iter()
            .flat_map(|s| s.fills.iter().chain(&s.strokes))
            .flatten()
        {
            assert!(
                (0.0..=1.0).contains(&p.0) && (0.0..=1.0).contains(&p.1),
                "{p:?}"
            );
        }

        value["kind"] = json!("scatter");
        value["x"] = json!([3, 1, 2, 5, 4]);
        let scatter = Chart::parse(&value).unwrap();
        assert_eq!(scatter.series[0].points[1], None);
        assert_eq!(scatter.series[0].points[0], Some((0.5, 0.5)));
        assert!(scatter.series[0].strokes.is_empty());
        assert_eq!(scatter.readout(1).unwrap().rows[0].2, "15");
    }
    #[test]
    fn clipping_touching_extreme_and_lone_points_stays_finite() {
        // Touching an edge from outside has no visible length; a lone in-range
        // value is a dot.
        let c = Chart::parse(&json!({"kind":"line","yMax":10,"x":["a","b","c","d","e"],
            "series":[{"values":[20,10,20,null,4]}]}))
        .unwrap();
        close(&c.series[0].strokes, &[vec![(1., 0.4)]]);
        assert_eq!(c.series[0].points[1], Some((0.25, 1.)));
        // The widest finite values crossing a subnormal domain keep finite crossings.
        for (min, max) in [(5e-324, 1e-323), (-1e308, 1e308), (-1., 1.)] {
            let c = Chart::parse(
                &json!({"kind":"area","yMin":min,"yMax":max,"x":["a","b","c"],
                "series":[{"values":[-1.7e308,1.7e308,-1.7e308]}]}),
            )
            .unwrap();
            let s = &c.series[0];
            assert_eq!(s.strokes.len(), 2);
            for p in s.fills.iter().chain(&s.strokes).flatten() {
                assert!(
                    (0.0..=1.0).contains(&p.0) && (0.0..=1.0).contains(&p.1),
                    "{p:?}"
                );
            }
            assert!(s.strokes[0][0].0 <= s.strokes[0][1].0);
            assert!(s.strokes[0][0].0 > 0. && s.strokes[1][1].0 < 1.);
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
    #[test]
    fn readout_picks_the_nearest_entry_with_values_and_formats_every_series() {
        let bars = Chart::parse(&json!({"kind":"bar","stacked":true,"unit":"ms","x":["North","South","West"],"series":[{"name":"Observed","values":[4,7,null]},{"name":"Forecast","values":[6,null,null]}]})).unwrap();
        assert_eq!(bars.nearest(0.), Some(0));
        assert_eq!(bars.nearest(0.5), Some(1));
        // West has no values, so the pointer over it reads its nearest neighbour.
        assert_eq!(bars.nearest(1.), Some(1));
        assert_eq!(
            bars.readout(0),
            Some(Readout {
                label: "North".into(),
                rows: vec![
                    (0, "Observed".into(), "4 ms".into()),
                    (1, "Forecast".into(), "6 ms".into())
                ],
            })
        );
        assert_eq!(bars.readout(1).unwrap().rows.len(), 1, "gaps are omitted");
        assert_eq!(bars.readout(2), None);
        assert_eq!(bars.readout(9), None);
        let scatter = Chart::parse(
            &json!({"kind":"scatter","yLabel":"Value","x":[100,-5,2],"series":[{"name":"s","values":[1.5,2,3]}]}),
        )
        .unwrap();
        // Positions follow the numeric domain, not input order.
        assert_eq!(scatter.nearest(0.), Some(1));
        assert_eq!(scatter.nearest(0.07), Some(2));
        assert_eq!(scatter.nearest(0.9), Some(0));
        let r = scatter.readout(0).unwrap();
        assert_eq!((r.label.as_str(), r.rows[0].2.as_str()), ("100", "1.5"));
        let line = Chart::parse(&json!({"kind":"line","x":["a","b","c","d","e"],"series":[{"name":"s","values":[1,2,3,4,5]}]})).unwrap();
        assert_eq!(line.positions, vec![0., 0.25, 0.5, 0.75, 1.]);
        assert_eq!(line.nearest(0.6), Some(2));
    }
    #[test]
    fn keyboard_steps_follow_plot_order_and_skip_entries_without_values() {
        let line = Chart::parse(&json!({"kind":"line","x":["a","b","c","d"],"series":[{"name":"s","values":[null,2,null,4]},{"name":"t","values":[null,null,3,null]}]})).unwrap();
        assert_eq!(line.step(None, Step::Next), Some(1));
        assert_eq!(line.step(None, Step::Previous), Some(3));
        assert_eq!(
            line.step(Some(1), Step::Next),
            Some(2),
            "any series value counts"
        );
        assert_eq!(line.step(Some(3), Step::Next), Some(3), "stops at the end");
        assert_eq!(
            line.step(Some(1), Step::Previous),
            Some(1),
            "stops at the start"
        );
        assert_eq!(line.step(Some(2), Step::Last), Some(3));
        assert_eq!(line.step(Some(3), Step::First), Some(1));
        // An entry without values (or out of range) restarts like no entry.
        assert_eq!(line.step(Some(0), Step::Next), Some(1));
        assert_eq!(line.step(Some(9), Step::Previous), Some(3));
        let scatter = Chart::parse(
            &json!({"kind":"scatter","x":[100,-5,2],"series":[{"name":"s","values":[1,2,3]}]}),
        )
        .unwrap();
        assert_eq!(scatter.step(None, Step::First), Some(1));
        assert_eq!(scatter.step(Some(1), Step::Next), Some(2));
        assert_eq!(scatter.step(Some(2), Step::Next), Some(0));
        let empty =
            Chart::parse(&json!({"kind":"bar","x":["a"],"series":[{"values":[null]}]})).unwrap();
        assert_eq!(empty.step(None, Step::Next), None);
    }
}
