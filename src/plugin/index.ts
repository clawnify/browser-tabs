import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

// Per-agent browser tab isolation over ONE shared Chrome (shared logins).
//
// The OpenClaw `browser` tool drives a single shared Chrome via one CDP
// endpoint, so every agent shares one flat tab namespace. When several agents
// run at once they step on each other's tabs — the live logs show `tab not
// found`, `targetId must match`, and stale refs. This plugin scopes the browser
// PER AGENT so an agent may only act on tabs it opened.
//
// Ownership is keyed by the tool's STABLE tab handle (its `tabId`, e.g. `t6`) —
// NOT the raw DevTools targetId, which Chromium replaces on navigation (the
// service migrates the tabId across that replacement, so it is durable). Any
// handle the model passes (raw targetId, tabId, or label) is resolved to that
// canonical tabId via observed results before an ownership check.
//
//   • after_tool_call (observe): map every handle → canonical tabId, and record
//     ownership of the tab an agent OPENS (sticky; released only on close).
//   • before_tool_call (enforce): block a target that resolves to ANOTHER
//     agent's tab, and inject the agent's own tab when the model omits a target.
//
// SCOPE (honest): action isolation only. It does NOT hide foreign tabs from the
// `action=tabs` LIST (a plugin can't rewrite the live tool result the model
// sees). Full list-scoping is the upstream server-side change. A VPS is one org,
// so the residual visibility is intra-tenant.
//
// No child_process / eval / dynamic code — pure string/Map work.

interface PluginConfig {
  enabled?: boolean;
  debug?: boolean;
}

const BROWSER_TOOL = "browser";
// Actions that operate on a specific tab.
const TARGET_ACTIONS = new Set(["snapshot", "act", "screenshot", "console", "close", "focus", "label"]);
// Subset we default to the agent's own tab when the model omits a target.
const DEFAULTABLE_ACTIONS = new Set(["snapshot", "act", "screenshot", "console"]);

type ObservedTab = { raw: string; tabId?: string; label?: string; suggested?: string };

/** Best-effort agent identity for scoping. */
function deriveAgent(ctx: { agentId?: string; sessionKey?: string | null }): string | undefined {
  const id = ctx.agentId?.trim();
  if (id) return id.toLowerCase();
  const key = ctx.sessionKey?.trim();
  if (key) {
    const parts = key.split(":").filter(Boolean);
    const idx = parts.indexOf("agent");
    const slug = idx >= 0 ? parts[idx + 1] : parts[0];
    if (slug) return slug.toLowerCase();
  }
  return undefined;
}

/** Recursively collect every tab-shaped object ({targetId, tabId?, label?}) in a result. */
function collectTabs(value: unknown, out: ObservedTab[] = []): ObservedTab[] {
  if (Array.isArray(value)) {
    for (const item of value) collectTabs(item, out);
    return out;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const raw = typeof obj.targetId === "string" ? obj.targetId : undefined;
    if (raw) {
      out.push({
        raw,
        tabId: typeof obj.tabId === "string" ? obj.tabId : undefined,
        label: typeof obj.label === "string" ? obj.label : undefined,
        suggested: typeof obj.suggestedTargetId === "string" ? obj.suggestedTargetId : undefined,
      });
    }
    for (const v of Object.values(obj)) collectTabs(v, out);
  }
  return out;
}

function readStr(params: Record<string, unknown>, key: string): string | undefined {
  const v = params[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

// ── MODULE-scope ownership state ────────────────────────────────────────────
// MUST live at module scope, not inside register(): OpenClaw calls a plugin's
// register() multiple times per process (on agent/config events), so per-call
// closure state would be wiped on every re-registration — silently dropping all
// tab ownership. These Maps are singletons for the process (one shared Chrome).
const canonById = new Map<string, string>(); // any handle (raw/label/tabId) -> canonical tabId
const ownerByTab = new Map<string, string>(); // canonical tabId -> agentId
const lastTabByAgent = new Map<string, string>(); // agentId -> its most-recent canonical tabId

export default definePluginEntry({
  id: "clawnify-browser-tabs",
  name: "Clawnify Browser Tabs (per-agent isolation)",
  description:
    "Scopes the shared browser to the calling agent: an agent may only act on tabs it opened, keyed by the stable tabId.",

  register(api) {
    const cfg: PluginConfig = (api.pluginConfig ?? {}) as PluginConfig;
    if (cfg.enabled === false) {
      api.logger.info("clawnify-browser-tabs disabled (config.enabled=false)");
      return;
    }
    const debug = cfg.debug === true;

    // Ownership state (canonById / ownerByTab / lastTabByAgent) is module-scoped
    // above so it survives OpenClaw's repeated register() calls in one process.

    // Canonical id for a tab = its tabId when present (durable across navigation),
    // else the raw targetId as a fallback.
    const canonOf = (tab: ObservedTab): string => tab.tabId ?? tab.raw;

    // Resolve an arbitrary handle the model passed to a canonical tabId.
    const canon = (handle: string | undefined): string | undefined =>
      handle ? canonById.get(handle) ?? handle : undefined;

    // Record every handle → canonical mapping we can see (keeps a new raw id,
    // assigned on navigation, pointing at the same stable tab).
    const learn = (tab: ObservedTab): string => {
      const cid = canonOf(tab);
      for (const h of [tab.raw, tab.tabId, tab.label, tab.suggested]) {
        if (h) canonById.set(h, cid);
      }
      return cid;
    };

    // ── Observe: learn handle mappings + assign/release ownership ─────────────
    api.on("after_tool_call", (event, ctx) => {
      if (event.toolName !== BROWSER_TOOL || event.error) return;
      const agent = deriveAgent(ctx);
      const params = (event.params ?? {}) as Record<string, unknown>;
      const action = readStr(params, "action");
      const tabs = collectTabs(event.result);
      const cids = tabs.map(learn); // always refresh mappings
      if (debug) {
        api.logger.info(
          `[browser-tabs observe] agent=${agent ?? "?"} action=${action ?? "?"} tabsInResult=${tabs.length} ownedTotal=${ownerByTab.size}`,
        );
      }
      if (!agent) return;

      // Ownership is STICKY: set only by opening a tab, released only by closing.
      if (action === "open") {
        for (const cid of cids) {
          ownerByTab.set(cid, agent);
          lastTabByAgent.set(agent, cid);
        }
      } else if (action === "close") {
        const cid = canon(readStr(params, "targetId"));
        if (cid) {
          const owner = ownerByTab.get(cid);
          ownerByTab.delete(cid);
          if (owner && lastTabByAgent.get(owner) === cid) lastTabByAgent.delete(owner);
        }
      } else if (action && TARGET_ACTIONS.has(action)) {
        // Track the agent's most-recent OWN tab for default injection (does not
        // grant ownership — only updates when the tab is already the agent's).
        const cid = canon(readStr(params, "targetId"));
        if (cid && ownerByTab.get(cid) === agent) lastTabByAgent.set(agent, cid);
      }
    });

    // ── Enforce: block foreign targets, default to the agent's own tab ────────
    api.on(
      "before_tool_call",
      (event, ctx) => {
        if (event.toolName !== BROWSER_TOOL) return;
        const agent = deriveAgent(ctx);
        if (!agent) return; // no identity → cannot scope (non-agent caller / CLI)
        const params = (event.params ?? {}) as Record<string, unknown>;
        const action = readStr(params, "action");
        if (!action) return;

        const rawHandle = readStr(params, "targetId");

        if (rawHandle && TARGET_ACTIONS.has(action)) {
          const cid = canon(rawHandle);
          const owner = cid ? ownerByTab.get(cid) : undefined;
          if (owner && owner !== agent) {
            if (debug) {
              api.logger.info(
                `[browser-tabs enforce] agent=${agent} action=${action} target=${rawHandle} (tab ${cid}) → BLOCK (owned by ${owner})`,
              );
            }
            return {
              block: true,
              blockReason:
                `Tab "${rawHandle}" belongs to another agent on this browser. ` +
                `Open your own tab (action=open) or use a tab you created — agents share one Chrome but not each other's tabs.`,
            };
          }
          if (debug) {
            api.logger.info(
              `[browser-tabs enforce] agent=${agent} action=${action} target=${rawHandle} (tab ${cid}) → allow (owner=${owner ?? "none"})`,
            );
          }
          return;
        }

        if (!rawHandle && DEFAULTABLE_ACTIONS.has(action)) {
          const own = lastTabByAgent.get(agent);
          if (own) {
            if (debug) {
              api.logger.info(
                `[browser-tabs enforce] agent=${agent} action=${action} (no target) → inject own tab ${own}`,
              );
            }
            return { params: { ...params, targetId: own } };
          }
        }
        if (debug) {
          api.logger.info(
            `[browser-tabs enforce] agent=${agent} action=${action} target=${rawHandle ?? "none"} → pass`,
          );
        }
      },
      { priority: 45 },
    );

    api.logger.info("clawnify-browser-tabs registered (per-agent browser action isolation)");
  },
});
