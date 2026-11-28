import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';
import * as DateTime from 'effect/DateTime';
import * as SqlClient from 'effect/sql/SqlClient';
import * as SQLite from '@t3tools/shared/nodeSqliteClient';
import { OrchestrationV2DomainEventJson, OrchestrationV2ProviderThreadJson, ApplicationProjectEvent, ServerSettings, CodexSettings, DEFAULT_MODEL, resolveProjectProviderInstanceEnabled } from '@t3tools/contracts';
import { resolveProjectSettings } from '@t3tools/shared/projectSettings';
import { derive } from '@t3tools/provider-core/server/IdAllocator';
export { createAttachmentId, attachmentFileExtension } from '@upstream/apps/server/src/attachmentStore.ts';
import * as Sink from '@upstream/apps/server/src/orchestration-v2/EventSink.ts';
import * as Store from '@upstream/apps/server/src/orchestration-v2/EventStore.ts';
import * as Projections from '@upstream/apps/server/src/orchestration-v2/ProjectionStore.ts';
import * as Runtime from '@upstream/apps/server/src/persistence/ProviderSessionRuntime.ts';
import { parse, postprocess, preprocess } from 'micromark';
import { decodeString } from 'micromark-util-decode-string';
import releases from './t3-releases.json';
export { parseMarkdownFileLink, resolveMarkdownFileLinkTarget } from '@t3tools/shared/markdownLinks';

// Reuse the Markdown tokenizer already bundled by T3. Destination offsets let
// recovery change links without reformatting messages, code samples or labels.
export function markdownLinkDestinations(text: string) {
  if (!text.includes('](') && !text.includes(']:')) return [];
  const events = postprocess(parse().document().write(preprocess()(text, undefined, true)));
  return events.flatMap(([phase, token, context]) =>
    phase === 'enter' && ['resourceDestinationString', 'definitionDestinationString'].includes(token.type)
      ? [{ start: token.start.offset, end: token.end.offset, href: decodeString(context.sliceSerialize(token)) }]
      : []);
}

export const upstream = Object.freeze(releases.at(-1)!);
export const supportedVersions = Object.freeze(releases.map(r => r.version));
export function providerThreadId(instanceId: string, nativeId: string) {
  return derive.providerThread({ driver: 'codex', providerInstanceId: instanceId, nativeThreadId: nativeId });
}
export function projectDefaults(raw: unknown, projectId: string) {
  const settings = Schema.decodeUnknownSync(ServerSettings)(raw);
  if ((settings.providerInstances.codex && settings.providerInstances.codex.driver !== 'codex') || !resolveProjectProviderInstanceEnabled(settings, projectId, 'codex' as never))
    throw new Error('Enable the default Codex provider instance in this T3 project before importing.');
  const resolved = resolveProjectSettings(settings, projectId, null).settings;
  const codex = Schema.decodeUnknownSync(CodexSettings)(settings.providerInstances.codex?.config || {});
  const environmentHome = codex.setupMode === 'managed' ? undefined : settings.providerInstances.codex?.environment?.findLast(v => v.name === 'CODEX_HOME')?.value;
  if (!codex.homePath && environmentHome !== undefined && typeof environmentHome !== 'string')
    throw new Error('The Codex home is a secret reference. Set an explicit home path before importing.');
  return { runtimeMode: resolved.defaultRuntimeMode, model: DEFAULT_MODEL, codexHome: codex.homePath || environmentHome || '' };
}

// Keep both canonical events and immediate projections under the upstream writer.
export async function applyBatch(dbPath: string, input: { projects: unknown[]; threads: any[] }, options: { failBeforeCommit?: boolean } = {}) {
  const stores = Layer.mergeAll(Sink.layer.pipe(Layer.provideMerge(Layer.merge(Store.layer, Projections.layer))), Runtime.layer)
    .pipe(Layer.provideMerge(SQLite.layer({ filename: dbPath })));
  return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const sink = yield* Sink.EventSinkV2;
    const runtimes = yield* Runtime.ProviderSessionRuntimeRepository;
    return yield* sql.withTransaction(Effect.gen(function* () {
      for (const raw of input.projects) {
        const event = yield* Schema.decodeUnknownEffect(ApplicationProjectEvent)({ ...(raw as object), sequence: 0 });
        const { sequence: _, ...unsequenced } = event;
        const result = yield* sink.commitProjectCommand({ commandId: event.commandId!, projectId: event.aggregateId,
          commandType: 'project.create', acceptedAt: DateTime.makeUnsafe(event.occurredAt), event: unsequenced });
        if (!result.committed) throw new Error('Project creation was already processed; rescan before importing.');
      }
      const imported: string[] = [];
      for (const thread of input.threads) {
        const projectId = thread.events[0].payload.projectId;
        const projects = yield* sql`SELECT workspace_root FROM projection_projects WHERE project_id=${projectId} AND deleted_at IS NULL`;
        if (projects.length !== 1 || projects[0].workspace_root !== thread.runtime.runtimePayload.cwd)
          throw new Error('The selected project is missing or its folder changed. Rescan before importing.');
        const events = yield* Effect.forEach(thread.events, event => Schema.decodeUnknownEffect(OrchestrationV2DomainEventJson)(event));
        const provider = yield* Schema.decodeUnknownEffect(OrchestrationV2ProviderThreadJson)(thread.provider);
        const committed = yield* sink.write({ unlessNativeThreadOwned: provider, events });
        if (committed.length === 0) throw new Error(`Native session already owned: ${provider.nativeThreadRef?.nativeId}`);
        yield* runtimes.upsert(thread.runtime, { onConflict: 'ignore' });
        // Read back projections inside the SAME transaction. A mismatch rolls back
        // the batch rather than restoring an old database over subsequent work.
        const id = thread.runtime.threadId;
        const messages = yield* sql`SELECT payload_json FROM orchestration_v2_projection_messages WHERE thread_id=${id}`;
        const expected = thread.events.filter((e: any) => e.type === 'message.updated').map((e: any) => e.payload);
        const byId = new Map(messages.map((r: any) => { const m = JSON.parse(r.payload_json); return [m.id, m]; }));
        if (byId.size !== expected.length || expected.some((m: any) => {
          const actual = byId.get(m.id) as any;
          return !actual || actual.text !== m.text || actual.role !== m.role || JSON.stringify(actual.attachments) !== JSON.stringify(m.attachments);
        })) throw new Error(`History verification failed: ${thread.title}`);
        const items = yield* sql`SELECT turn_item_id FROM orchestration_v2_projection_turn_items WHERE thread_id=${id}`;
        if (items.length !== expected.length) throw new Error(`Turn item verification failed: ${thread.title}`);
        const rows = yield* sql`SELECT resume_cursor_json,runtime_payload_json FROM provider_session_runtime WHERE thread_id=${id}`;
        if (JSON.parse(rows[0]?.resume_cursor_json as string || '{}').threadId !== thread.sourceId ||
            JSON.parse(rows[0]?.runtime_payload_json as string || '{}').cwd !== thread.runtime.runtimePayload.cwd)
          throw new Error(`Session verification failed: ${thread.title}`);
        imported.push(thread.runtime.threadId);
      }
      if (options.failBeforeCommit) throw new Error('Injected verification failure.');
      return { imported };
    }));
  }).pipe(Effect.provide(stores))));
}
