---
description: Show the recent TaskWake decision log
allowed-tools: Bash(node:*)
---

## Context

- Recent TaskWake log: !`node "${CLAUDE_PLUGIN_ROOT}/bin/taskwake.js" logs`

## Task

Summarize the log in the user's language: what was detected, resumed, skipped, and when.