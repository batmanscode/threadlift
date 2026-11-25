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

export const upstream = Object.freeze({ version: '0.1.12', commit: 'ca81b7b97a1c4b91e5ac25768d0f6629f37732fd' });
export function providerThreadId(instanceId: string, nativeId: string) {
  return derive.providerThread({ driver: 'codex', providerInstanceId: instanceId, nativeThreadId: nativeId });
}
export function projectDefaults(raw: unknown, projectId: string) {
  const settings = Schema.decodeUnknownSync(ServerSettings)(raw);
  if ((settings.providerInstances.codex && settings.providerInstances.codex.driver !== 'codex') || !resolveProjectProviderInstanceEnabled(settings, projectId, 'codex' as never))
    throw new Error('Enable the default Codex provider instance in this T3 project before importing.');
  const resolved = resolveProjectSettings(settings, projectId, null).settings;
  const codex = Schema.decodeUnknownSync(CodexSettings)(settings.providerInstances.codex?.config || {});
  return { runtimeMode: resolved.defaultRuntimeMode, model: DEFAULT_MODEL, codexHome: codex.homePath }; 
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
        yield* sink.commitProjectCommand({ commandId: event.commandId!, projectId: event.aggregateId,
          commandType: 'project.create', acceptedAt: DateTime.makeUnsafe(event.occurredAt), event: unsequenced });
      }
      const imported: string[] = [];
      for (const thread of input.threads) {
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
