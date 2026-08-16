import type { MediaModelChoice } from "./media_model_catalog";
import type { VideoFlowState, VideoProductionContext } from "./video_flow";

export const VIDEO_INTERVIEW_SYSTEM = `You are Ava, a perceptive video producer having a real conversation with a person who wants to create a video.

Understand ordinary speech, typos, shorthand, indirect answers and changes of mind from the full conversation. Help shape the idea while gathering useful production choices: their goal, emotion, audience or destination, vertical versus horizontal format, scenes or visual movement, length, resolution, and model. These are internal goals, never a questionnaire or keyword script.

Rules:
- React naturally and offer tailored creative suggestions. Ask at most ONE focused question per turn.
- Never recite a checklist, repeat a question already answered, or require command phrases.
- Let the creative idea take shape first. Then, when useful, explain only the currently available lengths, resolution, model capabilities and exact prices from availableModels. Never invent a model, capability, format, duration, resolution or price.
- If more than one model fits, explain the practical difference and let the person choose. If only one fits, say so naturally when model/cost becomes relevant.
- Choose action "generate" only when the person clearly wants to proceed and the selected values are supported by one catalog model.
- Choose "restart" for a genuinely different video idea, and "switch" when they move to a song, image or unrelated task.
- The reply must match the action. Do not promise generation while returning discuss.

Return ONLY JSON:
{"action":"discuss","reply":"natural Ava response","context":{"goal":string|null,"mood":string|null,"scenes":string|null,"intendedUse":string|null,"audience":string|null,"aspectRatio":"9:16"|"16:9"|null,"durationSeconds":number|null,"resolution":"1080p"|"1440p"|"2160p"|null,"modelId":string|null,"sourceMode":"text"|"image"|null}}
action must be discuss, generate, restart, or switch.`;
export const VIDEO_INTERVIEW_FALLBACK_MODEL = "gemini-3-7-flash";

const text = (v: unknown, max=500) => typeof v === "string" && v.trim() ? v.replace(/\s+/g," ").trim().slice(0,max) : undefined;
export type VideoInterviewTurn = { action:"discuss"|"generate"|"restart"|"switch"; reply:string; context:VideoProductionContext };
export function parseVideoInterviewTurn(rawText:string, previous?:VideoProductionContext, models:MediaModelChoice[]=[]):VideoInterviewTurn {
  const raw=String(rawText||"").trim().replace(/^```(?:json)?\s*/i,"").replace(/\s*```$/i,"");
  const a=raw.indexOf("{"), b=raw.lastIndexOf("}"); if(a<0||b<=a) throw new Error("video interview returned no JSON object");
  const p=JSON.parse(raw.slice(a,b+1)) as Record<string,unknown>; const r=(p.context&&typeof p.context==="object"?p.context:{}) as Record<string,unknown>;
  const base: VideoProductionContext=String(p.action)==="restart"?{}:(previous??{}); const duration=Number(r.durationSeconds);
  const context:VideoProductionContext={...base, goal:text(r.goal)??base.goal,mood:text(r.mood)??base.mood,scenes:text(r.scenes,900)??base.scenes,intendedUse:text(r.intendedUse)??base.intendedUse,audience:text(r.audience)??base.audience};
  if(r.aspectRatio==="9:16"||r.aspectRatio==="16:9") context.aspectRatio=r.aspectRatio;
  if(Number.isFinite(duration)) context.durationSeconds=Math.round(duration);
  if(r.resolution==="1080p"||r.resolution==="1440p"||r.resolution==="2160p") context.resolution=r.resolution;
  if(r.sourceMode==="text"||r.sourceMode==="image") context.sourceMode=r.sourceMode;
  const modelId=text(r.modelId,160)??base.modelId; if(modelId&&models.some(m=>m.id===modelId)) context.modelId=modelId;
  const action=["generate","restart","switch"].includes(String(p.action))?String(p.action) as VideoInterviewTurn["action"]:"discuss";
  const reply=text(p.reply,800)??""; if(action!=="switch"&&!reply) throw new Error("video interview returned an empty reply");
  return {action,reply,context};
}
export function videoInterviewPayload(flow:VideoFlowState, latest:string, models:MediaModelChoice[], feedback?:string):string {
  return JSON.stringify({currentPhase:flow.phase,savedContext:flow.context??{},previousAvaReply:flow.lastInterviewReply??null,latestUserMessage:String(latest).slice(0,2000),userConversationSoFar:String(flow.conversation??"").slice(-6000),availableModels:models,serverValidationFeedback:feedback??null});
}
export function recoverVideoDiscussion(raw:string, previous?:VideoProductionContext):VideoInterviewTurn|null {
  const reply=String(raw||"").replace(/<think>[\s\S]*?<\/think>/gi,"").trim();
  return !reply||/[{}]/.test(reply)?null:{action:"discuss",reply:reply.slice(0,800),context:previous??{}};
}
