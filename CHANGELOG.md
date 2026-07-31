# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.0 — 2026-07-31

First public release: run AgentBox coding agents in Tenki Firecracker microVMs, as a community
provider plugin registered with `agentbox plugin add`.

### Added

- **Full box lifecycle** over the `@tenkicloud/sandbox` SDK — create, exec, file transfer in both
  directions, pause/resume, destroy. One Tenki session per box, each its own microVM.
- **`agentbox prepare --provider tenki`** — bakes a base snapshot from a throwaway builder sandbox
  (tmux, Docker, the AgentBox runtime, and `claude` / `codex` / `opencode`), then pins the snapshot id
  to `~/.agentbox/tenki-prepared.json` so later `create` calls boot in seconds. Re-bakes by itself if
  the pinned snapshot is gone from the workspace.
- **Host agent config travels.** `prepare` bakes your static agent configuration — settings, MCP
  servers, plugin registries, `/workspace` pre-trust — into the image. Credentials are deliberately
  not baked; AgentBox seeds them per box at create time through a symlink pivot in the image.
- **In-box Docker.** `docker build` and `docker run` work as the box user, on overlay2 over cgroup v2,
  and the daemon plus image cache survive pause/resume.
- **Interactive attach** through the host's OpenSSH client into a tmux session, authenticated with an
  ephemeral ed25519 key and a short-lived certificate. Window resizes propagate.
- **Public HTTPS preview URLs** per exposed port, with an expiring (signed) variant for ports that
  should not stay durably reachable.
- **Checkpoints** mapped to id-addressed Tenki snapshots — create, list, restore, remove — matching
  the Vercel and E2B shape.
- **Session lifetime management.** The host keepalive extends an active box's deadline;
  `AGENTBOX_TENKI_TIMEOUT_MS` sets the starting lifetime.
- **`agentbox doctor` integration**, reporting credential status (token masked) and whether a base
  snapshot is pinned.
- Bounded, ambiguity-aware retries around every control-plane call, with non-idempotent operations
  (provision, snapshot create) deliberately excluded from retry so a timeout can't double-provision a
  billable resource.

### Notes

- Requires the `agentbox` CLI 0.27.1 or newer (provider SDK v2) and an OpenSSH client on the host.
- `agentbox prune --provider tenki` does not work — the CLI's prune allowlist covers built-in
  providers only. Clean up orphans from the Tenki dashboard.
