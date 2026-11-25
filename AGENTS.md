# Threadlift

Read README.md for supported versions, the user flow, and data boundaries.

- Use isolated profiles for all write tests. Never run development imports against a real Codex or T3 profile.
- Preserve existing chats, original source files, target ownership locking, and fail-closed format checks.
- Keep the skill a concise launcher for deterministic code. Do not put database surgery in model instructions.
- Change the T3 adapter in `adapters/`, rebuild it from the pinned upstream commit, and retain upstream licenses. Do not hand-edit the generated vendor bundle.
- Run `npm test` after relevant changes; use the browser for a user-facing flow change. Do not add unrelated features or configuration.
- Keep `work/`, job data, screenshots of private chats, and credentials out of commits.
