// a2ui.ts — minimal A2UI (v0.9-style) surface builder for AvaTOK's generative
// in-chat UI. The agent (worker) composes a SURFACE: a flat map of components
// referenced by id, with a root. The Flutter A2UI renderer maps each component
// type to a Zine widget (the "catalog") and styles it with our design tokens —
// so the agent only ever picks COMPONENTS + LAYOUT, never colours/fonts.
//
// We embed one self-contained surface in the Ava message envelope (field `a2ui`)
// instead of standing up an A2A server (owner decision: worker emits A2UI
// directly). Colours are design-token NAMES (e.g. "lime", "coral") the client
// resolves to Zine.* — never raw hex.
//
// This vocabulary is deliberately generic so future Composio tools (Drive,
// Sheets, …) reuse it with zero new Flutter. Calendar is the pilot consumer.

export type Token =
  | "paper" | "paper2" | "card" | "ink" | "inkSoft" | "inkMute"
  | "blue" | "blueInk" | "lime" | "coral" | "coralMark" | "lilac" | "mint" | "mintInk";

export type TextVariant = "display" | "title" | "body" | "sub" | "tag";

// An action a button/pressable fires back to the client. Kept tiny + safe:
//  - prompt:  send `text` to Ava as a normal turn (e.g. "schedule a meeting")
//  - link:    open `url` (verified http(s) only on the client)
//  - composio: call a server action route with {route, args} (server-validated)
export type A2uiAction =
  | { type: "prompt"; text: string }
  | { type: "link"; url: string }
  | { type: "composio"; route: string; args?: Record<string, unknown> };

export type A2uiNode =
  | { type: "column"; children: string[]; gap?: number }
  | { type: "row"; children: string[]; gap?: number; align?: "start" | "center" | "between" }
  | { type: "text"; value: string; variant?: TextVariant; color?: Token; weight?: number }
  | { type: "card"; child: string; fill?: Token; pad?: number; accent?: Token }
  | { type: "pill"; label: string; icon?: string; fill?: Token; fg?: Token }
  | { type: "button"; label: string; icon?: string; fill?: Token; action?: A2uiAction; full?: boolean }
  | { type: "divider" }
  | { type: "spacer"; size: number }
  | { type: "icon"; name: string; size?: number; color?: Token }
  | { type: "eventRow"; start: string; end: string; title: string; location?: string; video?: boolean; guests?: number; accent?: Token }
  | { type: "openDay"; title: string; subtitle: string };

export interface A2uiSurface {
  version: "v0.9";
  surfaceId: string;
  root: string;
  components: Record<string, A2uiNode>;
}

// Tiny builder: accumulates components, hands back ids, assembles a surface.
export class SurfaceBuilder {
  private components: Record<string, A2uiNode> = {};
  private n = 0;
  private id(prefix: string): string { return `${prefix}_${this.n++}`; }

  add(prefix: string, node: A2uiNode): string {
    const id = this.id(prefix);
    this.components[id] = node;
    return id;
  }

  column(children: string[], gap = 8): string { return this.add("col", { type: "column", children, gap }); }
  row(children: string[], gap = 6, align: "start" | "center" | "between" = "center"): string {
    return this.add("row", { type: "row", children, gap, align });
  }
  text(value: string, variant: TextVariant = "body", color: Token = "ink"): string {
    return this.add("txt", { type: "text", value, variant, color });
  }
  pill(label: string, icon?: string, fill: Token = "paper", fg: Token = "ink"): string {
    return this.add("pill", { type: "pill", label, icon, fill, fg });
  }
  button(label: string, action: A2uiAction, opts: { icon?: string; fill?: Token; full?: boolean } = {}): string {
    return this.add("btn", { type: "button", label, action, icon: opts.icon, fill: opts.fill ?? "card", full: opts.full });
  }
  card(child: string, opts: { fill?: Token; pad?: number; accent?: Token } = {}): string {
    return this.add("card", { type: "card", child, fill: opts.fill ?? "card", pad: opts.pad, accent: opts.accent });
  }
  openDay(title: string, subtitle: string): string { return this.add("open", { type: "openDay", title, subtitle }); }
  eventRow(e: { start: string; end: string; title: string; location?: string; video?: boolean; guests?: number; accent?: Token }): string {
    return this.add("ev", { type: "eventRow", ...e });
  }
  spacer(size = 8): string { return this.add("sp", { type: "spacer", size }); }
  divider(): string { return this.add("div", { type: "divider" }); }

  build(root: string, surfaceId: string): A2uiSurface {
    return { version: "v0.9", surfaceId, root, components: this.components };
  }
}
