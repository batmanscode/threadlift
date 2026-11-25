---
name: threadlift
description: "Recover, import, or migrate missing local Codex chats and files into T3 Code with Threadlift. Use for missing-chat recovery on macOS; supports T3 Code 0.1.12 and the default Codex instance."
---

# Threadlift

Use the Threadlift helper for a requested Codex-to-T3 recovery. The user chooses chats and files in a system-browser picker; an independent worker finishes after T3 quits. Do not improvise SQL or rewrite Codex history.

1. Read the [Threadlift README](https://github.com/batmanscode/threadlift). Use a trusted checkout of this repository in a stable location such as `~/Library/Application Support/Threadlift/app`, outside temporary T3 worktrees. If absent, clone `https://github.com/batmanscode/threadlift.git` there as part of the authorized recovery. A copied skill alone does not contain the importer.
2. Find Node 24.10 or later. Check `node --version`; use an available compatible runtime or arrange the required setup under the user's existing permissions. No runtime dependency installation is needed for a release checkout.
3. Run `node <checkout>/bin/threadlift.mjs inspect` with the intended local Codex/T3 homes. The helper supports T3 0.1.12 and the default Codex instance. Respect its refusals; do not bypass version checks or point at a remote/unrelated profile.
4. Run `node <checkout>/bin/threadlift.mjs open` using your supported background/long-running command facility. The picker server stays running until preparation hands off; retain its private link and return control to the user. Let it open the **system browser**, not T3's embedded browser, because the picker/progress page must survive T3 quitting. Keep the printed private link local. The user can review and select chats/files there; do not infer a particular chat from its title alone.
5. In the same handoff message, explain what to do after clicking Prepare: finish other T3 runs, quit T3 with Cmd+Q, then wait with the browser page open. The worker waits for T3's ownership lock, backs up, imports, verifies, and attempts to reopen T3. Do not force-quit processes or take over the worker's writes.
6. Tell the user to check the browser receipt and open their imported chat after T3 returns. If the user returns for help, use `status --job <path>` to inspect the receipt and missing/skipped files. Distinguish verified history/files and session linkage from a tested live continuation. If the user authorized a follow-up test, use a minimal harmless turn; otherwise ask them to open the chat and continue normally.

Existing/partial T3 imports are not overwritten. A stale physical folder path requires locating the current folder; a missing file is reported, not reconstructed. On failure, read `status --job <path>` and preserve the backup. Pre-commit failures leave the database unchanged. For an interrupted prepared job, `apply --job <path>` retries or verifies it without importing twice. It stops if the imported data has since changed. Never restore a backup over newer work or a running T3 profile.
