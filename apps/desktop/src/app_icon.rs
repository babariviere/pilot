//! App-owned Lucide meaning, not behavior or status inference. Glyphs inherit
//! their host's semantic text color and use the existing rem-based chrome scale.
use gpui_kit::{
    Styled,
    assets::{IconName, icon_assets},
    component::Icon,
};

// The full catalog enum is larger than Kit's default asset bundle. Only embed
// the additional glyphs used here; preserve default icons for Kit controls.
icon_assets!(pub(crate) AppIconAssets, [
    House, Folders, MessagesSquare, SquarePen, CodeXml, Wrench, Layers, ListFilter, Ellipsis, ListTodo, Circle,
]);

macro_rules! app_icons {
    ($($role:ident => $glyph:ident),* $(,)?) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq)]
        pub enum AppIcon { $($role),* }
        impl AppIcon {
            pub(crate) fn asset(self) -> IconName {
                match self { $(Self::$role => IconName::$glyph),* }
            }
            #[cfg(any(test, feature = "native-probes"))]
            pub(crate) const ALL: &'static [Self] = &[$(Self::$role),*];
        }
    };
}
app_icons! {
    Tasks => ListTodo,
    Todo => Circle,
    Complete => Check,
    Working => Ellipsis,
    Expand => ChevronDown,
    Collapse => ChevronUp,
    Home => House,
    Inbox => Inbox,
    Projects => Folders,
    Project => Folder,
    Overview => LayoutDashboard,
    Chats => MessagesSquare,
    NewChat => SquarePen,
    Back => ChevronLeft,
    Forward => ChevronRight,
    Filter => ListFilter,
    More => Ellipsis,
    Retry => RefreshCw,
    Copy => Copy,
    Send => ArrowUp,
    Stop => Square,
    Artifacts => Layers,
    Source => CodeXml,
    Earlier => ArrowUp,
    Latest => ArrowDown,
    Read => FileText,
    Edit => SquarePen,
    Command => SquareTerminal,
    Script => CodeXml,
    Search => Search,
    Fetch => Globe,
    Tool => Wrench,
    Error => TriangleAlert,
    Info => Info,
    Close => Close,
}
impl AppIcon {
    /// Row/toolbar glyph: one rem, without an entity or independent animation.
    pub(crate) fn icon(self) -> Icon {
        Icon::new(self.asset()).size_4()
    }
    pub(crate) fn inline(self) -> Icon {
        Icon::new(self.asset()).size_3p5()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::appearance::ChromeAssets;
    use gpui_kit::AssetSource;

    #[test]
    fn every_app_role_loads_real_svg_and_preserves_kit_assets() {
        for role in AppIcon::ALL {
            let path = role.asset().path();
            let bytes = ChromeAssets.load(&path).unwrap().unwrap();
            let svg = std::str::from_utf8(&bytes).unwrap();
            assert!(
                svg.contains("<svg") && svg.contains("stroke="),
                "{role:?}: {path}"
            );
            assert!(
                ["<path", "<rect", "<circle", "<line", "<polyline"]
                    .iter()
                    .any(|part| svg.contains(part)),
                "{role:?} must contain painted geometry"
            );
        }
        assert!(ChromeAssets.load("icons/check.svg").unwrap().is_some());
        assert!(!matches!(
            ChromeAssets.load("https://example.com/icon.svg"),
            Ok(Some(_))
        ));
    }
}
