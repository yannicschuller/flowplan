// KaTeX (lib/math-render.ts, 75 KB gzip) is loaded when a formula shows,
// not with every document: until it is there a formula shows as its
// LaTeX source and is set as soon as KaTeX arrived.
export const MAX_MATH_LENGTH = 10000;
type MathRender = typeof import("./math-render");
let loaded: MathRender | null = null;
let loading: Promise<MathRender> | null = null;

export function loadMath(): Promise<MathRender> {
  loading ??= import("./math-render").then((m) => (loaded = m));
  loading.catch(() => (loading = null));
  return loading;
}
// KaTeX if it is there already (synchronous callers).
export const mathLoaded = () => loaded;

// Sets a formula into an element (its `data-math` names the expression):
// right away with KaTeX loaded, otherwise once it is – unless the element
// shows another formula by then.
export function renderMathInto(element: HTMLElement, expression: string, inline: boolean) {
  if (loaded) {
    element.innerHTML = loaded.renderMath(expression, inline);
    return;
  }
  element.textContent = expression;
  void loadMath()
    .then((m) => {
      if ((element.dataset.math ?? expression) === expression) element.innerHTML = m.renderMath(expression, inline);
    })
    .catch(() => {});
}
