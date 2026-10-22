# Hello Flowplan – example block extension

A counter and a small poll as Flowplan blocks. Static files only:

- `flowplan-plugin.json` – the manifest (name, version, block types, permissions, frame size, settings)
- `index.html`, `hello.js`, `hello.css` – the page Flowplan loads into a sandboxed frame

Try it:

1. Serve this folder over HTTPS, e.g. behind your reverse proxy, with the header
   `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'`.
2. Allow the origin on the instance: `PLUGIN_ALLOWED_ORIGINS=https://plugins.example.org`
   (or switch on "Block extensions from any HTTPS address" in the administration).
3. As a workspace owner: Settings → Integrations → Block extensions → enter
   `https://plugins.example.org/plugin-hello/` and register.
4. Type `/` in a document: the blocks appear under "Extensions".

The protocol is documented in the Flowplan documentation ("Block extensions") and in
`lib/plugin-protocol.ts`.
