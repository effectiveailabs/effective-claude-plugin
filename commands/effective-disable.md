---
allowed-tools: Bash
description: Disable session-sync and stop the background daemon
---

Run `effective disable` and confirm to the user that sync is now disabled and
the background daemon has been stopped. No further conversation data will be
uploaded until they run `effective enable` again.

If the `effective` command is not found, run
`node "${CLAUDE_PLUGIN_ROOT}/bin/effective.mjs" disable` instead.
