---
name: self-review
description: Use before `gh pr create` when your task message asks for a self-review. A lighter-model reviewer checks the diff, you fix what holds up, and the PR body gets a one-line result.
---

# Self-review before the PR

1. Commit your work, then measure it: `git diff --shortstat origin/<default>...HEAD`. Leave lockfiles and generated files out of the count.
2. Skip the review when the change is within the limits in your task message, or touches only docs or comments. Put `Self-review: skipped (small change, N lines)` in the PR body and stop here.
3. Otherwise start the `self-reviewer` agent with the Agent tool. Tell it the base (`origin/<default>`), the task in a sentence or two, and anything it should know (files to focus on, trade-offs you chose). Don't paste the diff; it reads it itself.
4. Check each finding against the code. Fix the real ones, rerun the tests closest to the fix, and commit. Drop findings that are wrong or out of scope. Run the reviewer again only if a fix was large.
5. Add one to three lines to the PR body, never the reviewer's full output:
   - `Self-review: no findings.`
   - `Self-review: 2 fixed (missing null check in foo.ts, no test for empty input); 1 left (out of scope).`
6. If the reviewer could not run, read the diff once yourself and write `Self-review: done by the Worker (reviewer unavailable)`.
