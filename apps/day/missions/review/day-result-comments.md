# Private result review

The result page (`DeliveryScreen.tsx`) shows one Code changes row and the note under Your check.
`CodeReviewScreen.tsx` is the Review code page over it (`codeReviewRoute` in `deliveryView.ts`):
files, the selected file's diff with comments under their lines, Keep for later and Send back.
Both read and write through `reviewSession.ts` and `resultReview.ts`. The service stores comments,
personal-note revisions and queue selections in `missions.sqlite`, separately from user
verification and task completion. Only the native capability routes can access these rows.
No review save calls a provider, sends to an agent or publishes to GitHub.

Each save names an operation ID, exact delivery identity and previous review revision.
SQLite compares the revision inside the transaction and crosses `durable()` before the
receipt is returned. Reusing an operation with different bytes refuses. The native host
supplies the operation ID and fsyncs its request before one PUT. Reopening reads pending
IDs; Check reads that exact operation receipt, never sends it again. Stale revisions keep
terminal rejection receipts, so they do not leave the result held forever. A missing receipt
remains Unknown. Original terminal LF, CR and BOM bytes in line excerpts are preserved.

Line anchors keep the original snapshot, side, path, blob hash and one-based inclusive
line range. The service supplies the excerpt from retained UTF-8 bytes. It never trusts
client excerpt text. Comparisons come from explicit delivery evidence or an exact match
between the owner's reported commit and a retained committed comparison. Inventory reads
inspect up to five metadata pages, not live repositories; a missing match stays unavailable.
An old comment shows under its lines only where its exact snapshot, path and blob show, through
current retained-source access checks. There is no fuzzy reanchoring. Each file uses its own upstream NSH DiffView, keeping
line selection independent of other files. Binary/unkept sources explain why no text shows.
File counts come from a line diff in `reviewSession.ts` (`lineCounts`), limited to 100,000 line
comparisons per file (about 20 ms in QuickJS) so the page's thread stays free; past it, moved lines
are not counted.

The report, task state, publication observations and human acceptance remain separate.
Existing Send back owns revision-message admission and receipt recovery. Send back with
comments puts every saved comment of the shown version, with saved IDs and original excerpts,
after any unsent Send back words, excludes personal notes, and sends it once through the same
assessment as Send back. Over the 8,000-byte note limit it refuses and sends nothing.
An existing active same-mission coordinator receives the request when available; otherwise
the owner receives it. The Send back intent pins that route, and the native receipt pin keeps
the exact recipient across restart. A route change invalidates that send envelope without
changing result identity or human acceptance. A held
recipient is not silently resumed or replaced.

Queue selections do not change the start-fresh discovery cutoff. Explicitly selected older
results are a separate bounded list. Later sorts after pending results, below other Today
questions/actions. Accepted or sent-back results are hidden only by the existing acknowledged
verification rules. Personal notes never affect queue state or delivery identity.

Add a note saves a general comment (`anchor.kind = "general"`); per-section comments are no longer
offered. Reopening My notes keeps unsent edits ahead of the saved note. When a result changes,
earlier unsent drafts stay readable in their original-version disclosure (20 per page).
They are not moved into the current editor or sent automatically.

## Costs and limits

Source disclosure reads at most 1 MiB across up to 40 text-file pairs in one comparison,
to limit JSON/VM memory and UI work. Other files retain their names and an unavailable
reason; source bytes are never truncated. A comment covers at most 40 lines and 16,000
excerpt bytes, keeping inline editors small. Comment/note text uses the existing 8,000-byte
revision-message ceiling. Large collections need explicit paging before these limits widen.
Private history reads 20 operations per page, with Earlier and Latest navigation; there is
no per-result lifetime entry limit. The profile holds at most 16,384 private receipt entries,
in its own native ledger (64 MiB), separate from planning and acceptance capacity. Each pending
request reserves space for its complete terminal record before sending, including worst-case
JSON escaping of service-supplied source excerpts. Settlement consumes that reservation; new
requests cannot consume it. Reaching this review-only limit refuses a new save without deleting
evidence or blocking ordinary result acceptance. Profile receipt compaction is not implemented.

Tests use isolated service stores, the released JSON/native bridge and the production TSX
pages with fixture sources. Those checks do not establish physical Linux or packaged-app
qualification, Apple signing, user acceptance, or live cutover.
