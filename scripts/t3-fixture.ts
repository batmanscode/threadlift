import * as Effect from 'effect/Effect';
import * as Logger from 'effect/Logger';
import * as SQLite from '@t3tools/shared/nodeSqliteClient';
import { runMigrations } from '@upstream/apps/server/src/persistence/Migrations.ts';
export async function initializeFixture(dbPath: string) {
  return Effect.runPromise(Effect.scoped(runMigrations().pipe(Effect.provide(SQLite.layer({ filename: dbPath })), Effect.provide(Logger.layer([Logger.make(() => {})])))));
}
