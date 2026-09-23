"use client";
const flushers = new Set<() => Promise<void>>();
export function registerDocumentFlush(flush: () => Promise<void>) {
  flushers.add(flush);
  return () => {
    flushers.delete(flush);
  };
}
export async function flushOpenDocuments() {
  await Promise.all(Array.from(flushers, (flush) => flush()));
}
