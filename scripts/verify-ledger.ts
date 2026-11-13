import "dotenv/config";
import { connection } from "../src/db";
import { closeMongo, inStoreTransaction, useMongo } from "../src/db/store";
import { journals, ledgerLines } from "../src/db/schema";
import { assertBalanced } from "../src/lib/domain";

try {
  const [entries, lines] = await inStoreTransaction(async (tx) => {
    const entries = await tx.find(journals);
    const lines = await tx.find(ledgerLines);
    return [entries, lines] as const;
  }, false);
  const byJournal = new Map<string, (typeof ledgerLines.$inferSelect)[]>();
  for (const line of lines) {
    const list = byJournal.get(line.journalId) ?? [];
    list.push(line);
    byJournal.set(line.journalId, list);
  }
  for (const entry of entries) {
    try {
      assertBalanced(byJournal.get(entry.id) ?? []);
    } catch {
      throw new Error("Unbalanced journal: " + entry.id);
    }
    byJournal.delete(entry.id);
  }
  if (byJournal.size)
    throw new Error("Ledger lines refer to missing journals.");
  console.log(
    "PASS: every journal is balanced and contains at least two lines.",
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if (useMongo()) await closeMongo();
  else await connection().close();
}
