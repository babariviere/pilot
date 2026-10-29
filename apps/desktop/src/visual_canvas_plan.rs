//! Finite native canvas geometry, tessellated off the UI thread into triangle
//! batches. The PD1 decoder already enforces the published draw contract
//! (20,000 commands, 100,000 path points, 64 Ki UTF-16 of text); this adds only
//! the native geometry guards below. Unsupported transforms are explicit.
use crate::visual_drawing::Drawing;
use lyon_tessellation::{
    FillGeometryBuilder, FillOptions, FillTessellator, FillVertex, GeometryBuilder,
    GeometryBuilderError, StrokeGeometryBuilder, StrokeOptions, StrokeTessellator, StrokeVertex,
    VertexId, math::Point, path::Polygon,
};
/// Triangle vertices one canvas frame may hold. Each becomes a ~110-byte GPU
/// vertex every frame, and GPUI drops a frame whose instance data exceeds
/// 256 MiB, so this keeps one canvas under half of that. It also stops hostile
/// self-intersecting fills, whose tessellation would otherwise grow without bound.
pub(crate) const MAX_VERTICES: usize = 1 << 20;
const TOO_DETAILED: &str = "Canvas exceeds the native limit of 1,048,576 triangle vertices";
/// Points in one filled free-form path. Sweep tessellation of a fill costs
/// points × edges crossing the sweep line, so a hostile path is quadratic.
/// Built-in shapes and strokes are linear and have no such limit.
pub(crate) const FILL_POINTS: usize = 4096;
#[derive(Clone, Copy, Debug)]
struct Paint {
    stroke: bool,
    color: usize,
    opacity: f32,
    width: f32,
}
#[derive(Debug)]
pub(crate) enum Primitive {
    /// Consecutive shapes of one color, as triangles (three vertices each) in
    /// canvas units, in drawing order.
    Triangles {
        vertices: Vec<[f32; 2]>,
        /// Top-left and bottom-right corners of `vertices`.
        bounds: [[f32; 2]; 2],
        color: usize,
        opacity: f32,
    },
    Text {
        text: String,
        at: [f32; 2],
        color: usize,
        opacity: f32,
        size: f32,
        weight: f32,
        align: usize,
        baseline: usize,
        mono: bool,
    },
}
#[derive(Debug)]
pub(crate) struct Plan {
    pub(crate) width: f32,
    pub(crate) height: f32,
    pub(crate) primitives: Vec<Primitive>,
}
#[derive(Clone, Copy)]
struct State {
    m: [f64; 6],
    opacity: f64,
}
impl State {
    fn point(&self, x: f64, y: f64) -> Result<Point, &'static str> {
        let [a, b, c, d, e, f] = self.m;
        let p = [a * x + c * y + e, b * x + d * y + f];
        if p.iter().any(|n| !n.is_finite() || n.abs() > 65_536.) {
            return Err("Canvas coordinates exceed native geometry bounds");
        }
        Ok(Point::new(p[0] as f32, p[1] as f32))
    }
    /// Segments for a full circle of radius `r`, so chords stay within a tenth
    /// of a canvas unit of the true curve: small dots stay cheap, large circles smooth.
    fn segments(&self, r: f64) -> usize {
        let [a, b, c, d, _, _] = self.m;
        let r = r * a.hypot(b).max(c.hypot(d));
        if r <= 0.1 {
            return 8;
        }
        let step = (1. - 0.1 / r).acos();
        ((std::f64::consts::PI / step).ceil() as usize).clamp(8, 64)
    }
    fn checked(&self) -> Result<(), &'static str> {
        if self.m.iter().any(|n| !n.is_finite() || n.abs() > 1e6) {
            return Err("Canvas transform exceeds native bounds");
        }
        Ok(())
    }
    fn scale(&self) -> Result<f64, &'static str> {
        let [a, b, c, d, _, _] = self.m;
        let sx = a.hypot(b);
        let sy = c.hypot(d);
        if (sx - sy).abs() > 1e-6 * sx.max(sy).max(1.)
            || (a * c + b * d).abs() > 1e-6 * sx.max(1.) * sy.max(1.)
        {
            return Err("Non-uniform/sheared canvas strokes are not implemented");
        }
        Ok(sx)
    }
    fn paint(&self, n: &[f64]) -> Result<Paint, &'static str> {
        let stroke = n[0] == 2.;
        let width = if stroke { n[3] * self.scale()? } else { 0. };
        if !width.is_finite() || width > 128. {
            return Err("Canvas stroke exceeds native width limit");
        }
        Ok(Paint {
            stroke,
            color: n[1] as usize,
            opacity: (n[2] * self.opacity) as f32,
            width: width as f32,
        })
    }
}
impl Plan {
    pub(crate) fn compile(d: &Drawing, width: f64, height: f64) -> Result<Self, &'static str> {
        if !(1.0..=2000.).contains(&width) || !(24.0..=600.).contains(&height) {
            return Err("Canvas dimensions exceed native limits");
        }
        let mut plan = Self {
            width: width as f32,
            height: height as f32,
            primitives: Vec::new(),
        };
        let mut tessellator = Tessellator::default();
        let mut state = State {
            m: [1., 0., 0., 1., 0., 0.],
            opacity: 1.,
        };
        let mut stack = Vec::new();
        let mut i = 0;
        while i < d.ops.len() {
            let op = d.ops[i];
            i += 1;
            match op {
                1. => stack.push(state),
                2. => state = stack.pop().ok_or("Invalid canvas restore")?,
                3. => {
                    let x = d.ops[i];
                    let y = d.ops[i + 1];
                    let [a, b, c, e, tx, ty] = state.m;
                    state.m[4] = tx + a * x + c * y;
                    state.m[5] = ty + b * x + e * y;
                    i += 2;
                    state.checked()?;
                }
                4. => {
                    let (s, c) = d.ops[i].sin_cos();
                    let [a, b, x, e, _, _] = state.m;
                    state.m[0] = a * c + x * s;
                    state.m[1] = b * c + e * s;
                    state.m[2] = x * c - a * s;
                    state.m[3] = e * c - b * s;
                    i += 1;
                    state.checked()?;
                }
                5. => {
                    let x = d.ops[i];
                    let y = d.ops[i + 1];
                    state.m[0] *= x;
                    state.m[1] *= x;
                    state.m[2] *= y;
                    state.m[3] *= y;
                    i += 2;
                    state.checked()?;
                }
                6. => {
                    state.opacity *= d.ops[i];
                    i += 1;
                }
                10. => {
                    let n = &d.ops[i..i + 9];
                    i += 9;
                    let paint = state.paint(n)?;
                    let (x, y, w, h) = (n[4], n[5], n[6], n[7]);
                    let left = x.min(x + w);
                    let right = x.max(x + w);
                    let top = y.min(y + h);
                    let bottom = y.max(y + h);
                    let r = n[8].min((right - left) / 2.).min((bottom - top) / 2.);
                    let mut points = Vec::new();
                    if r == 0. {
                        for (x, y) in [(left, top), (right, top), (right, bottom), (left, bottom)] {
                            points.push(state.point(x, y)?);
                        }
                    } else {
                        let quarter = state.segments(r).div_ceil(4).max(2);
                        for (cx, cy, start) in [
                            (right - r, top + r, -std::f64::consts::FRAC_PI_2),
                            (right - r, bottom - r, 0.),
                            (left + r, bottom - r, std::f64::consts::FRAC_PI_2),
                            (left + r, top + r, std::f64::consts::PI),
                        ] {
                            for j in 0..=quarter {
                                let t =
                                    start + j as f64 / quarter as f64 * std::f64::consts::FRAC_PI_2;
                                points.push(state.point(cx + r * t.cos(), cy + r * t.sin())?);
                            }
                        }
                    }
                    tessellator.convex(&mut plan, &points, paint)?;
                }
                11. => {
                    let n = &d.ops[i..i + 7];
                    i += 7;
                    let paint = state.paint(n)?;
                    let segments = state.segments(n[6]);
                    let mut points = Vec::with_capacity(segments);
                    for j in 0..segments {
                        let t = j as f64 / segments as f64 * std::f64::consts::TAU;
                        points.push(state.point(n[4] + n[6] * t.cos(), n[5] + n[6] * t.sin())?);
                    }
                    tessellator.convex(&mut plan, &points, paint)?;
                }
                12. => {
                    let n = &d.ops[i..i + 8];
                    i += 8;
                    tessellator.path(
                        &mut plan,
                        &[state.point(n[4], n[5])?, state.point(n[6], n[7])?],
                        false,
                        state.paint(n)?,
                    )?;
                }
                13. => {
                    let n = &d.ops[i..i + 6];
                    i += 6;
                    let count = n[5] as usize;
                    let mut points = Vec::with_capacity(count);
                    for _ in 0..count {
                        points.push(state.point(d.ops[i], d.ops[i + 1])?);
                        i += 2;
                    }
                    tessellator.path(&mut plan, &points, n[4] == 1., state.paint(n)?)?;
                }
                14. => {
                    let n = &d.ops[i..i + 10];
                    i += 10;
                    let paint = state.paint(n)?;
                    let sweep = n[9] - n[8];
                    if !sweep.is_finite() {
                        return Err("Canvas arc exceeds native bounds");
                    }
                    let sweep = sweep.clamp(-std::f64::consts::TAU, std::f64::consts::TAU);
                    let full = state.segments(n[6]) as f64;
                    let segments =
                        ((sweep.abs() / std::f64::consts::TAU * full).ceil() as usize).max(1);
                    let ring = |r: f64| {
                        (0..=segments)
                            .map(|j| {
                                let t = n[8] + sweep * j as f64 / segments as f64;
                                state.point(n[4] + r * t.cos(), n[5] + r * t.sin())
                            })
                            .collect::<Result<Vec<_>, _>>()
                    };
                    let outer = ring(n[6])?;
                    if paint.stroke {
                        tessellator.path(&mut plan, &outer, false, paint)?;
                    } else if n[7] > 0. {
                        tessellator.band(&mut plan, &outer, &ring(n[7])?, paint)?;
                    } else {
                        tessellator.fan(&mut plan, state.point(n[4], n[5])?, &outer, paint)?;
                    }
                }
                20. => {
                    let n = &d.ops[i..i + 10];
                    i += 10;
                    let [a, b, c, e, _, _] = state.m;
                    let scale = state.scale()?;
                    if b.abs() > 1e-6 || c.abs() > 1e-6 || a <= 0. || e <= 0. {
                        return Err("Rotated/mirrored canvas text is not implemented");
                    }
                    let size = [11., 13., 15., 20., 26.][n[5] as usize] * scale;
                    if size > 128. {
                        return Err("Canvas text exceeds native font limit");
                    }
                    let text = d.strings[n[4] as usize].clone();
                    let at = state.point(n[2], n[3])?;
                    plan.primitives.push(Primitive::Text {
                        text,
                        at: [at.x, at.y],
                        color: n[0] as usize,
                        opacity: (n[1] * state.opacity) as f32,
                        size: size as f32,
                        weight: n[6] as f32,
                        align: n[7] as usize,
                        baseline: n[8] as usize,
                        mono: n[9] == 1.,
                    });
                }
                _ => return Err("Unknown native canvas command"),
            }
        }
        for primitive in &mut plan.primitives {
            if let Primitive::Triangles {
                vertices, bounds, ..
            } = primitive
            {
                *bounds = vertices
                    .iter()
                    .fold([[f32::MAX; 2], [f32::MIN; 2]], |[lo, hi], p| {
                        [
                            [lo[0].min(p[0]), lo[1].min(p[1])],
                            [hi[0].max(p[0]), hi[1].max(p[1])],
                        ]
                    });
            }
        }
        Ok(plan)
    }
    /// Total triangle vertices across every batch.
    pub(crate) fn vertices(&self) -> usize {
        self.primitives
            .iter()
            .map(|p| match p {
                Primitive::Triangles { vertices, .. } => vertices.len(),
                Primitive::Text { .. } => 0,
            })
            .sum()
    }
}
#[derive(Default)]
struct Tessellator {
    fill: FillTessellator,
    stroke: StrokeTessellator,
    points: Vec<Point>,
    total: usize,
}
impl Tessellator {
    /// The open batch of this paint's color, or a new one after it.
    fn batch(plan: &mut Plan, paint: Paint) -> &mut Vec<[f32; 2]> {
        let same = matches!(plan.primitives.last(), Some(Primitive::Triangles { color, opacity, .. })
            if *color == paint.color && opacity.to_bits() == paint.opacity.to_bits());
        if !same {
            plan.primitives.push(Primitive::Triangles {
                vertices: Vec::new(),
                bounds: [[0.; 2]; 2],
                color: paint.color,
                opacity: paint.opacity,
            });
        }
        match plan.primitives.last_mut() {
            Some(Primitive::Triangles { vertices, .. }) => vertices,
            _ => unreachable!("a triangle batch was just ensured"),
        }
    }
    fn hidden(paint: Paint) -> bool {
        paint.opacity == 0. || (paint.stroke && paint.width == 0.)
    }
    /// Appends `count` triangles directly; built-in shapes need no sweep.
    fn direct(
        &mut self,
        plan: &mut Plan,
        paint: Paint,
        count: usize,
        triangles: impl Iterator<Item = [Point; 3]>,
    ) -> Result<(), &'static str> {
        let count = count * 3;
        if self.total + count > MAX_VERTICES {
            return Err(TOO_DETAILED);
        }
        self.total += count;
        Self::batch(plan, paint).extend(triangles.flatten().map(|p| [p.x, p.y]));
        Ok(())
    }
    /// A convex outline: filled as a fan from its first point, or stroked closed.
    fn convex(
        &mut self,
        plan: &mut Plan,
        points: &[Point],
        paint: Paint,
    ) -> Result<(), &'static str> {
        match points.split_first() {
            _ if paint.stroke => self.path(plan, points, true, paint),
            Some((&hub, rim)) => self.fan(plan, hub, rim, paint),
            None => Ok(()),
        }
    }
    /// Triangles from `hub` to each rim edge: convex shapes and pie slices.
    fn fan(
        &mut self,
        plan: &mut Plan,
        hub: Point,
        rim: &[Point],
        paint: Paint,
    ) -> Result<(), &'static str> {
        if Self::hidden(paint) {
            return Ok(());
        }
        let count = rim.len().saturating_sub(1);
        self.direct(
            plan,
            paint,
            count,
            rim.windows(2).map(|w| [hub, w[0], w[1]]),
        )
    }
    /// The band between two matching arcs: an annulus sector.
    fn band(
        &mut self,
        plan: &mut Plan,
        outer: &[Point],
        inner: &[Point],
        paint: Paint,
    ) -> Result<(), &'static str> {
        if Self::hidden(paint) {
            return Ok(());
        }
        let quads = outer.windows(2).zip(inner.windows(2));
        let triangles = quads.flat_map(|(o, i)| [[o[0], o[1], i[0]], [i[0], o[1], i[1]]]);
        let count = outer.len().min(inner.len()).saturating_sub(1) * 2;
        self.direct(plan, paint, count, triangles)
    }
    /// Free-form paths and every stroke, through lyon. Strokes are linear in
    /// their points; fills are capped at [`FILL_POINTS`] and a bounded number
    /// of self-intersections.
    fn path(
        &mut self,
        plan: &mut Plan,
        points: &[Point],
        closed: bool,
        paint: Paint,
    ) -> Result<(), &'static str> {
        if points.len() < 2 || Self::hidden(paint) {
            return Ok(());
        }
        if !paint.stroke && points.len() > FILL_POINTS {
            return Err("Canvas filled path exceeds the native limit of 4,096 points");
        }
        let left = MAX_VERTICES - self.total;
        // A simple n-point fill needs 3(n - 2) vertices; allow some crossings.
        let crossing = (!paint.stroke).then(|| 3 * (points.len() + 1024));
        let room = crossing.map_or(left, |c| c.min(left));
        let vertices = Self::batch(plan, paint);
        let before = vertices.len();
        self.points.clear();
        let mut sink = Sink {
            points: &mut self.points,
            out: vertices,
            room,
            full: false,
        };
        let polygon = Polygon { points, closed };
        let result = if paint.stroke {
            let options = StrokeOptions::default().with_line_width(paint.width);
            self.stroke.tessellate_polygon(polygon, &options, &mut sink)
        } else {
            self.fill
                .tessellate_polygon(polygon, &FillOptions::default(), &mut sink)
        };
        let full = sink.full;
        self.total += vertices.len() - before;
        if full && room < left {
            return Err("Canvas filled path crosses itself too often to draw natively");
        }
        if full {
            return Err(TOO_DETAILED);
        }
        result.map_err(|_| "Canvas path could not be tessellated natively")
    }
}
/// Writes triangles straight into a batch. `room` is the plan's remaining
/// vertex allowance; exceeding it aborts tessellation instead of allocating more.
struct Sink<'a> {
    points: &'a mut Vec<Point>,
    out: &'a mut Vec<[f32; 2]>,
    room: usize,
    full: bool,
}
impl Sink<'_> {
    fn vertex(&mut self, p: Point) -> Result<VertexId, GeometryBuilderError> {
        if self.full || self.points.len() >= self.room {
            self.full = true;
            return Err(GeometryBuilderError::TooManyVertices);
        }
        self.points.push(p);
        Ok(VertexId(self.points.len() as u32 - 1))
    }
}
impl GeometryBuilder for Sink<'_> {
    fn add_triangle(&mut self, a: VertexId, b: VertexId, c: VertexId) {
        if self.room < 3 {
            self.full = true;
            return;
        }
        self.room -= 3;
        for id in [a, b, c] {
            let p = self.points[id.0 as usize];
            self.out.push([p.x, p.y]);
        }
    }
}
impl FillGeometryBuilder for Sink<'_> {
    fn add_fill_vertex(&mut self, v: FillVertex) -> Result<VertexId, GeometryBuilderError> {
        self.vertex(v.position())
    }
}
impl StrokeGeometryBuilder for Sink<'_> {
    fn add_stroke_vertex(&mut self, v: StrokeVertex) -> Result<VertexId, GeometryBuilderError> {
        self.vertex(v.position())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::visual_drawing::tests::encode;
    fn plan(commands: usize, ops: &[f64], strings: &[String]) -> Result<Plan, &'static str> {
        Plan::compile(
            &Drawing::decode(&encode(commands, ops, strings)).unwrap(),
            680.,
            160.,
        )
    }
    fn batches(p: &Plan) -> Vec<(usize, usize)> {
        p.primitives
            .iter()
            .filter_map(|p| match p {
                Primitive::Triangles {
                    vertices, color, ..
                } => Some((*color, vertices.len())),
                Primitive::Text { .. } => None,
            })
            .collect()
    }
    /// Sum of triangle areas, so tests can check geometry, not just counts.
    fn area(p: &Plan) -> f32 {
        p.primitives
            .iter()
            .filter_map(|p| match p {
                Primitive::Triangles { vertices, .. } => Some(vertices),
                Primitive::Text { .. } => None,
            })
            .flat_map(|v| v.chunks_exact(3))
            .map(|t| {
                ((t[1][0] - t[0][0]) * (t[2][1] - t[0][1])
                    - (t[2][0] - t[0][0]) * (t[1][1] - t[0][1]))
                    .abs()
                    / 2.
            })
            .sum()
    }
    #[test]
    fn finite_transforms_and_budgets_reject_before_native_tessellation() {
        let p = plan(
            3,
            &[3., 10., 20., 5., 2., 2., 11., 1., 2., 1., 0., 1., 2., 3.],
            &[],
        )
        .unwrap();
        assert!(
            matches!(&p.primitives[0], Primitive::Triangles { vertices, .. }
            if !vertices.is_empty() && vertices.iter().all(|p| p[0].is_finite() && p[1].is_finite()))
        );
        assert!(plan(1, &[11., 1., 2., 1., 0., 1e308, 0., 1.], &[]).is_err());
        // Shapes past the viewport are clipped while painting, not refused.
        assert!(plan(1, &[11., 1., 2., 1., 0., 5000., 50., 10.], &[]).is_ok());
        assert!(plan(1, &[11., 1., 2., 1., 0., 70_000., 50., 10.], &[]).is_err());
        assert!(plan(2, &[5., 2., 3., 11., 2., 2., 1., 1., 10., 10., 3.], &[]).is_err());
    }
    /// 768 commands, past the old 512 cliff: every cell is planned, in order.
    #[test]
    fn valid_canvas_over_512_commands_plans_every_shape() {
        let mut ops = Vec::new();
        for i in 0..768 {
            let (x, y) = ((i % 32) as f64 * 20., (i / 32) as f64 * 6.);
            ops.extend([
                10.,
                1.,
                (i % 13) as f64,
                1.,
                0.,
                x + 2.,
                y + 1.,
                16.,
                4.,
                0.,
            ]);
        }
        let p = plan(768, &ops, &[]).unwrap();
        let b = batches(&p);
        assert_eq!(b.len(), 768, "a color change starts a new batch");
        assert!(
            b.iter()
                .enumerate()
                .all(|(i, &(c, n))| c == i % 13 && n == 6)
        );
        assert!((area(&p) - 768. * 64.).abs() < 0.5, "{}", area(&p));
        // The same grid in one color is one batch.
        for chunk in ops.chunks_exact_mut(10) {
            chunk[2] = 7.;
        }
        assert_eq!(batches(&plan(768, &ops, &[]).unwrap()), vec![(7, 768 * 6)]);
    }
    /// A representative large chart: grid lines, 3000 dots, a 5000-point line and labels.
    #[test]
    fn practical_large_drawing_plans_completely() {
        let (mut ops, mut strings, mut commands) = (Vec::new(), Vec::new(), 0);
        for k in 0..40 {
            let x = 10. + k as f64 * 16.;
            ops.extend([12., 2., 6., 1., 1., x, 0., x, 160.]);
            commands += 1;
        }
        for k in 0..3000 {
            let (x, y) = ((k * 37 % 660) as f64 + 10., (k * 53 % 140) as f64 + 10.);
            ops.extend([11., 1., 7. + (k % 3) as f64, 0.8, 0., x, y, 2.5]);
            commands += 1;
        }
        ops.extend([13., 2., 2., 1., 1.5, 0., 5000.]);
        for k in 0..5000 {
            ops.extend([k as f64 * 0.132, 80. + (k as f64 / 40.).sin() * 60.]);
        }
        commands += 1;
        for k in 0..60 {
            strings.push(format!("label {k}"));
            ops.extend([
                20.,
                1.,
                1.,
                k as f64 * 11.,
                150.,
                k as f64,
                0.,
                400.,
                0.,
                0.,
                0.,
            ]);
            commands += 1;
        }
        let started = std::time::Instant::now();
        let p = plan(commands, &ops, &strings).unwrap();
        let texts = p
            .primitives
            .iter()
            .filter(|p| matches!(p, Primitive::Text { .. }))
            .count();
        assert_eq!(texts, 60);
        assert!(p.vertices() < MAX_VERTICES / 4, "{}", p.vertices());
        eprintln!(
            "{commands} commands: {} vertices, {} batches in {:?}",
            p.vertices(),
            p.primitives.len(),
            started.elapsed()
        );
    }
    /// The largest ordinary drawings the published contract admits still plan.
    #[test]
    fn contract_scale_drawings_plan() {
        let mut dots = Vec::new();
        for k in 0..20_000 {
            dots.extend([
                11.,
                1.,
                7.,
                1.,
                0.,
                (k % 670) as f64 + 5.,
                (k / 670) as f64 * 5. + 5.,
                3.,
            ]);
        }
        let started = std::time::Instant::now();
        let p = plan(20_000, &dots, &[]).unwrap();
        eprintln!(
            "20000 dots: {} vertices in {:?}",
            p.vertices(),
            started.elapsed()
        );
        let mut line = vec![13., 2., 2., 1., 2., 0., 99_999.];
        for k in 0..99_999 {
            line.extend([k as f64 * 0.0068, 80. + (k as f64 / 500.).sin() * 70.]);
        }
        let started = std::time::Instant::now();
        let p = plan(1, &line, &[]).unwrap();
        eprintln!(
            "99999-point line: {} vertices in {:?}",
            p.vertices(),
            started.elapsed()
        );
    }
    /// Batches never merge across text or another color, so paint order holds.
    #[test]
    fn batches_keep_drawing_order() {
        let rect = |c: f64| [10., 1., c, 1., 0., 0., 0., 10., 10., 0.];
        let mut ops = Vec::new();
        ops.extend(rect(7.));
        ops.extend(rect(7.));
        ops.extend([20., 1., 1., 0., 0., 0., 0., 400., 0., 0., 0.]);
        ops.extend(rect(7.));
        ops.extend(rect(8.));
        ops.extend(rect(7.));
        let p = plan(6, &ops, &["a".into()]).unwrap();
        assert_eq!(p.primitives.len(), 5);
        assert!(matches!(p.primitives[1], Primitive::Text { .. }));
        assert_eq!(batches(&p), vec![(7, 12), (7, 6), (8, 6), (7, 6)]);
    }
    /// A 10×1 line stroked 2 wide covers its 10×2 rectangle; zero-opacity shapes add nothing.
    #[test]
    fn strokes_tessellate_to_their_outline() {
        let p = plan(
            2,
            &[
                12., 2., 7., 1., 2., 0., 10., 10., 10., 11., 1., 7., 0., 0., 5., 5., 3.,
            ],
            &[],
        )
        .unwrap();
        assert!((area(&p) - 20.).abs() < 1e-3, "{}", area(&p));
        let p = plan(1, &[11., 1., 7., 1., 0., 50., 50., 40.], &[]).unwrap();
        let circle = std::f32::consts::PI * 1600.;
        assert!((area(&p) - circle).abs() / circle < 0.01, "{}", area(&p));
    }
    /// Hostile geometry stops at the native vertex limit, quickly and explicitly.
    #[test]
    fn oversized_geometry_is_refused_not_truncated() {
        // A self-intersecting star polygon has millions of crossings.
        let n = FILL_POINTS - 1;
        let mut star = vec![13., 1., 7., 1., 0., 1., n as f64];
        for i in 0..n {
            let t = (i * (n / 2) % n) as f64 / n as f64 * std::f64::consts::TAU;
            star.extend([340. + 70. * t.cos(), 80. + 70. * t.sin()]);
        }
        let started = std::time::Instant::now();
        assert_eq!(
            plan(1, &star, &[]).err(),
            Some("Canvas filled path crosses itself too often to draw natively")
        );
        eprintln!("hostile star refused in {:?}", started.elapsed());
        // Every edge of this comb spans the sweep: the quadratic case, at the cap.
        let mut comb = vec![13., 1., 7., 1., 0., 1., FILL_POINTS as f64];
        for i in 0..FILL_POINTS - 2 {
            comb.extend([i as f64 * 0.08, if i % 2 == 0 { 0. } else { 150. }]);
        }
        comb.extend([(FILL_POINTS - 3) as f64 * 0.08, 160., 0., 160.]);
        let started = std::time::Instant::now();
        assert!(plan(1, &comb, &[]).is_ok());
        eprintln!("{FILL_POINTS}-point comb filled in {:?}", started.elapsed());
        comb[6] += 1.;
        comb.extend([0., 155.]);
        assert_eq!(
            plan(1, &comb, &[]).err(),
            Some("Canvas filled path exceeds the native limit of 4,096 points")
        );
        // Strokes have no point limit: they tessellate in linear time.
        comb[1] = 2.;
        comb[4] = 1.;
        assert!(plan(1, &comb, &[]).is_ok());
        // So does an aggregate of individually ordinary shapes.
        let mut cards = Vec::new();
        for k in 0..20_000 {
            cards.extend([10., 1., 7., 1., 0., (k % 600) as f64, 10., 80., 80., 40.]);
        }
        assert_eq!(plan(20_000, &cards, &[]).err(), Some(TOO_DETAILED));
    }
}
