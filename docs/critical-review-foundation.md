# Critical review foundation (disabled)

The critical-review namespace is separate from `reviews.json` and `/api/reviews`, which still
only track whether chat results were read. Version 1 transport models are mirrored in
`PilotCore/CriticalReviews.swift`. Records are host-owned, immutable and idempotent by ID;
new runs and dispositions retain history rather than rewriting evidence or finding meaning.

`CriticalReviewStore` runs private SQLite writes and fsync in a bounded worker queue. It refuses
future schema versions. The store is not constructed by the server and has no HTTP, agent or UI
entry point. Production review, acquisition, permissions and provider execution remain disabled.

Focused checks use temporary stores and synthetic records only. Swift compilation and end-to-end
review behavior require subsequent CI and integration work; transport types do not enable reviews.

`CriticalReviewVault` captures only explicit host selections into private immutable blobs and a
digest-sealed manifest. Readers accept manifest/blob IDs and bounded byte pages, not live paths.
Unselected data, secret paths/known credentials, binaries, unsafe paths and exceeded limits become
explicit omission records without retaining their contents. Capture adapters must provide known
secrets and select only authorized data. Pattern matching cannot prove that arbitrary text is secret-free.
No real repository acquisition or provider transmission is wired. Missing/tampered blobs fail closed.
