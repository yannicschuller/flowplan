// Node.js 25+ defines a global `localStorage`. Without --localstorage-file
// it is unusable (undefined), and the first read – even `typeof
// localStorage` – writes "ExperimentalWarning: localStorage is not available
// because --localstorage-file was not provided" to the log (#194). Code
// shared with the browser reads it during server rendering (preferences in
// useState initialisers, lib0 below yjs at import), so instrumentation.ts
// replaces the getter with a plain undefined before anything else runs –
// without calling it, so nothing is written. The value stays what Node.js
// returns there anyway; started with --localstorage-file, nothing changes.
type Target = Record<string, unknown>;

export function storageFileGiven(execArgv: readonly string[] = process.execArgv, nodeOptions = process.env.NODE_OPTIONS || "") {
  return [...execArgv, ...nodeOptions.split(/\s+/)].some((arg) => arg === "--localstorage-file" || arg.startsWith("--localstorage-file="));
}

export function quietUnconfiguredLocalStorage(target: Target = globalThis as unknown as Target, fileGiven = storageFileGiven()) {
  if (fileGiven) return false;
  const descriptor = Object.getOwnPropertyDescriptor(target, "localStorage");
  // Only Node.js's own accessor; a value set by someone else stays.
  if (!descriptor?.get || !descriptor.configurable) return false;
  Object.defineProperty(target, "localStorage", { value: undefined, writable: true, configurable: true, enumerable: descriptor.enumerable });
  return true;
}
