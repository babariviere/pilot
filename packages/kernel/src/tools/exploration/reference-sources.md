# Reference sources: dependencies and linked projects

Project chats can read code outside the project, read-only, from two kinds of roots. Pilot resolves both on the
host; no tool accepts a root from the model.

## Roots

- **Dependency sources.** pilotd reads the project's lock files and maps each pinned version to its local cache:
  - Go: `go.mod` `require` lines, after `replace` rules that name a module and version, map to
    `$(go env GOMODCACHE)/<escaped path>@<escaped version>`. Escaping follows Go: `A` becomes `!a`.
    Local-directory replacements are skipped. `// indirect` modules are readable but listed only on request.
  - Cargo: crates that workspace members (`Cargo.lock` packages without a `source`) depend on directly map to
    `$CARGO_HOME/registry/src/*/<name>-<version>`.
  - Node: `package.json` dependencies map to `node_modules/<name>` in the project folder, with the installed
    version, only when a lock file exists. Links that leave `node_modules` (workspace packages) are skipped.
    Lock files come from the project's read-only main view when it exists, else the project folder.
    `node_modules` always comes from the project folder. Only existing real directories inside the cache count.
- **Linked projects.** `Project.linkedProjects` (at most 10 IDs) lists other Pilot projects. Their read-only main
  view (`main-views/<id>/source`) is readable. pilotd refreshes a linked main view in the background at most once
  every 10 minutes per project; a project without a main view yet is not offered until the first refresh makes it.

## Gates

| Chat                             | How a read reaches a root                                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Mission coordinator and planner  | `source.scope` adds `references`; the coordinator source tools admit them like main and members.                                |
| Ask, explorer and research chats | Ask's `read`, `ls`, `find`, `grep` and `code_*` send an absolute path inside a root to a fresh source-only reader rooted there. |
| Build                            | `code_*` tools route the same way. The SDK `read` and shell are unchanged.                                                      |

Every routed call asks pilotd again (`source.references` IPC), so unlinking takes effect on the next call.
Reference roots use the coordinator's source-only reader: no symlinks, hardlinks, `.git` or `.jj`, and no
traversal. The `reference_sources` tool lists `name@version → path` lines (direct dependencies and linked
projects, at most 200, with an optional name filter). Specialist roles get no reference roots.

## Cost

`DependencySources` caches each resolution until one lock file changes (inode, size or mtime). A call costs a few
`lstat` calls. On a real Go service with 318 modules the first resolution took about 220 ms and later calls under
1 ms. `go env GOMODCACHE` runs once per daemon, outside any module and with `GOTOOLCHAIN=local`.

## API

- `PATCH /api/projects/:id` with `{ "linkedProjects": ["<project id>"] }` replaces the list; `[]` clears it.
  Unknown IDs, the project itself and more than 10 links are refused. Removing a project removes it from every list.
- Day sends `link` and `unlink` native project actions (`project`, `linked`); `GET /api/native-projects/setup`
  returns each project's `linked` IDs.

## Limits

- A module downloaded after the last lock-file change is found only after the next change to that lock file.
- Only the root `go.mod`, `Cargo.lock` and `package.json` are read; nested modules in a monorepo are not.
- Source-only reads refuse hardlinked files. pnpm on APFS clones files, so this has not refused real packages.
