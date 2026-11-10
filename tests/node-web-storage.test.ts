// Node.js 25+'s localStorage without --localstorage-file (#194): replaced by
// undefined before anything reads it, so no ExperimentalWarning is logged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { quietUnconfiguredLocalStorage, storageFileGiven } from "../lib/node-web-storage";

const nodeLike = () => {
  let reads = 0;
  const target: Record<string, unknown> = {};
  Object.defineProperty(target, "localStorage", {
    configurable: true,
    enumerable: true,
    get() {
      reads++;
      return undefined;
    },
  });
  return { target, reads: () => reads };
};

test("the getter is replaced without being called", () => {
  const { target, reads } = nodeLike();
  assert.equal(quietUnconfiguredLocalStorage(target, false), true);
  assert.equal(typeof target.localStorage, "undefined");
  assert.equal("localStorage" in target, true);
  assert.equal(reads(), 0);
});

test("with --localstorage-file, or a value someone set, nothing changes", () => {
  const { target, reads } = nodeLike();
  assert.equal(quietUnconfiguredLocalStorage(target, true), false);
  void target.localStorage;
  assert.equal(reads(), 1);
  const plain: Record<string, unknown> = { localStorage: { getItem: () => null } };
  assert.equal(quietUnconfiguredLocalStorage(plain, false), false);
  assert.equal(typeof plain.localStorage, "object");
  assert.equal(quietUnconfiguredLocalStorage({}, false), false);
});

test("--localstorage-file is found in the arguments and in NODE_OPTIONS", () => {
  assert.equal(storageFileGiven([], ""), false);
  assert.equal(storageFileGiven(["--localstorage-file=/data/ls"], ""), true);
  assert.equal(storageFileGiven(["--localstorage-file", "/data/ls"], ""), true);
  assert.equal(storageFileGiven([], "--max-old-space-size=512 --localstorage-file=/tmp/x"), true);
  assert.equal(storageFileGiven(["--localstorage-filex"], ""), false);
});
