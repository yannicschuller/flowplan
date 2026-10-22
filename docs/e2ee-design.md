# End-to-end encrypted spaces – design

Status: implemented (v1). Code: `lib/e2ee.ts` (cryptography, shared by browser
and tests), `lib/e2ee-server.ts` (storage, access control, refusals),
`components/e2ee-store.ts` (keys in the browser tab), `components/e2ee.tsx`
(dialogs, page gate, members, settings), `components/encrypted-editor.tsx`
(editor and sync), triggers in `lib/db.ts` (schema 55). Tests:
`tests/e2ee.test.ts`, `tests/browser/e2ee.spec.ts`.

Encrypted spaces are meant for journals, passwords and other sensitive
notes: a space whose documents are encrypted and decrypted in the browser,
so that the Flowplan server only ever stores and relays ciphertext.

## Threat model

**Protected against**

- The **server operator** reading content: the database, the uploads
  folder, the S3 bucket and the logs hold ciphertext, wrapped keys and
  metadata only.
- **Backups and copies** of the database or the bucket (scheduled backups,
  Litestream replicas, instance backups, a stolen disk): same as above.
- **Other members of the workspace**, including workspace owners and
  instance admins, who are not members of the encrypted space: they have
  neither server access nor a sealed space key.
- **Server-side features leaking content by accident**: search index, AI,
  previews, exports, share links, publications, webhooks and MCP refuse
  encrypted pages or return metadata only. SQLite triggers refuse plaintext
  writes for encrypted pages as a last line of defence.

**Not protected against (out of scope, stated plainly)**

- **A malicious or compromised server that serves bad JavaScript.** The
  browser runs whatever code the server delivers. A server operator who
  wants to read content can ship a modified app that sends the passphrase
  or the decrypted text home. End-to-end encryption in a web app protects
  data at rest on the server and in backups; it does not protect against
  the party that serves the code. (Mitigations such as a signed desktop
  build or a browser extension that pins the code are possible later.)
- Malware or a malicious extension on the member's device, and anyone who
  can use an unlocked browser tab.
- **Rollback and withholding** by the server: it can drop updates, serve an
  older snapshot or refuse service. Ciphertext is authenticated (AES-GCM
  with associated data), so it cannot forge or move content between pages,
  but it can make data disappear.
- **Metadata** (see below).

## What stays visible to the server

- Page structure: which pages exist, their parent, position, icon, kind
  (always "document"), lock flag, created/updated timestamps and authors
  of changes (who appended which update, when).
- Page **titles**, unless the space was created with **"Titel
  verschlüsseln"** (then the server stores the placeholder "Verschlüsselte
  Seite" and the encrypted title in `pages.title_cipher`).
- **Sizes**: of every encrypted update, snapshot and file.
- The **member list** of the space (grants and who holds which key version),
  the space name and icon.
- Live presence: who has a page open (the live channel), not the cursor
  position (the encrypted editor sends no cursors).

## Cryptography

All primitives come from WebCrypto (`crypto.subtle`), available in every
current browser and in Node 22+ (tests run the very same code).

| Purpose | Algorithm |
| --- | --- |
| Personal key pair | X25519 |
| Private key wrap (passphrase) | PBKDF2-SHA256, 600 000 iterations, 16-byte salt → AES-256-GCM |
| Private key wrap (recovery key) | 256-bit random recovery key → HKDF-SHA256 → AES-256-GCM |
| Space key sealed for a member | ephemeral X25519 ECDH with the member's public key → HKDF-SHA256 (random salt, info = context) → AES-256-GCM |
| Content (updates, snapshots, titles) | AES-256-GCM with the space key, random 96-bit IV, associated data = purpose, page id and key version |
| Files | AES-256-GCM with a random per-file key; the file key is encrypted with the space key |

**Why X25519 and not RSA-OAEP.** X25519 in WebCrypto ships in Safari 17
(2023), Firefox 130 (2024) and Chromium 133 (2025, enabled by default). In
2026 every supported browser has it, and Node 22 too. X25519 keys are short
(32 bytes), fast, and need no padding choices. RSA-OAEP would have worked
everywhere earlier but adds large keys and slow key generation for no
benefit today. The setup dialog checks support (`x25519Supported()`) and
explains when a browser lacks it; there is no RSA fallback.

**Why PBKDF2 and not Argon2id.** Argon2id is not part of WebCrypto and no
Argon2 WASM module is a dependency of Flowplan; PBKDF2-SHA256 with 600 000
iterations (OWASP 2023 recommendation) is native, fast in the browser and
needs no extra code to audit. The server rejects wraps with fewer than
600 000 iterations; the iteration count is stored with the wrap, so it can
be raised later without a migration.

**Associated data.** Every ciphertext names what it is:
`flowplan:e2ee:<purpose>:v1:<pageId>:<keyVersion>` for content,
`flowplan:e2ee:space-key:v1:<spaceId>:<version>:<userId>` for sealed space
keys, file keys and contents carry the page id and a random file nonce.
The server cannot move ciphertext to another page, another member or
another purpose without decryption failing.

### Formats

- Content: `0x01 | IV (12) | ciphertext+tag`, stored as BLOB.
- Wraps and sealed keys: JSON with base64 fields (`alg`, `v`, `salt`, `iv`,
  `ct`, for sealed keys also `epk`), validated strictly by the server.
- Titles: `{"v": keyVersion, "d": base64(content)}`.
- Files: `"FPX1" | header length (4) | header JSON {v, n, k} | content`
  where `k` is the file key encrypted with the space key and the content
  holds a small JSON with name and type followed by the bytes. The server
  stores the upload as `encrypted.bin`, `application/octet-stream`, and
  never inspects it (no MIME sniffing, no EXIF stripping, no text
  extraction for search).

## Keys

**Per person** (`e2ee_identities`): public key, the private key wrapped with
the passphrase and – second wrap – with the recovery key. All three are
opaque blobs to the server. The **passphrase never leaves the browser**; it
is separate from the sign-in password, so a password reset by an admin does
not grant access.

- **Setup**: passphrase (≥ 10 characters) twice → key pair and recovery key
  generated in the browser → recovery key shown with *Download* and
  *Print*; nothing is stored until the person confirms they kept it.
- **Recovery key**: 32 random bytes, shown as 52 base32 characters in groups
  of four (`ABCD-EFGH-…`). Entering it lets the person choose a new
  passphrase. A new recovery key can be generated in the settings (the old
  one stops working).
- **Unlock**: per browser tab, in memory only (no localStorage/IndexedDB),
  forgotten on reload, on "Jetzt sperren" and after inactivity (auto-lock,
  default 15 minutes, 5/15/30/60 selectable).
- **Reset**: when both passphrase and recovery key are lost, the person can
  delete their key pair. All their sealed space keys go with it; members
  must add them again. Spaces in which they were the only key holder are
  lost. **Losing passphrase and recovery key means losing the data – the
  operator cannot help.** The interface says so at setup, in the space
  dialog and in the settings.

**Per space** (`e2ee_space_keys`): random 256-bit AES keys, numbered by
version (`spaces.key_version`). Each key version is sealed separately for
each member's public key.

- **Create**: the browser picks the space id, generates key version 1 and
  seals it for the creator; `space.create` with `encrypted` stores it.
  Encrypted spaces are always private.
- **Add a member** (`e2ee.member.add`): only a space manager who holds the
  current key (i.e. has unlocked) can do it, because only they can seal the
  key versions for the newcomer's public key. The newcomer gets *every*
  key version the adder holds, so they read older content too, and a grant
  on the space. Members who have not set up keys are listed but cannot be
  added yet.
- **Remove a member / leave** (`e2ee.member.remove`): the grant and the
  member's sealed keys are deleted and the space is marked
  `rotate_pending`. Appending is refused until a remaining member's browser
  generates key version n+1 and seals it for exactly the remaining key
  holders (`e2ee.rotate`, checked by the server); the remover's browser does
  this right away, otherwise the next member who opens the space does it.
  Removing someone from the workspace (or deleting the account) does the
  same through triggers.
- **What rotation does not do**: old content is **not re-encrypted**. A
  removed person who kept copies of old key versions or of decrypted
  content can still read what existed when they left; they cannot read
  anything written after the rotation. Compaction re-encrypts the full
  document with the newest key over time, but that does not take back what
  they already had.

## Documents: encrypted sync path

Encrypted pages do not use `document.sync` (which stores HTML and a
plaintext Yjs state). They have their own path:

- **Append-only log** (`e2ee_updates`): each local Yjs update (batched for
  250 ms) is encrypted with the current space key and appended with
  `e2ee.append`. The server assigns a sequence number and pushes the
  ciphertext to other open editors over the existing live channel
  (`/api/documents/live`, generation `e2ee`). Yjs updates commute, so
  order does not matter for correctness; the sequence number lets clients
  fetch what they missed (`GET /api/e2ee/pages/<id>/log?after=<seq>`).
- **Compaction**: when 200 or more updates have piled up, a client that
  has everything up to sequence `s` encrypts the full state as a snapshot
  (`e2ee.compact`, `e2ee_snapshots`); the server replaces the snapshot and
  deletes the updates ≤ `s`. A snapshot never replaces a newer one.
- **No local cache**: the encrypted editor keeps no IndexedDB copy, so a
  locked or closed tab leaves nothing readable on the device. Offline
  editing of encrypted pages is therefore not supported in v1.
- **Editor**: a reduced TipTap editor (headings, lists, tasks, quotes,
  code, tables via paste, links, encrypted files and images). Features that
  need the server to read content are not offered: comments, text
  comments, mentions with notifications, AI, synced blocks, linked
  databases, version history, authorship, Markdown source view.

## Server enforcement

`guardEncryptedCommand` runs before every command: any command naming a
page or space of an encrypted space must be on a short allow-list
(page create/update/move/delete/restore, favourites, follow, owner and
review, space update/delete/restore, the `e2ee.*` commands, notifications).
Everything else is refused with "Für verschlüsselte Seiten nicht
verfügbar." – including `document.sync`, `document.markdown(.apply)`,
snapshots and version restore, duplicate, templates, page-to-record,
comments and text comments, aliases, share links, page shares, grants,
publications, imports and Git export. New features stay out of encrypted
spaces until they are made to work without plaintext. Additionally:

- Commands may not mix an encrypted space with another space (no moving in
  or out), page kinds other than document are refused, titles must be the
  placeholder in spaces with encrypted titles, covers are refused.
- **Exports**: Markdown, ZIP, DOCX, EPUB and the PDF/print view refuse an
  encrypted page or space; workspace exports and archives skip them
  (`lockedPageIds` includes encrypted pages). Allowed are the
  **encrypted archive** (`GET /api/e2ee/spaces/<id>/archive`: ciphertext,
  sealed keys and the person's wrapped private key, decryptable with the
  passphrase or recovery key alone) and a **Markdown export decrypted in
  the browser**.
- **Search**: encrypted pages are neither indexed nor found.
- **AI**: the central AI gate (`lib/ai/access.ts`) treats encrypted spaces
  as blocked.
- **Share links and publications**: refused; triggers block inserts.
- **Webhooks**: payloads about encrypted pages carry ids only.
- **MCP**: `read_page` goes through the Markdown export and is refused;
  `append_to_page` goes through `document.sync` and is refused; listing
  shows metadata only.
- **Uploads**: encrypted pages take only `purpose=e2ee` uploads that start
  with the `FPX1` header; image import from the web and voice
  transcription are refused.
- **Triggers** (`lib/db.ts`): plaintext in `documents.html/state`,
  `snapshots`, `comments`, `inline_threads`, `rows`, `share_links`,
  `publications`, a public token, a non-document page kind and moving a page
  across the encryption boundary all abort the write.

## Out of scope for v1

- **Databases** (records, properties, views) in encrypted spaces: the
  server evaluates filters, formulas, relations and automations on
  plaintext. Encrypted spaces allow documents only; the interface says so.
- Whiteboards, dashboards and journals as page kinds (a journal is written
  as ordinary documents in an encrypted space).
- Offline editing, version history, comments, mentions with
  notifications, search over encrypted content (would need client-side
  indexing).
- Protection against a malicious server serving modified JavaScript.
- Converting an existing plaintext space into an encrypted one (copy the
  content into a new encrypted space instead).
