import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Ava thread route telemetry", () => {
  const source = readFileSync("src/routes/ava_thread.ts", "utf8");

  it("records route validation, acceptance, and dispatch outcomes without conversation or message contents", () => {
    expect(source).toContain('"ava_thread_route_rejected"');
    expect(source).toContain('"ava_thread_route_accepted"');
    expect(source).toContain('"ava_thread_route_dispatch_result"');
    expect(source).toContain("conv_kind: conv.startsWith(\"g_\")");
    expect(source).toContain("text_len: text.length");
    const routePropsStart = source.indexOf("const routeProps = {");
    const routePropsEnd = source.indexOf("const byoKey", routePropsStart);
    const routeProps = source.slice(routePropsStart, routePropsEnd);
    expect(routeProps).not.toContain("conv:");
    expect(routeProps).not.toContain("text:");
  });

  it("makes route telemetry explicitly best-effort", () => {
    expect(source).toContain("execCtx.waitUntil");
    expect(source).toContain("try { await trackUser(env, uid, email, event, \"avaai\", props); } catch");
    expect(source).toContain("try { await track(env, \"anonymous\", event, \"avaai\", props); } catch");
  });
});
