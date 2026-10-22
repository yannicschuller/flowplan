// A block of a block extension (lib/plugins.ts): the plugin's page in a
// sandboxed frame – scripts only, never the same origin, so it cannot read
// cookies, storage or the page around it. Everything it may do goes through
// the postMessage protocol of lib/plugin-protocol.ts: each message is
// checked for its source (this frame's window, opaque origin "null"), its
// shape and the nonce handed over at start; writing needs edit rights and
// the "write:block" permission, database queries a granted database and a
// signed-in reader (never on published pages).
import { PluginBlock } from "@/lib/plugin-node";
import { tr, PAGE_LOCALE } from "@/lib/locale-tag";
import { serverMessage } from "@/lib/i18n-errors";
import {
  PROTOCOL,
  blockText,
  clampFrameHeight,
  createNonce,
  decodeBlockData,
  encodeBlockData,
  parsePluginMessage,
  permissionError,
  pluginContext,
  trustedSource,
  type HostMessage,
} from "@/lib/plugin-protocol";

export type PluginInfo = {
  id: string;
  name: string;
  version: string;
  blocks: { type: string; label: string; icon: string; description: string; entry: string }[];
  permissions: string[];
  size: { height: number; maxHeight: number };
  settings: Record<string, unknown>;
};

// The plugins of a page's workspace, fetched once per page for a minute.
const pageCache = new Map<string, { at: number; list: Promise<PluginInfo[]> }>();
export function pagePlugins(pageId: string): Promise<PluginInfo[]> {
  const cached = pageCache.get(pageId);
  if (cached && Date.now() - cached.at < 60_000) return cached.list;
  const list = fetch(`/api/plugins?page=${encodeURIComponent(pageId)}`, { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : { plugins: [] }))
    .then((data: { plugins?: PluginInfo[] }) => data.plugins || [])
    .catch(() => [] as PluginInfo[]);
  pageCache.set(pageId, { at: Date.now(), list });
  return list;
}
async function sharedPlugin(token: string, pluginId: string): Promise<PluginInfo | null> {
  try {
    const response = await fetch(`/api/share/${encodeURIComponent(token)}/plugins/${encodeURIComponent(pluginId)}`, { cache: "no-store" });
    return response.ok ? ((await response.json()) as PluginInfo) : null;
  } catch {
    return null;
  }
}

type MountOptions = {
  pluginId: string;
  blockType: string;
  label: string;
  data: string;
  // Editors in an editable document; everyone else reads.
  editable: boolean;
  // In the app: the page the block is on. On published pages: the link token.
  pageId?: string;
  shareToken?: string;
  title?: () => string;
  selection?: () => string;
  onData?: (data: string, text: string) => void;
};

// A host message without its envelope (protocol and nonce are added).
type Outgoing = HostMessage extends infer M ? (M extends HostMessage ? Omit<M, "protocol" | "nonce"> : never) : never;
// At most this many messages per second from one frame; more are dropped.
const RATE = 60;

export function mountPluginBlock(element: HTMLElement, options: MountOptions) {
  let data = options.data || "null";
  let destroyed = false;
  let frame: HTMLIFrameElement | null = null;
  let listener: ((event: MessageEvent) => void) | null = null;
  // A fresh nonce per frame; the plugin learns it from "init".
  const nonce = createNonce();
  element.classList.add("plugin-block");
  element.replaceChildren();
  const note = (text: string) => {
    const box = document.createElement("div");
    box.className = "plugin-block-note";
    const name = document.createElement("strong");
    name.textContent = options.label || tr("Erweiterung", "Extension");
    const reason = document.createElement("span");
    reason.textContent = text;
    box.append(name, reason);
    element.replaceChildren(box);
  };
  note(tr("Wird geladen …", "Loading …"));

  void (async () => {
    const plugin = options.shareToken
      ? await sharedPlugin(options.shareToken, options.pluginId)
      : options.pageId
        ? (await pagePlugins(options.pageId)).find((p) => p.id === options.pluginId) || null
        : null;
    if (destroyed) return;
    const block = plugin?.blocks.find((b) => b.type === options.blockType);
    if (!plugin || !block) {
      note(
        options.shareToken
          ? tr("Diese Erweiterung wird auf veröffentlichten Seiten nicht gezeigt.", "This extension is not shown on published pages.")
          : tr("Diese Erweiterung ist nicht verfügbar.", "This extension is not available."),
      );
      return;
    }
    const readOnly = !options.editable;
    const isPublic = !!options.shareToken;
    const post = (message: Outgoing) =>
      frame?.contentWindow?.postMessage({ protocol: PROTOCOL, nonce, ...message }, "*");
    const reply = (id: string, result: { ok: true; result: unknown } | { ok: false; error: string }) =>
      post({ type: "response", id, ...result });
    frame = document.createElement("iframe");
    // Scripts only: no same origin, no forms, no pop-ups, no top navigation.
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.setAttribute("allow", "");
    frame.setAttribute("loading", "lazy");
    frame.title = `${plugin.name}: ${block.label}`;
    frame.className = "plugin-block-frame";
    frame.style.height = `${clampFrameHeight(plugin.size.height, plugin.size.maxHeight)}px`;
    frame.src = block.entry;
    frame.addEventListener("load", () =>
      post({ type: "init", blockType: block.type, readOnly, permissions: plugin.permissions, settings: plugin.settings }),
    );
    let windowStart = Date.now(),
      count = 0;
    listener = (event: MessageEvent) => {
      if (!frame || !trustedSource(event, frame.contentWindow)) return;
      const now = Date.now();
      if (now - windowStart > 1000) {
        windowStart = now;
        count = 0;
      }
      if (++count > RATE) return;
      const message = parsePluginMessage(event.data, nonce);
      if (!message) return;
      const denied = permissionError(message, { readOnly, public: isPublic, permissions: plugin.permissions });
      if (denied && "id" in message) return reply(message.id, { ok: false, error: denied });
      switch (message.type) {
        case "ready":
          post({ type: "data", data: decodeBlockData(data) });
          return;
        case "resize":
          frame.style.height = `${clampFrameHeight(message.height, plugin.size.maxHeight)}px`;
          return;
        case "getData":
          return reply(message.id, { ok: true, result: decodeBlockData(data) });
        case "setData": {
          let text: string;
          try {
            text = encodeBlockData(message.data);
          } catch {
            return reply(message.id, { ok: false, error: "too-large" });
          }
          data = text;
          options.onData?.(text, blockText(message.text));
          return reply(message.id, { ok: true, result: null });
        }
        case "getContext":
          return reply(message.id, {
            ok: true,
            result: pluginContext(
              {
                title: options.title?.() || "",
                theme: document.documentElement.dataset.theme === "dark" ? "dark" : "light",
                locale: PAGE_LOCALE,
                selection: options.selection?.(),
                readOnly,
                blockType: block.type,
              },
              plugin.permissions,
            ),
          });
        case "query": {
          const params = new URLSearchParams({ page: options.pageId || "", database: message.databaseId });
          if (message.limit) params.set("limit", String(message.limit));
          void fetch(`/api/plugins/${encodeURIComponent(plugin.id)}/query?${params}`, { cache: "no-store" })
            .then(async (response) => {
              const body = await response.json().catch(() => ({}));
              reply(message.id, response.ok ? { ok: true, result: body } : { ok: false, error: serverMessage(body.error) || `http-${response.status}` });
            })
            .catch(() => reply(message.id, { ok: false, error: "network" }));
          return;
        }
      }
    };
    window.addEventListener("message", listener);
    const wrapper = document.createElement("div");
    wrapper.className = "plugin-block-body";
    const caption = document.createElement("div");
    caption.className = "plugin-block-caption";
    caption.textContent = `${block.icon ? block.icon + " " : ""}${block.label} · ${plugin.name}`;
    wrapper.append(frame, caption);
    element.replaceChildren(wrapper);
  })();

  return {
    // Data changed elsewhere (another editor, undo): the frame hears it.
    update(next: string) {
      if (next === data) return;
      data = next;
      frame?.contentWindow?.postMessage({ protocol: PROTOCOL, nonce, type: "data", data: decodeBlockData(next) }, "*");
    },
    destroy() {
      destroyed = true;
      if (listener) window.removeEventListener("message", listener);
      element.replaceChildren();
    },
  };
}

// The editor's node view: changes from the frame become attribute updates.
export const PluginBlockView = PluginBlock.extend<{ pageId: string; title: () => string }>({
  addOptions() {
    return { pageId: "", title: () => "" };
  },
  addNodeView() {
    const { pageId, title } = this.options;
    return ({ node, editor, getPos }) => {
      let current = node;
      const dom = document.createElement("div");
      dom.contentEditable = "false";
      dom.dataset.plugin = node.attrs.pluginId;
      const handle = mountPluginBlock(dom, {
        pluginId: node.attrs.pluginId,
        blockType: node.attrs.blockType,
        label: node.attrs.label,
        data: node.attrs.data,
        editable: editor.isEditable,
        pageId,
        title,
        selection: () => {
          const { from, to } = editor.state.selection;
          return editor.state.doc.textBetween(from, to, " ").slice(0, 5000);
        },
        onData: (data, text) => {
          const pos = typeof getPos === "function" ? getPos() : undefined;
          if (typeof pos !== "number" || !editor.isEditable) return;
          const at = editor.state.doc.nodeAt(pos);
          if (at?.type.name !== "pluginBlock") return;
          editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...at.attrs, data, text }));
        },
      });
      return {
        dom,
        update(next) {
          if (next.type !== current.type || next.attrs.pluginId !== current.attrs.pluginId || next.attrs.blockType !== current.attrs.blockType)
            return false;
          if (next.attrs.data !== current.attrs.data) handle.update(next.attrs.data);
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
