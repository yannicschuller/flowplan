import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { docGroups, docSearchIndex, docSlugs, loadDoc } from "../lib/docs";
import { LOCALES } from "../lib/i18n";

for (const locale of LOCALES)
  test(`every documentation page loads with title, lead and content (${locale})`, () => {
    assert.ok(docSlugs.length >= 20);
    assert.equal(new Set(docSlugs).size, docSlugs.length);
    for (const slug of docSlugs) {
      const doc = loadDoc(slug, locale)!;
      assert.ok(doc, slug);
      const listed = docGroups(locale).flatMap((g) => g.pages).find((p) => p.slug === slug)!;
      assert.equal(doc.title, listed.title, `${slug}: title matches the navigation`);
      assert.ok(doc.summary.length > 30, `${slug}: lead`);
      assert.ok(doc.html.length > 500, `${slug}: content`);
      assert.ok(!doc.html.includes("[!NOTE]") && !doc.html.includes("[!WARNING]"), `${slug}: callouts render`);
    }
    assert.equal(loadDoc("../package", locale), null);
  });

test("every page has an English translation without German left in it", () => {
  for (const slug of docSlugs) {
    assert.ok(existsSync(join(process.cwd(), "content", "docs", "en", `${slug}.md`)), `${slug}: English file`);
    const doc = loadDoc(slug, "en")!;
    const text = (doc.leadHtml + doc.html)
      .replace(/<code>[\s\S]*?<\/code>|<pre>[\s\S]*?<\/pre>/g, "")
      .replace(/<[^>]+>/g, " ");
    assert.doesNotMatch(text, /\b(und|der|die|das|nicht|mit|für|oder|wird|werden|eine?n?)\b/, `${slug}: German words`);
  }
});

for (const locale of LOCALES)
  test(`links between documentation pages point at existing pages and sections (${locale})`, () => {
    const anchors = new Map(
      docSlugs.map((slug) => [slug, new Set([...loadDoc(slug, locale)!.html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]))]),
    );
    for (const slug of docSlugs) {
      const doc = loadDoc(slug, locale)!;
      for (const [, target, anchor] of (doc.html + doc.leadHtml).matchAll(/href="\/docs\/([a-z-]+)(?:#([a-z0-9-]+))?"/g)) {
        assert.ok(anchors.has(target), `${slug} links to missing page ${target}`);
        if (anchor) assert.ok(anchors.get(target)!.has(anchor), `${slug} links to missing section ${target}#${anchor}`);
      }
    }
  });

test("the search index covers section text", () => {
  const index = docSearchIndex("de");
  const storage = index.find((p) => p.slug === "speicher-und-sicherung")!;
  assert.ok(storage.sections.some((s) => s.text === "Garage" && s.body.includes("garage bucket create")));
  const config = index.find((p) => p.slug === "konfiguration")!;
  assert.match(config.sections.find((s) => s.id === "s3-und-datenbanksicherung")!.body, /S3_BUCKET \S/);
  const english = docSearchIndex("en").find((p) => p.slug === "konfiguration")!;
  assert.equal(english.title, "Configuration");
});

test("self-hosting is documented for everyone, in both languages", () => {
  const selfHosting = docGroups("en").find((g) => g.title === "Self-hosting")!.pages.map((p) => p.slug);
  for (const slug of ["installation", "konfiguration", "speicher-und-sicherung", "coolify-und-proxy", "betrieb", "anmeldung-oidc", "administration"])
    assert.ok(selfHosting.includes(slug), slug);
  for (const locale of LOCALES)
    assert.match(loadDoc("installation", locale)!.html, /ghcr\.io\/yannicschuller\/flowplan/);
});
