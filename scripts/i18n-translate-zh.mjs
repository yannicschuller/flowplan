#!/usr/bin/env node
// Machine-translates the English catalogue (locales/en.json) into
// locales/zh.json via Microsoft's public translator endpoint (no API key).
//
//   node scripts/i18n-translate-zh.mjs               translate what is missing
//   node scripts/i18n-translate-zh.mjs --force       retranslate everything
//   node scripts/i18n-translate-zh.mjs --limit 200   stop after N new strings
//   CONCURRENCY=8 node scripts/…                     parallel requests (default 8)
//
// Progress is kept in .i18n-zh-progress.json (resumable). A string whose
// placeholders ({0}, {1} …) do not survive is retried alone and otherwise kept
// in English, so `npm run i18n -- --check` still reports it as missing.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;
const en = JSON.parse(readFileSync(`${root}locales/en.json`, "utf8"));
const progressPath = `${root}.i18n-zh-progress.json`;
const outPath = `${root}locales/zh.json`;

const args = process.argv.slice(2);
const force = args.includes("--force");
const limit = args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) : Infinity;
const concurrency = Number(process.env.CONCURRENCY || 8);

const done = existsSync(progressPath) ? JSON.parse(readFileSync(progressPath, "utf8")) : {};
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- token -----------------------------------------------------------------
let session = null;
let pending = null;
async function token() {
  if (session && Date.now() < session.expires - 60_000) return session;
  if (pending) return pending;
  pending = (async () => {
    const html = await (
      await fetch("https://cn.bing.com/translator", {
        headers: { "user-agent": UA, "accept-language": "en-US,en;q=0.9" },
      })
    ).text();
    const ig = html.match(/IG:"([A-Fa-f0-9]+)"/)?.[1];
    const abuse = html.match(/params_AbusePreventionHelper\s*=\s*\[(\d+),"([^"]+)",(\d+)\]/);
    if (!ig || !abuse) throw new Error("could not read the translator token");
    session = { ig, key: abuse[1], token: abuse[2], expires: Date.now() + Number(abuse[3]) };
    return session;
  })().finally(() => (pending = null));
  return pending;
}

let iid = 0;
let backoffUntil = 0;
async function translate(text) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const wait = backoffUntil - Date.now();
    if (wait > 0) await sleep(wait);
    try {
      const s = await token();
      const body = new URLSearchParams({ fromLang: "en", to: "zh-Hans", text });
      body.append("token", s.token);
      body.append("key", s.key);
      const res = await fetch(
        `https://cn.bing.com/ttranslatev3?isVertical=1&&IG=${s.ig}&IID=translator.5028.${++iid}`,
        {
          method: "POST",
          headers: {
            "user-agent": UA,
            "content-type": "application/x-www-form-urlencoded",
            referer: "https://cn.bing.com/translator",
          },
          body,
        },
      );
      if (res.status === 429 || res.status === 401 || res.status === 403) {
        session = null;
        backoffUntil = Date.now() + 2000 * (attempt + 1);
        await sleep(1000 * (attempt + 1));
        continue;
      }
      const json = await res.json();
      const value = json?.[0]?.translations?.[0]?.text;
      if (typeof value !== "string" || !value) throw new Error(JSON.stringify(json).slice(0, 160));
      return value;
    } catch (e) {
      session = null;
      await sleep(600 * (attempt + 1));
      if (attempt === 4) return null;
    }
  }
  return null;
}

// ---- HTML-safe: translate text nodes, keep the tags ------------------------
const TAG = /<\/?[a-zA-Z][^>]*>/g;
const placeholders = (s) => (s.match(/\{\d+\}/g) || []).sort().join(",");

async function translateSource(source) {
  if (!source.includes("<")) {
    const value = await translate(source);
    if (!value || placeholders(source) !== placeholders(value)) return null;
    return value;
  }
  const parts = [];
  let last = 0;
  for (const m of source.matchAll(TAG)) {
    if (m.index > last) parts.push({ text: source.slice(last, m.index), tag: false });
    parts.push({ text: m[0], tag: true });
    last = m.index + m[0].length;
  }
  if (last < source.length) parts.push({ text: source.slice(last), tag: false });
  for (const part of parts) {
    if (part.tag || !/\p{L}/u.test(part.text)) continue;
    const value = await translate(part.text);
    if (!value) return null;
    part.text = value;
  }
  return parts.map((p) => p.text).join("");
}

// ---- queue -----------------------------------------------------------------
const skippable = (s) => !/\p{L}/u.test(s) || /^https?:\/\//.test(s);
const queue = Object.keys(en).filter((key) => {
  const source = key.split("||")[0];
  if (skippable(source)) return false;
  if (!force && done[key] && done[key] !== "!FAILED") return false;
  return true;
});

let translated = 0;
let failed = 0;
let cursor = 0;
const started = Date.now();

function flush() {
  const catalogue = Object.fromEntries(
    Object.keys(en)
      .sort((a, b) => a.localeCompare(b, "en"))
      .map((k) => [k, done[k] && done[k] !== "!FAILED" ? done[k] : ""]),
  );
  writeFileSync(outPath, `${JSON.stringify(catalogue, null, 2)}\n`);
  writeFileSync(progressPath, `${JSON.stringify(done, null, 2)}\n`);
}

async function worker() {
  while (cursor < queue.length) {
    if (translated >= limit) return;
    const key = queue[cursor++];
    const source = key.split("||")[0];
    let value = await translateSource(source);
    if (value === null) value = await translateSource(source); // one retry
    if (value) {
      done[key] = value;
      translated++;
    } else {
      done[key] = "!FAILED";
      failed++;
    }
  }
}

const ticker = setInterval(() => {
  flush();
  const seconds = (Date.now() - started) / 1000;
  const rate = translated / Math.max(seconds, 1);
  const left = queue.length - cursor;
  process.stdout.write(
    `\r${translated} 已翻译 · ${failed} 失败 · ${left} 剩余 · ${rate.toFixed(1)}/s · ${Math.round(left / Math.max(rate, 0.01))}s   `,
  );
}, 3000);

await Promise.all(Array.from({ length: concurrency }, worker));
clearInterval(ticker);
flush();
console.log(`\n完成：${translated} 已翻译，${failed} 失败，${queue.length - cursor} 未处理`);
