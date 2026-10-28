//! The upstream selection model requires logical text identity, not reusable cells.
use nsh_core::{
    geometry::{Bounds, Point, Points, bounds, point, size},
    selection::{SelectionModel, SelectionTexts},
};

struct Texts(Vec<(u64, &'static str)>);

impl SelectionTexts for Texts {
    fn len(&self) -> usize {
        self.0.len()
    }
    fn content(&self, i: usize) -> &str {
        self.0[i].1
    }
    fn frame(&self, i: usize) -> Bounds<Points> {
        bounds(
            point(Points(0.), Points(i as f32 * 20.)),
            size(Points(200.), Points(20.)),
        )
    }
    fn offset_at(&self, _i: usize, _point: Point<Points>) -> u32 {
        0
    }
    fn key(&self, i: usize) -> u64 {
        self.0[i].0
    }
}

#[test]
fn reused_node_keys_retarget_selection_to_unrelated_items() {
    let mut selection = SelectionModel::new();
    selection.select_all(&Texts(vec![(10, "alpha"), (11, "beta")]));
    let recycled = Texts(vec![(10, "older"), (11, "other")]);
    selection.texts_changed(&recycled);
    // The old beta endpoint still selects four UTF-16 units of the new text.
    assert_eq!(selection.text(&recycled), "older\nothe");
}

#[test]
fn stable_item_keys_follow_prepend_but_do_not_retain_unmounted_text() {
    let mut selection = SelectionModel::new();
    selection.select_all(&Texts(vec![(10, "alpha"), (11, "beta")]));
    let prepended = Texts(vec![(9, "earlier"), (10, "alpha"), (11, "beta")]);
    selection.texts_changed(&prepended);
    assert_eq!(selection.text(&prepended), "alpha\nbeta");
    let unmounted = Texts(vec![(9, "earlier")]);
    selection.texts_changed(&unmounted);
    assert!(
        selection.is_empty(),
        "logical keys alone cannot preserve offscreen selection"
    );
}

#[test]
fn model_copies_the_supplied_order_including_duplicates() {
    let texts = Texts(vec![(11, "beta"), (12, "beta"), (10, "alpha")]);
    let mut selection = SelectionModel::new();
    selection.select_all(&texts);
    assert_eq!(selection.text(&texts), "beta\nbeta\nalpha");
}
