// Moves a file, also onto another file system (#161): a backups folder
// mounted from an SMB/NFS share or another volume makes rename() fail with
// EXDEV. Then the file is copied next to its destination first and renamed
// there – so a half-written file never carries the final name – and the
// source is removed afterwards.
import { copyFileSync, renameSync, rmSync } from "node:fs";

export function moveFile(from: string, to: string, rename: (a: string, b: string) => void = renameSync) {
  try {
    rename(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "EXDEV") throw error;
    const part = `${to}.${process.pid}.part`;
    try {
      copyFileSync(from, part);
      renameSync(part, to);
    } catch (copyError) {
      rmSync(part, { force: true });
      throw copyError;
    }
    rmSync(from, { force: true });
  }
}
