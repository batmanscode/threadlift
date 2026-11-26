# Threadlift

Read README.md for supported versions, the user flow, and data boundaries.

- Use isolated profiles for all write tests. Never run development imports against a real Codex or T3 profile.
- Preserve existing chats, original source files, target ownership locking, and fail-closed format checks.
- Keep the skill a concise launcher for deterministic code. Do not put database surgery in model instructions.
- Change the T3 adapter in `adapters/`, rebuild it from the pinned upstream commit, and retain upstream licenses. Do not hand-edit the generated vendor bundle.
- Match validation to the change: doc/link review for docs-only edits, `npm test` for relevant code changes, the affected browser journey for UI, and an isolated macOS app lifecycle check for quit/reopen changes. For T3 compatibility updates, follow the [README verification requirements](README.md#verification). Do not add unrelated features or configuration.
- Update `README.md` and `skills/threadlift/SKILL.md` where behavior, supported versions, commands, or limits change. Update only the affected documentation.
- Report what ran, what failed, and what remains untested honestly. Model reviews are second opinions, not evidence that runtime behavior worked.
- Keep `work/`, job data, screenshots of private chats, and credentials out of commits.
