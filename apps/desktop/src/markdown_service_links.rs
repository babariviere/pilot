//! GitHub, Linear and Slack links in message Markdown render as Swift's service links:
//! the service mark beside the written label (or a locally derived name), underlined in
//! the link colour, with the exact URL in its tooltip. Copy keeps the written text and
//! activation goes through the same explicit route as any other message link.
use crate::{
    app_icon::BrandMark,
    external_links::{self, Badge, Service},
};
use gpui_kit::{
    App, InteractiveElement, ParentElement, SharedString, StatefulInteractiveElement, Styled,
    TestSupportExt, Window,
    base::text::{
        InlineElement, InlineRenderContext, MarkdownNode, MarkdownParseContext, MarkdownPlugin,
        markdown_ast::Node,
    },
    component::{ActiveTheme, StyledExt, text::TextView, tooltip::Tooltip},
    div,
};
use std::sync::Arc;

const NAME: &str = "service-link";

pub(crate) type Open = Arc<dyn Fn(&str, &mut Window, &mut App) + Send + Sync>;

struct Prepared {
    url: SharedString,
    badge: Badge,
}

struct Plugin {
    owner: u64,
    open: Open,
}

/// Install before the first streamed link so its arrival cannot trigger a
/// selection-clearing reparse. The plugin filters link nodes.
pub(crate) fn install(view: TextView, owner: u64, open: Open) -> TextView {
    view.plugin(Plugin { owner, open })
}

fn has_image(nodes: &[Node]) -> bool {
    nodes.iter().any(|n| {
        matches!(n, Node::Image(_) | Node::ImageReference(_))
            || n.children().is_some_and(|c| has_image(c))
    })
}

fn prepare(node: &Node) -> Option<MarkdownNode> {
    let Node::Link(link) = node else {
        return None;
    };
    if has_image(&link.children) {
        return None;
    }
    let written = node
        .to_string()
        .replace("\r\n", " ")
        .replace(['\n', '\r'], " ");
    let badge = external_links::badge(&link.url, Some(&written))?;
    let label = format!("{} link: {}", badge.service.name(), badge.title);
    Some(
        MarkdownNode::new(
            NAME,
            Arc::new(Prepared {
                url: link.url.clone().into(),
                badge,
            }),
        )
        .text(written)
        .accessibility_label(label),
    )
}

impl MarkdownPlugin for Plugin {
    fn name(&self) -> &str {
        NAME
    }

    fn parse(&self, node: &Node, _: &MarkdownParseContext<'_>) -> Option<MarkdownNode> {
        prepare(node)
    }

    fn render_inline(
        &self,
        node: &MarkdownNode,
        context: &InlineRenderContext,
        window: &mut Window,
        cx: &mut App,
    ) -> Option<InlineElement> {
        let prepared = node.data::<Arc<Prepared>>()?.clone();
        let style = context.text_style();
        let (size, line) = (context.font_size(), context.line_height());
        // Same centred baseline as the surrounding text. FontMetrics descent is signed,
        // unlike the shaped-line descent the text flow uses.
        let text = window.text_system();
        let font = text.resolve_font(&style.font());
        let (ascent, descent) = (text.ascent(font, size), text.descent(font, size).abs());
        let baseline = (line - ascent - descent) / 2. + ascent;
        let color = cx.theme().link;
        let mark = match prepared.badge.service {
            Service::GitHub => BrandMark::GitHub,
            Service::Linear => BrandMark::Linear,
            Service::Slack => BrandMark::Slack,
        };
        let start = node.source_range().map_or(0, |r| r.start);
        let (open, url, tip) = (
            self.open.clone(),
            prepared.url.clone(),
            prepared.url.clone(),
        );
        let element = div()
            .id(SharedString::from(format!(
                "service-link-{}-{start}",
                self.owner
            )))
            .test_support()
            .h_flex()
            .items_center()
            .gap(size * 0.25)
            .h(line)
            .cursor_pointer()
            .text_color(color)
            .child(mark.icon().size(size * 0.9).flex_none().text_color(color))
            .child(
                div()
                    .font_family(style.font_family.clone())
                    .font_weight(style.font_weight)
                    .text_size(size)
                    .line_height(line)
                    .whitespace_nowrap()
                    .underline()
                    .text_decoration_color(color)
                    .child(SharedString::from(prepared.badge.title.clone())),
            )
            .tooltip(move |w, cx| Tooltip::new(tip.clone()).build(w, cx))
            .on_click(move |event, w, cx| {
                if event.is_right_click() || event.is_middle_click() {
                    return;
                }
                gpui_kit::base::TextSelection::end(w, cx);
                cx.stop_propagation();
                open(&url, w, cx);
            });
        Some(InlineElement::new(element).with_baseline(baseline))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui_kit::base::text::markdown_ast::{Image, Link, Strong, Text};

    fn text(value: &str) -> Node {
        Node::Text(Text {
            value: value.into(),
            position: None,
        })
    }
    fn link(url: &str, children: Vec<Node>) -> Node {
        Node::Link(Link {
            children,
            url: url.into(),
            title: None,
            position: None,
        })
    }
    fn prepared(node: &Node) -> Option<(String, String, Service)> {
        prepare(node).map(|n| {
            let p = n.data::<Arc<Prepared>>().unwrap();
            assert_eq!(
                p.url.as_ref(),
                match node {
                    Node::Link(l) => l.url.as_str(),
                    _ => unreachable!(),
                }
            );
            (
                n.as_text().to_string(),
                p.badge.title.clone(),
                p.badge.service,
            )
        })
    }

    #[test]
    fn service_links_keep_written_copy_text_and_exact_destination() {
        let url = "https://github.com/acme/api/pull/412";
        assert_eq!(
            prepared(&link(url, vec![text(url)])),
            Some((url.into(), "acme/api#412".into(), Service::GitHub))
        );
        let bold = Node::Strong(Strong {
            children: vec![text("ticket")],
            position: None,
        });
        assert_eq!(
            prepared(&link(
                "https://linear.app/acme/issue/eng-3/fix-it",
                vec![text("the\n"), bold]
            )),
            Some(("the ticket".into(), "the ticket".into(), Service::Linear))
        );
        let slack = "https://acme.slack.com/archives/C1/p1111111111111111";
        assert_eq!(
            prepared(&link(slack, vec![text(slack)])),
            Some((slack.into(), "Slack thread".into(), Service::Slack))
        );
    }

    #[test]
    fn ordinary_lookalike_unsafe_and_image_links_stay_ordinary() {
        for url in [
            "https://example.com/a",
            "https://github.com.evil.io/o/r/pull/1",
            "https://evil-github.com/o/r",
            "https://user@github.com/o/r",
            "javascript:alert(1)",
        ] {
            assert!(prepared(&link(url, vec![text("x")])).is_none(), "{url}");
        }
        let image = Node::Image(Image {
            alt: "logo".into(),
            url: "https://example.com/x.png".into(),
            title: None,
            position: None,
        });
        assert!(prepared(&link("https://github.com/o/r", vec![image])).is_none());
        assert!(prepare(&text("https://github.com/o/r")).is_none());
    }
}
