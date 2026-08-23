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

  it("blocks guest spending by server rule and names the initiator", () => {
    const agent = readFileSync("src/do/ava_agent.ts", "utf8");
    expect(agent).toContain("speaker && looksLikeMediaApproval(rawUserText)");
    expect(agent).toContain("only ${initiatorName} can give the final go-ahead");
    expect(agent).toContain("shared_image_suggestion:");
    expect(agent).toContain("PUBLIC SHARED AVA TURN");
    expect(agent).toContain("Never say you will remind or relay this to the other person");
    expect(agent).toContain("ava_shared_reply_deflection_blocked");
    expect(agent).toContain('&& !publicShared');
  });

  it("shows reference ingestion and routes readable audio correctly", () => {
    const agent = readFileSync("src/do/ava_agent.ts", "utf8");
    const tools = readFileSync("src/lib/composio.ts", "utf8");
    expect(agent).toContain("__AVA_REFERENCE_INGEST__");
    expect(agent).toContain("Ava is ingesting the reference…");
    expect(agent).toContain('"audio_transcribe"');
    expect(tools).toContain("ingest, brainstorm from, summarize, transcribe");
  });
});
