# Changelog

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
