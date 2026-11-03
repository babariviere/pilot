# Pilot

Background coding agents, durable chats, and a native desktop app.

Pilot runs [pi](https://github.com/earendil-works/pi) agents in isolated workspaces.
Ask questions, delegate changes, and review the results. A local daemon keeps agents
running independently of the app.

## Get started

1. Download Pilot Next from [Releases](https://github.com/babariviere/pilot/releases)
   for Apple Silicon macOS 15+ or x86-64 Wayland Linux.
2. Configure a model provider in pi. Pilot uses your existing pi authentication.
3. Add a local project, choose **Ask** or **Build**, and describe your task.

See [installation and setup](docs/getting-started.md) for requirements and platform limits.

## Features

- **Chats:** explore code in Ask, implement changes in Build.
- **Workspaces:** keep agent edits separate from your checkout.
- **Missions:** coordinate several chats around one goal.
- **Automations:** schedule messages and run project hooks.
- **Integrations:** work with GitHub, Slack, Linear, MCP, and Postgres.
- **Local history:** retain conversations, artifacts, knowledge, and usage records.

[User documentation](docs/README.md) · [Technical documentation](docs/technical/README.md)

## Development

Start with the [desktop guide](apps/desktop/README.md) and
[development reference](docs/technical/development.md).

## License

MIT.
