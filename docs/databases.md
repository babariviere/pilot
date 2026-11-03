# Postgres databases

Project Build chats can query configured Postgres databases. Ask chats, subagents,
and chats from other projects do not receive this tool.

1. In **Project Settings → Databases**, add an environment.
2. Enter a read connection, write connection, or both in the secure fields.
3. Choose the access policy and **Save Databases**.

Connections default to **Ask each chat**. Enabling writes or automatic access is
an explicit choice. Leave a replacement URL empty to keep the existing secret.
Settings stay on this machine; saving does not test the connection.

## Approve deliberately

When a chat requests access, check the named environment and mode, then use
**Allow … access** in the app. Typing the same words does not grant access.
Grants last for that chat; write access also permits reads.

Query results go to the model provider. Configure only data you are comfortable
sharing with it. Use a read-only database role for read connections and verified
TLS for remote connections. Approval does not prove connectivity or correct TLS.

Advanced configuration lives in `~/.config/pilot/database.json` (or
`$XDG_CONFIG_HOME/pilot/database.json`) and must be owner-only, mode `0600`.
Do not commit credentials. Agent shells run as you; these controls are not a secret
vault or a hard isolation boundary against a full-access shell.

See the [configuration reference](technical/product-reference.md#databases) for
the JSON format, TLS options, and query limits.
