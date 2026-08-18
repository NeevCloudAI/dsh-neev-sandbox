# Changelog

## 0.2.0

- Persistent sandbox (opt-in). A new `persist` config reuses one sandbox across
  runs — reconnected by name, paused instead of deleted on exit — so its files
  survive; `idleTimeoutMs` auto-pauses an idle sandbox and resumes it lazily on
  the next operation. Default behavior is unchanged (fully ephemeral).
- The subprocess and terminal providers hold the sandbox awake for the life of a
  live process or PTY, so an idle auto-pause can never freeze work in flight.
- Resume waits for the data plane to be routable before use, avoiding a transient
  post-resume connect error.

## 0.1.1

- Docs: live npm badges, a runnable `examples/quickstart.mjs`, an FAQ, and a
  "Retrieve organization and project IDs" pointer in the install steps.
- Release: publish with npm provenance (signed build attestation).

No changes to the providers or runtime behavior.

## 0.1.0

First release. A DeepSeek Harness plugin that relocates the execution world —
files, Bash, PTY, and LSP — into a short-lived, gVisor-isolated NeevSandbox.

- `@neevcloud/dsh-sandbox/runtime` (`ctx.neev`) — owns one sandbox's lifecycle.
- `@neevcloud/dsh-sandbox/subprocess` (`ctx.subprocess`) — processes and PTYs.
- `@neevcloud/dsh-sandbox/filesystem` (`ctx.fs`) — files, so a file Bash writes
  is visible to the file tools and vice versa.
- Ships a `cordis.patch.yml` that wires the providers in as one sandbox world.
