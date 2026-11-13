import { closeMongo, initializeMongo } from "../src/db/store";

try {
  await initializeMongo();
  console.log("SalonOS database initialized.");
} catch (error) {
  const name = error instanceof Error ? error.name : "Unknown error";
  console.error(`MongoDB initialization failed (${name}). Check the Atlas environment variables and network access.`);
  process.exitCode = 1;
} finally {
  await closeMongo();
}
