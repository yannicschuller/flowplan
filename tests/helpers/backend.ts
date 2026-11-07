// Which database this test run uses (tests/helpers/cleanup.mjs): tests of
// SQLite's own migrations, files or FTS5 internals skip on PostgreSQL.
//   test("…", { skip: sqliteOnly }, () => …)
export const onPostgres = /^postgres(ql)?:\/\//i.test(process.env.DATABASE_URL || "");
export const sqliteOnly: string | false = onPostgres && "SQLite only (its migrations, files or FTS5)";
