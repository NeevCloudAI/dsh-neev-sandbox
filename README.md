<p align="center">
  <img src="assets/hero.svg" alt="NeevSandbox for DeepSeek Harness" width="100%">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@neevcloud/dsh-sandbox"><img alt="npm version" src="https://img.shields.io/npm/v/@neevcloud/dsh-sandbox?color=4f46e5"></a>
  <a href="https://www.npmjs.com/package/@neevcloud/dsh-sandbox"><img alt="npm downloads" src="https://img.shields.io/npm/dm/@neevcloud/dsh-sandbox?color=0d9488"></a>
  <img alt="Node" src="https://img.shields.io/badge/node-%E2%89%A522-3c873a">
  <img alt="DeepSeek Harness" src="https://img.shields.io/badge/DeepSeek%20Harness-0.1.0--rc.7%2B-7c3aed">
  <img alt="License" src="https://img.shields.io/badge/license-Apache%202.0-0d9488">
</p>

# @neevcloud/dsh-sandbox

Give your DeepSeek Harness agent a **clean, disposable Linux box** for every run.
This bundle relocates the Harness's execution world — **files, Bash, PTY, and
LSP** — into a short-lived, gVisor-isolated [NeevSandbox](https://neevcloud.com).
Files the agent writes and commands it runs share one sandbox, nothing runs on
your machine, and there's **nothing to fork**: drop the bundle into any `dsh`
install and the stock tools keep working, now executing remotely.

```sh
npm install --global @deepseek-ai/dsh
dsh plugin --profile headless add @neevcloud/dsh-sandbox
NEEV_API_KEY=... NEEV_ORG_ID=... NEEV_PROJECT_ID=... \
  dsh --profile headless "clone my repo, run the tests, and summarize the failures"
```

Your agent's `pwd`, `id`, files it writes, servers it starts — all live in the
sandbox, not on your laptop.

## Why

DeepSeek Harness is built on **capability seams**: swappable interfaces that
providers implement and tools consume. The Harness Bash, terminal, and LSP
tools delegate every execution-world operation to one seam — `ctx.subprocess`.
Replace that single provider and **all of them move together**, with no changes
to the tools themselves. That's the whole idea here: one small bundle, and your
agent's execution world is a remote sandbox.

> Follows the Harness [capability-seam](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/capability-seams.md)
> model and installs through the standard `dsh plugin` bundle mechanism — no
> Harness source changes, no monorepo checkout.

## How it works

<p align="center">
  <img src="assets/how-it-works.svg" alt="The same agent, but its code runs inside an isolated gVisor sandbox instead of on your machine" width="100%">
</p>

Three Cordis services, shipped as one bundle:

| Entry point | Registers | Role |
|---|---|---|
| `@neevcloud/dsh-sandbox/runtime` | `ctx.neev` | Owns one sandbox: create → ready → delete on exit |
| `@neevcloud/dsh-sandbox/subprocess` | `ctx.subprocess` | Runs processes and PTYs in that sandbox |
| `@neevcloud/dsh-sandbox/filesystem` | `ctx.fs` | Reads, writes, edits, and lists files in that sandbox |

A shipped `cordis.patch.yml` wires them in: it disables the local subprocess
provider, inserts the two Neev rows, and sets the sandbox-aware Bash executor to
delegate straight through. `dsh plugin add` applies it for you.

## Use cases

- **Run untrusted or AI-generated code** off your machine — the blast radius is
  a disposable gVisor sandbox that's deleted when the run ends.
- **A fresh box per task.** Every `dsh` run gets its own clean Linux
  environment; no leftover state, no "works on my laptop."
- **Fan out agents in parallel**, each isolated in its own sandbox, without them
  stepping on each other's files or processes.
- **Reproducible, CI-like execution** decoupled from whatever is installed on
  the host.
- **Long-running or interactive work** — dev servers, REPLs, and TUIs run over a
  real PTY inside the sandbox.

## Install

```sh
npm install --global @deepseek-ai/dsh
dsh plugin --profile headless add @neevcloud/dsh-sandbox
```

Set your Neev credentials in the host environment (never commit them):

```sh
export NEEV_API_KEY=...      # your Neev API key
export NEEV_ORG_ID=...       # organization id
export NEEV_PROJECT_ID=...   # project id
```

New to NeevCloud? Create an API key and find your organization and project ids
by following [Retrieve organization and project IDs](https://docs.ai.neevcloud.com/tutorials/create-your-first-sandbox-in-neevcloud-agentic-studio-javascript-sdk#step-3-retrieve-organization-and-project-ids)
in the Agentic Studio quickstart.

Then run a task:

```sh
dsh --profile headless "use Bash to run 'cat /etc/os-release' and 'id -un', and report the output"
```

A successful run reports the **sandbox's** OS and user — not your host's — and
prints the sandbox id at both lifecycle boundaries:

```text
NeevSandbox created: <sandbox-id>
NeevSandbox terminated: <sandbox-id>
```

Verify the wiring anytime with `dsh --profile headless --dump-config`: the
`subprocess` row is disabled and the `neev-runtime` / `neev-subprocess` rows are
inserted.

### Local development install

```sh
git clone https://github.com/NeevCloudAI/dsh-neev-sandbox && cd dsh-neev-sandbox
npm install && npm run build
dsh plugin --profile headless add .
```

## Configuration

The runtime module accepts these Cordis config fields (all optional):

| Field | Default | Meaning |
|---|---|---|
| `orgId` | `NEEV_ORG_ID` | Organization id |
| `projectId` | `NEEV_PROJECT_ID` | Project id |
| `templateId` | `sb-ubuntu-26-04-minimal` | Sandbox template the server provisions from |
| `image` | — | Explicit OCI image; takes precedence over `templateId` |
| `cwd` | discovered | Absolute working directory; discovered via `pwd` when omitted |

The **API key is read only from `NEEV_API_KEY`** — it is never a config field,
so a secret can never end up in a committed profile patch, and it is never
forwarded into the sandbox.

Override a row in your profile's `cordis.patch.yml` (a patch replaces the whole
config, so restate what you need):

```yaml
- id: neev-runtime
  name: '@neevcloud/dsh-sandbox/runtime'
  config:
    templateId: sb-ubuntu-26-04-minimal
```

## Scope and limitations

- **File versions are metadata-derived.** The SDK exposes no native version
  token, so the freshness token guarding `writeText`/`editText` is a hash of the
  file's mtime, size, and mode. Guards work; there is a small non-atomic window
  between the version check and the write.
- **Writes are atomic via temp + rename**, and paths resolve without symlink
  canonicalization (`realpath`) in this release.
- **Interactive stdin** flows through the terminal (PTY); ordinary managed
  processes take startup stdin only.
- **Environment:** only your explicit entries are forwarded; credential-shaped
  and `NEEV_*` names are always stripped, and the sandbox keeps its own base
  environment (a base-image variable cannot be unset through the spawn env).
- **PTY working directory and environment** follow the sandbox defaults.

## Resources

- [Create your first sandbox (Agentic Studio, JS SDK)](https://docs.ai.neevcloud.com/tutorials/create-your-first-sandbox-in-neevcloud-agentic-studio-javascript-sdk) — get an API key and your org/project IDs
- [Sandbox Runtime API reference](https://docs.ai.neevcloud.com/api-reference/sandbox-runtime) — the sandbox APIs this bundle builds on
- [AI Agent API reference](https://docs.ai.neevcloud.com/api-reference/ai-agent) — the agent platform APIs
- [`@neevcloud/sdk`](https://www.npmjs.com/package/@neevcloud/sdk) — the JavaScript SDK the providers use
- [DeepSeek Harness capability seams](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/capability-seams.md) — the `ctx.subprocess` / `ctx.fs` model this plugs into

## Develop

```sh
npm install
npm run check      # lint · typecheck · test · build
npm pack
```

Live tests exercise a real sandbox and skip automatically unless `NEEV_API_KEY`
(with `NEEV_ORG_ID` / `NEEV_PROJECT_ID`) is set. Both Loader entry points
default-export their service class.

For a self-contained taste of the providers without `dsh` or a model, run
[`examples/quickstart.mjs`](examples/quickstart.mjs) — it runs a command in the
sandbox, writes a file with `ctx.fs`, and reads it back with Bash:

```sh
npm install && npm run build
NEEV_API_KEY=... NEEV_ORG_ID=... NEEV_PROJECT_ID=... node examples/quickstart.mjs
```

## License

Apache 2.0 — see [LICENSE](LICENSE).
