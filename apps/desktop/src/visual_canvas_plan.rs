//! Finite bounded native geometry, prepared off UI. Unsupported transforms are explicit.
use crate::visual_drawing::Drawing;
#[derive(Clone, Copy, Debug)]
pub(crate) struct Paint {
    pub(crate) stroke: bool,
    pub(crate) color: usize,
    pub(crate) opacity: f32,
    pub(crate) width: f32,
}
#[derive(Debug)]
pub(crate) enum Primitive {
    Path {
        points: Vec<[f32; 2]>,
        closed: bool,
        paint: Paint,
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
    pub(crate) cost: usize,
}
#[derive(Clone, Copy)]
struct State {
    m: [f64; 6],
    opacity: f64,
}
impl State {
    fn point(&self, x: f64, y: f64) -> Result<[f32; 2], &'static str> {
        let [a, b, c, d, e, f] = self.m;
        let p = [a * x + c * y + e, b * x + d * y + f];
        if p.iter().any(|n| !n.is_finite() || n.abs() > 65_536.) {
            return Err("Canvas coordinates exceed native geometry bounds");
        }
        Ok([p[0] as f32, p[1] as f32])
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
        if d.commands > 512 {
            return Err("Canvas exceeds native512-command display budget");
        }
        if !(1.0..=2000.).contains(&width) || !(24.0..=600.).contains(&height) {
            return Err("Canvas dimensions exceed native limits");
        }
        let mut plan = Self {
            width: width as f32,
            height: height as f32,
            primitives: Vec::new(),
            cost: 0,
        };
        let mut state = State {
            m: [1., 0., 0., 1., 0., 0.],
            opacity: 1.,
        };
        let mut stack = Vec::new();
        let mut i = 0;
        let mut text_bytes = 0;
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
                        for (cx, cy, start) in [
                            (right - r, top + r, -std::f64::consts::FRAC_PI_2),
                            (right - r, bottom - r, 0.),
                            (left + r, bottom - r, std::f64::consts::FRAC_PI_2),
                            (left + r, top + r, std::f64::consts::PI),
                        ] {
                            for j in 0..=12 {
                                let t = start + j as f64 / 12. * std::f64::consts::FRAC_PI_2;
                                points.push(state.point(cx + r * t.cos(), cy + r * t.sin())?);
                            }
                        }
                    }
                    plan.path(points, true, paint)?;
                }
                11. => {
                    let n = &d.ops[i..i + 7];
                    i += 7;
                    let paint = state.paint(n)?;
                    let mut points = Vec::new();
                    for j in 0..64 {
                        let t = j as f64 / 64. * std::f64::consts::TAU;
                        points.push(state.point(n[4] + n[6] * t.cos(), n[5] + n[6] * t.sin())?);
                    }
                    plan.path(points, true, paint)?;
                }
                12. => {
                    let n = &d.ops[i..i + 8];
                    i += 8;
                    plan.path(
                        vec![state.point(n[4], n[5])?, state.point(n[6], n[7])?],
                        false,
                        state.paint(n)?,
                    )?;
                }
                13. => {
                    let n = &d.ops[i..i + 6];
                    i += 6;
                    let count = n[5] as usize;
                    if count > 4096 {
                        return Err("Canvas path exceeds native4096-point budget");
                    }
                    let mut points = Vec::new();
                    for _ in 0..count {
                        points.push(state.point(d.ops[i], d.ops[i + 1])?);
                        i += 2;
                    }
                    plan.path(points, n[4] == 1., state.paint(n)?)?;
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
                    let segments =
                        ((sweep.abs() / std::f64::consts::TAU * 64.).ceil() as usize).max(1);
                    let mut points = Vec::new();
                    for j in 0..=segments {
                        let t = n[8] + sweep * j as f64 / segments as f64;
                        points.push(state.point(n[4] + n[6] * t.cos(), n[5] + n[6] * t.sin())?);
                    }
                    if !paint.stroke {
                        if n[7] > 0. {
                            for j in (0..=segments).rev() {
                                let t = n[8] + sweep * j as f64 / segments as f64;
                                points.push(
                                    state.point(n[4] + n[7] * t.cos(), n[5] + n[7] * t.sin())?,
                                );
                            }
                        } else {
                            points.push(state.point(n[4], n[5])?);
                        }
                    }
                    plan.path(points, !paint.stroke, paint)?;
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
                    text_bytes += text.len();
                    if text_bytes > 4096 {
                        return Err("Canvas text exceeds native4096-byte budget");
                    }
                    plan.cost += text.len().div_ceil(4) + 8;
                    let at = state.point(n[2], n[3])?;
                    if at[0] < -128.
                        || at[1] < -128.
                        || at[0] > plan.width + 128.
                        || at[1] > plan.height + 128.
                    {
                        return Err(
                            "Canvas text clipping outside native viewport margin is not implemented",
                        );
                    }
                    plan.primitives.push(Primitive::Text {
                        text,
                        at,
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
            if plan.cost > 4096 {
                return Err("Canvas exceeds aggregate native display budget");
            }
        }
        Ok(plan)
    }
    fn path(
        &mut self,
        points: Vec<[f32; 2]>,
        closed: bool,
        paint: Paint,
    ) -> Result<(), &'static str> {
        if points.iter().any(|p| {
            p[0] < -128. || p[1] < -128. || p[0] > self.width + 128. || p[1] > self.height + 128.
        }) {
            return Err("Canvas clipping outside native viewport margin is not implemented");
        }
        self.cost += points.len() + 8;
        if self.cost > 4096 {
            return Err("Canvas exceeds native4096 geometry budget");
        }
        self.primitives.push(Primitive::Path {
            points,
            closed,
            paint,
        });
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::visual_drawing::tests::encode;
    #[test]
    fn finite_transforms_and_budgets_reject_before_native_tessellation() {
        let d = Drawing::decode(&encode(
            3,
            &[3., 10., 20., 5., 2., 2., 11., 1., 2., 1., 0., 1., 2., 3.],
            &[],
        ))
        .unwrap();
        let p = Plan::compile(&d, 760., 160.).unwrap();
        assert!(
            matches!(&p.primitives[0],Primitive::Path{points,..}if points.iter().all(|p|p[0].is_finite()&&p[1].is_finite()))
        );
        let huge = Drawing::decode(&encode(1, &[11., 1., 2., 1., 0., 1e308, 0., 1.], &[])).unwrap();
        assert!(Plan::compile(&huge, 760., 160.).is_err());
        let outside =
            Drawing::decode(&encode(1, &[11., 1., 2., 1., 0., 5000., 50., 10.], &[])).unwrap();
        assert!(Plan::compile(&outside, 760., 160.).is_err());
        let badstroke = Drawing::decode(&encode(
            2,
            &[5., 2., 3., 11., 2., 2., 1., 1., 10., 10., 3.],
            &[],
        ))
        .unwrap();
        assert!(Plan::compile(&badstroke, 760., 160.).is_err());
    }
}
