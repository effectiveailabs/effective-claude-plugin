---
allowed-tools: Bash
description: Show session-sync status (config, daemon, per-file sync state)
---

Run `effective status` and summarize the result for the user: whether sync is
enabled and paused, whether the background daemon is running, the API base, the
masked token, and a short per-file sync summary (offsets, last synced time, and
any last error). If the `effective` command is not found, tell the user the
plugin's `bin/` may not be on PATH and they can run
`node "${CLAUDE_PLUGIN_ROOT}/bin/effective.mjs" status` instead.
