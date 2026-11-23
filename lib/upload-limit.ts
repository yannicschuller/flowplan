// The largest file an instance may allow per upload (Administration →
// Grenzen & Aufbewahrung, per group and per person, limits files): 10 GB.
// POST /api/upload streams the file to disk (lib/multipart-stream.ts), so
// the server's memory does not grow with it. Paths that read a whole file
// into memory keep a lower limit of their own (IN_MEMORY_FILE_MB).
export const MAX_UPLOAD_MB = 10240;
// Per file for what is read into memory as a whole (files inside a
// Flowplan archive, Anki packages, attachments fetched by the Notion and
// BookStack imports, whiteboard imports): the former maximum of 1 GB.
export const IN_MEMORY_FILE_MB = 1024;
