import { looksLikeVideoRequest } from "./composio";

export type VideoFlowPhase = "discovering" | "generating" | "completed";
export interface VideoProductionContext {
  goal?: string;
  mood?: string;
  scenes?: string;
  intendedUse?: string;
  audience?: string;
  aspectRatio?: "9:16" | "16:9";
  durationSeconds?: number;
  resolution?: "1080p" | "1440p" | "2160p";
  modelId?: string;
  sourceMode?: "text" | "image";
}
export interface VideoFlowState {
  phase: VideoFlowPhase;
  conversation?: string;
  context?: VideoProductionContext;
  lastInterviewReply?: string;
}

export function videoFlowKey(conv: string): string { return `video_flow:${conv}`; }
export function isVideoFlowState(v: unknown): v is VideoFlowState {
  if (!v || typeof v !== "object") return false;
  const f = v as VideoFlowState;
  return ["discovering", "generating", "completed"].includes(f.phase);
}
export function nextVideoFlow(flow: VideoFlowState | null, text: string): VideoFlowState | null {
  const clean = String(text || "").trim();
  if ((!flow || flow.phase === "completed") && !looksLikeVideoRequest(clean)) return null;
  if (!flow || flow.phase === "completed") return { phase: "discovering", conversation: clean };
  if (flow.phase !== "discovering") return null;
  return { ...flow, conversation: [flow.conversation, clean].filter(Boolean).join("\n\n") };
}
export function isVideoContextReady(c?: VideoProductionContext): boolean {
  return !!c?.goal && !!c.aspectRatio && !!c.durationSeconds && !!c.resolution && !!c.modelId;
}
export function videoPrompt(c: VideoProductionContext): string {
  return [
    `Goal and story: ${c.goal ?? ""}`, c.mood ? `Mood: ${c.mood}` : "",
    c.scenes ? `Scenes and movement: ${c.scenes}` : "", c.intendedUse ? `Intended use: ${c.intendedUse}` : "",
    c.audience ? `Audience: ${c.audience}` : "", `Format: ${c.aspectRatio === "9:16" ? "vertical" : "horizontal"}`,
  ].filter(Boolean).join("\n");
}
