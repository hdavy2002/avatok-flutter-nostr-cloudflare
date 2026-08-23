import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { looksLikeMediaApproval } from "../src/lib/ava_group_session";

describe("public Ava media collaboration", () => {
  it("recognises natural final approvals conservatively", () => {
    for (const text of ["go ahead", "yes go ahead", "do it", "proceed", "looks perfect", "#ava approved"]) {
      expect(looksLikeMediaApproval(text), text).toBe(true);
    }
    for (const text of ["make the chorus softer", "I like it but change the ending", "what does everyone think?"]) {
      expect(looksLikeMediaApproval(text), text).toBe(false);
    }
  });

  it("shares public DM and group sessions while keeping private Ava isolated", () => {
    const route = readFileSync("src/routes/ava_thread.ts", "utf8");
    expect(route).toContain("if (!priv)");
    expect(route).toContain('conv.slice(3).split("__")');
    expect(route).toContain("looksLikeImageRequest(text)");
    expect(route).toContain("activeSession.owner_uid");
    expect(route).toContain("forceGeneral: true");
    expect(route).not.toContain('if (!priv && conv.startsWith("g_"))');
    expect(route).not.toContain("agentOf(env, ctx.uid).fetch");
  });

  it("uses one AI-led brainstorm while enforcing payer approval", () => {
    const agent = readFileSync("src/do/ava_agent.ts", "utf8");
    expect(agent).toContain("speaker && looksLikeMediaApproval(rawUserText)");
    expect(agent).toContain("only ${initiatorName} can give the final go-ahead");
    expect(agent).toContain("callSharedBrainstorm");
    expect(agent).toContain("shared_brainstorm:${conv}");
    expect(agent).toContain('capability: "shared_brainstorm"');
    expect(agent).toContain('brainstorm.creationType === "song"');
    expect(agent).not.toContain("shared_image_suggestion:");
    expect(agent).not.toContain("ava_shared_reply_deflection_blocked");
  });

  it("shows reference ingestion and routes readable audio correctly", () => {
    const agent = readFileSync("src/do/ava_agent.ts", "utf8");
    const tools = readFileSync("src/lib/composio.ts", "utf8");
    expect(agent).toContain("__AVA_REFERENCE_INGEST__");
    expect(agent).toContain("Ava is ingesting the reference…");
    expect(agent).toContain('"audio_transcribe"');
    expect(tools).toContain("ingest, brainstorm from, summarize, transcribe");
  });

  it("routes Ava conversation intelligence through Gemini on Vertex", () => {
    const agent = readFileSync("src/do/ava_agent.ts", "utf8");
    const tools = readFileSync("src/lib/composio.ts", "utf8");
    expect(agent).toContain('DEFAULT_THREAD_MODEL = "gemini-3.7-flash"');
    expect(agent).toContain('provider: r.via === "vertex" ? "google_vertex" : "google_direct"');
    expect(agent).not.toContain("openrouterAdapter.run(this.env");
    expect(tools).toContain("async function vertexStep");
    expect(tools).toContain("generateContentVia(env, model");
    expect(tools).toContain('provider: "google_vertex"');
  });
});
