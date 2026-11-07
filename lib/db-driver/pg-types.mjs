// Postgres values in the shapes SQLite gives them, so code reads the same
// rows on both: 64-bit integers (ms timestamps, COUNT(*)) and numerics
// (SUM, AVG) as numbers – exact up to 2^53, like SQLite through node:sqlite –
// and booleans (EXISTS(…), a<>b) as 1/0. The schema itself has no boolean
// columns (INTEGER 0/1 as in SQLite).
const BIGINT = 20;
const NUMERIC = 1700;
const BOOL = 16;
export function configureTypes(pg) {
  pg.types.setTypeParser(BIGINT, (v) => Number(v));
  pg.types.setTypeParser(NUMERIC, (v) => Number(v));
  pg.types.setTypeParser(BOOL, (v) => (v === "t" ? 1 : 0));
}
