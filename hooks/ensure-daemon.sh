#!/usr/bin/env bash
# SessionStart hook: fast, non-blocking "ensure daemon running" healthcheck.
# Must never block or fail the session — always exit 0.

# Drain stdin (the hook JSON) so the caller's pipe never blocks; we ignore it.
cat >/dev/null 2>&1 || true

ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"

node "$ROOT/bin/effective.mjs" daemon-ensure >/dev/null 2>&1 || true

exit 0
