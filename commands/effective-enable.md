---
allowed-tools: Bash
description: Enable session-sync (uploads conversations to Effective)
---

First, ask the user for their Effective API key (it looks like `sk-eai-...`) if
they have not already provided one in this conversation. Do NOT echo the key
back in plaintext.

Then run `effective enable --token <KEY>` (substituting the key the user gave
you). The command prints a consent disclosure describing exactly what gets
uploaded and how secrets are redacted — relay that disclosure to the user and
confirm that sync is now enabled and the daemon started.

If the user also specifies a custom API base, append `--api <URL>`.

If the `effective` command is not found, run
`node "${CLAUDE_PLUGIN_ROOT}/bin/effective.mjs" enable --token <KEY>` instead.
