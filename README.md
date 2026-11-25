# Threadlift

Bring missing Codex chats—and their files—into T3 Code.

Threadlift is a local recovery helper for **macOS, T3 Code 0.1.12, and the default Codex instance (`codex`)**. It handles the case where a Codex chat started without a project, was later moved into one, and never appeared in T3's import. Use T3's normal setup/import first.

## Start from a T3 chat

Copy this into a new T3 chat:

```text
Read https://github.com/batmanscode/threadlift and use Threadlift to help me import my missing Codex chats. Launch the picker in my system browser so I can choose the chats and files. Leave existing chats unchanged.
```

With local command/file permissions, the agent can obtain and run Threadlift. You do not need to operate Terminal or install a separate Mac app yourself. The optional [skill](skills/threadlift/SKILL.md) teaches the same workflow; it is not required.

1. **Select chats.** The browser lists recent local Codex chats, marks those already in T3, and previews the selected history and recoverable uploads.
2. **Review files and folders.** Keep project files in place, or opt in to copy files from the chat’s original folder. Existing destination files are never overwritten. Locate the current folder if it was renamed. Missing files are listed rather than invented.
3. **Prepare import.** Threadlift stages the selected data and starts an independent helper. T3's database has not been changed yet.
4. **Finish other T3 runs, then quit T3 with Cmd+Q.** Quitting T3 ends its active agent run; that is expected. The independent helper keeps working. Keep the system-browser tab open for progress and the receipt. Do not start another T3 server or CLI write during the import.
5. **Wait.** The helper takes a consistent backup, imports, verifies, and reopens T3. The browser shows the result. If reopening fails, it explicitly asks you to open T3 normally.

Find imported chats in T3’s **Settled** section, or search their titles. Open one and send a follow-up to check continuation. The receipt distinguishes verified history/files from the original session binding; **a binding alone does not prove a successful live follow-up**.

## Run directly

Requires **Node 24.10 or later**, an initialized T3 0.1.12 profile, and the default Codex provider instance (`codex`) using the same Codex home as the source. The release checkout includes its T3 adapter; no `npm install` is needed to run it. An agent can use an available compatible Node runtime, or help set one up. Do not assume the system `node` is compatible.

```sh
git clone https://github.com/batmanscode/threadlift.git
cd threadlift
node bin/threadlift.mjs open
```

For an agent-managed installation, keep the checkout somewhere stable such as `~/Library/Application Support/Threadlift/app`, rather than an automatically cleaned-up T3 worktree. The helper must remain available after T3 quits.

Useful options:

```sh
node bin/threadlift.mjs inspect
node bin/threadlift.mjs open --codex-home /path/to/.codex --t3-home /path/to/.t3
node bin/threadlift.mjs open --days 0
node bin/threadlift.mjs status --job /absolute/path/to/job.json
```

`inspect` reads metadata without importing. The normal scan covers 30 days; `--days 0` includes older local chats. `--app` selects a custom T3 app location. `--no-reopen` is for isolated profiles/headless testing; it does not disable compatibility checks. `apply --job PATH` runs or retries an already prepared job and waits for the server ownership lock. Automatic reopening supports the default `~/.t3` profile; use `--no-reopen` for isolated profiles and open the intended profile yourself.

## What comes across

- Available **user/assistant conversation messages**, with timestamps. Selected chats are not truncated to 200 messages.
- Recoverable local uploaded images and files, stored as T3 attachments.
- Files already in a project folder remain there. Optional recovery copies regular files from the chat's original working folder without overwriting destination files.
- The original Codex session ID and selected working folder are linked so T3 can attempt continuation. Check with a real follow-up after importing.
- Plain JSONL, Zstandard-compressed rollouts, and inherited `history_base` prefixes. Unsupported or incomplete rewind histories stop with an explanation.

Existing T3 chats—including partial imports—are left unchanged. Threadlift does not merge into or replace them. It does not recreate deleted files, download remote-only attachments, migrate credentials/settings, replay every Codex tool/UI panel, or translate sessions to another provider. Historical absolute links in conversation text are preserved and may still point to an old folder.

Current bounds: 20 chats per job, 128 MiB of decompressed conversation data per chat including inherited history, 1 GiB of staged files per job, and 10,000 files per workspace recovery. T3's attachment limits also apply: 10 MiB per supported image, 50 MiB per ordinary file, 100 attachments per message. Oversized conversations are rejected rather than silently shortened. Workspace recovery skips `.git`, `node_modules`, `.venv`, `__pycache__`, and symlinks; the receipt lists skips.

## Local data and recovery

Chat data stays on this Mac. There is no telemetry, account, cloud upload, or Gemini/API dependency in Threadlift. Development review used synthetic test data.

Each job lives in `~/Library/Application Support/Threadlift/jobs/` with private file permissions. It contains a conversation copy, staged files, a file manifest, a consistent SQLite backup, status, and a receipt. Treat this directory as private: it contains your chat content. The browser link is private too.

Threadlift holds T3's own `server-owner.sqlite` lock throughout backup, import, and verification. It never deletes that lock or kills T3 processes. Unsupported database formats and managed T3 environments are refused. Original Codex data is read-only.

History verification runs inside the SQLite transaction before commit: a pre-commit failure leaves T3’s database unchanged. If the helper is interrupted after commit, it preserves imported data. `node bin/threadlift.mjs apply --job /absolute/path/job.json` can verify/retry that same job without importing it twice. If imported data has since changed, it stops rather than overwriting it. Threadlift never automatically restores a database backup.

Failures are reported in the browser and job status. A backup is not permission to replace a database after you have done new work: do not copy `before.sqlite` over a live or subsequently changed profile. Keep the job directory until you have checked the imported chat and files. Once satisfied and the helper has finished, you can remove the job directory to reclaim space and remove the extra local chat copy.

## Development

`open` keeps its picker server running until preparation hands off to the independent worker. Agents should run it in their supported background/long-running command facility, retain the private link, and return control to the user. Do not wait for the user to select chats inside a blocking tool call.

Runtime code uses Node built-ins plus a bundled, version-pinned T3 adapter. The adapter uses T3's own event writer and projections rather than handwritten projection updates.

```sh
npm ci
git clone --depth 1 --branch v0.1.12 https://github.com/pingdotgg/t3code.git work/t3code
npm run build:adapter
npm test
```

The build verifies upstream commit `ca81b7b97a1c4b91e5ac25768d0f6629f37732fd`. Tests create isolated Codex/T3 profiles; never point development servers or write tests at a real profile. The first release was also checked against the official T3 0.1.12 server and web client: earlier history and attachment downloads worked, and a real Codex session continued with its remembered context and read a copied file from the selected project folder. The desktop app was not installed for this test, so its normal quit and automatic relaunch were not exercised. This is evidence for the tested path, not every possible Codex history or provider configuration.

A compatibility update needs an upstream writer build, schema fixture, full-history/file checks, existing-chat protection, failure recovery, and a real-client pass.

Small, focused fixes are welcome. Include what failed and a test or reproduction. Please omit chat dumps, local credentials, and private job directories from issues.

## License and references

New Threadlift code is [Apache-2.0](LICENSE). Bundled T3 Code and dependencies retain their [upstream notices](vendor/THIRD_PARTY_LICENSES.txt). Threadlift is an independent recovery tool.

- [Native project-discovery fix, T3 PR #34542](https://github.com/pingdotgg/t3code/pull/34542)
- [T3's released importer](https://github.com/pingdotgg/t3code/blob/v0.1.12/apps/server/src/project/AgentSessionImporter.ts)
- [Peter Steinberger's agent/skill guidance](https://github.com/steipete/agent-scripts)
- [OpenClaw skill-creation guidance](https://github.com/openclaw/openclaw/blob/main/skills/skill-creator/SKILL.md)

Threadlift was developed and reviewed with Codex and Gemini. Review assistance is not a guarantee of data fidelity; the tests and receipts describe the evidence.

