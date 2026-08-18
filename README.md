# NeevSandbox for DeepSeek Harness

`@neevcloud/dsh-sandbox` runs DeepSeek Harness subprocess work — Bash, PTY, and
LSP — inside a short-lived NeevSandbox. It is an installable `dsh` bundle and
requires no changes to the Harness installation.

The bundle replaces the local subprocess provider (`ctx.subprocess`) with one
backed by a NeevSandbox. Because the Harness Bash, terminal, and LSP tools
delegate every execution-world operation to that seam, they run in the sandbox
unchanged.

## Prerequisites

- Node.js `^22.19.0` or `>=24.0.0`
- `@deepseek-ai/dsh` `0.1.0-rc.7` or a later compatible release
- A Neev project with `NEEV_API_KEY`, `NEEV_ORG_ID`, and `NEEV_PROJECT_ID` set
  in the host environment

Keep credentials in environment variables or a secret manager; do not commit
them.

## Install

```sh
npm install --global @deepseek-ai/dsh
dsh plugin --profile headless add @neevcloud/dsh-sandbox
NEEV_API_KEY=... NEEV_ORG_ID=... NEEV_PROJECT_ID=... \
  dsh --profile headless "build and test this repo"
```

During development, install a local checkout from its directory:

```sh
npm install
npm run build
dsh plugin --profile headless add .
```

Each run prints the sandbox id at both lifecycle boundaries; the ids should
match:

```text
NeevSandbox created: <sandbox-id>
NeevSandbox terminated: <sandbox-id>
```

## Configuration

The bundle starts an ephemeral sandbox on profile boot and deletes it when
`dsh` exits. The runtime module accepts these Cordis config fields:

| Field | Default | Meaning |
|---|---|---|
| `apiKey` | `NEEV_API_KEY` | Neev API credential, used only by the host SDK |
| `orgId` | `NEEV_ORG_ID` | Organization id |
| `projectId` | `NEEV_PROJECT_ID` | Project id |
| `templateId` | `sb-ubuntu-26-04-dev` | Sandbox template the server provisions from |
| `image` | — | Explicit image, used when `templateId` is omitted |
| `cwd` | discovered | Absolute working directory; discovered via `pwd` when omitted |

To override rows directly in the profile's `cordis.patch.yml`, restate the
fields you need (a patch replaces the complete config):

```yaml
- id: neev-runtime
  name: '@neevcloud/dsh-sandbox/runtime'
  config:
    templateId: sb-ubuntu-26-04-dev
```

## Scope and limitations

- **Subprocess only.** This release provides `ctx.subprocess` (Bash, PTY, LSP).
  The filesystem stays host-side, so the file tools and Bash observe different
  working trees until a Neev filesystem provider is added.
- **No numeric pid.** Sandbox processes are addressed by id, so the seam's
  `pid` is reported as `-1`; process control uses the sandbox process id.
- **PTY working directory and environment** follow the sandbox defaults; the
  PTY create API does not accept a per-session cwd or environment.
- **Interactive stdin** is available through the terminal (PTY); ordinary
  managed processes accept startup stdin only.

## Develop

```sh
npm install
npm run check   # lint, typecheck, test, build
npm pack
```

The two Loader entry points are `@neevcloud/dsh-sandbox/runtime` and
`@neevcloud/dsh-sandbox/subprocess`; each default-exports its service class.
