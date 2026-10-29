//! Ordinary Markdown ```mermaid fences, rendered by the bounded native subset.
//! Preparation runs inside the Markdown parse (background for appends and large
//! replacements), never in rendering. Only closed fences become diagrams; an
//! unclosed streaming fence stays an ordinary code block with its exact source.
use crate::native_mermaid::Prepared;
use gpui_kit::{
    IntoElement,
    base::text::{MarkdownNode, MarkdownParseContext, markdown_ast::Node},
    component::text::TextView,
    div,
};
use std::sync::Arc;

const NAME: &str = "mermaid-fence";

/// Keep the parser configuration stable before the first streamed fence.
/// Enabling it only when a marker arrives reparses the entire document and
/// clears an existing selection. The parser itself ignores non-Mermaid nodes.
pub(crate) fn install(view: TextView, owner: u64) -> TextView {
    view.markdown_block_parser(parse)
        .markdown_block_renderer(NAME, move |node, _, _| {
            let Some(prepared) = node.data::<Arc<Prepared>>() else {
                return div().into_any_element();
            };
            let start = node.source_range().map_or(0, |r| r.start);
            crate::native_mermaid_view::Element::new(
                format!("mermaid-fence-{owner}-{start}"),
                prepared.clone(),
            )
            .fence()
            .into_any_element()
        })
}

fn parse(node: &Node, cx: &MarkdownParseContext<'_>) -> Option<MarkdownNode> {
    let Node::Code(code) = node else {
        return None;
    };
    if !is_mermaid(code.lang.as_deref()) {
        return None;
    }
    let fence = cx.node_source(node)?;
    if !closed(fence) {
        return None;
    }
    Some(
        MarkdownNode::new(NAME, Arc::new(Prepared::new(&code.value)))
            .text(code.value.clone())
            .markdown(fence.to_string())
            .accessibility_label("Mermaid diagram"),
    )
}

/// Same rule as the Swift renderer: the info string's first token, any case.
fn is_mermaid(lang: Option<&str>) -> bool {
    lang.is_some_and(|l| l.eq_ignore_ascii_case("mermaid"))
}

/// Whether the fence's own source ends with a closing fence of the opening's
/// kind and length. Markdown closes an unterminated fence at the end of the
/// document, which is exactly what a still-streaming message looks like.
fn closed(fence: &str) -> bool {
    let mut lines = fence.lines();
    let open = lines.next().unwrap_or("").trim_start();
    let Some(mark) = open.chars().next().filter(|c| matches!(c, '`' | '~')) else {
        return false;
    };
    let length = open.chars().take_while(|c| *c == mark).count();
    let Some(last) = lines.last() else {
        return false;
    };
    // Container prefixes (block quotes, list indentation) precede the fence.
    let last = last.trim_start_matches([' ', '\t', '>']).trim_end();
    last.len() >= length && last.chars().all(|c| c == mark)
}

#[cfg(test)]
mod tests {
    use super::{closed, is_mermaid};

    #[test]
    fn only_closed_fences_of_the_opening_kind_render() {
        assert!(closed("```mermaid\ngraph TD\nA --> B\n```"));
        assert!(closed("~~~~mermaid\ngraph TD\n~~~~~"));
        assert!(closed("```mermaid\n> graph TD\n> ```"));
        assert!(!closed("```mermaid\ngraph TD\nA --> B\n"));
        assert!(!closed("```mermaid\ngraph TD\nA --> B\n``"));
        assert!(!closed("````mermaid\ngraph TD\n```"));
        assert!(!closed("~~~mermaid\ngraph TD\n```"));
        assert!(!closed("```mermaid"));
    }

    #[test]
    fn language_is_the_case_insensitive_mermaid_token() {
        assert!(is_mermaid(Some("mermaid")));
        assert!(is_mermaid(Some("Mermaid")));
        assert!(!is_mermaid(Some("mermaidjs")));
        assert!(!is_mermaid(Some("rust")));
        assert!(!is_mermaid(None));
    }
}
