# @clawnify/browser-tabs

Per-agent browser tab isolation for OpenClaw, when multiple agents share **one** browser.

By [Clawnify](https://clawnify.com).

## The problem

Run several OpenClaw agents against a single shared Chrome (one CDP endpoint) and they share one flat tab namespace. When they work at the same time they step on each other's tabs — you'll see `tab not found`, `action targetId must match request targetId`, and stale refs, because one agent's snapshot/act lands on a tab another agent just changed.

This plugin scopes the browser **per agent**: an agent may only act on tabs it opened, while all agents keep the **same shared browser profile** (so shared logins/cookies are preserved).

## What it does

Entirely at the tool-call boundary — no fork of the `browser` plugin, pure string/Map work (no `child_process`/`eval`), so it installs as a normal external plugin:

- **`before_tool_call`** — blocks a `targetId`/`tabId`/`label` that resolves to *another* agent's tab, and injects the agent's own last tab when the model omits a target on `snapshot`/`act`/`screenshot`/`console`.
- **`after_tool_call`** — records ownership when an agent opens a tab (released on close), keyed by the calling agent (`ctx.agentId`).

Ownership is keyed by the tool's **stable `tabId`** (raw DevTools targetIds change on navigation) and kept at module scope so it survives the host re-running the plugin's `register()`.

## Install

```bash
openclaw plugins install @clawnify/browser-tabs --pin
```

Then enable it in your OpenClaw config (`plugins.allow` / `plugins.entries`), with prompt-injection hooks allowed (it rewrites tool params):

```jsonc
{
  "plugins": {
    "allow": ["browser", "clawnify-browser-tabs"],
    "entries": {
      "clawnify-browser-tabs": {
        "enabled": true,
        "hooks": { "allowPromptInjection": true }
      }
    }
  }
}
```

The `browser` plugin stays enabled — this wraps it, it does not replace it.

## Config

```jsonc
{
  "enabled": true, // master switch (default true)
  "debug": false   // log each observe/enforce decision (default false)
}
```

## Scope

This delivers **action isolation** — agents can't act on each other's tabs and default onto their own. It does **not** hide foreign tabs from the `action=tabs` *list* (a plugin cannot rewrite the live tool result the model sees). Complete list-scoping belongs in the browser tool itself and is best solved upstream.

Ownership is in-memory: a full gateway restart resets it (it self-heals as agents reuse tabs).

## License

MIT.

---

Built by [Clawnify](https://clawnify.com) — managed OpenClaw AI agents for non-technical teams.
