import { test } from "node:test";
import assert from "node:assert/strict";
import { embedFromUrl, embedProvider } from "../lib/embed-providers";
import { cleanHtml } from "../lib/document-server";

test("pasted links become the providers' player URLs", () => {
  const cases: [string, string | null][] = [
    [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10",
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
    ],
    [
      "https://youtu.be/dQw4w9WgXcQ",
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
    ],
    [
      "https://www.youtube.com/shorts/dQw4w9WgXcQ",
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
    ],
    ["https://vimeo.com/76979871", "https://player.vimeo.com/video/76979871"],
    [
      "https://www.loom.com/share/0123456789abcdef0123456789abcdef",
      "https://www.loom.com/embed/0123456789abcdef0123456789abcdef",
    ],
    [
      "https://open.spotify.com/intl-de/track/4cOdK2wGLETKBW3PvgPWqT?si=x",
      "https://open.spotify.com/embed/track/4cOdK2wGLETKBW3PvgPWqT",
    ],
    [
      "https://www.figma.com/design/AbCdEfGhIjKlMnOp/Entwurf?node-id=1",
      "https://www.figma.com/embed?embed_host=flowplan&url=https%3A%2F%2Fwww.figma.com%2Fdesign%2FAbCdEfGhIjKlMnOp",
    ],
    [
      "https://codepen.io/team/pen/abcDEF1",
      "https://codepen.io/team/embed/abcDEF1?default-tab=result",
    ],
    ["https://evil.example/watch?v=dQw4w9WgXcQ", null],
    ["javascript:alert(1)", null],
    ["https://vimeo.com/channels/staffpicks", null],
    ["https://open.spotify.com/user/abc", null],
  ];
  for (const [input, expected] of cases) {
    assert.equal(embedFromUrl(input)?.src ?? null, expected, input);
    if (expected) assert.ok(embedProvider(expected), expected);
  }
});

test("stored documents keep only provider player iframes", () => {
  const html = cleanHtml(
    [
      '<iframe src="https://player.vimeo.com/video/76979871"></iframe>',
      '<iframe src="https://player.vimeo.com/api/other"></iframe>',
      '<iframe src="https://open.spotify.com/embed/track/4cOdK2wGLETKBW3PvgPWqT"></iframe>',
      '<iframe src="https://evil.example/embed/x"></iframe>',
    ].join(""),
  );
  assert.equal((html.match(/<iframe/g) || []).length, 2);
  assert.match(html, /player\.vimeo\.com\/video\/76979871/);
  assert.match(html, /open\.spotify\.com\/embed\/track/);
  assert.doesNotMatch(html, /evil|api\/other/);
  assert.match(
    html,
    /sandbox="allow-scripts allow-same-origin allow-presentation"/,
  );
});
