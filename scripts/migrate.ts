import "dotenv/config";
import { migrate } from "../src/db/migrate";
import { connection } from "../src/db";
import { initializeMongo, closeMongo, useMongo } from "../src/db/store";
try {
  if (useMongo()) await initializeMongo();
  else await migrate();
  console.log("Database migrations applied.");
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  if (useMongo()) await closeMongo();
  else await connection().close();
}
