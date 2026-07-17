---
description: List pending and recently completed TaskWake resumptions
allowed-tools: Bash(node:*)
---

## Context

- Current TaskWake state: !`node "${CLAUDE_PLUGIN_ROOT}/bin/taskwake.js" status`

## Task

Present the state in the user's language. For pending entries, include the next attempt time. If there is no activity, say so in one sentence.