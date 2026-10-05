// The number card of a dashboard: label, big number, source. In the editor
// a gear opens the settings in the card itself (database, view,
// calculation, property, label). The number is fetched from the server –
// only for people who can read the database – and refreshed every minute.
import { MetricBlock } from "@/lib/metric-node";
import { tr } from "@/lib/locale-tag";
import { serverMessage } from "@/lib/i18n-errors";

export type MetricConfig = {
  source?: string;
  view?: string;
  aggregate?: "count" | "sum" | "average" | "min" | "max";
  field?: string;
  label?: string;
};
type Source = { id: string; title: string; views: { id: string; name: string }[]; numbers: { id: string; name: string }[] };

export function parseMetric(value: string | null | undefined): MetricConfig {
  try {
    const data = JSON.parse(value || "{}");
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}
const aggregates: [NonNullable<MetricConfig["aggregate"]>, string, string][] = [
  ["count", "Anzahl Einträge", "Number of records"],
  ["sum", "Summe", "Sum"],
  ["average", "Durchschnitt", "Average"],
  ["min", "Minimum", "Minimum"],
  ["max", "Maximum", "Maximum"],
];

// Draws the card into `element`. `pageId` is the page the card is on (for
// choosing a source); `onChange` saves settings in the editor.
export function mountMetric(
  element: HTMLElement,
  initial: MetricConfig,
  options: { editable: boolean; pageId?: string; onChange?: (config: MetricConfig) => void },
) {
  let config = { ...initial };
  let sources: Source[] | null = null;
  let editing = options.editable && !config.source;
  element.classList.add("metric-block");
  element.innerHTML = "";
  const card = document.createElement("div");
  card.className = "metric-card";
  const settings = document.createElement("div");
  settings.className = "metric-settings";
  element.append(card, settings);

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  let request = 0;
  async function refresh() {
    card.innerHTML = "";
    const label = el("div", "metric-label", config.label || tr("Kennzahl", "Metric"));
    const value = el("div", "metric-value", "…");
    const caption = el("div", "metric-caption");
    card.append(label, value, caption);
    if (options.editable) {
      const gear = el("button", "metric-gear", "⚙");
      gear.type = "button";
      gear.title = tr("Kennzahl einstellen", "Configure metric");
      gear.setAttribute("aria-label", gear.title);
      gear.addEventListener("click", () => {
        editing = !editing;
        void renderSettings();
      });
      card.append(gear);
    }
    if (!config.source) {
      value.textContent = "–";
      caption.textContent = tr("Noch keine Datenbank gewählt.", "No database chosen yet.");
      return;
    }
    const id = ++request;
    try {
      const params = new URLSearchParams({ source: config.source, aggregate: config.aggregate || "count" });
      if (config.view) params.set("view", config.view);
      if (config.field) params.set("field", config.field);
      const response = await fetch(`/api/dashboard-metric?${params}`, { cache: "no-store" });
      const data = await response.json().catch(() => ({}));
      if (id !== request) return;
      if (!response.ok) {
        value.textContent = "–";
        caption.textContent =
          response.status === 401 ? tr("Nur für angemeldete Mitglieder.", "Only for signed-in members.") : serverMessage(data.error) || "";
        return;
      }
      value.textContent = data.formatted;
      caption.textContent = [data.source, data.view].filter(Boolean).join(" · ");
      const kind = aggregates.find(([k]) => k === (config.aggregate || "count"));
      if (!config.label && kind) label.textContent = tr(kind[1], kind[2]) + (data.field ? ` · ${data.field}` : "");
    } catch {
      if (id === request) value.textContent = "–";
    }
  }
  async function renderSettings() {
    settings.innerHTML = "";
    settings.hidden = !editing;
    if (!editing || !options.pageId) return;
    if (!sources) {
      settings.textContent = tr("Datenbanken werden geladen …", "Loading databases …");
      const response = await fetch(`/api/dashboard-sources?page=${options.pageId}`, { cache: "no-store" }).catch(() => null);
      sources = response?.ok ? await response.json() : [];
      settings.textContent = "";
    }
    const source = sources!.find((s) => s.id === config.source);
    const select = (labelText: string, values: [string, string][], current: string, change: (v: string) => void) => {
      const label = el("label", "metric-field");
      label.append(el("span", undefined, labelText));
      const input = el("select");
      for (const [v, text] of values) {
        const option = el("option", undefined, text);
        option.value = v;
        option.selected = v === current;
        input.append(option);
      }
      input.addEventListener("change", () => change(input.value));
      label.append(input);
      settings.append(label);
    };
    const update = (next: MetricConfig) => {
      config = next;
      options.onChange?.(config);
      void refresh();
      void renderSettings();
    };
    select(
      tr("Datenbank", "Database"),
      [["", tr("Auswählen …", "Choose …")], ...sources!.map((s): [string, string] => [s.id, s.title || tr("Ohne Titel", "Untitled")])],
      config.source || "",
      (v) => update({ ...config, source: v || undefined, view: "", field: "" }),
    );
    if (source) {
      select(
        tr("Ansicht (Filter)", "View (filters)"),
        [["", tr("Alle Einträge", "All records")], ...source.views.map((v): [string, string] => [v.id, v.name])],
        config.view || "",
        (v) => update({ ...config, view: v }),
      );
      select(
        tr("Berechnung", "Calculation"),
        aggregates.filter(([k]) => k === "count" || source.numbers.length).map(([k, de, en]) => [k, tr(de, en)]),
        config.aggregate || "count",
        (v) => update({ ...config, aggregate: v as MetricConfig["aggregate"], field: v === "count" ? "" : config.field || source.numbers[0]?.id }),
      );
      if ((config.aggregate || "count") !== "count")
        select(
          tr("Eigenschaft", "Property"),
          source.numbers.map((f): [string, string] => [f.id, f.name]),
          config.field || source.numbers[0]?.id || "",
          (v) => update({ ...config, field: v }),
        );
    }
    const label = el("label", "metric-field");
    label.append(el("span", undefined, tr("Beschriftung", "Label")));
    const input = el("input");
    input.value = config.label || "";
    input.maxLength = 80;
    input.placeholder = tr("z. B. Offene Tickets", "e.g. Open tickets");
    input.addEventListener("change", () => update({ ...config, label: input.value.trim() || undefined }));
    label.append(input);
    settings.append(label);
    const done = el("button", "metric-done", tr("Fertig", "Done"));
    done.type = "button";
    done.addEventListener("click", () => {
      editing = false;
      void renderSettings();
    });
    settings.append(done);
  }
  void refresh();
  void renderSettings();
  const timer = setInterval(() => document.visibilityState === "visible" && void refresh(), 60_000);
  return {
    update(next: MetricConfig) {
      config = { ...next };
      void refresh();
    },
    destroy() {
      clearInterval(timer);
      element.innerHTML = "";
    },
  };
}

export const MetricView = MetricBlock.extend<{ pageId: string }>({
  addOptions() {
    return { pageId: "" };
  },
  addNodeView() {
    const pageId = this.options.pageId;
    return ({ node, editor, getPos }) => {
      let current = node;
      let saved = node.attrs.metric as string;
      const dom = document.createElement("div");
      dom.contentEditable = "false";
      const handle = mountMetric(dom, parseMetric(node.attrs.metric), {
        editable: editor.isEditable,
        pageId,
        onChange: (config) => {
          const pos = typeof getPos === "function" ? getPos() : undefined;
          if (typeof pos !== "number") return;
          const at = editor.state.doc.nodeAt(pos);
          if (at?.type.name !== "metricBlock") return;
          saved = JSON.stringify(config);
          editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...at.attrs, metric: saved }));
        },
      });
      return {
        dom,
        update(next) {
          if (next.type !== current.type) return false;
          if (next.attrs.metric !== current.attrs.metric && next.attrs.metric !== saved) handle.update(parseMetric(next.attrs.metric));
          current = next;
          return true;
        },
        destroy: () => handle.destroy(),
        ignoreMutation: () => true,
        stopEvent: (event) => !(event.type === "dragstart" && (event.target as HTMLElement)?.dataset?.dragHandle !== undefined),
      };
    };
  },
});
