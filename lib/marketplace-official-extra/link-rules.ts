// Link-rule presets of the marketplace (see ./types.ts): automatic links
// (lib/auto-link.ts) for common references. Addresses with a placeholder
// host (example.com, OWNER/REPO, ABC) are adapted by the workspace owner
// after the import in Settings → Workspace → Automatic links.
import type { ExtraLinkRules } from "./types";

const adapt = {
  de: "Nach dem Import unter **Einstellungen → Arbeitsbereich → Automatische Links** Adresse und Kürzel an die eigene Umgebung anpassen und im Tester ausprobieren. Importierte Regeln kommen zu den vorhandenen hinzu; gleiche Muster werden übersprungen.",
  en: "After importing, adapt the address and prefix to your own setup in **Settings → Workspace → Automatic links** and try them in the tester. Imported rules are added to the existing ones; identical patterns are skipped.",
};
const describe = (de: string, en: string) => ({ de: `${de}\n\n${adapt.de}`, en: `${en}\n\n${adapt.en}` });

export const extraLinkRules: ExtraLinkRules[] = [
  {
    kind: "link-rules",
    id: "jira-issues",
    category: "projects",
    language: "multi",
    title: { de: "Jira-Vorgänge verlinken", en: "Link Jira issues" },
    tags: ["Automatische Links", "Jira", "Tickets", "Entwicklung"],
    summary: {
      de: "Vorgangsschlüssel wie ABC-123 werden beim Tippen zum Link auf den Vorgang in Jira – für ein oder zwei Projektkürzel.",
      en: "Issue keys like ABC-123 become a link to the issue in Jira as you type – for one or two project keys.",
    },
    description: describe(
      "Zwei Regeln mit den Platzhaltern **ABC** und **XYZ** für die Projektkürzel und **jira.example.com** für die eigene Jira-Adresse (Cloud: `https://firma.atlassian.net/browse/{match}`).\n\n- `ABC-123` → `https://jira.example.com/browse/ABC-123`\n- `XYZ-7` → `https://jira.example.com/browse/XYZ-7`\n\nAbsichtlich keine Regel für *alle* Großbuchstaben-Kürzel: sie würde auch „ISO-9001“ oder „UTF-8“ verlinken. Andere Tracker mit gleichen Schlüsseln (z. B. YouTrack, Linear) funktionieren mit einer anderen Adresse genauso.",
      "Two rules with the placeholders **ABC** and **XYZ** for the project keys and **jira.example.com** for your own Jira address (cloud: `https://company.atlassian.net/browse/{match}`).\n\n- `ABC-123` → `https://jira.example.com/browse/ABC-123`\n- `XYZ-7` → `https://jira.example.com/browse/XYZ-7`\n\nDeliberately no rule for *all* upper-case keys: it would also link “ISO-9001” or “UTF-8”. Other trackers with the same keys (e.g. YouTrack, Linear) work the same with another address.",
    ),
    rules: [
      { name: "Jira ABC", pattern: "\\bABC-\\d+\\b", template: "https://jira.example.com/browse/{match}" },
      { name: "Jira XYZ", pattern: "\\bXYZ-\\d+\\b", template: "https://jira.example.com/browse/{match}" },
    ],
  },
  {
    kind: "link-rules",
    id: "github-references",
    category: "projects",
    language: "multi",
    title: { de: "GitHub-Issues und Pull Requests", en: "GitHub issues and pull requests" },
    tags: ["Automatische Links", "GitHub", "Code", "Entwicklung"],
    summary: {
      de: "owner/repo#123 und #123 werden zu Links auf Issues und Pull Requests, abc1234 zum Commit – wie auf GitHub selbst.",
      en: "owner/repo#123 and #123 become links to issues and pull requests, abc1234 to the commit – just like on GitHub itself.",
    },
    description: describe(
      "Drei Regeln:\n\n- `owner/repo#123` → Issue oder Pull Request in diesem Repository (GitHub leitet von /issues/ auf den Pull Request weiter)\n- `#123` → Issue im Standard-Repository **OWNER/REPO** (Platzhalter ersetzen)\n- `commit abc1234` → der Commit im Standard-Repository\n\nFür GitHub Enterprise `github.com` durch die eigene Adresse ersetzen.",
      "Three rules:\n\n- `owner/repo#123` → issue or pull request in that repository (GitHub redirects from /issues/ to the pull request)\n- `#123` → issue in the default repository **OWNER/REPO** (replace the placeholder)\n- `commit abc1234` → the commit in the default repository\n\nFor GitHub Enterprise replace `github.com` with your own address.",
    ),
    rules: [
      { name: "GitHub owner/repo#123", pattern: "\\b([\\w.-]+)/([\\w.-]+)#(\\d+)\\b", template: "https://github.com/$1/$2/issues/$3" },
      { name: "GitHub #123", pattern: "(?<![\\w/&])#(\\d+)\\b", template: "https://github.com/OWNER/REPO/issues/$1" },
      { name: "GitHub-Commit", pattern: "\\bcommit ([0-9a-f]{7,40})\\b", template: "https://github.com/OWNER/REPO/commit/$1" },
    ],
  },
  {
    kind: "link-rules",
    id: "gitlab-references",
    category: "projects",
    language: "multi",
    title: { de: "GitLab-Merge-Requests und Issues", en: "GitLab merge requests and issues" },
    tags: ["Automatische Links", "GitLab", "Code", "Entwicklung"],
    summary: {
      de: "gruppe/projekt!42 wird zum Link auf den Merge Request, gruppe/projekt#7 auf das Issue – auf gitlab.com oder der eigenen Instanz.",
      en: "group/project!42 becomes a link to the merge request, group/project#7 to the issue – on gitlab.com or your own instance.",
    },
    description: describe(
      "Zwei Regeln nach GitLabs eigener Schreibweise:\n\n- `gruppe/projekt!42` → `https://gitlab.com/gruppe/projekt/-/merge_requests/42`\n- `gruppe/projekt#7` → `https://gitlab.com/gruppe/projekt/-/issues/7`\n\nFür eine eigene GitLab-Instanz `gitlab.com` durch deren Adresse ersetzen. Untergruppen (`a/b/c!1`) erfasst die Regel nicht – dafür eine eigene Regel mit festem Pfad anlegen. Nicht zusammen mit der GitHub-Regel für `owner/repo#123` verwenden, beide würden dieselben Texte verlinken.",
      "Two rules in GitLab's own notation:\n\n- `group/project!42` → `https://gitlab.com/group/project/-/merge_requests/42`\n- `group/project#7` → `https://gitlab.com/group/project/-/issues/7`\n\nFor your own GitLab instance replace `gitlab.com` with its address. Subgroups (`a/b/c!1`) are not covered – add a rule with a fixed path for them. Do not combine with the GitHub rule for `owner/repo#123`; both would link the same texts.",
    ),
    rules: [
      // Group and project apart: a captured "/" would be URL-encoded.
      { name: "GitLab-Merge-Request", pattern: "\\b([\\w.-]+)/([\\w.-]+)!(\\d+)\\b", template: "https://gitlab.com/$1/$2/-/merge_requests/$3" },
      { name: "GitLab-Issue", pattern: "\\b([\\w.-]+)/([\\w.-]+)#(\\d+)\\b", template: "https://gitlab.com/$1/$2/-/issues/$3" },
    ],
  },
  {
    kind: "link-rules",
    id: "sentry-issues",
    category: "projects",
    language: "multi",
    title: { de: "Sentry-Fehler verlinken", en: "Link Sentry issues" },
    tags: ["Automatische Links", "Sentry", "Monitoring", "Fehler"],
    summary: {
      de: "Kurz-IDs von Fehlern aus dem Monitoring wie WEBAPP-3K werden zum Link auf die Suche in Sentry.",
      en: "Short IDs of errors from monitoring like WEBAPP-3K become a link to the search in Sentry.",
    },
    description: describe(
      "Eine Regel für die Kurz-ID eines Sentry-Projekts:\n\n- `WEBAPP-3K` → `https://example.sentry.io/issues/?query=WEBAPP-3K`\n\nPlatzhalter: **WEBAPP** ist das Projektkürzel (in Sentry unter den Projekteinstellungen), **example** der Name der Organisation; für eine eigene Sentry-Installation die ganze Adresse ersetzen. Praktisch in Störungsberichten und im Fehler-Tracker.",
      "One rule for the short ID of a Sentry project:\n\n- `WEBAPP-3K` → `https://example.sentry.io/issues/?query=WEBAPP-3K`\n\nPlaceholders: **WEBAPP** is the project's short name (in Sentry's project settings), **example** the organisation; for a self-hosted Sentry replace the whole address. Handy in incident postmortems and the bug tracker.",
    ),
    rules: [{ name: "Sentry WEBAPP", pattern: "\\bWEBAPP-[0-9A-Z]{1,8}\\b", template: "https://example.sentry.io/issues/?query={match}" }],
  },
  {
    kind: "link-rules",
    id: "research-references",
    category: "knowledge",
    language: "multi",
    title: { de: "Fachreferenzen: DOI, arXiv, RFC, CVE", en: "References: DOI, arXiv, RFC, CVE" },
    tags: ["Automatische Links", "Wissenschaft", "Standards", "Sicherheit"],
    summary: {
      de: "DOIs, arXiv-Artikel, Internet-Standards (RFC 9110) und Sicherheitslücken (CVE-2024-1234) werden zu Links auf ihre offiziellen Seiten.",
      en: "DOIs, arXiv papers, internet standards (RFC 9110) and vulnerabilities (CVE-2024-1234) become links to their official pages.",
    },
    description: describe(
      "Vier Regeln, die ohne Anpassung funktionieren:\n\n- `10.1000/xyz123` (DOI) → `https://doi.org/…`\n- `arXiv:2101.00001` → `https://arxiv.org/abs/2101.00001`\n- `RFC 9110` → `https://www.rfc-editor.org/rfc/rfc9110`\n- `CVE-2024-1234` → `https://nvd.nist.gov/vuln/detail/CVE-2024-1234`\n\nGut für Literaturlisten, Lesenotizen, Sicherheitshinweise und technische Konzepte.",
      "Four rules that work without changes:\n\n- `10.1000/xyz123` (DOI) → `https://doi.org/…`\n- `arXiv:2101.00001` → `https://arxiv.org/abs/2101.00001`\n- `RFC 9110` → `https://www.rfc-editor.org/rfc/rfc9110`\n- `CVE-2024-1234` → `https://nvd.nist.gov/vuln/detail/CVE-2024-1234`\n\nGood for bibliographies, reading notes, security advisories and technical designs.",
    ),
    rules: [
      // Prefix and suffix apart, so the "/" between them stays a "/"; no trailing punctuation.
      { name: "DOI", pattern: "\\b(10\\.\\d{4,9})/([^\\s\"<>]*[^\\s\"<>.,;:!?)])", template: "https://doi.org/$1/$2" },
      { name: "arXiv", pattern: "\\barXiv:(\\d{4}\\.\\d{4,5}(?:v\\d+)?)\\b", template: "https://arxiv.org/abs/$1" },
      { name: "RFC", pattern: "\\bRFC ?(\\d{1,5})\\b", template: "https://www.rfc-editor.org/rfc/rfc$1" },
      { name: "CVE", pattern: "\\bCVE-\\d{4}-\\d{4,7}\\b", template: "https://nvd.nist.gov/vuln/detail/{match}" },
    ],
  },
  {
    kind: "link-rules",
    id: "wikipedia-links",
    category: "knowledge",
    language: "multi",
    title: { de: "Wikipedia-Links [[w:…]]", en: "Wikipedia links [[w:…]]" },
    tags: ["Automatische Links", "Wikipedia", "Wiki", "Nachschlagen"],
    summary: {
      de: "Schreibweise aus Wikis: [[w:Begriff]] verlinkt den deutschen Wikipedia-Artikel, [[en:Term]] den englischen.",
      en: "Wiki notation: [[w:Begriff]] links the German Wikipedia article, [[en:Term]] the English one.",
    },
    description: describe(
      "Zwei Regeln:\n\n- `[[w:Kanban]]` → `https://de.wikipedia.org/wiki/Kanban`\n- `[[en:Kanban (development)]]` → `https://en.wikipedia.org/wiki/Kanban%20(development)`\n\nDer Text zwischen den Klammern darf Leerzeichen enthalten. Für eine andere Sprache das Kürzel in Muster und Adresse ändern (z. B. `fr`).",
      "Two rules:\n\n- `[[w:Kanban]]` → `https://de.wikipedia.org/wiki/Kanban`\n- `[[en:Kanban (development)]]` → `https://en.wikipedia.org/wiki/Kanban%20(development)`\n\nThe text between the brackets may contain spaces. For another language change the code in the pattern and the address (e.g. `fr`).",
    ),
    rules: [
      { name: "Wikipedia (de)", pattern: "\\[\\[w:([^\\]|]{1,100})\\]\\]", template: "https://de.wikipedia.org/wiki/$1" },
      { name: "Wikipedia (en)", pattern: "\\[\\[en:([^\\]|]{1,100})\\]\\]", template: "https://en.wikipedia.org/wiki/$1" },
    ],
  },
  {
    kind: "link-rules",
    id: "german-laws",
    category: "other",
    language: "de",
    title: { de: "Gesetze: § 433 BGB und Art. 5 GG", en: "German laws: § 433 BGB and Art. 5 GG" },
    tags: ["Automatische Links", "Recht", "Gesetze", "Verwaltung"],
    summary: {
      de: "Paragrafen von BGB, HGB, StGB, ZPO, AO und SGB V sowie Artikel des Grundgesetzes werden zu Links auf gesetze-im-internet.de.",
      en: "Sections of German codes (BGB, HGB, StGB, ZPO, AO, SGB V) and articles of the Basic Law become links to gesetze-im-internet.de.",
    },
    description: describe(
      "Sieben Regeln für häufig zitierte Gesetze auf dem Angebot des Bundesjustizministeriums:\n\n- `§ 433 BGB`, `§ 312g BGB` → `https://www.gesetze-im-internet.de/bgb/__433.html`\n- ebenso für **HGB**, **StGB**, **ZPO**, **AO** und **SGB V**\n- `Art. 5 GG` → `https://www.gesetze-im-internet.de/gg/art_5.html`\n\nWeitere Gesetze nach demselben Muster ergänzen: das Kürzel in der Adresse ist das der Seite auf gesetze-im-internet.de (meist klein geschrieben). Keine Rechtsberatung – nur Links.",
      "Seven rules for frequently cited German laws on the Federal Ministry of Justice's site:\n\n- `§ 433 BGB`, `§ 312g BGB` → `https://www.gesetze-im-internet.de/bgb/__433.html`\n- likewise for **HGB**, **StGB**, **ZPO**, **AO** and **SGB V**\n- `Art. 5 GG` → `https://www.gesetze-im-internet.de/gg/art_5.html`\n\nAdd more laws the same way: the abbreviation in the address is the one used on gesetze-im-internet.de (mostly lower case). Not legal advice – just links.",
    ),
    rules: [
      { name: "BGB", pattern: "§ ?(\\d{1,4}[a-z]?) BGB\\b", template: "https://www.gesetze-im-internet.de/bgb/__$1.html" },
      { name: "HGB", pattern: "§ ?(\\d{1,4}[a-z]?) HGB\\b", template: "https://www.gesetze-im-internet.de/hgb/__$1.html" },
      { name: "StGB", pattern: "§ ?(\\d{1,4}[a-z]?) StGB\\b", template: "https://www.gesetze-im-internet.de/stgb/__$1.html" },
      { name: "ZPO", pattern: "§ ?(\\d{1,4}[a-z]?) ZPO\\b", template: "https://www.gesetze-im-internet.de/zpo/__$1.html" },
      { name: "AO", pattern: "§ ?(\\d{1,4}[a-z]?) AO\\b", template: "https://www.gesetze-im-internet.de/ao_1977/__$1.html" },
      { name: "SGB V", pattern: "§ ?(\\d{1,4}[a-z]?) SGB V\\b", template: "https://www.gesetze-im-internet.de/sgb_5/__$1.html" },
      { name: "Grundgesetz", pattern: "Art\\. ?(\\d{1,3}[a-z]?) GG\\b", template: "https://www.gesetze-im-internet.de/gg/art_$1.html" },
    ],
  },
  {
    kind: "link-rules",
    id: "zendesk-tickets",
    category: "other",
    language: "multi",
    title: { de: "Support-Tickets verlinken", en: "Link support tickets" },
    tags: ["Automatische Links", "Support", "Zendesk", "Tickets"],
    summary: {
      de: "„Ticket #12345“ wird zum Link auf das Ticket im Helpdesk – voreingestellt für Zendesk, für andere Systeme nur die Adresse ändern.",
      en: "“Ticket #12345” becomes a link to the ticket in the help desk – preset for Zendesk, for other systems just change the address.",
    },
    description: describe(
      "Eine Regel:\n\n- `Ticket #12345` oder `Ticket 12345` → `https://example.zendesk.com/agent/tickets/12345`\n\n**example** durch die eigene Subdomain ersetzen. Für andere Helpdesks die Adresse anpassen, etwa `https://support.example.com/tickets/$1`. Das Wort „Ticket“ im Muster verhindert, dass jede Zahl mit # verlinkt wird.",
      "One rule:\n\n- `Ticket #12345` or `Ticket 12345` → `https://example.zendesk.com/agent/tickets/12345`\n\nReplace **example** with your own subdomain. For other help desks adapt the address, e.g. `https://support.example.com/tickets/$1`. The word “Ticket” in the pattern keeps every number with # from being linked.",
    ),
    rules: [{ name: "Support-Ticket", pattern: "\\b[Tt]icket #?(\\d{1,10})\\b", template: "https://example.zendesk.com/agent/tickets/$1" }],
  },
];
