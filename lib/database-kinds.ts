// The kinds of a new database (lib/database-setup.ts). On their own so the
// offline queue in the workspace shell (lib/offline-create.ts) needs no setups.
export const databaseKinds = ["tasks", "documents", "contacts", "empty", "flashcards"] as const;
export type DatabaseKind = (typeof databaseKinds)[number];
