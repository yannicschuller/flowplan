import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-citations-"));
const { id, run, one } = await import("../lib/db");
const { command, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { htmlState, stateHtml } = await import("../lib/document-server");
const { htmlToMarkdown } = await import("../lib/markdown");
const Y = await import("yjs");
const {
  parseBibtex,
  parseCslJson,
  parseReferences,
  inlineCitation,
  referenceText,
  formatReference,
  sortReferences,
  normalizeDoi,
  suggestKey,
  uniqueKey,
  pandocCitation,
  latexText,
  citedWorks,
} = await import("../lib/citations");
const { bibliography, resolveDoi, bibliographyForDoi } = await import("../lib/citations-server");

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", "citations", name), "utf8");
const english = (_de: string, en: string) => en;
function user(name: string): Identity {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.com`);
  return { id: uid, name, email: `${name}@example.com`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}

test("BibTeX from Zotero: macros, accents, names, dates and unsafe links", () => {
  const items = parseBibtex(fixture("zotero.bib"));
  assert.deepEqual(items.map((i) => i.id), ["mueller2021", "knuth1984", "garcia2019", "wiki", "noyear"]);
  const [mueller, knuth, garcia, wiki, thesis] = items;
  assert.deepEqual(mueller.author, [
    { family: "Müller", given: "Anna" },
    { family: "Schmidt", given: "Bernd Karl" },
  ]);
  assert.equal(mueller.title, "Gemeinsames Schreiben in Echtzeit");
  assert.equal(mueller["container-title"], "Journal of Collaborative Software");
  assert.deepEqual(mueller.issued, { "date-parts": [[2021, 3]] });
  assert.deepEqual([mueller.type, mueller.volume, mueller.issue, mueller.page], ["article-journal", "12", "3", "45–67"]);
  assert.equal(mueller.DOI, "10.1234/jcs.2021.003");
  assert.equal(mueller.URL, undefined);
  assert.equal(knuth.title, "The TeXbook");
  assert.deepEqual(knuth.author, [{ family: "Knuth", given: "Donald E." }]);
  assert.deepEqual(
    garcia.author!.map((n) => n.family),
    ["García", "van der Berg", "Lee", "Ørsted"],
  );
  assert.equal(garcia.author![0].given, "José");
  assert.deepEqual(garcia.editor, [{ family: "Shapiro", given: "Marc" }]);
  assert.deepEqual(garcia.issued, { "date-parts": [[2019, 6, 12]] });
  assert.equal(garcia.type, "paper-conference");
  assert.deepEqual(wiki.author, [{ literal: "Wikimedia Foundation" }]);
  assert.equal(wiki.title, "Wikipedia & Co.");
  assert.equal(wiki.URL, "https://www.wikipedia.org/");
  assert.equal(thesis.issued, undefined);
  assert.deepEqual([thesis.type, thesis.publisher], ["thesis", "Universität Wien"]);
  assert.equal(latexText("Schr{\\\"o}dinger -- {\\c{C}}ay \\& {\\ss}"), "Schrödinger – Çay & ß");
  // Broken input never throws; what can be read is read.
  assert.deepEqual(parseBibtex("@article{x, title={Offen"), []);
  assert.equal(parseBibtex("@book{ok, title={Gut}, author={A, B}}\n@article{broken, title={").length, 1);
});

test("CSL-JSON (Zotero export) is cleaned and keys follow the citation key", () => {
  const items = parseCslJson(fixture("zotero.json"));
  assert.deepEqual(items.map((i) => i.id), ["lee2020", "nameless"]);
  const [lee, nameless] = items;
  assert.equal(lee.title, "Local-first software");
  assert.equal(lee.DOI, "10.1145/3365199");
  assert.equal(lee.issue, "11");
  assert.deepEqual(lee.issued, { "date-parts": [[2020, 11]] });
  assert.deepEqual(lee.author![2], { literal: "Ink & Switch" });
  assert.equal(nameless.URL, undefined);
  assert.equal(parseReferences(fixture("zotero.json")).length, 2);
  assert.equal(parseReferences(fixture("zotero.bib")).length, 5);
  assert.throws(() => parseReferences("[{nope"), /CSL-JSON/);
});

test("citations read like (Müller 2021) and the bibliography is APA-like", () => {
  const [mueller, knuth, garcia, wiki, thesis] = parseBibtex(fixture("zotero.bib"));
  assert.equal(inlineCitation(mueller), "(Müller & Schmidt 2021)");
  assert.equal(inlineCitation(knuth, "12"), "(Knuth 1984, S. 12)");
  assert.equal(inlineCitation(knuth, "12", english), "(Knuth 1984, p. 12)");
  assert.equal(inlineCitation(knuth, "Kap. 3"), "(Knuth 1984, Kap. 3)");
  assert.equal(inlineCitation(garcia), "(García et al. 2019)");
  assert.equal(inlineCitation(thesis), "(Ärger o. J.)");
  assert.equal(inlineCitation(thesis, "", english), "(Ärger n.d.)");
  assert.equal(inlineCitation(null), "(Quelle fehlt)");
  assert.equal(
    referenceText(mueller),
    "Müller, A., & Schmidt, B. K. (2021). Gemeinsames Schreiben in Echtzeit. Journal of Collaborative Software, 12(3), 45–67. https://doi.org/10.1234/jcs.2021.003",
  );
  assert.deepEqual(
    formatReference(mueller).filter((s) => s.italic).map((s) => s.text),
    ["Journal of Collaborative Software", "12"],
  );
  assert.equal(referenceText(knuth), "Knuth, D. E. (1984). The TeXbook (1. Aufl.). Addison-Wesley.");
  assert.equal(referenceText(knuth, english), "Knuth, D. E. (1984). The TeXbook (1. ed.). Addison-Wesley.");
  assert.equal(
    referenceText(garcia),
    "García, J., van der Berg, L., Lee, M., & Ørsted, H. (2019). Conflict-free Replicated Data Types in Practice. In M. Shapiro (Hrsg.), Proceedings of the Workshop on CRDTs (S. 1–10). ACM.",
  );
  assert.equal(referenceText(wiki), "Wikimedia Foundation (o. J.). Wikipedia & Co. https://www.wikipedia.org/");
  assert.deepEqual(sortReferences([mueller, wiki, knuth, garcia, thesis]).map((i) => i.id), ["noyear", "garcia2019", "knuth1984", "mueller2021", "wiki"]);
});

test("DOIs, keys and Pandoc citations", () => {
  assert.equal(normalizeDoi("https://doi.org/10.1145/3365199"), "10.1145/3365199");
  assert.equal(normalizeDoi("doi: 10.1000/xyz123."), "10.1000/xyz123");
  assert.equal(normalizeDoi("http://dx.doi.org/10.1002/(SICI)1097-4571"), "10.1002/(SICI)1097-4571");
  assert.equal(normalizeDoi("11.1000/xyz"), null);
  assert.equal(normalizeDoi("10.1000/<script>"), null);
  const [mueller] = parseBibtex(fixture("zotero.bib"));
  assert.equal(suggestKey(mueller), "mueller2021gemeinsames");
  assert.equal(uniqueKey("a", (k) => k === "a" || k === "aa"), "ab");
  assert.equal(pandocCitation("mueller2021"), "[@mueller2021]");
  assert.equal(pandocCitation("mueller2021", "12–14"), "[@mueller2021, p. 12–14]");
  assert.equal(pandocCitation("doi:10.1/x"), "[@doi:10.1/x]");
  assert.equal(pandocCitation("ends."), "[@{ends.}]");
  // The same work cited twice is listed once.
  assert.equal(citedWorks([{ key: "k", item: JSON.stringify(mueller) }, { key: "k", item: JSON.stringify(mueller) }, { key: "x", item: "kaputt" }]).length, 1);
});

test("citations survive the document round trip and export as Pandoc Markdown", () => {
  const [mueller, knuth] = parseBibtex(fixture("zotero.bib"));
  const attr = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
  const evil = { ...knuth, title: 'Böse <img src=x onerror="alert(1)">' };
  const html =
    `<p>Wie gezeigt <span data-citation="mueller2021" data-citation-item="${attr(JSON.stringify(mueller))}">x</span> ` +
    `und <span data-citation="knuth1984" data-citation-item="${attr(JSON.stringify(evil))}" data-citation-locator="12">x</span>.</p>` +
    `<div data-bibliography="true" data-bibliography-title="Quellen"></div>`;
  const doc = new Y.Doc();
  Y.applyUpdate(doc, htmlState(html));
  const stored = stateHtml(doc);
  assert.match(stored, /data-citation="mueller2021"/);
  assert.match(stored, /\(Müller &amp; Schmidt 2021\)/);
  assert.match(stored, /\(Knuth 1984, S\. 12\)/);
  assert.match(stored, /data-bibliography-title="Quellen"/);
  assert.doesNotMatch(stored, /<img|onerror=/);
  const context = { url: (u: string) => u, linked: () => null };
  const markdown = htmlToMarkdown(stored, context);
  assert.match(markdown, /Wie gezeigt \[@mueller2021\] und \[@knuth1984, p\. 12\]\./);
  assert.match(markdown, /## Quellen\n\n- Knuth, D\. E\. \(1984\)\. \*Böse/);
  assert.match(markdown, /\n- Müller, A\., &amp; Schmidt, B\. K\. \(2021\)\. Gemeinsames Schreiben in Echtzeit\. \*Journal of Collaborative Software\*, \*12\*\(3\)/);
  assert.match(markdown, /45–67\. <https:\/\/doi\.org\/10\.1234\/jcs\.2021\.003>/);
  // Without a bibliography block the works are listed at the end.
  const plain = htmlToMarkdown(stored.replace(/<div[^>]*data-bibliography[^>]*>.*?<\/div>/, ""), context);
  assert.match(plain, /\n## Literaturverzeichnis\n\n- Knuth/);
});

test("the workspace bibliography: import, update, permissions and DOIs", async () => {
  const owner = user("Bib"),
    reader = user("Leser");
  const wid = createWorkspace(owner.id, "Literatur");
  run("INSERT INTO members VALUES(?,?,?)", wid, reader.id, "viewer");
  bootstrap(owner, wid);
  const imported = command(owner, { action: "citation.import", workspaceId: wid, text: fixture("zotero.bib") }) as { added: number; updated: number };
  assert.deepEqual([imported.added, imported.updated], [5, 0]);
  const again = command(owner, { action: "citation.import", workspaceId: wid, text: fixture("zotero.json") }) as { added: number };
  assert.equal(again.added, 2);
  assert.equal(bibliography(reader, wid).length, 7);
  assert.equal((command(owner, { action: "citation.import", workspaceId: wid, text: fixture("zotero.bib") }) as { updated: number }).updated, 5);
  assert.throws(() => command(reader, { action: "citation.import", workspaceId: wid, text: fixture("zotero.bib") }), /Berechtigung/);
  assert.throws(() => command(owner, { action: "citation.import", workspaceId: wid, text: "nur Text" }), /Keine Literaturangaben/);
  command(owner, { action: "citation.remove", workspaceId: wid, key: "wiki" });
  assert.equal(bibliography(owner, wid).length, 6);

  // DOIs: resolved once through the (here simulated) safe fetch, then cached.
  let calls = 0;
  const fetcher = async (url: string, options?: { accept?: string }) => {
    calls++;
    assert.equal(url, "https://doi.org/10.5555/12345678");
    assert.equal(options?.accept, "application/vnd.citationstyles.csl+json");
    return {
      url,
      status: 200,
      type: "application/vnd.citationstyles.csl+json",
      data: Buffer.alloc(0),
      body: JSON.stringify({
        type: "article-journal",
        title: "Toward a Unified Theory of <b>High-Energy</b> Metaphysics",
        author: [{ family: "Josiah", given: "Carberry" }],
        issued: { "date-parts": [[2008, 8, 13]] },
        "container-title": "Journal of Psychoceramics",
        DOI: "10.5555/12345678",
      }),
    };
  };
  const data = await resolveDoi("https://doi.org/10.5555/12345678", fetcher as never);
  assert.equal(data.title, "Toward a Unified Theory of High-Energy Metaphysics");
  await resolveDoi("10.5555/12345678", fetcher as never);
  assert.equal(calls, 1);
  assert.ok(one("SELECT 1 FROM doi_cache WHERE doi='10.5555/12345678'"));
  const first = bibliographyForDoi(owner, wid, data);
  assert.equal(first.id, "josiah2008toward");
  assert.equal(bibliographyForDoi(owner, wid, data).id, first.id);
  await assert.rejects(resolveDoi("keine doi"), (e: any) => e.status === 400);
  const missing = async () => ({ url: "", status: 404, type: "text/html", body: "", data: Buffer.alloc(0) });
  await assert.rejects(resolveDoi("10.5555/missing", missing as never), (e: any) => e.status === 404);
  const garbage = async () => ({ url: "", status: 200, type: "application/json", body: "{}", data: Buffer.alloc(0) });
  await assert.rejects(resolveDoi("10.5555/garbage", garbage as never), (e: any) => e.status === 502);
});

test("citations, the bibliography and footnotes survive editing the page as Markdown", async () => {
  const { markdownSource } = await import("../lib/markdown");
  const { markdownToHtml } = await import("../lib/markdown-import");
  const [mueller] = parseBibtex(fixture("zotero.bib"));
  const attr = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
  const html =
    `<p>Siehe <span data-citation="mueller2021" data-citation-item="${attr(JSON.stringify(mueller))}">x</span>` +
    `<sup data-footnote="Eine Anmerkung"></sup>.</p><div data-bibliography="true" data-bibliography-title="Quellen"></div>`;
  const doc = new Y.Doc();
  Y.applyUpdate(doc, htmlState(html));
  const stored = stateHtml(doc);
  // The normal export: Pandoc citation, bibliography and footnote together.
  const exported = htmlToMarkdown(stored, { url: (u: string) => u, linked: () => null });
  assert.match(exported, /Siehe \[@mueller2021\]\[\^1\]\./);
  assert.match(exported, /## Quellen\n\n- Müller/);
  assert.match(exported, /\n\[\^1\]: Eine Anmerkung\n$/);
  // The source view keeps the citation as HTML and the bibliography as a block.
  const source = markdownSource(stored);
  const back = markdownToHtml(source.markdown, (href) => href, { source: true, blocks: (i) => source.blocks[i]?.html ?? null });
  const again = new Y.Doc();
  Y.applyUpdate(again, htmlState(back));
  const applied = stateHtml(again);
  assert.match(applied, /data-citation="mueller2021"/);
  assert.match(applied, /data-bibliography-title="Quellen"/);
  assert.match(applied, /data-footnote="Eine Anmerkung"/);
});
