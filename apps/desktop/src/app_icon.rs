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
    Archive,
    House, Folders, MessagesSquare, SquarePen, CodeXml, Wrench, Layers, ListFilter, Ellipsis, ListTodo, Circle, FolderPlus, Activity, Link, GitCompare, Maximize2, CornerDownRight, Clock, Trash, Map, Compass, MessageCircleQuestionMark, GitPullRequest, ArrowUpToLine, GitBranch, Minimize2, Eraser, ExternalLink, Paperclip,
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
    Dropped => CircleX,
    Working => Ellipsis,
    Paused => Circle,
    Expand => ChevronDown,
    Collapse => ChevronUp,
    Home => House,
    Inbox => Inbox,
    Archive => Archive,
    Projects => Folders,
    AddProject => FolderPlus,
    Usage => Activity,
    Settings => Settings,
    Project => Folder,
    Overview => LayoutDashboard,
    Mission => Map,
    Coordinator => Compass,
    Question => MessageCircleQuestionMark,
    Subagent => Bot,
    PullRequest => GitPullRequest,
    Push => ArrowUpToLine,
    Branch => GitBranch,
    Chats => MessagesSquare,
    NewChat => SquarePen,
    Back => ChevronLeft,
    Forward => ChevronRight,
    Filter => ListFilter,
    More => Ellipsis,
    Retry => RefreshCw,
    Copy => Copy,
    Send => ArrowUp,
    AttachImage => Paperclip,
    Steer => CornerDownRight,
    Queued => Clock,
    Delete => Trash,
    Stop => Square,
    Artifacts => Layers,
    Links => Link,
    OpenLink => ExternalLink,
    Changes => GitCompare,
    Enlarge => Maximize2,
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
    // Context compacted (Swift arrow.down.right.and.arrow.up.left).
    Compaction => Minimize2,
    // Context reset (Swift eraser).
    Reset => Eraser,
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

/// Service marks for recognized links, from Swift `BrandMark`: monochrome, so they take
/// their link's colour. GitHub: the `mark-github` octicon (github.com/primer/octicons,
/// MIT, licenses/OCTICONS.txt). Linear: the logomark from linear.app/brand. Slack: the
/// single-colour mark from Simple Icons (CC0). Identify the linked service only.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum BrandMark {
    GitHub,
    Linear,
    Slack,
}
impl BrandMark {
    #[cfg(test)]
    pub(crate) const ALL: [Self; 3] = [Self::GitHub, Self::Linear, Self::Slack];
    pub(crate) fn path(self) -> &'static str {
        match self {
            Self::GitHub => "pilot-brand/github.svg",
            Self::Linear => "pilot-brand/linear.svg",
            Self::Slack => "pilot-brand/slack.svg",
        }
    }
    fn svg(self) -> &'static str {
        match self {
            Self::GitHub => {
                "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 16 16\"><path fill=\"#000\" d=\"M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z\"/></svg>"
            }
            Self::Linear => {
                "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 100 100\"><path fill=\"#000\" d=\"M1.22541 61.5228c-.2225-.9485.90748-1.5459 1.59638-.857L39.3342 97.1782c.6889.6889.0915 1.8189-.857 1.5964C20.0515 94.4522 5.54779 79.9485 1.22541 61.5228ZM.00189135 46.8891c-.01764375.2833.08887215.5599.28957165.7606L52.3503 99.7085c.2007.2007.4773.3075.7606.2896 2.3692-.1476 4.6938-.46 6.9624-.9259.7645-.157 1.0301-1.0963.4782-1.6481L2.57595 39.4485c-.55186-.5519-1.49117-.2863-1.648174.4782-.465915 2.2686-.77832 4.5932-.92588465 6.9624ZM4.21093 29.7054c-.16649.3738-.08169.8106.20765 1.1l64.77602 64.776c.2894.2894.7262.3742 1.1.2077 1.7861-.7956 3.5171-1.6927 5.1855-2.684.5521-.328.6373-1.0867.1832-1.5407L8.43566 24.3367c-.45409-.4541-1.21271-.3689-1.54074.1832-.99132 1.6684-1.88843 3.3994-2.68399 5.1855ZM12.6587 18.074c-.3701-.3701-.393-.9637-.0443-1.3541C21.7795 6.45931 35.1114 0 49.9519 0 77.5927 0 100 22.4073 100 50.0481c0 14.8405-6.4593 28.1724-16.7199 37.3375-.3903.3487-.984.3258-1.3542-.0443L12.6587 18.074Z\"/></svg>"
            }
            Self::Slack => {
                "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\"><path fill=\"#000\" d=\"M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z\"/></svg>"
            }
        }
    }
    pub(crate) fn asset(path: &str) -> Option<&'static [u8]> {
        [Self::GitHub, Self::Linear, Self::Slack]
            .into_iter()
            .find(|m| m.path() == path)
            .map(|m| m.svg().as_bytes())
    }
    /// Inline beside link text, sized by the caller to the surrounding type.
    pub(crate) fn icon(self) -> Icon {
        Icon::empty().path(self.path())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::appearance::ChromeAssets;
    use gpui_kit::AssetSource;

    #[test]
    fn paused_uses_an_empty_circle() {
        assert_eq!(AppIcon::Paused.asset(), IconName::Circle);
        let bytes = ChromeAssets
            .load(&AppIcon::Paused.asset().path())
            .unwrap()
            .unwrap();
        let svg = std::str::from_utf8(&bytes).unwrap();
        assert!(svg.contains("<circle") && svg.contains("fill=\"none\""));
    }

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
        for mark in BrandMark::ALL {
            let svg = ChromeAssets.load(mark.path()).unwrap().unwrap();
            let svg = std::str::from_utf8(&svg).unwrap();
            assert!(svg.starts_with("<svg") && svg.contains("<path"), "{mark:?}");
        }
        assert!(!matches!(
            ChromeAssets.load("https://example.com/icon.svg"),
            Ok(Some(_))
        ));
    }
}
