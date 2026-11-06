// A small SFTP server for tests (ssh2's Server on 127.0.0.1 with a generated
// host key), serving one folder: enough for what lib/sftp.ts does – open,
// read, write, stat, list, mkdir, rename, remove. Password and public key
// sign-in; paths are kept inside the folder.
import { closeSync, fstatSync, mkdirSync, openSync, readdirSync, readSync, renameSync, rmdirSync, statSync, unlinkSync, writeSync, existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import { timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import ssh2 from "ssh2";

const { Server, utils } = ssh2;
const { STATUS_CODE, OPEN_MODE } = utils.sftp;

export type TestSftp = {
  port: number;
  hostKey: string;
  close: () => Promise<void>;
  logins: number;
};

const equal = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);

export async function startSftpServer(root: string, options: { user: string; password?: string; publicKey?: string; hostKey?: string }): Promise<TestSftp> {
  const hostKey = options.hostKey ?? utils.generateKeyPairSync("ed25519").private;
  const allowedKey = options.publicKey ? utils.parseKey(options.publicKey) : null;
  if (allowedKey instanceof Error) throw allowedKey;
  const state = { logins: 0 };
  const inside = (path: string) => {
    const full = resolve(root, `.${path.startsWith("/") ? path : `/${path}`}`);
    if (full !== resolve(root) && !full.startsWith(resolve(root) + sep)) throw new Error("outside");
    return full;
  };
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on("authentication", (ctx) => {
      if (ctx.username !== options.user) return ctx.reject();
      if (ctx.method === "password" && options.password && equal(Buffer.from(ctx.password), Buffer.from(options.password))) {
        state.logins++;
        return ctx.accept();
      }
      if (ctx.method === "publickey" && allowedKey && !Array.isArray(allowedKey)) {
        const key = allowedKey;
        if (ctx.key.algo !== key.type || !equal(ctx.key.data, key.getPublicSSH())) return ctx.reject();
        if (!ctx.signature) return ctx.accept();
        if (key.verify(ctx.blob!, ctx.signature, ctx.hashAlgo) === true) {
          state.logins++;
          return ctx.accept();
        }
        return ctx.reject();
      }
      ctx.reject(["password", "publickey"]);
    });
    client.on("error", () => {});
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("sftp", (acceptSftp) => {
          const sftp = acceptSftp();
          const handles = new Map<number, { fd?: number; dir?: string; listed?: boolean }>();
          let next = 1;
          const handle = (value: { fd?: number; dir?: string }) => {
            const n = next++;
            handles.set(n, value);
            const buffer = Buffer.alloc(4);
            buffer.writeUInt32BE(n);
            return buffer;
          };
          const lookup = (buffer: Buffer) => (buffer.length === 4 ? handles.get(buffer.readUInt32BE(0)) : undefined);
          const attrs = (path: string) => {
            const s = statSync(path);
            return { mode: s.mode, uid: 0, gid: 0, size: s.size, atime: Math.floor(s.atimeMs / 1000), mtime: Math.floor(s.mtimeMs / 1000) };
          };
          const guard = (reqid: number, fn: () => void) => {
            try {
              fn();
            } catch (error) {
              const code = (error as NodeJS.ErrnoException).code;
              sftp.status(reqid, code === "ENOENT" ? STATUS_CODE.NO_SUCH_FILE : code === "EACCES" ? STATUS_CODE.PERMISSION_DENIED : STATUS_CODE.FAILURE);
            }
          };
          sftp.on("OPEN", (reqid, filename, flags) =>
            guard(reqid, () => {
              const mode = flags & OPEN_MODE.WRITE ? (flags & OPEN_MODE.CREAT ? (flags & OPEN_MODE.TRUNC ? "w" : flags & OPEN_MODE.EXCL ? "wx" : "a") : "r+") : "r";
              const fd = openSync(inside(filename), mode === "a" ? "w" : mode);
              sftp.handle(reqid, handle({ fd }));
            }),
          );
          sftp.on("WRITE", (reqid, h, offset, data) =>
            guard(reqid, () => {
              writeSync(lookup(h)!.fd!, data, 0, data.length, offset);
              sftp.status(reqid, STATUS_CODE.OK);
            }),
          );
          sftp.on("READ", (reqid, h, offset, length) =>
            guard(reqid, () => {
              const buffer = Buffer.alloc(length);
              const read = readSync(lookup(h)!.fd!, buffer, 0, length, offset);
              if (!read) return sftp.status(reqid, STATUS_CODE.EOF);
              sftp.data(reqid, buffer.subarray(0, read));
            }),
          );
          sftp.on("FSTAT", (reqid, h) =>
            guard(reqid, () => {
              const s = fstatSync(lookup(h)!.fd!);
              sftp.attrs(reqid, { mode: s.mode, uid: 0, gid: 0, size: s.size, atime: Math.floor(s.atimeMs / 1000), mtime: Math.floor(s.mtimeMs / 1000) });
            }),
          );
          sftp.on("FSETSTAT", (reqid) => sftp.status(reqid, STATUS_CODE.OK));
          sftp.on("SETSTAT", (reqid) => sftp.status(reqid, STATUS_CODE.OK));
          sftp.on("CLOSE", (reqid, h) =>
            guard(reqid, () => {
              const entry = lookup(h);
              if (!entry) return sftp.status(reqid, STATUS_CODE.FAILURE);
              if (entry.fd !== undefined) closeSync(entry.fd);
              handles.delete(h.readUInt32BE(0));
              sftp.status(reqid, STATUS_CODE.OK);
            }),
          );
          const stat = (reqid: number, path: string) => guard(reqid, () => sftp.attrs(reqid, attrs(inside(path))));
          sftp.on("STAT", stat);
          sftp.on("LSTAT", stat);
          sftp.on("OPENDIR", (reqid, path) =>
            guard(reqid, () => {
              const dir = inside(path);
              if (!statSync(dir).isDirectory()) throw Object.assign(new Error("not a dir"), { code: "ENOENT" });
              sftp.handle(reqid, handle({ dir }));
            }),
          );
          sftp.on("READDIR", (reqid, h) =>
            guard(reqid, () => {
              const entry = lookup(h)!;
              if (entry.listed) return sftp.status(reqid, STATUS_CODE.EOF);
              entry.listed = true;
              sftp.name(
                reqid,
                readdirSync(entry.dir!).map((filename) => ({ filename, longname: filename, attrs: attrs(resolve(entry.dir!, filename)) })),
              );
            }),
          );
          sftp.on("MKDIR", (reqid, path) =>
            guard(reqid, () => {
              mkdirSync(inside(path));
              sftp.status(reqid, STATUS_CODE.OK);
            }),
          );
          sftp.on("RMDIR", (reqid, path) =>
            guard(reqid, () => {
              rmdirSync(inside(path));
              sftp.status(reqid, STATUS_CODE.OK);
            }),
          );
          sftp.on("REMOVE", (reqid, path) =>
            guard(reqid, () => {
              unlinkSync(inside(path));
              sftp.status(reqid, STATUS_CODE.OK);
            }),
          );
          sftp.on("RENAME", (reqid, from, to) =>
            guard(reqid, () => {
              // SFTP v3: no overwriting.
              if (existsSync(inside(to))) return sftp.status(reqid, STATUS_CODE.FAILURE);
              renameSync(inside(from), inside(to));
              sftp.status(reqid, STATUS_CODE.OK);
            }),
          );
          sftp.on("REALPATH", (reqid, path) =>
            guard(reqid, () => {
              const full = inside(path);
              const relative = full.slice(resolve(root).length).split(sep).join("/") || "/";
              sftp.name(reqid, [{ filename: relative, longname: relative, attrs: {} as never }]);
            }),
          );
        });
      });
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  const port = (server.address() as AddressInfo).port;
  const parsed = utils.parseKey(hostKey);
  if (parsed instanceof Error || Array.isArray(parsed)) throw new Error("host key");
  const { createHash } = await import("node:crypto");
  const fingerprint = `SHA256:${createHash("sha256").update(parsed.getPublicSSH()).digest("base64").replace(/=+$/, "")}`;
  return {
    port,
    hostKey: fingerprint,
    get logins() {
      return state.logins;
    },
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}
