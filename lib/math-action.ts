// The result a calculation offers (lib/math-solve.ts), without mathjs: the
// text menu shows it, mathjs itself loads when a calculation is asked for.
export function mathActionResult(action: { text: string }) {
  return action.text.replace(/^[=⇒]\s*/, "");
}
