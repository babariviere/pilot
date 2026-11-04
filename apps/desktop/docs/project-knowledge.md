# Project knowledge

Open a project's overview, then **Knowledge…**. A separate passive reading window
shows that project's research (**Investigations**) and component documentation
(**Components**). It owns one immutable canonical project ID and the captured Local
daemon/lineage, like the [Memory window](project-memory.md). Other projects never
reuse its rows.

Mission Overview shows a **Knowledge** section when the mission links entries: the
same project entries, never copies. Rows open the knowledge window at the exact
entry, or its pinned revision; **All project knowledge** opens the project list.
Archived missions keep their links, so their entries stay readable. A daemon without
the catalog shows no section rather than claiming the mission has none.

## Reading

- The list shows title, summary and one meta line: kind, revision, pin and check
  state. A row's check state is always the current revision's, so a mission pin to
  an earlier revision reads "pinned revision 1 · current revision 2: Checked …";
  the pinned revision's own state is in its entry. **All**, **Components**,
  **Investigations** and **Needs a check** filter
  on the daemon. The text field drafts a literal title/summary filter; Return
  applies it as one read, and typing never reads. An empty filtered result says
  so; loading, refusal and failure stay distinct from empty.
- An entry shows its readable Markdown body first (images disabled), with the
  stored check state above it: **Needs a check** with its stored reasons,
  **Checked** with the date, checker and coverage of that exact revision, **Not
  checked** (saving never checks), or **Check state unknown** for an unrecognized
  value. Sources, History and Details (IDs, origin, author) are one step away.
- **Sources** describes each typed locator. Only explicit web sources open, through
  the existing external-link opener. Repository files, artifacts, mission records
  and other entries say opening is unavailable here; the body still explains the
  entry without them.
- **History** lists revisions newest first. Opening one shows that exact revision,
  labeled as an earlier revision kept as written, with **Open current**.
- **Back** returns through History and the list. The list and history are retained
  with their selection, without a new read; **Refresh** rereads the current view.
  A failed refresh keeps the previous rows, labeled as a previous observation.

## Contract

Only these GETs are used, each between Local hello checks:
`/api/projects/:id/knowledge?kind=&missionId=&check=needs_check&q=&cursor=&limit=50`,
`/api/projects/:id/knowledge/:entry[?revision=N]` and
`/api/projects/:id/knowledge/:entry/revisions`. Mission Overview adds one bounded
`missionId` list read inside the mission reader's existing hello fence. Responses
must match the exact request (project, kind, mission link, entry and revision) or
fail; a 512 KiB wire cap bounds each read. Requests carry a window generation, and
only the latest request's exact route can change what is shown. Closing drops the
reader. No writes, linking, check or source verification exist in the app; agents
and the daemon's HTTP API own those (see
[the catalog design](../../../docs/technical/project-knowledge-catalog.md)).

## Verification

`knowledge_tests` covers exact paths and encoding, response/request matching,
honest check labels, source descriptions and hello-fenced GET-only reads over an
owned faux Local server. The `knowledge` hidden native probe mounts the production
window at 680/1100 pt, light and dark: a superseded slow read, kind/check/text
filters, keyboard opening, body-before-provenance, unavailable local sources, web
opening through a captured opener, exact historical revisions, retained Back,
failed refresh and GET-only traffic. It also opens an archived mission's Overview
in the production mission browser, follows a pinned linked entry into the
knowledge window and reads its history. This is synthetic native verification, not
a live daemon, OS IME/AX or performance claim.
