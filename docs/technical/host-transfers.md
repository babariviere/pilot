# Remote attachments and artifacts

The existing Mac importer accepts image clipboard/file types through ImageIO, normalizes orientation,
and writes PNG. Remote transfer uses those normalized PNGs, not the original user filesystem or
arbitrary files. Existing eight-image and 24-megapixel limits remain. A normalized file may reach
100 MiB (24MP RGBA plus PNG overhead); transfers stream to disk in at most two concurrent requests.

PUT /api/attachments/:uploadId requires exact Content-Length and immutable origin, digest and byte
count in the base64 JSON X-Pilot-Attachment header. Digests and PNG dimensions/signatures are checked
before ready publication. The store bounds retained reservations to 512 records and 2 GiB, plus at
most two in-progress file buffers. Quota pressure rejects new staging, never evicts accepted history.
Unknown delivery is not permission for cleanup, and there is no blind TTL expiry.

chat-create-attached and chat-send-attached operations carry {request,attachments}. Their immutable
payload contains resource IDs/hashes, never Mac paths. After durable operation reservation, adoption
pins each upload to the operation/target and inserts only daemon-owned image paths into the prompt.
Replays use the same ownership and input ID. The local copy is conservatively retained for history.
Unused, never-transmitted staging can be explicitly discarded. Only an intact journal's rejected
receipt permits release-attachments; accepted history remains retained. Pending/unknown receipts
cannot authorize deletion. Draft ownership must be durably updated before outbox acknowledgment.

HostedArtifactViewer fetches a host-qualified pinned revision and gives its sandbox the same endpoint
for library resources. Library cache keys include pinned host identity, not just reusable localhost
ports. Caches are bounded by count, bytes and in-flight reads. HTTP readers reject redirects and
oversized announced/chunked responses while receiving. Artifact export paths include host lineage
and resource IDs, and exported source is local materialized data, never a remote filesystem path.

Remote HTML/React/image creation reuses the existing artifact runtime. Linux SwiftUI preparation
already fails explicitly with "requires macOS"; remote SwiftUI rendering is not enabled.
Legacy transcript cards remain local-only. The unified UI must pass qualified artifact references
to HostedArtifactViewer and use upload/deliverAttached with raw composer text (not the legacy
ImageAttachments.message(), which intentionally contains Mac paths for local chats).

No filesystem/credential synchronization, external editor or preview forwarding is provided.

