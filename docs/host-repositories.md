# Host-scoped repositories and files

Remote directory selection is served by the chosen daemon, never by NSOpenPanel or a Mac file URL.
GET /api/repositories/directories accepts a server rootId (home or a registered project) and a
relative path. It reads one directory, scans at most 4096 entries and returns at most 100 directories
per page. Hidden directories and symlinks are not listed. The response explicitly reports truncation.

POST /api/repositories/projects accepts {selection:{rootId,path}} and creates a project on that
daemon only. Existing project list/branch/model APIs remain endpoint scoped. RepositoryBindings
records explicit host-qualified logical-project placements with generation checks. Matching paths,
names or repository URLs do not link projects, share memory, or transfer trust/credentials.

GET /api/sessions/:id/files?path=... reads only a relative regular file under the daemon-owned session
cwd. Traversal, absolute paths, symlinks and special files are rejected. File descriptors and scope
are rechecked before/after a bounded read. Text is capped at 512 KiB; binary content is not returned.
Directory/file reads share a four-request admission limit with no waiting queue.

HostClients exposes directory/project/file/changes adapters that preserve host refs and response
generations. Offline operations fail before reaching any endpoint; there is no local fallback.
The unified host-selection/picker UI consumes these adapters separately. Remote absolute project
paths are display/server data, not permission to invoke Mac filesystem APIs or an external editor.

