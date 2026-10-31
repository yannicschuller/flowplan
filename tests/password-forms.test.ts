// Credentials never end up in an address (#62): a form whose script did not
// load submits natively, and without method="post" that is a GET with the
// password in the URL – in browser history, proxy and server logs. Every
// <form> with a password field in the app's components therefore says
// method="post" and names an action that never handles the password.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parse } from "@babel/parser";

const root = join(import.meta.dirname, "..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : sources(path);
    return /\.tsx$/.test(name) ? [path] : [];
  });
}

type Node = { type: string; loc?: { start: { line: number } }; start?: number; end?: number; [key: string]: unknown };
type Attribute = { type: string; name?: { name?: string }; value?: Node | null };
const tagName = (node: Node) => ((node.name as { name?: string } | undefined)?.name ?? "") as string;
const attribute = (opening: Node, name: string) =>
  (opening.attributes as Attribute[]).find((a) => a.type === "JSXAttribute" && a.name?.name === name);

// Every <form> in the source that contains a password input: type="password"
// or an expression that can be "password" (type={show ? "text" : "password"}).
function passwordForms(file: string, text = readFileSync(file, "utf8")) {
  const ast = parse(text, { sourceType: "module", plugins: ["jsx", "typescript"], errorRecovery: true }) as unknown as Node;
  const found: { line: number; post: boolean; action: boolean }[] = [];
  const isPasswordInput = (opening: Node) => {
    const value = tagName(opening) === "input" ? attribute(opening, "type")?.value : null;
    return !!value && /["'`]password["'`]/.test(text.slice(value.start, value.end));
  };
  const visit = (node: unknown, form: Node | null): void => {
    if (Array.isArray(node)) return node.forEach((child) => visit(child, form));
    if (!node || typeof node !== "object" || typeof (node as Node).type !== "string") return;
    const current = node as Node;
    let inside = form;
    if (current.type === "JSXElement") {
      const opening = current.openingElement as Node;
      if (tagName(opening) === "form") inside = opening;
      else if (form && isPasswordInput(opening)) {
        const line = form.loc!.start.line;
        const method = attribute(form, "method")?.value;
        const post = method?.type === "StringLiteral" && String(method.value).toLowerCase() === "post";
        if (!found.some((f) => f.line === line)) found.push({ line, post, action: !!attribute(form, "action") });
      }
    }
    for (const [key, child] of Object.entries(current))
      if (key !== "loc" && key !== "leadingComments" && key !== "trailingComments") visit(child, inside);
  };
  visit(ast, null);
  return found;
}

test("every form with a password field posts, never a GET with the password in the URL", () => {
  const files = [...sources(join(root, "components")), ...sources(join(root, "app"))];
  const forms = files.flatMap((file) => passwordForms(file).map((form) => ({ ...form, file: relative(root, file) })));
  // The scan finds the sign-in, registration and reset forms at least.
  for (const known of ["components/login.tsx", "components/reset-password.tsx"])
    assert.ok(forms.some((f) => f.file === known), `no password form found in ${known}`);
  const wrong = forms.filter((f) => !f.post || !f.action).map((f) => `${f.file}:${f.line}`);
  assert.deepEqual(wrong, [], 'forms with a password field need method="post" and an action');
});

test("the scan recognises password fields and the method", () => {
  const sample = `
    const a = <form onSubmit={submit}><label>Password <input name="p" type="password" /></label></form>;
    const b = <form method="post" action="/api/auth/no-script" onSubmit={submit}><input type={show ? "text" : "password"} /></form>;
    const c = <form method="get" action="/x"><div><input type='password'></input></div></form>;
    const d = <form><input type="text" name="q" /></form>;
    const e = <input type="password" />;
  `;
  assert.deepEqual(
    passwordForms("sample.tsx", sample).map((f) => [f.post, f.action]),
    [
      [false, false],
      [true, true],
      [false, true],
    ],
  );
});
