// db-dialect-scan: sqlite-only file – edits the SQLite file of the media instance.
// Short clips for the website (public/demos/ in flowplan-website): raw
// 25 fps H.264 masters in MEDIA_DIR/raw, then encode.sh makes the WebM, MP4
// and WebP poster the site serves. Needs seed.mjs and ai-mock.mjs.
//
//   MEDIA_URL=http://127.0.0.1:3641 MEDIA_DATA=/dev/shm/media node scripts/site-media/clips.mjs [name …]
//
// Names: board-drag, timeline, ai-write, home, notebook (Mia, English, light)
// and db-views-, editor-, whiteboard- × de|en × "" | -dark (Lena and Alex,
// the demo showcase), 1280×800 like the clips they replace.
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
import { launch, context, open, ids, sleep, glide, clickOn, center, typeText, record, pointerAt, CURSOR, DATA, DIR } from "./lib.mjs";
import { handwriting } from "./handwriting.mjs";

const require = createRequire(new URL("../../package.json", import.meta.url));
const { DatabaseSync } = require("node:sqlite");
const I = ids();
const only = process.argv.slice(2);
const sql = (fn) => {
  const db = new DatabaseSync(join(DATA, "flowplan.sqlite"));
  db.exec("PRAGMA busy_timeout=10000");
  try {
    return fn(db);
  } finally {
    db.close();
  }
};
const main = (page) => page.locator("main");
const tabOf = (page, name) => main(page).getByRole("button", { name, exact: true }).or(main(page).getByRole("tab", { name, exact: true })).first();

// A fresh document for the editor clip, so every run starts the same.
function freshPage(who, title, icon, html) {
  const { workspace, user } = I[who];
  return sql((db) => {
    db.prepare("UPDATE pages SET deleted_at=CURRENT_TIMESTAMP WHERE title=? AND workspace_id=? AND deleted_at IS NULL").run(title, workspace);
    const space = db.prepare("SELECT space_id FROM pages WHERE workspace_id=? AND kind='database' LIMIT 1").get(workspace).space_id;
    const id = randomUUID();
    db.prepare("INSERT INTO pages(id,workspace_id,space_id,parent_id,title,kind,created_by,position,icon,cover) VALUES(?,?,?,?,?,?,?,?,?,?)").run(id, workspace, space, null, title, "document", user, 0.5, icon, "");
    db.prepare("INSERT INTO documents(page_id,html) VALUES(?,?)").run(id, html);
    return id;
  });
}

// Each scene: who, and a function that prepares the page and returns the
// recorded action.
const DEMO = {
  "db-views": (lang) => async (page) => {
    const t = (de, en) => (lang === "de" ? de : en);
    const who = lang === "de" ? "lena" : "alex";
    await open(page, `page=${I[who].pages.find((p) => p.kind === "database" && /Projekt|Project/.test(p.title)).id}`, 3000);
    const views = ["Board", t("Kalender", "Calendar"), "Timeline", t("Galerie", "Gallery"), t("Tabelle", "Table")];
    // Warm every view once, so the recording does not wait for code.
    for (const v of views) {
      await tabOf(page, v).click();
      await sleep(1500);
    }
    return async () => {
      await sleep(900);
      for (const v of views) {
        await clickOn(page, tabOf(page, v), 480);
        await sleep(1500);
      }
      await glide(page, 1100, 700, 600);
    };
  },
  editor: (lang) => async (page) => {
    const t = (de, en) => (lang === "de" ? de : en);
    const who = lang === "de" ? "lena" : "alex";
    const id = freshPage(who, t("Launch-Checkliste", "Launch checklist"), "🚀", t("<p>Alles für den Start der neuen Website – am Freitag geht sie live.</p>", "<p>Everything for the new website – it goes live on Friday.</p>"));
    await open(page, `page=${id}`, 3000);
    return async () => {
      const para = page.locator(".ProseMirror p").first();
      const c = await center(para);
      await glide(page, c.b.x + c.b.width - 4, c.y, 700);
      await page.mouse.down();
      await page.mouse.up();
      await page.keyboard.press("End");
      await sleep(300);
      // levels: 2 for entries with a second menu (callout → its kind).
      const slash = async (query, text, ms, levels = 1) => {
        await page.keyboard.type("/", { delay: 60 });
        await typeText(page, query, 300);
        await sleep(700);
        for (let i = 0; i < levels; i++) {
          await page.keyboard.press("Enter");
          await sleep(i < levels - 1 ? 600 : 0);
        }
        if (text) await typeText(page, text, ms);
      };
      await page.keyboard.press("Enter");
      await slash(t("Überschrift 2", "Heading 2"), t("Am Launch-Tag", "On launch day"), 600);
      await page.keyboard.press("Enter");
      await slash(t("Aufgabe", "Task"), t("Texte final prüfen", "Final copy review"), 650);
      await page.keyboard.press("Enter");
      await typeText(page, t("Pressemappe verschicken", "Send the press kit"), 650);
      await page.keyboard.press("Enter");
      await typeText(page, t("DNS umstellen", "Switch the DNS"), 550);
      await page.keyboard.press("Enter");
      await page.keyboard.press("Enter");
      await slash("Callout", t("Rollback-Plan liegt im Wiki.", "The rollback plan is in the wiki."), 800, 2);
      await sleep(300);
      const box = await page.evaluate(() => {
        const li = document.querySelector('.ProseMirror li[data-type="taskItem"], .ProseMirror li[data-checked]');
        const el = li && [...li.querySelectorAll("input,label,button,[role=checkbox]")].map((e) => e.getBoundingClientRect()).find((r) => r.width > 0);
        return el && { x: el.x + el.width / 2, y: el.y + el.height / 2 };
      });
      if (box) {
        await glide(page, box.x, box.y, 650);
        await sleep(150);
        await page.mouse.down();
        await page.mouse.up();
        await sleep(700);
      }
      await glide(page, 1150, 720, 600);
    };
  },
  whiteboard: (lang) => async (page) => {
    const t = (de, en) => (lang === "de" ? de : en);
    const who = lang === "de" ? "lena" : "alex";
    await open(page, `page=${I[who].pages.find((p) => p.kind === "whiteboard").id}`, 3000);
    await page.evaluate(() => {
      const el = [...document.querySelectorAll("*")]
        .filter((e) => e.scrollHeight - e.clientHeight > 40 && /auto|scroll/.test(getComputedStyle(e).overflowY))
        .sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
      if (el) el.scrollTo({ top: 200, behavior: "instant" });
    });
    await sleep(800);
    return async () => {
      const note = async (x, y, text) => {
        await clickOn(page, page.getByRole("button", { name: t("Notizzettel", "Sticky note"), exact: true }), 600);
        await sleep(200);
        await glide(page, x, y, 650);
        await page.mouse.down();
        await page.mouse.up();
        await sleep(300);
        await typeText(page, text, 600);
        await sleep(250);
        await page.keyboard.press("Escape");
        await page.keyboard.press("Escape");
      };
      await note(1130, 300, t("Offline-Modus", "Offline mode"));
      await sleep(300);
      await note(1130, 470, t("Vorlagen", "Templates"));
      await sleep(300);
      // Mind map: select a node, Tab adds a child.
      const node = main(page).getByText(t("Dokumentation", "Documentation"), { exact: true }).first();
      if (await node.count()) {
        await clickOn(page, node, 650);
        await sleep(350);
        await page.keyboard.press("Tab");
        await sleep(400);
        await typeText(page, "Tutorials", 500);
        await sleep(250);
        await page.keyboard.press("Escape");
        await page.keyboard.press("Escape");
      }
      await glide(page, 1180, 740, 600);
      // Long enough to read the result.
      await sleep(1800);
    };
  },
};
// Takes the whiteboard's new notes back, so the next variant starts the same.
async function undoAll(page, lang) {
  const undo = page.getByRole("button", { name: lang === "de" ? "Rückgängig" : "Undo", exact: true }).first();
  for (let i = 0; i < 20 && (await undo.isEnabled().catch(() => false)); i++) {
    await undo.click();
    await sleep(150);
  }
  await sleep(1500);
}

const MIA = {
  "board-drag": async (page) => {
    await open(page, `page=${I.db}`, 3000);
    await page.locator(".sidebar-hide").first().click();
    await tabOf(page, "Board").click();
    await sleep(2000);
    // Drags a card into a column (by its header), slowly when recorded.
    const drag = async (title, to, ms = 0) => {
      const c = await center(main(page).getByText(title, { exact: true }).first());
      const col = await center(main(page).getByText(to).first());
      if (Math.abs(c.x - col.x) < 60) return;
      await glide(page, c.x, c.y, ms || 1);
      await sleep(ms ? 200 : 50);
      await page.mouse.down();
      await glide(page, col.x + 20, col.y + 140, ms ? 1100 : 300);
      await sleep(300);
      await page.mouse.up();
      await sleep(ms ? 1200 : 1500);
    };
    // As seeded (an interrupted run may have moved them).
    await drag("Press kit", /^Planned/);
    await drag("Migration dry run", /^In progress/);
    // Until the "… moved" notices of the setup are gone.
    await page.getByText(/ moved$|verschoben$/).first().waitFor({ state: "hidden", timeout: 20_000 }).catch(() => {});
    await sleep(500);
    const act = async () => {
      await sleep(600);
      await drag("Press kit", /^In progress/, 700);
      await drag("Migration dry run", /^Done/, 700);
      await glide(page, 1100, 720, 700);
    };
    act.after = async () => {
      await drag("Press kit", /^Planned/);
      await drag("Migration dry run", /^In progress/);
    };
    return act;
  },
  timeline: async (page) => {
    await open(page, `page=${I.db}`, 3000);
    await page.locator(".sidebar-hide").first().click();
    await tabOf(page, "Timeline").click();
    await sleep(2500);
    // The bar of "Migration dry run", in the middle of the screen.
    const bar = main(page).locator("[data-row-id]").filter({ hasText: "Migration dry run" }).locator(".timeline-range").first();
    await bar.evaluate((e) => e.scrollIntoView({ block: "center" }));
    await sleep(1200);
    const move = async (dx, ms) => {
      const c = await center(bar);
      await glide(page, c.x, c.y, ms ? 800 : 1);
      await sleep(ms ? 300 : 50);
      await page.mouse.down();
      await glide(page, c.x + dx, c.y, ms || 300);
      await sleep(300);
      await page.mouse.up();
      await sleep(ms ? 2200 : 1500);
    };
    const act = async () => {
      await sleep(800);
      // A few days later: its successors follow.
      await move(90, 1600);
      await glide(page, 1100, 740, 700);
      await sleep(600);
    };
    act.after = () => move(-90, 0);
    return act;
  },
  "ai-write": async (page) => {
    await open(page, `page=${I.plan}`, 3000);
    const para = main(page).locator(".ProseMirror p").filter({ hasText: "staged rollout: the beta" }).first();
    await para.scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollBy(0, 0));
    await sleep(800);
    const act = async () => {
      await sleep(600);
      const b = await para.boundingBox();
      // Select the paragraph by dragging over it.
      await glide(page, b.x + 2, b.y + 6, 800);
      await page.mouse.down();
      await glide(page, b.x + b.width - 4, b.y + b.height - 8, 1200);
      await page.mouse.up();
      await sleep(700);
      await clickOn(page, page.locator(".text-menu-ai").first(), 600);
      await sleep(700);
      await clickOn(page, page.locator(".ai-writer-actions").getByRole("menuitem", { name: /^(Shorten|Kürzen)/ }).first(), 600);
      await sleep(6000);
      const accept = page.getByRole("button", { name: /^(Replace|Ersetzen)$/ }).first();
      await accept.waitFor({ timeout: 60_000 });
      await sleep(1200);
      await clickOn(page, accept, 700);
      await sleep(1800);
      await glide(page, 1150, 740, 700);
      await sleep(600);
    };
    // The Launch plan as before (other shots use it).
    const original = await para.innerText();
    act.after = async () => {
      const short = main(page).locator(".ProseMirror p").filter({ hasText: /^Flowplan 2\.0 (launches|startet)/ }).first();
      await short.click({ clickCount: 3 });
      await sleep(300);
      await page.keyboard.insertText(original);
      await sleep(3000);
    };
    return act;
  },
  home: async (page) => {
    await open(page, "", 3000);
    // Customize mode once, so its code is loaded (no blank frame later).
    await page.getByRole("button", { name: "Customize" }).click();
    await sleep(2500);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await sleep(1500);
    const act = async () => {
      await sleep(700);
      await clickOn(page, page.getByRole("button", { name: "Customize" }), 700);
      await sleep(1500);
      // The scratchpad one place up (before My tasks), then finish.
      const up = page.getByRole("button", { name: "Move Scratchpad up", exact: true });
      if (await up.count()) {
        await clickOn(page, up, 800);
        await sleep(1200);
      }
      await clickOn(page, page.getByRole("button", { name: "Done", exact: true }), 800);
      await sleep(1800);
      await glide(page, 1150, 740, 700);
    };
    // Back in its place (the home shots show it after My tasks).
    act.after = async () => {
      await page.getByRole("button", { name: "Customize" }).click();
      await sleep(1500);
      await page.getByRole("button", { name: "Move My tasks up", exact: true }).click();
      await sleep(800);
      await page.getByRole("button", { name: "Done", exact: true }).click();
      await sleep(2000);
    };
    return act;
  },
  notebook: async (page) => {
    await open(page, `page=${I.notebook}`, 3000);
    await page.locator(".sidebar-hide").first().click();
    await sleep(1000);
    const sheet = page.locator(".notebook-sheet").first();
    // Where the new line goes (sheet units: 595 wide; below the ramp), in view.
    const at = { x: 90, y: 100 + 20.25 * 22.5 };
    let b = await sheet.boundingBox();
    await page.locator(".notebook-scroll").evaluate((e, dy) => e.scrollBy(0, dy), b.y + at.y * (b.width / 595) - 450);
    await sleep(1200);
    let count = 0;
    const act = async () => {
      await sleep(600);
      b = await sheet.boundingBox();
      const scale = b.width / 595;
      const strokes = handwriting("4. Weight: G = m · g", { ...at, size: 19, seed: 77, color: "#1f2a44" }).strokes;
      for (const s of strokes) {
        const pts = s.points;
        await page.mouse.move(b.x + pts[0] * scale, b.y + pts[1] * scale);
        pointerAt(page, b.x + pts[0] * scale, b.y + pts[1] * scale);
        await page.mouse.down();
        for (let i = 3; i < pts.length; i += 6) await page.mouse.move(b.x + pts[i] * scale, b.y + pts[i + 1] * scale);
        await page.mouse.up();
        await sleep(40);
      }
      count = strokes.length;
      await sleep(1500);
      await glide(page, 1180, 760, 700);
      await sleep(800);
    };
    // Takes the line away again.
    act.after = async () => {
      for (let i = 0; i < count; i++) {
        await page.keyboard.press("Control+z");
        await sleep(60);
      }
      await sleep(2500);
    };
    return act;
  },
};

const NAMES = [
  ...Object.keys(MIA).map((n) => ({ name: n, who: "mia", lang: "en", dark: false, scene: MIA[n] })),
  ...Object.keys(DEMO).flatMap((s) =>
    ["de", "en"].flatMap((lang) =>
      [false, true].map((dark) => ({ name: `${s}-${lang}${dark ? "-dark" : ""}`, who: lang === "de" ? "lena" : "alex", lang, dark, scene: DEMO[s](lang), kind: s })),
    ),
  ),
];

const browser = await launch();
for (const c of NAMES) {
  if (only.length && !only.includes(c.name)) continue;
  const ctx = await context(browser, { who: c.who, lang: c.lang, dark: c.dark });
  await ctx.addInitScript(CURSOR);
  const page = await ctx.newPage();
  page.setDefaultTimeout(120_000);
  try {
    const act = await c.scene(page);
    pointerAt(page, 1100, 700);
    await page.mouse.move(1100, 700);
    await record(page, c.name, act);
    if (c.kind === "whiteboard") await undoAll(page, c.lang);
    await act.after?.();
  } catch (e) {
    console.error(c.name, e.message.split("\n")[0]);
    await page.screenshot({ path: join(DIR, "raw", `${c.name}-failed.png`) }).catch(() => {});
  }
  await ctx.close();
}
await browser.close();
