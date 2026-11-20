// Pilot's component library: the parts every screen is built from (README.md is the guide). Each part wraps
// `nsh/base` behaviour once and draws it with the theme's tokens (../theme.json). Screens compose these, choose
// roles and kinds, and pass only the layout props a part offers; add a variant here instead of restyling.
// The library is embeddable: files here import only `nsh`, `nsh/base`, each other and assets. Nothing here reads
// Day's feeds, navigation or native module, or calls a host, storage, file or network.
//
// - text: Display, Title, Heading, Body, BodyStrong, Caption, Num (the Number role), TONE, TYPE
// - state: Mark, State, Progress, Pill, MarkedLine
// - button: Button, Link, Chip, Chips, Buttons, Pressable
// - keys: KeyCap, KeyHint, KeyHints
// - field: TextField, Field, ReadField, Switch, Checkbox
// - choice: Options, Option, OptionTag
// - picker: Picker (the select), Menu, MenuTrigger, MenuTitle, MenuItem
// - section: Section, Block, EmptyLine, Rows, Row, RowDetail, RowGroup
// - panel: Panel, Columns, Column, Tabs, Tab, TabBar, PanelSlice
// - notice: Notice
// - question: Question
// - chat: Bubble, Reply, Steps, Event, Tray, WorkingLine, Composer, Quote
// - canvas: GridBackdrop, WindowCanvas
// - layout: Page, PageHead, PageFoot, Spacer, narrow, panelWidth
// - overlay: Confirm, FullWindow, FloatingCard, Ring
// - path: PathBar, Logo, PathSegment, PathSlash, PathMenu, SearchButton
// - disclosure: Disclosure, DividedRow, ExpandableRow
// - data: Facts, Fact, Figure, EvidenceList, EvidenceChip, Bars
// - diff: PatchDiff, ReviewDiff, DiffSplit, DiffCounts
// - icon: Icon (images: the icon files, loaded once)
// - motion: Arrive, FadeIn, createPanelMotion, glide
// - agent: the screen agent's registry (useAgent, AgentScope, snapshot, query, act)
import "./fonts";
import "./images";

export * from "./agent";
export * from "./button";
export * from "./canvas";
export * from "./chat";
export * from "./choice";
export * from "./data";
export * from "./diff";
export * from "./disclosure";
export * from "./field";
export * from "./icon";
export * from "./keys";
export * from "./layout";
export * from "./markdown";
export * from "./motion";
export * from "./notice";
export * from "./overlay";
export * from "./panel";
export * from "./path";
export * from "./picker";
export * from "./question";
export * from "./section";
export * from "./state";
export * from "./text";
