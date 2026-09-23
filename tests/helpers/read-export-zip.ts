import { fromBuffer, type Entry } from "yauzl";
// Independent ZIP inspection: the application importer deliberately accepts only backup paths.
export function readExportZip(bytes: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    fromBuffer(
      bytes,
      { lazyEntries: true, validateEntrySizes: true, strictFileNames: true },
      (error, zip) => {
        if (error) return reject(error);
        const entries = new Map<string, Buffer>();
        zip.on("error", reject);
        zip.on("end", () => resolve(entries));
        zip.on("entry", (entry: Entry) => {
          if (entries.has(entry.fileName)) {
            zip.close();
            reject(new Error("Duplicate ZIP path"));
            return;
          }
          zip.openReadStream(entry, (error, stream) => {
            if (error || !stream) {
              zip.close();
              reject(error || new Error("Missing ZIP stream"));
              return;
            }
            const chunks: Buffer[] = [];
            stream.on("error", reject);
            stream.on("data", (chunk) => chunks.push(chunk));
            stream.on("end", () => {
              entries.set(entry.fileName, Buffer.concat(chunks));
              zip.readEntry();
            });
          });
        });
        zip.readEntry();
      },
    );
  });
}
