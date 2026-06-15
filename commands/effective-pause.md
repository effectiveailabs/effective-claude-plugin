---
allowed-tools: Bash
description: Pause session-sync uploads (daemon keeps running)
---

Run `effective pause` and confirm to the user that uploads are paused. The
background daemon keeps running but will not upload anything until they run
`effective resume`. This is a quick way to temporarily stop syncing without
fully disabling the plugin.

If the `effective` command is not found, run
`node "${CLAUDE_PLUGIN_ROOT}/bin/effective.mjs" pause` instead.
