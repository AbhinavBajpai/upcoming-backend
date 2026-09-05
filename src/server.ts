import { readAuthConfig } from "./auth/config.js";
import { createAuth } from "./auth/service.js";
import { budgetedEmail, createEmailDelivery } from "./auth/email.js";
import { readCalendar } from "./catalog/calendar.js";
import { createApp } from "./app.js";
import { readConfig } from "./config.js";
import { createDatabase } from "./database.js";

const config = readConfig();
const database = createDatabase(config.databaseUrl);
const authConfig = readAuthConfig();
const auth = createAuth(
  database,
  authConfig,
  budgetedEmail(database, authConfig.secret, createEmailDelivery(authConfig)),
);
const app = createApp({
  accounts: { auth, config: authConfig },
  frontendDir: config.frontendDir,
  getCalendar: (month, now) => readCalendar(database, month, now),
  checkDatabase: async () => {
    await database.query("SELECT 1");
  },
});
const server = app.listen(config.port, "0.0.0.0", () => {
  console.log(`Upcoming API listening on port ${config.port}`);
});
server.on("error", () => {
  console.error(
    "Unable to start the API listener. Check PORT and whether it is already in use.",
  );
  void database.end().finally(() => {
    process.exitCode = 1;
  });
});
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const timeout = setTimeout(() => process.exit(1), 10_000);
  timeout.unref();
  server.close(() => {
    void database.end().then(
      () => {
        clearTimeout(timeout);
      },
      () => {
        process.exitCode = 1;
      },
    );
  });
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
