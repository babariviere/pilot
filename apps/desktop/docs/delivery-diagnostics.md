# Delivery diagnostics

The selected chat or new-chat draft owns the observation. A concise caption beside
its existing delivery state shows the last observed phase, numeric HTTP status when
available, sanitized category and Local acknowledgment. It is not a diagnostic dump
or a claim about why a particular user's earlier creation failed.

## Ownership and privacy

- [delivery_diagnostic.rs](../src/delivery_diagnostic.rs): fixed serialized enums for
  identity/target verification, receipt lookup, execution and private adoption;
  interrupted/refused/malformed/oversize/mismatch, unknown/pending/accepted/rejected
  and private failure classes. No arbitrary message fields.
- [interaction.rs](../src/interaction.rs): the existing worker performs typed bounded
  HTTP reads and exact-operation observation/retention. Redirects and automatic
  retries remain disabled. Non-200 bodies are not parsed or echoed.
- [delivery_store.rs](../src/delivery_store.rs): optional diagnostics on existing
  pending Intent and latest Delivery summary. Existing Book remains the only file.
- [chat_editor.rs](../src/chat_editor.rs): exact owner/id/target/kind/revision matching,
  passive shared caption typography, preserved input and recovery handlers.

HTTP status is an observation, not a rejection receipt. A 503 leaves delivery unknown;
a validated rejected receipt is a different category. The protocol's optional rejection
reason is arbitrary text, not a safe code enum, so it is intentionally never retained.
Identity/access helpers do not expose a numeric status; no status is invented there.
Known pending/accepted/rejected acknowledgment does not itself settle private state
and never changes IDs, targets, payloads, hashes, producer sequence or authority.

No body, provider text, full envelope, prompt, path or credentials enter the diagnostic
type or logs. The volatile worker projection contains only the existing bounded delivery
summary, owner key and typed observation; it does not duplicate operation payloads.

## Bounds and persistence

Each diagnostic's canonical serialization is below256 bytes by construction (fixed
enums and an optional100–999 status). The existing128 retained drafts/latest summaries
and32 pending intents bound persisted notes to160, below40KiB logical diagnostic data.
The existing16MiB Book cap is unchanged. The worker's volatile exact-operation map has
at most160 entries, with metadata strings bounded by existing token/key validation.
It is pruned only when that exact pending/latest retained summary no longer exists.

Existing settlement runs first. Its required private write does not acquire a new
diagnostic-size requirement. A fresh observation is installed afterward, best-effort,
with the same owner/operation fence. A stale pending note is not copied as if it described
the new settlement. Diagnostic capacity refusal leaves a valid acceptance intact and
does not pretend to be an I/O fault. An I/O failure retains the existing writer fence.

The in-process worker observation survives autosave success, unrelated owner/model/
project notices and navigation. A later failed explicit Check also seeds its
last-known acknowledgment from the prior exact owner/id/target/kind/revision
observation when both adoption and diagnostic persistence had been refused.
Another operation's observation cannot supply an acknowledgment; this does
not settle private state or authorize execution. A failed private adoption retains known Local
acknowledgment independently, even if no diagnostic can be durably written. The UI
then says details are not durably confirmed for restart. A failed fsync does not prove
bytes are absent; reopening uses only the actual validated private snapshot. Memory-only
observations cannot be promised across process restart. A diagnostic-only write failure
after successful adoption cannot remove the already durable accepted summary.

Restart loads optional notes with the Book and performs no lookup, execution or retry.
Legacy schema1 records without notes remain readable, with no inferred historical
diagnostic or envelope change. Invalid enum/status/extra diagnostic fields fail closed.
Older binaries that reject new fields must not overwrite the private file on downgrade.
There is no new file, migration, unbounded history or alternate persistence service.

These are observations of currently retained operations, not a permanent log. Existing
cleanup of fully settled empty drafts still applies; unresolved Unknown/pending intents
are never evicted. Stop has no durable operation receipt API and retains its prior
separate uncertainty/dismissal behavior.

## Interaction and verification

The conversation remains primary. The caption replaces duplicate transient delivery
notices/ordinary autosave success, not private-write or unsaved-input errors. Existing
Check/Retry/Stop/recovery actions remain explicit, reachable native controls; diagnostics
do not auto-invoke them, authorize a send, clear Unknown or change permission/IME guards.
No new entity, animation, input, timer or render-time I/O is introduced.

Pure/store and faux courier cases live beside their owners. They cover loss before/after
admission, typed HTTP boundaries/mismatches, lookup-only zero-execution, acknowledgment
and private-adoption failures, diagnostic capacity/write failures, exact original tuple,
autosave/other-owner/restart and legacy/corrupt state. A native
[production-composer fixture](../src/delivery_probe.rs) uses isolated private metadata
and a command recorder, never Local options or a real delivery worker. It checks four
680/1100 light/dark containers, actual pixels, containment, pointer Check recording,
native Unicode input, pending Enter, owner navigation and unsaved acknowledgment.

The named delivery_diagnostics target is registered in existing CI. Focused local
evidence and source mapping are in [delivery-diagnostics.md](../evidence/delivery-diagnostics.md).
Native captures do not establish OS IME/AX, visible motion/performance, Linux/Wayland,
full Swift parity, production operation outcome or user acceptance.
