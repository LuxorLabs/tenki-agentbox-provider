# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately through GitHub: go to the
[Security tab](https://github.com/LuxorLabs/tenki-agentbox-provider/security) and use
**Report a vulnerability**. That opens a private advisory visible only to you and the maintainers.

Useful things to include: the version you are on, what an attacker would need (a Tenki token? host
access? a malicious box?), and the smallest reproduction you have. If you are unsure whether
something counts, report it anyway and we will sort it out.

You will get an acknowledgement once we have triaged the report, and we will keep you updated as we
work on a fix. If we agree it is a vulnerability, we will credit you in the advisory unless you would
rather stay anonymous.

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |

This package is pre-1.0: fixes land on the latest minor rather than being backported.

## Scope

In scope — anything in this repository: the provider plugin, its credential handling, the base-image
bake (`prepare`), the attach path, and the published npm artifact.

Out of scope, but please still tell the right people:

- The **Tenki platform** or the `@tenkicloud/sandbox` SDK → report to Tenki.
- **AgentBox itself** or `@madarco/agentbox-provider-sdk` → report to
  [madarco/agentbox](https://github.com/madarco/agentbox).

## Trust model

Worth understanding before you file something, because a few of these look like vulnerabilities and
are in fact the documented design:

- **A provider plugin runs in-process with the AgentBox CLI**, with full host and credential access.
  AgentBox does not sandbox plugin code — provisioning infrastructure and handling secrets is the
  job. `agentbox plugin add` is the consent boundary. This is inherent to the plugin contract, not a
  flaw in this package.
- **The Tenki token** is read from the environment or `~/.agentbox/secrets.env` (written atomically
  at mode `0600`). It is never logged, never written into a snapshot, and never included in the
  published package. `agentbox doctor` shows it masked.
- **Credentials are not baked into the base image**, deliberately. `prepare` bakes only static agent
  config; AgentBox seeds credentials per box at create time, so a long-lived or shared snapshot
  carries no auth tokens.
- **Inside a box, the agent is effectively root.** The box user has passwordless `sudo` and is in the
  `docker` group, which is root-equivalent by design — in-box Docker requires it. The security
  boundary is the microVM, not the in-box user. An agent cannot reach your host filesystem, and host
  operations needing your credentials (`git push`) are brokered by the AgentBox host relay.
- **Interactive attach trusts the Tenki gateway's TLS rather than an SSH host key.** The SSH session
  runs over the gateway's authenticated WebSocket, and the "host" is a session id rather than a
  stable endpoint, so `StrictHostKeyChecking` is off and no host key is pinned. If you override
  `TENKI_BASE_URL` or `TENKI_GATEWAY_ADDRESS`, point them only at endpoints you trust — there is no
  second layer of authentication behind them.
- **Preview URLs are public.** An exposed port gets an HTTPS URL that anyone holding it can reach; no
  token is required. Use the signed (expiring) variant for anything you don't want durably
  reachable, and `agentbox` will unexpose the port when the box is destroyed.
