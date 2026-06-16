# session-sync

A Claude Code plugin that syncs your Claude Code conversations to
[Effective](https://effective.ai) sessions.

## What it does

`session-sync` watches your Claude Code transcript files and uploads new
conversation events (prompts, responses, code, commands, and tool output) to the
Effective backend so your sessions show up in Effective.

## Architecture: decoupled background daemon

The plugin **never uploads on the conversation critical path**. A single
machine-level background daemon tails the Claude Code transcript `.jsonl` files
and uploads deltas out of band. The only thing that runs during your session is
a `SessionStart` hook performing a sub-50ms "ensure the daemon is running"
healthcheck — it spawns the daemon detached if needed and returns immediately.
The daemon polls the transcript directory every ~3 seconds, reads only the bytes
appended since its last cursor, redacts secrets, and `PUT`s the session then
`POST`s the new events. Nothing in this path can slow down or block your
conversation.

## Install

Add this repo as a marketplace and install the plugin:

```
/plugin marketplace add effectiveailabs/effective-claude-plugin
/plugin install session-sync@effective
```

Then enable syncing with your Effective API key:

```
effective enable --token sk-eai-...
```

`enable` prints a consent disclosure describing exactly what is uploaded, writes
config, and starts the background daemon.

You can also use the slash commands: `/effective-enable`, `/effective-status`,
`/effective-pause`, `/effective-disable`.

## Privacy and redaction

Transcripts include your prompts, Claude's responses, code, file contents, shell
commands, and tool output. Before upload, each line is scanned and secrets
matching common patterns are replaced with `[REDACTED]`:

- `sk-...` style API keys
- AWS access key ids (`AKIA...`)
- GitHub tokens (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`)
- `Bearer ...` tokens
- PEM private key blocks
- `password=`, `api_key=`, `secret=`, `token=` style assignments

This is best-effort and **not a guarantee** that all sensitive data is removed.
You can add your own regex patterns via the `redact` array in `config.json`.

## Pause / disable

```
effective pause     # keep the daemon running but stop uploading
effective resume    # resume uploading
effective disable   # stop uploading and stop the daemon entirely
effective status    # show config, daemon state, and per-file sync progress
```

## Where config and logs live

By default, under `$HOME/.config/effective-sync/` (override with the
`EFFECTIVE_SYNC_HOME` environment variable):

- `config.json` — apiBase, token, enabled/paused flags, extra redact patterns
- `state.json` — per-file sync offsets, sequence counts, cursors, last error
- `daemon.pid` — single-instance lock
- `daemon.log` — daemon activity and errors

Transcripts are read from `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects`.

## Sources

The daemon watches multiple agent transcript sources and tags each uploaded
batch with its `source`:

- **Claude Code** — `~/.claude/projects/**/*.jsonl` (override the root with
  `CLAUDE_CONFIG_DIR`)
- **OpenAI Codex** — `~/.codex/sessions/**/rollout-*.jsonl` (override the root
  with `CODEX_HOME`)

## License

MIT © Effective AI Labs
