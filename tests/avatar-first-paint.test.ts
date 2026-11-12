import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Avatar, setAvatarDirectory } from "../components/ui";

// Profile pictures on reload (components/ui.tsx Avatar): the server renders
// the app, so whatever the HTML says is the first paint until hydration.

const id = "0b4e4a7e-5d2c-4c33-9a43-1d3c2f5b8a10";

test("the server-rendered profile picture is visible from the first paint", () => {
  setAvatarDirectory([{ id, name: "Alex Demo", avatar: "abc123" }]);
  const sidebar = renderToStaticMarkup(createElement(Avatar, { name: "Alex Demo", userId: id, eager: true }));
  assert.match(sidebar, /class="avatar +has-picture"/);
  assert.match(sidebar, new RegExp(`<img src="/api/avatars/${id}\\?v=abc123"`));
  // Not hidden until hydration (it used to be .fp-fade, opacity 0, and the
  // circle stayed empty until the scripts ran even with the picture cached).
  assert.doesNotMatch(sidebar, /fp-fade/);
  // The account in the sidebar is always in view: loaded with the page.
  assert.match(sidebar, /loading="eager"/);
  // Lists keep loading lazily.
  const list = renderToStaticMarkup(createElement(Avatar, { name: "Alex Demo", userId: id, small: true }));
  assert.match(list, /loading="lazy"/);
  assert.doesNotMatch(list, /fp-fade/);
  setAvatarDirectory([]);
});

test("a picture fills the whole circle, the placeholder lies in the same box", () => {
  const css = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");
  const rule = (selector: string) => {
    const at = css.indexOf(`\n${selector} {`);
    assert.ok(at >= 0, selector);
    return { at, body: css.slice(at, css.indexOf("}", at)) };
  };
  const frame = rule(".avatar.has-picture");
  const img = rule(".avatar.has-picture img");
  // No hairline border inset: it left a ring of the pastel colour around
  // the picture, and the blurred placeholder (painted under the border)
  // and the picture had different boxes.
  assert.match(frame.body, /border-width: 0;/);
  assert.match(frame.body, /background-origin: padding-box;/);
  assert.match(frame.body, /background-clip: padding-box;/);
  assert.match(img.body, /object-fit: cover;/);
  assert.match(img.body, /width: 100%;/);
  assert.match(img.body, /height: 100%;/);
  // Next to .avatar, before the rings that separate overlapping avatars,
  // which keep their border.
  assert.ok(frame.at > rule(".avatar").at);
  assert.ok(frame.at < rule(".presence .avatar").at);
});
