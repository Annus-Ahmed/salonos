import "dotenv/config";
import { connection } from "../src/db";
import { users, sessions } from "../src/db/schema";
import { ROLES, type Role } from "../src/lib/domain";
import { closeMongo, inStoreTransaction, useMongo } from "../src/db/store";
import { hashPassword } from "../src/server/auth";
const {
  ADMIN_NAME: name,
  ADMIN_EMAIL: email,
  ADMIN_PASSWORD: password,
  ADMIN_ROLE: role,
} = process.env;
try {
  if (!name || !email || !password || !ROLES.includes(role as Role))
    throw new Error(
      "Set ADMIN_NAME, ADMIN_EMAIL, ADMIN_PASSWORD (12+ chars), and ADMIN_ROLE (finance_manager, owner, or receptionist) in your environment.",
    );
  const passwordHash = await hashPassword(password);
  const normalized = email.trim().toLowerCase();
  const user = await inStoreTransaction(async (tx) => {
    const [existing] = await tx.find(
      users,
      { email: normalized },
      { lock: true },
    );
    const [saved] = existing
      ? await tx.update(
          users,
          { id: existing.id },
          { name, passwordHash, role: role as Role, active: true },
        )
      : await tx.insert(users, {
          name,
          email: normalized,
          passwordHash,
          role: role as Role,
        });
    await tx.remove(sessions, { userId: saved.id });
    return saved;
  }, true);
  console.log(`Account saved for ${user.email}. Previous sessions revoked.`);
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  if (useMongo()) await closeMongo();
  else await connection().close();
}
