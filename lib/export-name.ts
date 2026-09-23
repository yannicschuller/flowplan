export function exportName(value: string) {
  const clean = value
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N} ._-]/gu, "-")
    .replace(/\.{2,}/g, "-")
    .replace(/^[. ]+|[. ]+$/g, "");
  // Leave room for the UUID and extension within common 255-byte filename limits.
  const encoder = new TextEncoder();
  let result = "",
    bytes = 0;
  for (const char of Array.from(clean).slice(0, 80)) {
    const size = encoder.encode(char).length;
    if (bytes + size > 160) break;
    bytes += size;
    result += char;
  }
  result = result.replace(/[. ]+$/g, "") || "Seite";
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(result)
    ? "_" + result
    : result;
}
