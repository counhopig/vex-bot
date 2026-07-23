# Archived pre-rewrite code

Everything under `src/` and `tests/` here is the old architecture, moved wholesale
via `git mv` (history preserved) as of the start of the full rewrite described in
[`../docs/rewrite-plan.md`](../docs/rewrite-plan.md).

**This tree is reference only.** It does not build, is not linted, and is not
covered by CI. Nothing in the live `src/`/`tests/` may import from here.

Use it to look up:
- exact behavior of a module being rewritten (e.g. what `UserRuntimeManager`
  actually did before it became `AgentRegistry`)
- security-critical logic that must be carried into the new implementation
  (SSRF guards, timing-safe auth, path-traversal checks, atomic writes, etc.)
- test cases worth re-deriving as new TDD cycles for the rewritten module

Do not copy-paste files back out verbatim — every new module is written fresh,
with its own tests, per the rewrite plan's process.
