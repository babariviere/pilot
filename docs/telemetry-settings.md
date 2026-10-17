# Telemetry controls

Pilot keeps three host-scoped controls separate:

- **Local operational diagnostics** are on by default. They retain bounded lifecycle and request-timing evidence on
  that host only. Turning this off stops new local records; **Clear local diagnostics** removes retained diagnostic
  segments without deleting or starting chats.
- **Remote operational reporting** is off by default. Enabling it requires an OTLP/HTTP endpoint and affects only
  the selected host's app, daemon and kernel traces.
- **Product analytics** is off by default. Consent does not turn remote reporting on; cataloged analytics can leave
  the host only while both controls are enabled.

Settings live in `telemetry.json` under that daemon's private Pilot home with mode `0600`. Local and devbox daemons
therefore never inherit one another's consent. A disconnected devbox reports settings as unavailable. The app
refreshes its local effective setting after verified connection and reconnect rather than assuming that remote or
cached settings apply.

An endpoint must use HTTPS or literal loopback HTTP. Userinfo, query strings, fragments, custom headers and stored
credentials are rejected. A collector on `127.0.0.1` is recommended because it can own backend authentication;
Pilot does not ship or persist a privileged ingestion key. There is no offline export spool.

Disabling or changing remote reporting immediately swaps to a disabled exporter and marks the old in-memory queue
discarded before SDK shutdown. An OTLP request already handed to the SDK may finish its single bounded attempt, but
no queued batch begins a new request. Disabling analytics rotates its independent random identifier. The local Mac
app and daemon can share that identifier while consent is active; it is never derived from a machine/account and is
never copied to a devbox.

Each host keeps a private random HMAC key and exports only a truncated pseudonymous host correlation value, never
its raw daemon, lineage or app routing identity. The settings API returns only effective controls and reviewed
pseudonymous identifiers. It never returns either private key.
