import "dotenv/config";
import { getTableColumns, getTableName, sql } from "drizzle-orm";
import { connect } from "../src/db";
import { closeMongo, initializeMongo, mongo, Store } from "../src/db/store";
import * as s from "../src/db/schema";
import { assertBalanced } from "../src/lib/domain";

const sourceUrl = process.env.SOURCE_POSTGRES_URL;
if (!sourceUrl || !process.argv.includes("--confirm"))
  throw new Error(
    "Set SOURCE_POSTGRES_URL to a PostgreSQL backup or read-only source and pass --confirm. The MongoDB destination must be empty.",
  );
const source = connect(sourceUrl);
try {
  await initializeMongo();
  const { client, database } = mongo();
  const sourceData = await source.db.transaction(
    async (tx) => {
      const store = new Store(tx);
      const schemaResult = await tx.execute(sql`
        SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = current_schema()
      `);
      const schemaRows = (
        Array.isArray(schemaResult) ? schemaResult : schemaResult.rows
      ) as {
        table_name: string;
        column_name: string;
      }[];
      const sourceColumns = new Map<string, Set<string>>();
      for (const { table_name, column_name } of schemaRows) {
        const columns = sourceColumns.get(table_name) ?? new Set<string>();
        columns.add(column_name);
        sourceColumns.set(table_name, columns);
      }
      const collections = [];
      for (const table of Object.values(s)) {
        if (table === s.sessions || table === s.loginAttempts) continue;
        const name = getTableName(table);
        const columns = sourceColumns.get(name);
        if (!columns && (table === s.products || table === s.stockMovements))
          continue;
        if (!columns) throw new Error("Missing source table: " + name);
        const columnsByField = getTableColumns(table);
        const defaults: Record<string, Record<string, string | null>> = {
          settings: { bankQrUrl: null },
          services: { details: null },
          bookings: {
            initialPaymentMethod: null,
            confirmationSms: null,
            confirmationEmail: null,
          },
          booking_items: { customName: "", detailId: null, detailName: null },
        };
        const missing = Object.entries(columnsByField)
          .filter(([, column]) => !columns.has(column.name))
          .map(([field]) => field);
        const fallback = defaults[name] ?? {};
        if (missing.some((field) => !Object.hasOwn(fallback, field)))
          throw new Error("Unexpected missing columns in " + name);
        const fields = Object.keys(columnsByField).filter(
          (field) => !missing.includes(field),
        ) as (keyof typeof table.$inferSelect & string)[];
        const rows = missing.length
          ? (await store.find(table, {}, { fields })).map((row) => ({
              ...Object.fromEntries(
                missing.map((field) => [field, fallback[field]]),
              ),
              ...row,
            }))
          : await store.find(table);
        collections.push({ name, rows });
      }
      const journals = await store.find(s.journals);
      const grouped = new Map<string, (typeof s.ledgerLines.$inferSelect)[]>();
      for (const line of await store.find(s.ledgerLines)) {
        const lines = grouped.get(line.journalId) ?? [];
        lines.push(line);
        grouped.set(line.journalId, lines);
      }
      for (const journal of journals) {
        assertBalanced(grouped.get(journal.id) ?? []);
        grouped.delete(journal.id);
      }
      if (grouped.size)
        throw new Error("Source contains ledger lines without a journal.");
      return collections;
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );

  await client.withSession((session) =>
    session.withTransaction(
      async () => {
        const settings = database.collection("settings");
        const [configuration] = await settings
          .find({ id: 1 }, { session })
          .toArray();
        if (
          !configuration ||
          configuration.version !== 1 ||
          configuration.importedFromPostgres
        )
          throw new Error("Use a fresh MongoDB database for the import.");
        const claimed = await settings.updateOne(
          { id: 1, version: 1 },
          { $set: { importedFromPostgres: true } },
          { session },
        );
        if (!claimed.modifiedCount)
          throw new Error("Could not reserve the import destination.");
        for (const { name, rows } of sourceData) {
          const destination = database.collection(name);
          if (name === "settings") {
            if (rows.length !== 1)
              throw new Error("Expected one source settings row.");
            await destination.updateOne(
              { id: 1 },
              { $set: { ...rows[0], importedFromPostgres: true } },
              { session },
            );
            continue;
          }
          if (name === "accounts") {
            for (const row of rows) {
              const account = row as typeof s.accounts.$inferSelect;
              await destination.updateOne(
                { code: account.code },
                { $set: account },
                { session, upsert: true },
              );
            }
            continue;
          }
          if (await destination.countDocuments({}, { session }))
            throw new Error(
              "MongoDB destination already has records in " + name,
            );
          for (let start = 0; start < rows.length; start += 100)
            await destination.insertMany(
              rows.slice(start, start + 100).map((row) => ({ ...row })),
              { session },
            );
          if (
            (await destination.countDocuments({}, { session })) !== rows.length
          )
            throw new Error("Record count mismatch in " + name);
        }
      },
      { writeConcern: { w: "majority" } },
    ),
  );
  console.log(
    "Imported PostgreSQL records and verified record counts and source ledger totals. Users must sign in again.",
  );
} finally {
  await source.close();
  await closeMongo();
}
