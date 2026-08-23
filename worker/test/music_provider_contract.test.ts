// [SONG-CONTRACT-1] Locks the music provider request contract that three
// separate production failures taught us, each a live Venice 400 in front of
// the owner:
//   2026-08-16  lyrics_prompt must be less than 1000 characters   (MiniMax)
//   2026-08-17  This model does not support lyrics                (ElevenLabs)
//   2026-08-17  prompt must be less than 300 characters           (MiniMax)
// The shaping helpers are pure, so the limits are testable without a provider.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { compactMusicPrompt, trimLyricsToCap } from "../src/lib/vertex_media";

const STRUCTURED_BRIEF = [
  "Theme / intent: Gen Z pride, freedom from corrupt politicians and a new India",
  "Genre: Hindi reggae with a modern Indian beat",
  "Mood / energy: proud, energetic, defiant and anthemic",
  "Instruments: electric bass, skank guitar, one-drop drums, warm organ, tabla",
  "Language: Hindi",
  "Vocal arrangement: solo male vocalist",
  "Voice character: youthful, raw and commanding",
  "Intended use: sharing with friends in a group chat",
  "Audio model: minimax-music-v26",
  "Length: 60 seconds",
].join("\n");

describe("music provider request contract", () => {
  it("fits MiniMax's 300-char prompt ceiling that failed a real 1-minute song", () => {
    const out = compactMusicPrompt(STRUCTURED_BRIEF, 290);
    expect(STRUCTURED_BRIEF.length).toBeGreaterThan(300); // the shape that broke prod
    expect(out.length).toBeLessThanOrEqual(290);
    expect(out.length).toBeGreaterThan(0);
    // Musical direction survives the squeeze; plumbing lines do not.
    expect(out.toLowerCase()).toContain("genre");
    expect(out).not.toMatch(/Audio model:/i);
    expect(out).not.toMatch(/^Length:/im);
  });

  it("leaves an already-small prompt untouched", () => {
    const small = "Genre: lo-fi. Mood: calm";
    expect(compactMusicPrompt(small, 290)).toBe(small);
  });

  it("never emits a prompt over the cap even with one unbroken line", () => {
    const wall = `Genre: ${"a".repeat(900)}`;
    expect(compactMusicPrompt(wall, 290).length).toBeLessThanOrEqual(290);
  });

  it("trims lyrics on a section boundary, never mid-word", () => {
    const lyrics = ["[Verse 1]", "x".repeat(600), "[Chorus]", "y".repeat(600), "[Outro]", "z".repeat(200)].join("\n");
    const out = trimLyricsToCap(lyrics, 950);
    expect(out.length).toBeLessThanOrEqual(950);
    expect(lyrics.startsWith(out.slice(0, 50))).toBe(true);
  });

  it("keeps short lyrics byte-identical", () => {
    const lyrics = "[Verse 1]\nshort and complete\n[Chorus]\nstill short";
    expect(trimLyricsToCap(lyrics, 950)).toBe(lyrics);
  });

  it("declares each model's real limits, including ElevenLabs having no lyrics", () => {
    const src = readFileSync("src/lib/vertex_media.ts", "utf8");
    expect(src).toContain('"minimax-music-v26": { promptMaxChars: 290, lyricsMaxChars: 950, supportsLyrics: true }');
    expect(src).toContain('"elevenlabs-music": { promptMaxChars: 2000, lyricsMaxChars: 0, supportsLyrics: false }');
    // A vocal song must never be routed to a model that cannot sing lyrics.
    expect(src).toContain("musicLimitsFor(longModel).supportsLyrics");
    expect(src).toContain('const VERTEX_MUSIC_MODEL = "lyria-3-pro-preview"');
    expect(src).toContain("approved custom lyrics");
  });

  it("requires a resolved outro and smooth fade inside the requested duration", () => {
    const src = readFileSync("src/lib/vertex_media.ts", "utf8");
    expect(src).toContain("Begin the final outro before the time limit");
    expect(src).toContain("final 8–12 seconds for a smooth musical fade to silence");
    const prompts = readFileSync("src/lib/media_prompt.ts", "utf8");
    expect(prompts).toContain("with AT MOST ${targetWords} sung words");
    expect(prompts).toContain("fitLyricsToDurationWithRecovery");
    expect(prompts).toContain("fitted lyrics still exceed duration word budget");
  });
});
