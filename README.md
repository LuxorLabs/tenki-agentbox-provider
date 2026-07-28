# @luxorlabs/agentbox-provider-tenki

Run [AgentBox](https://agent-box.sh) coding agents in [Tenki](https://tenki.cloud) Firecracker
microVMs — a community provider plugin, published as its own package and registered with
`agentbox plugin add`.

> **Status: pre-release scaffold.** The package contract, toolchain, and CI are in place; the Tenki
> backend is being ported from the implementation validated in
> [madarco/agentbox#244](https://github.com/madarco/agentbox/pull/244). Not yet published to npm.

## What Tenki is

[Tenki](https://tenki.cloud) provisions Firecracker microVMs on demand, driven by the official
[`@tenkicloud/sandbox`](https://www.npmjs.com/package/@tenkicloud/sandbox) TypeScript SDK — a
ConnectRPC control plane plus a per-session data plane for command execution and file transfer.
Each AgentBox box becomes one Tenki session: a full VM with its own kernel, not a shared container.

## Supported AgentBox features

| Feature                        | Support   | Notes                                                                    |
| ------------------------------ | --------- | ------------------------------------------------------------------------ |
| `create` / `destroy`           | Yes       | Workspace seeded by git clone + carried-over stash and untracked files   |
| `exec`                         | Yes       | Over the session data plane (`session.run`)                              |
| File transfer (`cp`, download) | Yes       | Streaming read/write via the data plane                                  |
| Preview URLs                   | Yes       | Public HTTPS per port via `session.exposePort`, plus signed URLs         |
| Pause / resume                 | Yes       | Free and native (`session.pause` / `session.resume`)                     |
| Checkpoints                    | Yes       | Id-addressed snapshots (`createSnapshotAndWait`)                         |
| Interactive attach             | Yes       | Host PTY bridged to `session.ssh()`                                      |
| Session renewal                | Yes       | `session.extend` keeps a working box past its deadline                   |
| Base image                     | `prepare` | One-time `agentbox prepare --provider tenki` publishes the runtime image |
| Docker-in-box                  | No        | Pending nested-virtualization verification                               |
| Control Hub UI                 | No        | The hub loads only built-in providers; the CLI is fully supported        |

## Requirements

- Node.js 20 or newer
- The `agentbox` CLI (0.27.1 or newer — it must support provider SDK v2)
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

Expose your Tenki auth token as `TENKI_AUTH_TOKEN`:

```bash
export TENKI_AUTH_TOKEN=...          # or add TENKI_AUTH_TOKEN=… to ~/.agentbox/secrets.env
agentbox doctor                      # shows the `tenki:` group
```

`TENKI_API_TOKEN` is accepted as an alias. Credentials are read from the environment first, then
from `~/.agentbox/secrets.env` (mode `0600`); project `.env` files are never harvested. The token is
never logged and never included in the published package.

## Basic usage

One-time: publish the AgentBox runtime image into your Tenki workspace, then create a box.

```bash
agentbox prepare --provider tenki    # publishes the base image; records it locally
agentbox create --provider tenki
agentbox tenki claude                # provider-prefix sugar also works
```

Pin it project-wide with `box.provider: tenki` in `agentbox.yaml`, or per box with
`--provider tenki`.

## Resource configuration

Because AgentBox does not add config keys for plugin providers, Tenki reads its settings from the
generic keys plus its own environment variables:

| Setting            | Where                         | Notes                                        |
| ------------------ | ----------------------------- | -------------------------------------------- |
| VM size            | `--size` / `box.size`         | `cpu-memory[-disk]` in GB, e.g. `4-8-20`     |
| Default checkpoint | `box.defaultCheckpoint`       | Generic key; no per-provider variant         |
| Base image         | `AGENTBOX_TENKI_BASE_IMAGE`   | Overrides the ref recorded by `prepare`      |
| Parent image       | `AGENTBOX_TENKI_PARENT_IMAGE` | The image `prepare` builds the base from     |
| Workspace          | `AGENTBOX_TENKI_WORKSPACE_ID` | Defaults to the first workspace on the token |
| Session lifetime   | `AGENTBOX_TENKI_TIMEOUT_MS`   | Seeds the host keepalive loop                |

The baked base image ref lives in `~/.agentbox/tenki-prepared.json`, managed by this plugin.

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
- **No base image** — run `agentbox prepare --provider tenki`. Boxes boot from a registry image
  published into your own Tenki workspace, so this is required once per workspace.
- **Box expired mid-session** — raise `AGENTBOX_TENKI_TIMEOUT_MS`; the host keepalive extends a
  working session, but it starts from the lifetime the box was created with.

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
