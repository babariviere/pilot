//! Project memory's existing depth-one browsing contract. No mutation or UI-fold memory.
use serde::Deserialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
pub(crate) struct Range {
    pub(crate) lo: u64,
    pub(crate) hi: u64,
}
impl Range {
    pub(crate) fn label(self) -> String {
        if self.lo == self.hi {
            format!("#{}", self.lo)
        } else {
            format!("#{}–{}", self.lo, self.hi)
        }
    }
    pub(crate) fn valid(self) -> bool {
        let size = self.hi.saturating_sub(self.lo).saturating_add(1);
        self.hi > self.lo && size.is_power_of_two() && self.lo.is_multiple_of(size)
    }
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Entry {
    pub(crate) index: u64,
    pub(crate) id: String,
    pub(crate) device_id: String,
    pub(crate) session_id: String,
    pub(crate) at: u64,
    pub(crate) text: String,
    pub(crate) replaced_by: Option<u64>,
    #[serde(default)]
    pub(crate) replaces: Vec<String>,
    // Keep canonical shared provenance intact. It never becomes a guessed Local chat link.
    pub(crate) shared_origin: Option<serde_json::Value>,
}
#[derive(Clone, Debug, Deserialize)]
pub(crate) struct Node {
    #[serde(flatten)]
    pub(crate) range: Range,
    pub(crate) text: Option<String>,
    pub(crate) entry: Option<Entry>,
    #[serde(default)]
    pub(crate) pending: bool,
    #[serde(default)]
    pub(crate) replaced: bool,
}
#[derive(Clone, Debug, Deserialize)]
pub(crate) struct Tree {
    pub(crate) count: u64,
    pub(crate) nodes: Vec<Node>,
    pub(crate) truncated: bool,
}
fn ranges(count: u64, range: Option<Range>) -> Vec<Range> {
    if let Some(r) = range {
        let size = r.hi - r.lo + 1;
        if size <= 16 {
            return (r.lo..=r.hi)
                .rev()
                .map(|i| Range { lo: i, hi: i })
                .collect();
        }
        let mid = r.lo + size / 2;
        return vec![
            Range { lo: mid, hi: r.hi },
            Range {
                lo: r.lo,
                hi: mid - 1,
            },
        ];
    }
    let mut out = Vec::new();
    let mut lo = 0;
    for bit in (0..53).rev() {
        let size = 1u64 << bit;
        if count - lo >= size {
            out.push(Range {
                lo,
                hi: lo + size - 1,
            });
            lo += size;
        }
    }
    out.reverse();
    out
}
impl Tree {
    pub(crate) fn parse(
        value: serde_json::Value,
        range: Option<Range>,
    ) -> Result<Self, &'static str> {
        let tree: Self =
            serde_json::from_value(value).map_err(|_| "Local returned malformed memory.")?;
        if tree.count > 9_007_199_254_740_991
            || range.is_some_and(|r| !r.valid() || r.hi >= tree.count)
            || tree.truncated
            || tree.nodes.iter().map(|n| n.range).collect::<Vec<_>>() != ranges(tree.count, range)
        {
            return Err(
                "Local returned an incomplete or mismatched memory range. Refresh to retry.",
            );
        }
        for n in &tree.nodes {
            if let Some(e) = &n.entry {
                if n.range.lo != n.range.hi
                    || e.index != n.range.lo
                    || n.text.as_deref() != Some(&e.text)
                    || !crate::local_model::valid_id(&e.session_id)
                    || e.id.is_empty()
                    || e.device_id.is_empty()
                    || e.replaced_by.is_some_and(|i| i >= tree.count)
                {
                    return Err("Local returned mismatched memory note identity.");
                }
            } else if n.range.lo == n.range.hi || (!n.pending && !n.replaced && n.text.is_none()) {
                return Err("Local returned an incomplete memory node.");
            }
        }
        Ok(tree)
    }
}

#[derive(Default)]
pub(crate) struct State {
    pub(crate) generation: u64,
    pub(crate) range: Option<Range>,
    pub(crate) tree: Option<Tree>,
    pub(crate) busy: bool,
    pub(crate) error: Option<&'static str>,
}
impl State {
    pub(crate) fn begin(&mut self, range: Option<Range>) -> u64 {
        self.generation += 1;
        if self.range != range {
            self.tree = None;
        }
        self.range = range;
        self.busy = true;
        self.error = None;
        self.generation
    }
    pub(crate) fn accept(
        &mut self,
        generation: u64,
        range: Option<Range>,
        result: Result<Tree, &'static str>,
    ) -> bool {
        if self.generation != generation || self.range != range {
            return false;
        }
        self.busy = false;
        match result {
            Ok(tree) => {
                self.tree = Some(tree);
                self.error = None;
            }
            Err(e) => self.error = Some(e),
        }
        true
    }
}
