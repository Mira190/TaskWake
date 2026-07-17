---
description: Cancel a pending TaskWake resumption
argument-hint: <session-id>
allowed-tools: Bash(node:*)
---

Run `node "${CLAUDE_PLUGIN_ROOT}/bin/taskwake.js" cancel $ARGUMENTS` and report the result in the user's language.
If no session id was given, first run `node "${CLAUDE_PLUGIN_ROOT}/bin/taskwake.js" status`, show pending sessions, and ask which one to cancel.