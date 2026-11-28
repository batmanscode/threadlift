# Threadlift

Bring missing Codex chats—and their files—into T3 Code.

Threadlift is a local recovery helper for **macOS and the default Codex instance (`codex`)**, tested with **T3 Code 0.1.12 and 0.1.13**. It handles the case where a Codex chat started without a project, was later moved into one, and never appeared in T3's import. Use T3's normal setup/import first.

## Start from a T3 chat

Copy this into a new T3 chat:

```text
Read https://github.com/batmanscode/threadlift and use the latest Threadlift to help me import all missing Codex chats and their available files, including generated files. Launch the picker in my system browser so I can use Select all missing. Leave existing chats unchanged.
```

With local command/file permissions, the agent can obtain and run Threadlift. You do not need to operate Terminal or install a separate Mac app yourself. The optional [skill](skills/threadlift/SKILL.md) teaches the same workflow; it is not required.

1. **Select all missing.** One button scans every date and selects the missing chats, with available uploads and generated/linked files selected by default. Chats already in T3 are skipped. Internal subagent/helper sessions are excluded and counted separately; your regular chats and user forks remain eligible. You can also select individual chats. Chats that cannot be read are listed; acknowledge any omissions before continuing. Large selections are automatically divided into batches; you do not need to select 20 at a time.
2. **Review files and folders.** Keep all available files selected, or deselect anything you do not want to recover. The current Codex project assignment determines the suggested folder, including chats moved from No project; Threadlift creates or reuses the T3 project for that folder. Chats needing a valid folder are identified before preparing. Keep project files in place, or opt in to copy files from the chat’s original folder. Existing destination files are never overwritten. Locate the current folder if it was renamed. Missing files are listed rather than invented.
3. **Prepare import.** Threadlift stages the selected data and starts an independent helper. T3's database has not been changed yet.
4. **Finish other T3 runs, then quit T3 with Cmd+Q.** Quitting T3 ends its active agent run; that is expected. The independent helper keeps working. Keep the system-browser tab open for progress and the receipt. Do not start another T3 server or CLI write during the import.
5. **Wait.** The helper takes a consistent backup for each batch, imports and verifies them, then reopens T3 once. Keep T3 closed until every batch finishes. The browser shows the result. If reopening fails, it explicitly asks you to open T3 normally.

Find imported chats in T3’s **Settled** section, or search their titles. **Before doing real work in T3, check that the chats you expected are present, earlier and recent messages are readable, uploads open, and each chat points to the right project folder.** Review missing/skipped files in the receipt. If you want to check continuation, send a follow-up after reading the [shared-session note below](#local-data-and-recovery). The receipt distinguishes verified history/files from the original session binding; **a binding alone does not prove a successful live follow-up**.

## Run directly

Requires **Node 24.10 or later**, an initialized T3 profile with a recognized database format, and the default Codex provider instance (`codex`) using the same Codex home as the source. **Compatibility:** tested on T3 0.1.12 and 0.1.13. Later app/server versions can proceed with a warning if the database still matches one of those tested formats. Unknown database formats and app/server versions older than the detected format are refused. A version warning is not a claim that a future release works.

The release checkout includes its T3 adapter; no `npm install` is needed to run it. An agent can use an available compatible Node runtime, or help set one up. Do not assume the system `node` is compatible.

```sh
git clone https://github.com/batmanscode/threadlift.git
cd threadlift
node bin/threadlift.mjs open
```

For an agent-managed installation, keep the checkout somewhere stable such as `~/Library/Application Support/Threadlift/app`, rather than an automatically cleaned-up T3 worktree. The helper must remain available after T3 quits. Finish any long T3 runs before preparing: the worker waits up to 20 minutes for T3 to quit.

Useful options:

```sh
node bin/threadlift.mjs inspect
node bin/threadlift.mjs open --codex-home /path/to/.codex --t3-home /path/to/.t3
node bin/threadlift.mjs open --days 0
node bin/threadlift.mjs status --job /absolute/path/to/job.json
```

`inspect` reports compatibility and chat counts without printing chat titles or paths. Use `inspect --details` only when you want that private metadata in the command output. The normal scan covers 30 days; `--days 0` includes older local chats. `--app` selects a custom T3 app location. `--no-reopen` is for isolated profiles/headless testing; it does not disable compatibility checks. `apply --job PATH` runs or retries an already prepared job and waits for the server ownership lock. Automatic reopening supports the default `~/.t3` profile; use `--no-reopen` for isolated profiles and open the intended profile yourself.

## What comes across

- Available **user/assistant conversation messages**, with timestamps. Selected chats are not truncated to 200 messages.
- Recoverable local uploaded images and files, stored as T3 attachments.
- Selected **generated and linked files**, including local HTML, PDFs, images and ZIPs. Imported file links open project files in T3. Files already in the selected folder stay there; other selected files are copied together under `Threadlift files/` there, or use the workspace copy you requested. The receipt lists their locations. Structured assistant files gain a file link in the same reply.
- Files already in a project folder remain there. Optional recovery copies regular files from the chat's original working folder without overwriting destination files.
- The original Codex session ID and selected working folder are linked so T3 can attempt continuation. Check with a real follow-up after importing.
- Plain JSONL, Zstandard-compressed rollouts, and inherited `history_base` prefixes with an explicit byte boundary. Same-thread rewinds, ambiguous versions, missing active rollouts, and incomplete histories stop with an explanation; an old discarded branch is never selected as a fallback.

Saved chat names use Codex’s desktop title map, then its local session index and database. Only a regular chat with no saved name gets a short title from its first substantive user message. Internal helper sessions are excluded by explicit source metadata, never by a missing title, a short conversation, or the word “subagent” in a prompt. Their rollout files remain available to resolve inherited history and recover files referenced in that history.

Existing T3 chats—including partial imports and helper chats imported by an earlier Threadlift release—are left unchanged. Threadlift does not merge into or replace them. It does not recreate deleted files, download remote-only attachments, migrate credentials/settings, replay every Codex tool/UI panel, or translate sessions to another provider. Only selected local file-link destinations change in the imported text; the original Codex messages and unselected links stay unchanged. Prose and code samples are preserved. Unselected historical paths may still point to an old folder.

Available uploads and generated/linked files start selected. Review or deselect files before preparing; workspace-folder recovery stays opt-in. Bulk selection scans all dates, regardless of the current search filter. A repeated bulk scan refreshes the previews and retains explicit folder/file choices where still applicable. Relative files use the folder recorded for their message, including inherited history. An unknown folder is reported instead of guessing.

Single-file HTML can be recovered alone. Pages with local images or other files need their folder layout preserved: use workspace recovery if it includes the whole page folder, or a ZIP. Selecting the page and its companions separately does not guarantee that layout. External linked files copied together share a relative folder tree, while files kept in the project or imported as chat uploads can be placed elsewhere. Threadlift does not inspect or rewrite links inside HTML. Check the rendered page in T3 after importing.

Current bounds: automatic batches of up to 20 chats, reduced further when necessary to fit 256 MiB of serialized import events and 1 GiB of staged files per batch; 128 MiB of decompressed conversation data per chat including inherited history, and 10,000 files per workspace recovery. T3's attachment limits also apply: 10 MiB per supported image, 50 MiB per ordinary file, 100 attachments per message. Oversized conversations are rejected rather than silently shortened. If one chat alone exceeds a batch limit, preparation stops rather than silently excluding it; reduce its selected files or report the history limit. Workspace recovery skips `.git`, `node_modules`, `.venv`, `__pycache__`, and symlinks; the receipt lists skips.

## Local data and recovery

Chat data stays on this Mac. There is no telemetry, account, cloud upload, or Gemini/API dependency in Threadlift. Development review used synthetic test data.

Each job lives in `~/Library/Application Support/Threadlift/jobs/` with private file permissions. It contains conversation copies, staged files, manifests, status, and a receipt. A bulk job has child batch directories, each with its own consistent SQLite backup and receipt. Budget disk space for those backups as well as the recovered files: 400 small chats need at least 20 batches/backups. The batch-size limits do not cap the total disk space used by a bulk job. Treat this directory as private: it contains your chat content. The browser link is private too.

Threadlift holds T3's own `server-owner.sqlite` lock throughout backup, import, and verification. It never deletes that lock or kills T3 processes. Unsupported database formats and managed T3 environments are refused.

**The import reads your original Codex data without changing it.** It does not rename or move your original folders or rewrite Codex's saved paths. Imported history and uploads are stored in T3; optional workspace recovery adds copies to your selected folder without overwriting existing files.

**Continuing an imported chat in T3 resumes the same underlying Codex session**, using the selected project folder. New messages, chat metadata changes, and agent file edits can affect that shared session and folder. Removing T3 does not undo those changes. Finish work in one app before running the same chat in the other.

Source history is scanned again at Preview and Prepare. If a chat changed, review it again; unsupported rewinds stop instead of importing the discarded branch. Prepared project folders and previously identical files are checked again before writing. A renamed folder, changed project root, or missing expected file requires a rescan.

History verification runs inside each batch’s SQLite transaction before commit: a pre-commit failure leaves that batch’s database changes uncommitted. Earlier verified batches stay imported if a later one fails. The failure page identifies the verified batch count; retry the same parent job to continue without importing those chats twice. If the helper is interrupted after commit, it preserves imported data. Retry checks use the stored import events and T3 chat identity, including when T3 has replaced the original native-session binding. A timeout or uncertain database state never authorizes deleting previously installed files. `node bin/threadlift.mjs apply --job /absolute/path/job.json` can verify/retry that same job without importing it twice. When verifying an interrupted job, it stops if the imported data has since changed. Verified batches reuse their original dated receipts without a new audit when a bulk job resumes. An already verified job returns its original dated receipt without importing again or performing a new history/file audit. Threadlift never automatically restores a database backup. Background workers run once; failed startup is stopped rather than left to restart later. If the handoff cannot be confirmed, the error identifies the private job directory to inspect before retrying.

Failures are reported in the browser and job status. A backup is not permission to replace a database after you have done new work: do not copy `before.sqlite` over a live or subsequently changed profile. Keep the job directory until you have checked the imported chat and files. Once satisfied and the helper has finished, you can remove the job directory to reclaim space and remove the extra local chat copy.

### If the import fucks up

**For a new T3 installation with no T3-only work you need to keep:** if the import is wrong or incomplete, stop using T3, uninstall it, and ask your agent to remove T3's own saved data. You can keep using Codex and try importing again after a fix. Preserve your Codex data folder (`~/.codex` by default, or your configured Codex home), original uploads, and original project folders. This reset discards T3-only chats and settings; it is not a way to undo work already done through T3.

Copy this into a Codex chat if you want that clean start:

```text
This is a new T3 Code installation, and I have no T3-only work I need to keep. Help me uninstall T3 Code and remove its own saved data so I can try importing again later. Identify which paths belong to T3 before removing them. Preserve my Codex data (including any configured Codex home), original uploads, and all original project folders. Do not remove shared Codex or project data.
```

Uninstalling the T3 app alone leaves its saved data behind. Deleting an individual T3 chat also leaves a session-ownership record, so Threadlift still treats it as already imported. For a clean start after deliberately discarding T3's data, initialize a fresh profile in a supported T3 version, then run a new scan and prepare a new import. Do not reuse an old prepared job against the reset profile.

## Development

`open` keeps its picker server running until preparation hands off to the independent worker. Agents should run it in their supported background/long-running command facility, retain the private link, and return control to the user. Do not wait for the user to select chats inside a blocking tool call.

Runtime code uses Node built-ins plus a bundled, version-pinned T3 adapter. The adapter uses T3's own event writer and projections rather than handwritten projection updates.

```sh
npm ci
git clone --depth 1 --branch v0.1.12 https://github.com/pingdotgg/t3code.git work/t3code-v0.1.12
git clone --depth 1 --branch v0.1.13 https://github.com/pingdotgg/t3code.git work/t3code-v0.1.13
npm run build:adapter
npm test
```

The build checks the exact release commits in [`adapters/t3-releases.json`](adapters/t3-releases.json), bundles the 0.1.13 writer, and builds separate migration fixtures for both supported versions. `npm test` runs the full suite against each fixture. The imported chat/event formats are shared; the two new 0.1.13 migrations affect workflow tables. The database format is matched exactly; later app/server versions warn, and versions older than that format are refused. Tests create isolated Codex/T3 profiles; never point development servers or write tests at a real profile.

### Verification

Recorded automated baseline: Threadlift `0.1.8` with separate pinned T3 Code `0.1.12` and `0.1.13` fixtures.

| Area | Status | Evidence and limits |
| --- | --- | --- |
| Automated suite (`npm test`) | 30 tests passed on each version (60 checks), 2026-11-28 | Local and CI runs on isolated synthetic profiles using the native T3 writer, projection readback and file hashes. Covers history/file fidelity, source and existing-chat protection, locking, rollback, crash/retry, origin/rewind/identity refusal, older-chat bulk scanning, shared projects/files across batches, partial-batch retry, desktop names, and helper exclusion without breaking regular forks. |
| Official T3 `0.1.13` server and web client | Checked 2026-11-28 | A synthetic 260-message chat appeared in Settled; earlier turns loaded and generated HTML with its relative companion image rendered after deleting the synthetic source folder. This run did not test live continuation. The in-app PDF preview was blank, so visual PDF rendering remains unconfirmed. |
| Official T3 `0.1.12` server and web client | Checked in an earlier release | Earlier history and upload downloads worked; a dedicated Codex test session continued with remembered context and read a copied workspace file. |
| Generated-file recovery in the T3 `0.1.12` web client | Earlier synthetic check | With the original files removed, HTML and its relative companion image rendered, the chat image rendered, the ZIP was browsable, and the PDF served identical `application/pdf` bytes. The in-app test browser's PDF preview was blank; visual PDF rendering was not confirmed. |
| macOS desktop `.app` handoff | **Not tested** | The desktop app was not installed during these checks. Actual `Cmd+Q` → independent worker → import/verify → automatic reopen has not been exercised. |

The bulk picker was also checked in the browser on a synthetic profile: 21 missing chats and 63 files selected by one action across all dates, an unreadable chat explicitly omitted, two automatic batches verified. A subsequent helper-exclusion check selected and imported three regular chats with five files while excluding three internal helpers; the saved desktop title and unnamed-chat fallbacks appeared in the picker and verified receipt. These checks did not exercise the desktop app lifecycle.

The historical client checks were not rerun for every subsequent patch. This evidence covers the tested paths, not every possible Codex history, provider configuration, or future T3 version.

A compatibility update needs an upstream writer build, schema fixture, full-history/file checks, existing-chat protection, failure recovery, and a real-client pass.

Small, focused fixes are welcome. Include what failed and a test or reproduction. Please omit chat dumps, local credentials, and private job directories from issues.

## License and references

New Threadlift code is [Apache-2.0](LICENSE). Bundled T3 Code and dependencies retain their [upstream notices](vendor/THIRD_PARTY_LICENSES.txt). Threadlift is an independent recovery tool.

- [Native project-discovery fix, T3 PR #34542](https://github.com/pingdotgg/t3code/pull/34542)
- [T3's released importer](https://github.com/pingdotgg/t3code/blob/v0.1.13/apps/server/src/project/AgentSessionImporter.ts)
- [Peter Steinberger's agent/skill guidance](https://github.com/steipete/agent-scripts)
- [OpenClaw skill-creation guidance](https://github.com/openclaw/openclaw/blob/main/skills/skill-creator/SKILL.md)

Threadlift was developed and reviewed with Codex and Gemini. Review assistance is not a guarantee of data fidelity; the tests and receipts describe the evidence.

