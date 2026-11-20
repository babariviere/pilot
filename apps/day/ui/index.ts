// Pilot's component library: the parts every screen is built from (README.md is the guide). Each part wraps
// `nsh/base` behaviour once and draws it with the theme's tokens (../theme.json). Screens compose these, choose
// roles and kinds, and pass only the layout props a part offers; add a variant here instead of restyling.
// The library is embeddable: files here import only `nsh`, `nsh/base`, each other and assets. Nothing here reads
// Day's feeds, navigation or native module, or calls a host, storage, file or network.
//
// - text: Display, Title, Heading, Body, BodyStrong, Caption, Num (the Number role), TONE, TYPE
// - state: Mark, State, Progress, Pill (MarkLine deprecated)
// - button: Button, Link, Chip (Action, Badge, InlineAction, RowLink, ToggleChip, LinkAction deprecated), Pressable
// - keys: KeyCap, KeyHint, KeyHints
// - field: TextField, Field, ReadField, Switch, Checkbox
// - choice: Options, Option, OptionTag (RadioList, RadioRow, CheckboxRow, ToggleRow, PickMark deprecated)
// - picker: Picker (the select), Menu, MenuTrigger, MenuTitle, MenuItem
// - section: Section, Block, EmptyLine, Rows, Row
// - panel: Panel, Columns, Column, Tabs, Tab
// - notice: Notice
// - question: Question
// - chat: Bubble, Reply, Steps, Event, Tray, WorkingLine, Composer, Quote
// - quiet: Quiet, GridBackdrop
// - layout: Page, PageHead, narrow (PAGE_COLUMN, PageTitle, SectionTitle, QuietPanel deprecated)
// - path: PathBar, Logo, PathSegment, PathSlash, PathMenu, SearchButton
// - disclosure: Disclosure, DividedRow, ExpandableRow
// - tabs: TabRow, TabItem (deprecated)
// - data: EvidenceList, EvidenceChip, Bars (Track deprecated)
// - diff: PatchDiff, ReviewDiff
// - icon: Icon
// - motion: Arrive, FadeIn, createPanelMotion, glide
// - agent: the screen agent's registry (useAgent, AgentScope, snapshot, query, act)
import "./fonts";

export * from "./agent";
export * from "./button";
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
export * from "./panel";
export * from "./path";
export * from "./picker";
export * from "./question";
export * from "./quiet";
export * from "./section";
export * from "./state";
export * from "./tabs";
export * from "./text";
