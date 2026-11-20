---
name: cheap-search
description: Use when you need to search widely across a codebase. If you only need the conclusion, hand it to a subagent on a lighter model.
---

# Delegate wide searches

- When sweeping many directories only to learn something like "where does X happen", start a subagent with the Agent tool and set its model to haiku.
- Tell the subagent exactly what to find, where to look, and what to return (a list of file:line).
- Do searches that one or two Greps would finish yourself; a subagent costs more.
- Don't reread whole files to double-check a subagent's result. Read only the lines you need.
