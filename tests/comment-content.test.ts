import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeCommentContent,
  commentText,
  safeCommentLink,
  plainCommentContent,
  commentMentions,
  type CommentNode,
} from "../lib/comment-content";
const uid = "11111111-1111-4111-8111-111111111111";
test("rich comments validate formats, literal text, lists, links and bounded canonical attributes", () => {
  const content = normalizeCommentContent({
    type: "doc",
    attrs: { onclick: "evil" },
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "<script>alert(1)</script>",
            marks: [
              { type: "bold", attrs: { onclick: "evil" } },
              {
                type: "link",
                attrs: { href: "https://example.test", onclick: "evil" },
              },
            ],
          },
          { type: "hardBreak" },
          {
            type: "mention",
            attrs: { userId: uid, label: "Reader", onclick: "evil" },
          },
        ],
      },
      {
        type: "orderedList",
        attrs: { start: 3, type: "I" },
        content: [
          {
            type: "listItem",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "Task" }] },
            ],
          },
        ],
      },
      { type: "codeBlock", content: [{ type: "text", text: "const a = 1;" }] },
    ],
  });
  assert.equal(
    commentText(content),
    "<script>alert(1)</script>\n@Reader\nTask\nconst a = 1;",
  );
  assert.deepEqual(commentMentions(content), [uid]);
  assert.doesNotMatch(JSON.stringify(content), /onclick|evil/);
  assert.equal(content.content![1].attrs?.start, 3);
  assert.deepEqual(normalizeCommentContent(content), content);
  assert.equal(commentText(plainCommentContent("A\n\nB")), "A\n\nB");
  for (const link of [
    "javascript:alert(1)",
    "data:text/html,evil",
    "//evil.test",
    "https://user:pass@example.test",
    "https://example.test\n.evil",
    "/#page=bad",
  ])
    assert.equal(safeCommentLink(link), false);
  for (const link of [
    "https://example.test/path?q=hello",
    "http://localhost/test",
    "mailto:hello@example.test",
    `/#page=${uid}`,
  ])
    assert.equal(safeCommentLink(link), true);
});
test("rich comment limits reject oversized, malformed, unsupported and executable structures", () => {
  const invalid: unknown[] = [
    { type: "doc", content: [{ type: "image", attrs: { src: "x" } }] },
    { type: "doc", content: [{ type: "text", text: "wrong nesting" }] },
    { type: "doc", content: [{ type: "bulletList", content: [] }] },
    {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "X",
              marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }],
            },
          ],
        },
      ],
    },
    plainCommentContent("a".repeat(5001)),
  ];
  let deep: CommentNode = { type: "paragraph", content: [] };
  for (let i = 0; i < 14; i++) deep = { type: "blockquote", content: [deep] };
  invalid.push({ type: "doc", content: [deep] });
  for (const input of invalid)
    assert.throws(() => normalizeCommentContent(input));
  assert.equal(
    commentText(normalizeCommentContent(plainCommentContent("a".repeat(5000))))
      .length,
    5000,
  );
});
