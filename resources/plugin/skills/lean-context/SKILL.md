---
name: lean-context
description: Use before reading or exploring files in a large repository. Read only what you need to save context and tokens.
---

# Read only what you need

- Before opening a whole file, find the spot with Grep or `rg -n` and read just that range with Read's offset/limit.
- Don't reread files you have already read. Don't reread right after an edit to check it (Edit reports failures).
- Don't open generated files, lock files, build output, minified files, or large fixtures.
- Trim command output with `| head`, `--quiet`, `-q`. Look at the failing part, not the whole log.
- Look at the directory layout once with `git ls-files | head -200` or Glob, and remember it.
