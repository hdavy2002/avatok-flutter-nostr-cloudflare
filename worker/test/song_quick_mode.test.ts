// [SONG-QUICK-1 2026-08-17] The engine-written "quick song": the person
// describes a song, the MUSIC ENGINE writes the words and sings them. No lyric
// draft, no approval step.
//
// Everything asserted here is a PURE function, so the rules that decide (a)
// which model can perform the request and (b) whether a paid generation may run
// are testable without a Durable Object, a provider, or a wallet.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  musicRetryModel,
  resolveMusicModel,
  validateMusicModeRequest,
} from "../src/lib/vertex_media";
import {
  classifySongRequest,
  isQuickSongContextReady,
  isSongProductionContextReady,
  isSongFlowState,
  looksLikeQuickSongRequest,
  songProductionBrief,
  withEngineWrittenSong,
  type SongFlowState,
  type SongProductionContext,
} from "../src/lib/song_flow";
import { parseSongInterviewTurn } from "../src/lib/song_interview";

const DEFAULT_MUSIC_MODEL = "minimax-music-v26";

describe("quick song — provider routing", () => {
  it("routes an engine-written song to the configured quick model, ignoring the long-song ladder", () => {
    expect(resolveMusicModel({
      musicMode: "engine_written", durationSeconds: 60,
      defaultModel: DEFAULT_MUSIC_MODEL, longModel: "ace-step-15", quickModel: "elevenlabs-music",
    })).toBe("elevenlabs-music");
    // Length is irrelevant to the choice: the quick model owns the whole mode.
    expect(resolveMusicModel({
      musicMode: "engine_written", durationSeconds: 180,
      defaultModel: DEFAULT_MUSIC_MODEL, longModel: "", quickModel: "elevenlabs-music",
    })).toBe("elevenlabs-music");
  });

  it("falls back to the default model when no quick model is configured", () => {
    expect(resolveMusicModel({
      musicMode: "engine_written", durationSeconds: 90,
      defaultModel: DEFAULT_MUSIC_MODEL, longModel: "ace-step-15", quickModel: "   ",
    })).toBe(DEFAULT_MUSIC_MODEL);
  });

  it("leaves the existing vocal and instrumental routing untouched", () => {
    // A vocal song may only use a long model that accepts lyrics — the
    // [SONG-FALLBACK-1] rule that elevenlabs-music violates.
    expect(resolveMusicModel({
      musicMode: "vocal", durationSeconds: 180,
      defaultModel: DEFAULT_MUSIC_MODEL, longModel: "elevenlabs-music", quickModel: "elevenlabs-music",
    })).toBe(DEFAULT_MUSIC_MODEL);
    expect(resolveMusicModel({
      musicMode: "vocal", durationSeconds: 180,
      defaultModel: DEFAULT_MUSIC_MODEL, longModel: "ace-step-15", quickModel: "elevenlabs-music",
    })).toBe("ace-step-15");
    expect(resolveMusicModel({
      musicMode: "instrumental", durationSeconds: 180,
      defaultModel: DEFAULT_MUSIC_MODEL, longModel: "elevenlabs-music", quickModel: "elevenlabs-music",
    })).toBe("elevenlabs-music");
    expect(resolveMusicModel({
      musicMode: "vocal", durationSeconds: 90,
      defaultModel: DEFAULT_MUSIC_MODEL, longModel: "ace-step-15", quickModel: "elevenlabs-music",
    })).toBe(DEFAULT_MUSIC_MODEL);
  });

  it("retries an engine-written song on its own model, never on a lyrics-expecting default", () => {
    expect(musicRetryModel("engine_written", "elevenlabs-music", DEFAULT_MUSIC_MODEL)).toBe("elevenlabs-music");
    expect(musicRetryModel("vocal", "ace-step-15", DEFAULT_MUSIC_MODEL)).toBe(DEFAULT_MUSIC_MODEL);
    expect(musicRetryModel("instrumental", "ace-step-15", DEFAULT_MUSIC_MODEL)).toBe(DEFAULT_MUSIC_MODEL);
  });
});

describe("quick song — lyric contract per mode", () => {
  it("refuses approved lyrics in engine-written mode, because the engine writes them", () => {
    const rejected = validateMusicModeRequest("engine_written", "[Verse 1] anything");
    expect(rejected.ok).toBe(false);
    expect(validateMusicModeRequest("engine_written", "")).toEqual({ ok: true });
  });

  it("keeps the pre-existing vocal and instrumental rules", () => {
    expect(validateMusicModeRequest("vocal", "").ok).toBe(false);
    expect(validateMusicModeRequest("vocal", "[Verse 1] la").ok).toBe(true);
    expect(validateMusicModeRequest("instrumental", "[Verse 1] la").ok).toBe(false);
    expect(validateMusicModeRequest("instrumental", "").ok).toBe(true);
  });
});

describe("quick song — readiness and trigger", () => {
  const quickContext: SongProductionContext = {
    theme: "my sister leaving for college",
    durationSeconds: 90,
  };

  it("needs only a subject and a length — the interview it exists to skip is not required", () => {
    expect(isQuickSongContextReady(quickContext)).toBe(true);
    expect(isSongProductionContextReady(quickContext, "engine_written")).toBe(true);
    // The same context is NOT enough for a drafted-and-approved vocal song.
    expect(isSongProductionContextReady(quickContext, "vocal")).toBe(false);
  });

  it("still refuses a quick song with nothing to be about, or with no length", () => {
    expect(isQuickSongContextReady(undefined)).toBe(false);
    expect(isQuickSongContextReady({ durationSeconds: 90 })).toBe(false);
    expect(isQuickSongContextReady({ theme: "rain" })).toBe(false);
    expect(isQuickSongContextReady({ theme: "rain", durationSeconds: 30 })).toBe(false);
  });

  it("recognises the ways a person asks to skip writing and approving lyrics", () => {
    for (const text of [
      "just make it, I don't want to write anything — a song about rain",
      "make me a quick song about my dog",
      "surprise me with a song about Goa",
      "write a song about my mum, you write the words",
      "make a song about the monsoon, no approval needed",
      "@ava make a song about cricket and skip the lyrics step",
    ]) {
      expect(looksLikeQuickSongRequest(text), text).toBe(true);
      expect(classifySongRequest(text), text).toBe("engine_written");
    }
  });

  it("does not steal an ordinary song request, an instrumental, or idle chat", () => {
    expect(looksLikeQuickSongRequest("make me a reggae song about Gen Z")).toBe(false);
    expect(classifySongRequest("make me a reggae song about Gen Z")).toBe("vocal");
    // "just make it" plus an explicit no-vocals ask is still an instrumental.
    expect(looksLikeQuickSongRequest("just make it, an instrumental beat, no vocals")).toBe(false);
    expect(classifySongRequest("just make it, an instrumental beat, no vocals")).toBe("instrumental");
    expect(looksLikeQuickSongRequest("surprise me with dinner")).toBe(false);
    expect(classifySongRequest("surprise me with dinner")).toBeNull();
  });

  it("accepts quick_generate as an interview action and still ignores invented ones", () => {
    const turn = parseSongInterviewTurn(JSON.stringify({
      action: "quick_generate",
      reply: "I'll let the engine write and sing this one.",
      context: { theme: "monsoon in Kochi", durationSeconds: 90 },
    }));
    expect(turn.action).toBe("quick_generate");
    expect(isQuickSongContextReady(turn.context)).toBe(true);
    const bogus = parseSongInterviewTurn(JSON.stringify({
      action: "charge_the_wallet", reply: "hi", context: {},
    }));
    expect(bogus.action).toBe("discuss");
  });
});

describe("quick song — flow promotion", () => {
  it("rebuilds the brief so the engine is ASKED for sung words, and drops any draft", () => {
    const flow: SongFlowState = {
      phase: "reviewing", kind: "vocal", durationSeconds: 60,
      lyrics: "[Verse 1] words nobody approved",
      brief: "Language: English",
      context: { theme: "leaving home", genre: "indie folk", language: "English", durationSeconds: 60 },
    };
    const quick = withEngineWrittenSong(flow, { ...flow.context, durationSeconds: 120 });
    expect(quick.kind).toBe("engine_written");
    expect(quick.phase).toBe("generating");
    expect(quick.lyrics).toBeUndefined();
    expect(quick.durationSeconds).toBe(120);
    expect(quick.brief).toContain("Write and sing original lyrics");
    expect(quick.brief).toContain("in English");
    expect(quick.brief).not.toContain("No lyrics or vocals.");
    expect(isSongFlowState(quick)).toBe(true);
  });

  it("keeps the instrumental brief explicitly wordless", () => {
    const brief = songProductionBrief(
      { theme: "study focus", genre: "lo-fi", mood: "calm", durationSeconds: 90 }, "instrumental",
    );
    expect(brief).toContain("No lyrics or vocals.");
    expect(brief).not.toContain("Write and sing original lyrics");
  });
});

describe("quick song — configuration and server-side authority", () => {
  it("keeps the client working indicator alive across non-terminal song acknowledgements", () => {
    const agent = readFileSync("src/do/ava_agent.ts", "utf8");
    const inbound = readFileSync("../app/lib/features/avatok/chat_thread/inbound.dart", "utf8");
    const send = readFileSync("../app/lib/features/avatok/chat_thread/send.dart", "utf8");
    expect(agent).toContain("turn_pending: true");
    expect(agent).toContain('progress_label: progressLabel');
    expect(inbound).toContain("_reconcileAvaReplyProgress(extra)");
    expect(send).toContain("meta['turn_pending'] == true");
    expect(send).toContain("trigger: 'wire_progress'");
  });

  it("automatically falls back to an independent lyrics model before asking the person to retry", () => {
    const prompts = readFileSync("src/lib/media_prompt.ts", "utf8");
    const media = readFileSync("src/lib/vertex_media.ts", "utf8");
    expect(prompts).toContain('const LYRICS_FALLBACK_MODEL = "gemini-2.5-flash-lite"');
    expect(prompts).toContain("const ladder = [CRAFT_MODEL, CRAFT_MODEL, LYRICS_FALLBACK_MODEL]");
    expect(media).toContain("fallback_used: fallbackUsed");
  });

  it("declares veniceQuickSongModel in BOTH the interface and DEFAULTS, and not in numericKeys", () => {
    // A key the server reads but DEFAULTS does not declare is a FAKE flag:
    // putConfig rejects it with 400 `unknown key`, so it can never be flipped
    // and the fallback becomes its permanent value (CLAUDE.md fake-flag rule).
    const config = readFileSync("src/routes/config.ts", "utf8");
    expect(config).toContain("veniceQuickSongModel: string;");
    expect(config).toContain('veniceQuickSongModel: "elevenlabs-music",');
    // String keys must NOT be in numericKeys or `flags.sh set` 400s `bad type`.
    const start = config.indexOf("const numericKeys");
    const numericBlock = config.slice(start, config.indexOf("]);", start));
    expect(start).toBeGreaterThan(0);
    expect(numericBlock).toContain("veniceMusicTokens");
    expect(numericBlock).not.toContain("veniceQuickSongModel");
  });

  it("validates the paid quick step on the server and never lets a guest trigger it", () => {
    const agent = readFileSync("src/do/ava_agent.ts", "utf8");
    // The model proposes; canExecute() decides. quick_generate must be gated by
    // the server's own readiness check, not by the model's say-so.
    expect(agent).toContain('interview.action === "quick_generate" && songKind !== "instrumental" && quickReady');
    // [AVA-GROUP-SESSION-1] a group guest may steer but may not spend.
    expect(agent).toContain('speaker && (interview.action === "generate" || interview.action === "quick_generate")');
    // Expectation-setting is posted by the server, not left to the model.
    expect(agent).toContain("the music engine writes the words itself");
    // Telemetry carries the person's contact so either side can be retrieved.
    expect(agent).toContain('"ava_song_quick_mode"');
  });

  it("tags the submitted job so an engine-written song is distinguishable forever", () => {
    const media = readFileSync("src/lib/vertex_media.ts", "utf8");
    expect(media).toContain("music_mode: musicMode, model: submittedModel, email,");
    const jobs = readFileSync("src/lib/media_jobs.ts", "utf8");
    expect(jobs).toContain('"vocal" | "instrumental" | "engine_written" | null');
    // The column is plain TEXT with no CHECK constraint, so no migration is
    // needed and the 27-column insert contract is untouched.
    const migration = readFileSync("migrations/2026-08-15-venice-music-route-guard.sql", "utf8");
    expect(migration).toContain("ADD COLUMN music_mode TEXT");
    expect(migration).not.toContain("CHECK");
  });
});
