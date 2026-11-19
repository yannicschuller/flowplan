// occt-import-js ships no types; the worker (parse-worker.ts) describes the
// part it uses.
declare module "occt-import-js" {
  const create: (options?: object) => Promise<unknown>;
  export default create;
}
