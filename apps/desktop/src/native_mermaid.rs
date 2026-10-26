//! Closed native flowchart subset. No skipped statements, source execution or I/O.
//! Audited against Swift NativeMermaid/MermaidKit 2.4.0; deliberately does not
//! port its permissive parser (which silently ignores statements). See docs/native-mermaid.md.
use std::collections::{BTreeMap, VecDeque};
use std::sync::Arc;
use unicode_segmentation::UnicodeSegmentation;

#[derive(Clone, Debug)]
pub(crate) struct Prepared {
    pub(crate) source: Arc<str>,
    pub(crate) diagram: Result<Arc<Diagram>, Bad>,
}
impl Prepared {
    pub(crate) fn new(source: &str) -> Self {
        Self {
            source: source.into(),
            diagram: prepare(source).map(Arc::new),
        }
    }
}

pub(crate) type Bad = &'static str;
pub(crate) const MAX_SOURCE: usize = 20 * 1024;
const MAX_NODES: usize = 48;
const MAX_EDGES: usize = 96;
const MAX_STATEMENTS: usize = 192;
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Shape {
    Rectangle,
    Rounded,
    Diamond,
}
#[derive(Clone, Debug)]
pub(crate) struct Node {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) shape: Shape,
    explicit: bool,
}
#[derive(Clone, Debug)]
pub(crate) struct Edge {
    pub(crate) from: usize,
    pub(crate) to: usize,
    pub(crate) arrow: bool,
    pub(crate) label: String,
}
#[derive(Clone, Debug)]
pub(crate) struct Graph {
    pub(crate) nodes: Vec<Node>,
    pub(crate) edges: Vec<Edge>,
    horizontal: bool,
    reverse: bool,
}
#[derive(Clone, Debug)]
pub(crate) struct BoxedNode {
    pub(crate) node: Node,
    pub(crate) x: f32,
    pub(crate) y: f32,
}
#[derive(Clone, Debug)]
pub(crate) struct Route {
    pub(crate) edge: Edge,
    pub(crate) points: Vec<[f32; 2]>,
    pub(crate) label_at: [f32; 2],
}
#[derive(Clone, Debug)]
pub(crate) struct Diagram {
    pub(crate) nodes: Vec<BoxedNode>,
    pub(crate) routes: Vec<Route>,
    pub(crate) width: f32,
    pub(crate) height: f32,
}
pub(crate) const NODE_W: f32 = 240.;
pub(crate) const NODE_H: f32 = 88.;

/// O(source bytes), bounded slices before any graph allocation; no regex/backtracking.
fn statements(source: &str) -> Result<Vec<&str>, Bad> {
    if source.len() > MAX_SOURCE {
        return Err("Diagram exceeds the 20 KiB source limit.");
    }
    if source
        .chars()
        .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
    {
        return Err("Control characters are not supported.");
    }
    let mut result = Vec::new();
    let mut start = 0;
    let mut close = None;
    let mut quoted = false;
    for (i, c) in source.char_indices() {
        if c == '"' {
            quoted = !quoted;
        }
        if !quoted {
            if let Some(end) = close {
                if c == end {
                    close = None;
                }
            } else {
                close = match c {
                    '[' => Some(']'),
                    '(' => Some(')'),
                    '{' => Some('}'),
                    '|' => Some('|'),
                    _ => None,
                };
                if matches!(c, '\n' | ';') {
                    let s = source[start..i].trim();
                    if !s.is_empty() {
                        if result.len() >= MAX_STATEMENTS {
                            return Err("Too many diagram statements.");
                        }
                        result.push(s);
                    }
                    start = i + c.len_utf8();
                }
            }
        }
    }
    if close.is_some() || quoted {
        return Err("Unclosed diagram label.");
    }
    let s = source[start..].trim();
    if !s.is_empty() {
        if result.len() >= MAX_STATEMENTS {
            return Err("Too many diagram statements.");
        }
        result.push(s);
    }
    Ok(result)
}
fn label(raw: &str, max: usize) -> Result<String, Bad> {
    let raw = raw.trim();
    let text = if raw.starts_with('"') && raw.ends_with('"') && raw.len() >= 2 {
        &raw[1..raw.len() - 1]
    } else {
        raw
    };
    if text.is_empty()
        || text.len() > 512
        || text.graphemes(true).take(max + 1).count() > max
        || text.chars().any(|c| {
            c.is_control()
                || matches!(
                    c,
                    '<' | '>' | '&' | '`' | '\\' | '"' | '[' | ']' | '{' | '}' | '(' | ')' | '|'
                )
                || matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
    {
        return Err("Label exceeds limits or uses unsupported markup/escapes.");
    }
    Ok(text.into())
}
struct Cursor<'a>(&'a str);
impl<'a> Cursor<'a> {
    fn space(&mut self) {
        self.0 = self.0.trim_start();
    }
    fn take(&mut self, token: &str) -> bool {
        self.space();
        if let Some(rest) = self.0.strip_prefix(token) {
            self.0 = rest;
            true
        } else {
            false
        }
    }
    fn endpoint(
        &mut self,
        graph: &mut Graph,
        ids: &mut BTreeMap<String, usize>,
    ) -> Result<usize, Bad> {
        self.space();
        let n = self
            .0
            .bytes()
            .take_while(|b| b.is_ascii_alphanumeric() || *b == b'_')
            .count();
        if n == 0 || n > 64 || !self.0.as_bytes()[0].is_ascii_alphabetic() {
            return Err("Expected an ASCII node ID (letter, then letters/digits/underscore).");
        }
        let id = &self.0[..n];
        self.0 = &self.0[n..];
        if [
            "end",
            "subgraph",
            "style",
            "class",
            "classDef",
            "click",
            "direction",
            "linkStyle",
        ]
        .contains(&id)
        {
            return Err("Subgraphs, styling and actions are not supported natively.");
        }
        self.space();
        let syntax = [
            ('[', ']', Shape::Rectangle),
            ('(', ')', Shape::Rounded),
            ('{', '}', Shape::Diamond),
        ]
        .into_iter()
        .find(|(open, _, _)| self.0.starts_with(*open));
        let (text, shape, explicit) = if let Some((_, close, shape)) = syntax {
            self.0 = &self.0[1..];
            let end = self.0.find(close).ok_or("Unclosed node.")?;
            let text = label(
                &self.0[..end],
                if shape == Shape::Diamond { 16 } else { 48 },
            )?;
            self.0 = &self.0[end + 1..];
            (text, shape, true)
        } else {
            (id.into(), Shape::Rectangle, false)
        };
        if let Some(&ix) = ids.get(id) {
            if explicit {
                let old = &mut graph.nodes[ix];
                if old.explicit && (old.label != text || old.shape != shape) {
                    return Err("Conflicting node declarations are not supported.");
                }
                old.label = text;
                old.shape = shape;
                old.explicit = true;
            }
            return Ok(ix);
        }
        if graph.nodes.len() == MAX_NODES {
            return Err("Diagram exceeds 48 nodes.");
        }
        let ix = graph.nodes.len();
        graph.nodes.push(Node {
            id: id.into(),
            label: text,
            shape,
            explicit,
        });
        ids.insert(id.into(), ix);
        Ok(ix)
    }
}
pub(crate) fn parse(source: &str) -> Result<Graph, Bad> {
    let statements = statements(source)?;
    let mut statements = statements
        .into_iter()
        .filter(|s| !s.starts_with("%%") || s.starts_with("%%{"));
    let header = statements.next().ok_or("Empty Mermaid source.")?;
    let parts: Vec<_> = header.split_whitespace().take(4).collect();
    if parts.len() != 2
        || !["flowchart", "graph"].contains(&parts[0])
        || !["TD", "TB", "BT", "LR", "RL"].contains(&parts[1])
    {
        return Err("Native subset supports flowchart/graph TD, TB, BT, LR and RL only.");
    }
    let mut graph = Graph {
        nodes: Vec::new(),
        edges: Vec::new(),
        horizontal: matches!(parts[1], "LR" | "RL"),
        reverse: matches!(parts[1], "BT" | "RL"),
    };
    let mut ids = BTreeMap::new();
    for statement in statements {
        let mut cursor = Cursor(statement);
        let mut from = cursor.endpoint(&mut graph, &mut ids)?;
        cursor.space();
        while !cursor.0.is_empty() {
            let arrow = if cursor.take("-->") {
                true
            } else if cursor.take("---") {
                false
            } else {
                return Err("Unsupported statement or edge syntax. No partial diagram is shown.");
            };
            let text = if cursor.take("|") {
                let end = cursor.0.find('|').ok_or("Unclosed edge label.")?;
                let text = label(&cursor.0[..end], 24)?;
                cursor.0 = &cursor.0[end + 1..];
                text
            } else {
                String::new()
            };
            let to = cursor.endpoint(&mut graph, &mut ids)?;
            if graph.edges.len() == MAX_EDGES {
                return Err("Diagram exceeds 96 edges.");
            }
            if from == to || graph.edges.iter().any(|e| e.from == from && e.to == to) {
                return Err("Self links and parallel edges are not supported natively.");
            }
            graph.edges.push(Edge {
                from,
                to,
                arrow,
                label: text,
            });
            from = to;
            cursor.space();
        }
    }
    if graph.nodes.is_empty() {
        return Err("Diagram has no nodes.");
    }
    Ok(graph)
}

/// Stable longest-path ranks, dummy slots for long links, unique label lanes.
/// No recursive graph walks or unbounded crossing-minimization. All ranks/slots
/// are capped before expansion; all coordinates bounded before presentation.
pub(crate) fn prepare(source: &str) -> Result<Diagram, Bad> {
    let graph = parse(source)?;
    let n = graph.nodes.len();
    let mut degree = vec![0; n];
    let mut rank = vec![0usize; n];
    for e in &graph.edges {
        degree[e.to] += 1;
    }
    let mut queue: VecDeque<_> = (0..n).filter(|i| degree[*i] == 0).collect();
    let mut visited = 0;
    while let Some(i) = queue.pop_front() {
        visited += 1;
        for edge in graph.edges.iter().filter(|e| e.from == i) {
            rank[edge.to] = rank[edge.to].max(rank[i] + 1);
            degree[edge.to] -= 1;
            if degree[edge.to] == 0 {
                queue.push_back(edge.to);
            }
        }
    }
    if visited != n {
        return Err("Cycles are not supported by this native layout. Exact source is retained.");
    }
    let depth = rank.iter().copied().max().unwrap() + 1;
    if depth > 24 {
        return Err("Diagram exceeds 24 layout ranks.");
    }
    let slots = n + graph
        .edges
        .iter()
        .map(|e| rank[e.to] - rank[e.from] - 1)
        .sum::<usize>();
    if slots > 128 {
        return Err("Diagram exceeds 128 layout slots.");
    }
    let mut layers = vec![Vec::new(); depth];
    for (i, r) in rank.iter().enumerate() {
        layers[*r].push(i);
    }
    let mut segments = Vec::new();
    let mut next = n;
    for e in &graph.edges {
        let mut chain = vec![e.from];
        for layer in layers.iter_mut().take(rank[e.to]).skip(rank[e.from] + 1) {
            layer.push(next);
            chain.push(next);
            next += 1;
        }
        chain.push(e.to);
        segments.push(chain);
    }
    let max_breadth = layers.iter().map(Vec::len).max().unwrap();
    let breadth_step = if graph.horizontal {
        NODE_H + 32.
    } else {
        NODE_W + 32.
    };
    let primary_size = if graph.horizontal { NODE_W } else { NODE_H };
    let mut primary = vec![24.; depth];
    let mut lane_step = vec![if graph.horizontal { 32. } else { 24. }; depth];
    let mut gap_lanes = vec![0usize; depth];
    for e in &graph.edges {
        for lanes in gap_lanes.iter_mut().take(rank[e.to]).skip(rank[e.from]) {
            *lanes += 1;
        }
        if !e.label.is_empty() {
            lane_step[rank[e.from]] = if graph.horizontal { 208. } else { 48. };
        }
    }
    for r in 1..depth {
        primary[r] =
            primary[r - 1] + primary_size + 24. + gap_lanes[r - 1] as f32 * lane_step[r - 1];
    }
    let full_primary = primary[depth - 1] + primary_size + 24.;
    let full_breadth = max_breadth as f32 * breadth_step + 176.;
    if full_primary > 8192. || full_breadth > 8192. || full_primary * full_breadth > 16_777_216. {
        return Err("Diagram exceeds native coordinate/area limits.");
    }
    let mut positions = vec![[0.; 2]; slots];
    for (r, layer) in layers.iter().enumerate() {
        let inset = (max_breadth - layer.len()) as f32 * breadth_step / 2. + 24.;
        for (col, &i) in layer.iter().enumerate() {
            let p = if graph.reverse {
                full_primary - primary[r] - primary_size
            } else {
                primary[r]
            };
            let b = inset + col as f32 * breadth_step;
            positions[i] = if graph.horizontal { [p, b] } else { [b, p] };
        }
    }
    let nodes = graph
        .nodes
        .iter()
        .enumerate()
        .map(|(i, node)| BoxedNode {
            node: node.clone(),
            x: positions[i][0],
            y: positions[i][1],
        })
        .collect();
    let mut lanes = vec![0; depth];
    let mut routes = Vec::new();
    for (e, chain) in graph.edges.iter().zip(segments) {
        let mut points = Vec::new();
        let mut label_at = [0.; 2];
        for (segment, pair) in chain.windows(2).enumerate() {
            let a = positions[pair[0]];
            let b = positions[pair[1]];
            let r = rank[e.from] + segment;
            let lane = primary[r]
                + primary_size
                + 12.
                + lane_step[r] / 2.
                + lanes[r] as f32 * lane_step[r];
            lanes[r] += 1;
            let lane = if graph.reverse {
                full_primary - lane
            } else {
                lane
            };
            let (start, end) = if graph.horizontal {
                (
                    [
                        a[0] + if graph.reverse { 0. } else { NODE_W },
                        a[1] + NODE_H / 2.,
                    ],
                    [
                        b[0] + if graph.reverse { NODE_W } else { 0. },
                        b[1] + NODE_H / 2.,
                    ],
                )
            } else {
                (
                    [
                        a[0] + NODE_W / 2.,
                        a[1] + if graph.reverse { 0. } else { NODE_H },
                    ],
                    [
                        b[0] + NODE_W / 2.,
                        b[1] + if graph.reverse { NODE_H } else { 0. },
                    ],
                )
            };
            let (p, q) = if graph.horizontal {
                ([lane, start[1]], [lane, end[1]])
            } else {
                ([start[0], lane], [end[0], lane])
            };
            if segment == 0 {
                label_at = if graph.horizontal {
                    [lane - 72., start[1] - 38.]
                } else {
                    [start[0] + 8., lane - 34.]
                };
            }
            points.extend([start, p, q, end]);
        }
        routes.push(Route {
            edge: e.clone(),
            points,
            label_at,
        });
    }
    let (width, height) = if graph.horizontal {
        (full_primary, full_breadth)
    } else {
        (full_breadth, full_primary)
    };
    Ok(Diagram {
        nodes,
        routes,
        width,
        height,
    })
}

/// Presentation wrapping preserves grapheme clusters. The original labels and
/// exact source remain available for copying, rather than claiming wrapped text
/// is the original Mermaid source.
pub(crate) fn wrapped(text: &str, columns: usize) -> String {
    let mut out = String::new();
    for (i, g) in text.graphemes(true).enumerate() {
        if i > 0 && i % columns == 0 {
            out.push('\n');
        }
        out.push_str(g);
    }
    out
}

#[cfg(test)]
#[path = "native_mermaid_tests.rs"]
mod tests;
