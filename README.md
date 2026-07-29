# @luxorlabs/agentbox-provider-tenki

Run [AgentBox](https://agent-box.sh) coding agents in [Tenki](https://tenki.cloud) Firecracker
microVMs — a community provider plugin, published as its own package and registered with
`agentbox plugin add`.

## What Tenki is

[Tenki](https://tenki.cloud) provisions Firecracker microVMs on demand, driven by the official
[`@tenkicloud/sandbox`](https://www.npmjs.com/package/@tenkicloud/sandbox) TypeScript SDK — a
ConnectRPC control plane plus a per-session data plane for command execution and file transfer.
Each AgentBox box becomes one Tenki session: a full VM with its own kernel, not a shared container.

## Supported AgentBox features

| Feature                        | Support   | Notes                                                                  |
| ------------------------------ | --------- | ---------------------------------------------------------------------- |
| `create` / `destroy`           | Yes       | Workspace seeded by git clone + carried-over stash and untracked files |
| `exec`                         | Yes       | Over the session data plane (`session.run`)                            |
| File transfer (`cp`, download) | Yes       | Streaming read/write via the data plane                                |
| Preview URLs                   | Yes       | Public HTTPS per port via `session.exposePort`, plus signed URLs       |
| Pause / resume                 | Yes       | Free and native (`session.pause` / `session.resume`)                   |
| Checkpoints                    | Yes       | Id-addressed snapshots (`createSnapshotAndWait`)                       |
| Interactive attach             | Yes       | Host OpenSSH over the session SSH transport, short-lived certificate   |
| Session renewal                | Yes       | `session.extend` keeps a working box past its deadline                 |
| Agent config                   | Yes       | Host settings/MCP/plugins baked at `prepare`; credentials per box      |
| Base image                     | `prepare` | One-time `agentbox prepare --provider tenki` bakes a base snapshot     |
| Docker-in-box                  | No        | Pending nested-virtualization verification                             |
| Control Hub UI                 | No        | The hub loads only built-in providers; the CLI is fully supported      |

## Requirements

- Node.js 20 or newer
- The `agentbox` CLI (0.27.1 or newer — it must support provider SDK v2)
- An OpenSSH client (`ssh` and `ssh-keygen`) on the host, used for interactive attach
- A Tenki account with a workspace and an auth token

## Installation

```bash
npm i -g @luxorlabs/agentbox-provider-tenki
agentbox plugin add @luxorlabs/agentbox-provider-tenki
agentbox plugin list            # -> tenki … (SDK v2)
```

AgentBox does not know about `tenki` until `plugin add` records it. A plugin runs in-process with
full host and credential access, so `plugin add` is the trust boundary — see
[Security](#security-considerations).

## Authentication

On a terminal, the first `agentbox create --provider tenki` prompts for a token and saves it. To set
it up ahead of time, expose it as `TENKI_AUTH_TOKEN`:

```bash
export TENKI_AUTH_TOKEN=...          # or add TENKI_AUTH_TOKEN=… to ~/.agentbox/secrets.env
agentbox doctor                      # shows the `tenki:` group
```

`TENKI_API_TOKEN` is accepted as an alias. Credentials are read from the environment first, then
from `~/.agentbox/secrets.env` (mode `0600`); project `.env` files are never harvested. The token is
never logged and never included in the published package.

## Basic usage

One-time: bake the AgentBox base image in your Tenki workspace, then create a box. `prepare` boots a
throwaway builder from Tenki's `sandbox` base, installs tmux, the AgentBox runtime and the coding
agents, snapshots it, and pins the snapshot id. Every box then boots from that snapshot.

```bash
agentbox prepare --provider tenki    # bakes the base image; records its digest locally
agentbox create --provider tenki
agentbox tenki claude                # provider-prefix sugar also works
```

Pin it project-wide with `box.provider: tenki` in `agentbox.yaml`, or per box with
`--provider tenki`.

## Resource configuration

Because AgentBox does not add config keys for plugin providers, Tenki reads its settings from the
generic keys plus its own environment variables:

| Setting            | Where                         | Notes                                                      |
| ------------------ | ----------------------------- | ---------------------------------------------------------- |
| VM size            | `--size` / `box.size`         | `cpu-memory[-disk]` in GB, e.g. `4-8-20`                   |
| Default checkpoint | `box.defaultCheckpoint`       | Generic key; no per-provider variant                       |
| Base image         | `AGENTBOX_TENKI_BASE_IMAGE`   | Tenki base image `prepare` layers onto (default `sandbox`) |
| Workspace          | `AGENTBOX_TENKI_WORKSPACE_ID` | Defaults to the token's own scope                          |
| Session lifetime   | `AGENTBOX_TENKI_TIMEOUT_MS`   | Seeds the host keepalive loop                              |

The baked base image ref lives in `~/.agentbox/tenki-prepared.json`, managed by this plugin.

## Agent configuration and credentials

`prepare` bakes your host's **static** agent config into the base snapshot — settings, MCP servers,
plugin registries, and `/workspace` pre-trust — so boxes start with your own setup rather than a
blank one. It is best-effort: an agent whose config can't be read is skipped with a warning rather
than failing the bake.

One host-side wrinkle is handled for you: codex leaves a live Unix socket at `~/.codex/ipc/ipc.sock`
whenever it has run, and the upstream staging helper's `rsync -a` cannot recreate a socket (it exits
23). `prepare` stages codex through a sanitized shadow of that directory, so its config bakes whether
or not codex is running.

Credentials are handled separately, and deliberately not baked. AgentBox seeds them per box at
create time into `~/.agentbox-creds/<agent>/`, which the base image pivots into place with symlinks
(`~/.claude/.credentials.json`, `~/.codex/auth.json`, `~/.local/share/opencode/auth.json`). That
keeps auth tokens out of an image that may be long-lived or shared, and lets a refreshed token
propagate without re-baking.

That seeding only has something to push when AgentBox has host-side credential backups
(`~/.agentbox/<agent>-credentials.json`), which are captured from boxes you have already used. With
no backup yet, the symlinks are dangling by design: you log into the agent once inside the box, the
login lands in `~/.agentbox-creds/`, and AgentBox captures it from there for later boxes.

The base image also creates a `vscode` account as an alias of the box user (same uid, same home).
The credential seed shipped in the current provider SDK extracts with an in-shell `sudo -u vscode`,
so without that account the seed fails with `sudo: unknown user vscode` and boxes start logged out.
The alias keeps seeded files owned by the user the agents actually run as.

## Preview URLs

Every exposed port gets a public HTTPS URL through Tenki's WebProxy — no tunnel and no token
needed. `agentbox open` and the `expose:` entries in `agentbox.yaml` work as they do on any cloud
provider. Signed URLs are available for ports you don't want publicly reachable.

## Checkpoint support

Tenki snapshots are **id-addressed**: the platform returns an opaque id rather than a name you
choose. The plugin stores that id in AgentBox's cloud-checkpoint manifest, so
`agentbox checkpoint create` / `list` / restore behave the same as on Vercel and E2B. Snapshots are
taken live — the source box keeps running.

## Troubleshooting

- **`unknown provider "tenki"`** — the plugin isn't registered. Run `agentbox plugin add
@luxorlabs/agentbox-provider-tenki` and confirm with `agentbox plugin list`.
- **`plugin targets provider SDK vN`** — your `agentbox` CLI is too old. Update to 0.27.1 or newer.
- **Credentials not found** — check `agentbox doctor`. The token must be in the environment or in
  `~/.agentbox/secrets.env`, not a project `.env`.
- **No base image** — run `agentbox prepare --provider tenki`. Boxes boot from a snapshot baked in
  your own Tenki workspace, so this is required once per workspace. If that snapshot is later deleted
  (or the token is pointed at another workspace), the next `prepare` notices and re-bakes.
- **Box expired mid-session** — raise `AGENTBOX_TENKI_TIMEOUT_MS`; the host keepalive extends a
  working session, but it starts from the lifetime the box was created with.
- **Attach fails to open a shell** — attach needs `ssh` and `ssh-keygen` on the host. Per-box key
  material lives in `~/.agentbox/boxes/<session-id>/ssh/`; the certificate is re-minted on every
  attach, so deleting that directory is safe and simply regenerates it.
- **Attach as a different user** — set `AGENTBOX_TENKI_SSH_USER` if a custom base image does not run
  as `tenki`.

## Security considerations

- An AgentBox provider plugin runs **in-process with the CLI**, with full host and credential
  access. AgentBox does not sandbox plugin code — provisioning infrastructure and handling secrets
  is the job. `agentbox plugin add` is the consent boundary; only add plugins you trust.
- The Tenki token is read from the environment or `~/.agentbox/secrets.env` (`0600`), never logged,
  and never bundled into the published artifact.
- Each box is an isolated microVM, so an agent cannot reach your host filesystem. Host-side
  operations that need your credentials (`git push` in particular) are brokered by the AgentBox host
  relay rather than by handing keys to the box.

## Uninstallation

```bash
agentbox plugin remove tenki                       # unregister (leaves the npm package installed)
npm uninstall -g @luxorlabs/agentbox-provider-tenki
```

Destroy any remaining boxes with `agentbox destroy <name>` first — removing the plugin leaves
AgentBox unable to manage them. Base images and snapshots in your Tenki workspace are not deleted;
remove those through Tenki.

## Development

```bash
npm install
npm run build
npm test
npm run validate:package     # packs, installs in isolation, asserts the plugin contract

agentbox plugin add .        # register this working copy
agentbox doctor
```

## License

MIT — see [LICENSE](./LICENSE). Maintained by Luxor Labs. AgentBox itself is a separate project by
Marco D'Alia; this plugin builds on its public
[`@madarco/agentbox-provider-sdk`](https://www.npmjs.com/package/@madarco/agentbox-provider-sdk).
