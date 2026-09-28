import { test } from "node:test";
import assert from "node:assert/strict";
import { adminDocSlugs, docGroups, docGroupsFor, docSearchIndex, docSlugs, loadDoc } from "../lib/docs";

test("every documentation page loads with title, lead and content", () => {
  assert.ok(docSlugs.length >= 20);
  assert.equal(new Set(docSlugs).size, docSlugs.length);
  for (const slug of docSlugs) {
    const doc = loadDoc(slug)!;
    assert.ok(doc, slug);
    const listed = docGroups.flatMap((g) => g.pages).find((p) => p.slug === slug)!;
    assert.equal(doc.title, listed.title, `${slug}: title matches the navigation`);
    assert.ok(doc.summary.length > 30, `${slug}: lead`);
    assert.ok(doc.html.length > 500, `${slug}: content`);
    assert.ok(!doc.html.includes("[!NOTE]") && !doc.html.includes("[!WARNING]"), `${slug}: callouts render`);
  }
  assert.equal(loadDoc("../package"), null);
});

test("links between documentation pages point at existing pages and sections", () => {
  const anchors = new Map(
    docSlugs.map((slug) => [slug, new Set([...loadDoc(slug)!.html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]))]),
  );
  for (const slug of docSlugs) {
    const doc = loadDoc(slug)!;
    for (const [, target, anchor] of (doc.html + doc.leadHtml).matchAll(/href="\/docs\/([a-z-]+)(?:#([a-z0-9-]+))?"/g)) {
      assert.ok(anchors.has(target), `${slug} links to missing page ${target}`);
      if (anchor) assert.ok(anchors.get(target)!.has(anchor), `${slug} links to missing section ${target}#${anchor}`);
    }
  }
});

test("the search index covers section text", () => {
  const index = docSearchIndex(true);
  const storage = index.find((p) => p.slug === "speicher-und-sicherung")!;
  assert.ok(storage.sections.some((s) => s.text === "Garage" && s.body.includes("garage bucket create")));
  const config = index.find((p) => p.slug === "konfiguration")!;
  assert.match(config.sections.find((s) => s.id === "s3-und-datenbanksicherung")!.body, /S3_BUCKET \S/);
});

test("running the instance is documented for administrators only", () => {
  for (const slug of ["installation", "konfiguration", "speicher-und-sicherung", "coolify-und-proxy", "betrieb", "anmeldung-oidc", "administration"])
    assert.ok(adminDocSlugs.has(slug), slug);
  const publicSlugs = docGroupsFor(false).flatMap((g) => g.pages.map((p) => p.slug));
  assert.ok(publicSlugs.includes("erste-schritte"));
  assert.ok(!publicSlugs.some((slug) => adminDocSlugs.has(slug)));
  assert.ok(!docSearchIndex().some((p) => adminDocSlugs.has(p.slug)), "public search");
  // Public pages neither link to nor page on to administrator pages.
  for (const slug of publicSlugs) {
    const doc = loadDoc(slug, false)!;
    for (const [, target] of doc.html.matchAll(/href="\/docs\/([a-z-]+)/g))
      assert.ok(!adminDocSlugs.has(target), `${slug} links to ${target}`);
    for (const near of [doc.prev, doc.next]) assert.ok(!near || !adminDocSlugs.has(near.slug), `${slug} pages to ${near?.slug}`);
  }
});
