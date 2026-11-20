---
name: targeted-tests
description: Use when running tests or builds. Run the tests for what you changed first, and the full suite only once at the end.
---

# Narrow tests first, the full suite once

1. First run only the tests closest to the files you changed (name the file, class, or test).
2. On failure, rerun just that failure while fixing it. Don't run everything each time.
3. Right before opening the PR, run the repository's full checks (tests, lint, type check) once.
4. Read mostly the failure summary: `--quiet`, `-q`, `--reporter=dot`, `| tail -50`.
5. Run slow integration tests only when they relate to the task; if you skipped them, say so in the PR body.
