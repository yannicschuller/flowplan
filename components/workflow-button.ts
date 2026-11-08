// The workflow button on a page (lib/workflow-button-node.ts, docs/specs/
// workflows.md §10.8). Members who may start the workflow see a button
// (with a small form when the manual trigger has inputs); a click starts
// the active version – it runs as the workflow's runner, the clicking
// person is `startedBy` – and answers "Started", with a link to the
// workflow for its editors. Who may: the trigger decides (editors by
// default, or all members who see this page); guests and share links see
// nothing. In the editor, an unconfigured button offers the workflows of
// the workspace that have a manual trigger.
import { WorkflowButton } from "@/lib/workflow-button-node";
import { onEditableChange } from "./editor-editable";
import { tr } from "@/lib/locale-tag";
import { serverMessage } from "@/lib/i18n-errors";

type StartInfo = { pageId: string; title: string | null; status: string; nodeId: string | null; inputs: { name: string; type: string; required: boolean }[]; may: boolean; canEdit: boolean };
type MountOptions = {
  workflow: string;
  label: string;
  // The page with the button (its readers may start a `who: members` workflow).
  hostPageId?: string;
  workspaceId?: () => string;
  editable: boolean;
  shareToken?: string;
  onConfigure?: (attrs: { workflow: string; label: string }) => void;
};

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
};
async function request<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(serverMessage(String((data as { error?: string }).error || res.statusText))), { status: res.status });
  return data as T;
}

export function mountWorkflowButton(element: HTMLElement, options: MountOptions) {
  let alive = true;
  element.dataset.state = "loading";
  element.replaceChildren();
  // Published pages and share links: never.
  if (options.shareToken) {
    element.dataset.state = "hidden";
    return { destroy: () => {} };
  }
  const configure = async () => {
    const workspaceId = options.workspaceId?.() || "";
    const select = el("select", { className: "fp-select" });
    select.setAttribute("aria-label", tr("Workflow", "Workflow"));
    select.append(el("option", { value: "" }, tr("Workflow wählen …", "Choose a workflow …")));
    const label = el("input", { type: "text", value: options.label, placeholder: tr("Beschriftung", "Label"), maxLength: 80 });
    label.setAttribute("aria-label", tr("Beschriftung", "Label"));
    const save = el("button", { type: "button", className: "button compact primary" }, tr("Übernehmen", "Apply"));
    const note = el("small", { className: "wfb-note" });
    try {
      const { workflows } = await request<{ workflows: { pageId: string; title: string; manual: boolean; status: string }[] }>(`/api/workflows?workspaceId=${encodeURIComponent(workspaceId)}`);
      const startable = workflows.filter((w) => w.manual);
      for (const w of startable) select.append(el("option", { value: w.pageId, selected: w.pageId === options.workflow }, w.title || tr("Ohne Titel", "Untitled")));
      if (!startable.length) note.textContent = tr("Kein aktiver Workflow mit dem Auslöser „Manuell starten“.", "No active workflow with the trigger “Start manually”.");
    } catch (e) {
      note.textContent = (e as Error).message;
    }
    save.onclick = () => {
      if (!select.value) return;
      options.onConfigure?.({ workflow: select.value, label: label.value.trim() || select.selectedOptions[0]?.textContent || "" });
    };
    if (!alive) return;
    element.dataset.state = "config";
    element.replaceChildren(el("div", { className: "wfb-config" }, select, label, save, note));
  };
  const show = async () => {
    if (!options.workflow) {
      if (options.editable) await configure();
      else element.dataset.state = "hidden";
      return;
    }
    let info: StartInfo;
    try {
      info = await request<StartInfo>(`/api/workflows/${options.workflow}/start${options.hostPageId ? `?host=${options.hostPageId}` : ""}`);
    } catch {
      if (!alive) return;
      // Not there (deleted, not visible, a guest): editors of the page can choose again.
      if (options.editable) await configure();
      else element.dataset.state = "hidden";
      return;
    }
    if (!alive) return;
    const text = options.label || info.title || tr("Workflow starten", "Start the workflow");
    const button = el("button", { type: "button", className: "button primary wfb-start" }, text);
    const status = el("span", { className: "wfb-note" });
    status.setAttribute("role", "status");
    const fields = info.inputs.map((f) => {
      const input = el("input", { type: f.type === "number" ? "number" : f.type === "date" ? "date" : f.type === "boolean" ? "checkbox" : "text", required: f.required, name: f.name });
      input.setAttribute("aria-label", f.name + (f.required ? " *" : ""));
      if (f.type !== "boolean") input.placeholder = f.name + (f.required ? " *" : "");
      return input;
    });
    if (info.status !== "active") {
      button.disabled = true;
      status.textContent = tr("Der Workflow ist nicht aktiv.", "The workflow is not active.");
    } else if (!info.may) {
      button.disabled = true;
      status.textContent = tr("Nur Bearbeitende des Workflows können ihn starten.", "Only editors of the workflow can start it.");
    }
    button.onclick = async () => {
      const inputs: Record<string, unknown> = {};
      for (const input of fields) {
        if (input.required && !input.value && input.type !== "checkbox") {
          input.focus();
          status.textContent = tr(`„${input.name}“ fehlt.`, `“${input.name}” is missing.`);
          return;
        }
        if (input.type === "checkbox") inputs[input.name] = input.checked;
        else if (input.value) inputs[input.name] = input.value;
      }
      button.disabled = true;
      status.textContent = tr("Startet …", "Starting …");
      try {
        await request("/api/command", { action: "workflow.run", pageId: info.pageId, inputs, source: "block", host: options.hostPageId });
        status.replaceChildren(tr("Gestartet.", "Started."));
        if (info.canEdit) {
          const runs = el("button", { type: "button", className: "text-button" }, tr("Läufe ansehen", "View the runs"));
          runs.onclick = () => (window.location.hash = `page=${info.pageId}`);
          status.append(" ", runs);
        }
        for (const input of fields) if (input.type !== "checkbox") input.value = "";
      } catch (e) {
        status.textContent = (e as Error).message;
      } finally {
        button.disabled = false;
      }
    };
    element.dataset.state = "ready";
    const row = el("div", { className: "wfb-form" }, ...fields, button);
    if (options.editable && info.canEdit) {
      const change = el("button", { type: "button", className: "text-button wfb-change" }, tr("Ändern", "Change"));
      change.onclick = () => void configure();
      row.append(change);
    }
    element.replaceChildren(row, status);
  };
  void show();
  return {
    destroy: () => {
      alive = false;
      element.replaceChildren();
    },
  };
}

// The editor's node view: choosing a workflow becomes the node's attributes.
export const WorkflowButtonView = WorkflowButton.extend<{ pageId: string; workspaceId: () => string }>({
  addOptions() {
    return { pageId: "", workspaceId: () => "" };
  },
  addNodeView() {
    const { pageId, workspaceId } = this.options;
    return ({ node, editor, getPos }) => {
      let current = node;
      const dom = document.createElement("div");
      dom.className = "workflow-button-block";
      dom.contentEditable = "false";
      const mount = () =>
        mountWorkflowButton(dom, {
          workflow: current.attrs.workflow,
          label: current.attrs.label,
          hostPageId: pageId,
          workspaceId,
          editable: editor.isEditable,
          onConfigure: (attrs) => {
            const pos = typeof getPos === "function" ? getPos() : undefined;
            if (typeof pos !== "number" || !editor.isEditable) return;
            editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, ...attrs }));
          },
        });
      let handle = mount();
      const unsubscribe = onEditableChange(editor, () => {
        handle.destroy();
        handle = mount();
      });
      return {
        dom,
        update(next) {
          if (next.type !== current.type) return false;
          const changed = next.attrs.workflow !== current.attrs.workflow || next.attrs.label !== current.attrs.label;
          current = next;
          if (changed) {
            handle.destroy();
            handle = mount();
          }
          return true;
        },
        destroy: () => {
          unsubscribe();
          handle.destroy();
        },
        ignoreMutation: () => true,
        stopEvent: (event) => !(event.type === "dragstart" && (event.target as HTMLElement)?.dataset?.dragHandle !== undefined),
      };
    };
  },
});
