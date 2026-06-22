/**
 * Ava Receptionist v2 — handover simulation.
 * Faithful port of the decision logic from:
 *   worker/src/routes/receptionist.ts  (receptionistConfigFor, composeReceptionistPrompt, start validation)
 *   worker/src/routes/config.ts        (receptionistRings default)
 *   app/lib/features/avatok/call_screen.dart (_probeReceptionist, _onNoAnswer, _statusSub)
 *   app/lib/push/push_service.dart     (_declineRouting)
 *
 * This does NOT call Gemini / play audio — it verifies the "does the call get
 * handed over to the AI voice agent, and how?" wiring for every activation path.
 */

// ----- server: config.ts default -------------------------------------------
const PLATFORM_CFG = { receptionistEnabled: true, receptionistRings: 5 };

// ----- server: receptionist.ts ---------------------------------------------
const STATUS_PRESETS = {
  busy: "is busy right now", travelling: "is travelling at the moment",
  meeting: "is in a meeting right now", driving: "is driving at the moment",
  holiday: "is on holiday right now", after_hours: "is unavailable after hours right now",
  custom: "",
};
const LANG_CODES = new Set(["en-US","en-GB","fr-FR","es-ES","hi-IN","ja-JP"]); // subset for the sim

function statusPhrase(s) {
  const p = (s.status_preset || "").trim();
  if (!p) return "";
  if (p === "custom") return (s.status_custom || "").trim();
  return STATUS_PRESETS[p] ?? "";
}

// GET /api/receptionist/config?to= — returns how the caller should hand off.
function receptionistConfigFor(settings, premium, cfg = PLATFORM_CFG) {
  if (cfg.receptionistEnabled === false) return { available: false, reason: "disabled" };
  if (!settings || !settings.enabled) return { available: false, reason: "off" };
  if (!premium) return { available: false, reason: "not_premium" };
  const rings = Math.max(1, Math.round(Number(cfg.receptionistRings ?? 5)));
  const mode = settings.answer_all ? "first_ring" : "rings";
  return { available: true, mode, rings, decline_to_ava: !!settings.decline_to_ava,
           voice_name: settings.voice_name || "Puck" };
}

// POST /start — activation_mode validation.
function validateActivationMode(m) {
  const VALID = new Set(["rings", "first_ring", "decline"]);
  m = String(m || "rings");
  return VALID.has(m) ? m : "rings";
}

function composeReceptionistPrompt(s) {
  const who = (s.display_name || "the person you're assisting").trim();
  const me = (s.persona_name || "Ava").trim();
  const status = statusPhrase(s);
  const lang = (s.language_code || "").trim();
  const lines = [`You are ${me}, the personal AI assistant answering a phone call for ${who}, who did not pick up.`];
  if (status) lines.push(`${who} ${status}. If the caller asks, tell them that warmly and offer to take a message.`);
  if (lang) lines.push(`Speak to the caller in ${lang} unless they clearly cannot understand it.`);
  if (s.greeting_text) lines.push(`Open the call with this greeting: "${s.greeting_text}"`);
  lines.push(`--- OWNER INSTRUCTIONS ---`, (s.instructions_text || "Take a message."));
  if (s.custom_prompt) lines.push(`--- ADDITIONAL OWNER GUIDANCE (safety + 2-min cap still win) ---`, s.custom_prompt);
  return lines.join("\n");
}

// ----- client: push_service.dart _declineRouting ---------------------------
function declineRouting(localMirror, isAudio) {
  if (isAudio && localMirror.receptionist_enabled && localMirror.receptionist_decline_to_ava) {
    return "decline_ava";
  }
  return "decline";
}

// ----- client: call_screen.dart caller side --------------------------------
// Returns the handover decision: { handedOver, activationMode, ringWindowSecs } or {handedOver:false}
function callerOutcome({ isVideo, configResult, calleeAction }) {
  const result = { events: [] };
  // _probeReceptionist (audio only)
  let mode = "rings", windowSecs = 35;
  if (!isVideo && configResult && configResult.available) {
    mode = configResult.mode;
    if (mode === "first_ring") windowSecs = 6;
    else windowSecs = Math.min(60, Math.max(20, (configResult.rings ?? 5) * 7));
    result.events.push(`probe → mode=${mode}, window=${windowSecs}s`);
  } else {
    result.events.push(`probe → unavailable/video → default window 35s, no early handoff`);
  }

  // Mode C: callee hit Decline. The status the callee signals depends on their opt-in.
  if (calleeAction && calleeAction.type === "decline") {
    const status = declineRouting(calleeAction.localMirror, !isVideo);
    result.events.push(`callee Decline → signals '${status}'`);
    if (status === "decline_ava" && !isVideo) {
      return { handedOver: true, activationMode: validateActivationMode("decline"),
               trigger: "decline", ...result };
    }
    return { handedOver: false, reason: "normal decline (missed call)", ...result };
  }

  // Mode A/B: nobody answered within the ring window → _onNoAnswer → _tryReceptionist
  if (isVideo) return { handedOver: false, reason: "video call (Ava is audio-only)", ...result };
  if (!configResult || !configResult.available) {
    return { handedOver: false, reason: `receptionist unavailable (${configResult?.reason})`, ...result };
  }
  const activation = validateActivationMode(mode === "first_ring" ? "first_ring" : "rings");
  return { handedOver: true, activationMode: activation, trigger: mode,
           ringWindowSecs: windowSecs, ...result };
}

// ===========================================================================
// SCENARIOS
// ===========================================================================
const baseSettings = {
  enabled: true, display_name: "Sonal", voice_name: "Kore",
  instructions_text: "Take a message and tell them I'll call back.",
};

const scenarios = [
  {
    name: "Mode A — premium owner, 5 rings, no answer (audio)",
    isVideo: false, premium: true,
    settings: { ...baseSettings, answer_all: false },
    calleeAction: null,
    expect: { handedOver: true, trigger: "rings", activationMode: "rings", windowSecs: 35 },
  },
  {
    name: "Mode B — owner is 'travelling', answer on first ring (audio)",
    isVideo: false, premium: true,
    settings: { ...baseSettings, answer_all: true, status_preset: "travelling",
                persona_name: "Maya", language_code: "en-GB" },
    calleeAction: null,
    expect: { handedOver: true, trigger: "first_ring", activationMode: "first_ring", windowSecs: 6 },
  },
  {
    name: "Mode C — owner rejects the call, decline-to-Ava ON (audio)",
    isVideo: false, premium: true,
    settings: { ...baseSettings, decline_to_ava: true },
    calleeAction: { type: "decline", localMirror: { receptionist_enabled: true, receptionist_decline_to_ava: true } },
    expect: { handedOver: true, trigger: "decline", activationMode: "decline" },
  },
  {
    name: "Negative — owner rejects, decline-to-Ava OFF → normal missed call",
    isVideo: false, premium: true,
    settings: { ...baseSettings, decline_to_ava: false },
    calleeAction: { type: "decline", localMirror: { receptionist_enabled: true, receptionist_decline_to_ava: false } },
    expect: { handedOver: false },
  },
  {
    name: "Negative — owner not premium → no handover",
    isVideo: false, premium: false,
    settings: { ...baseSettings, answer_all: false },
    calleeAction: null,
    expect: { handedOver: false },
  },
  {
    name: "Negative — VIDEO call → no handover (Ava is audio-only)",
    isVideo: true, premium: true,
    settings: { ...baseSettings, answer_all: true },
    calleeAction: null,
    expect: { handedOver: false },
  },
];

let pass = 0, fail = 0;
console.log("=".repeat(78));
console.log("AVA RECEPTIONIST v2 — INCOMING-CALL HANDOVER SIMULATION");
console.log("=".repeat(78));
for (const sc of scenarios) {
  const cfg = receptionistConfigFor(sc.settings, sc.premium);
  const out = callerOutcome({ isVideo: sc.isVideo, configResult: cfg, calleeAction: sc.calleeAction });

  const okHanded = out.handedOver === sc.expect.handedOver;
  const okMode = sc.expect.activationMode ? out.activationMode === sc.expect.activationMode : true;
  const okWin = sc.expect.windowSecs ? out.ringWindowSecs === sc.expect.windowSecs : true;
  const okTrig = sc.expect.trigger ? out.trigger === sc.expect.trigger : true;
  const ok = okHanded && okMode && okWin && okTrig;
  ok ? pass++ : fail++;

  console.log(`\n${ok ? "✅ PASS" : "❌ FAIL"}  ${sc.name}`);
  out.events.forEach(e => console.log(`        · ${e}`));
  if (out.handedOver) {
    console.log(`        → HANDED OVER to AI voice agent | trigger=${out.trigger} activation_mode=${out.activationMode}` +
                (out.ringWindowSecs ? ` after ${out.ringWindowSecs}s` : ``));
    // Show the persona prompt Ava would open with.
    const prompt = composeReceptionistPrompt(sc.settings);
    console.log(`        Ava opens as: "${prompt.split("\n")[0]}"`);
    const statusLine = prompt.split("\n").find(l => l.includes("right now") || l.includes("at the moment"));
    if (statusLine) console.log(`        status line:  "${statusLine}"`);
  } else {
    console.log(`        → NOT handed over (${out.reason}) — normal call/missed-call path`);
  }
}
console.log("\n" + "=".repeat(78));
console.log(`RESULT: ${pass} passed, ${fail} failed`);
console.log("=".repeat(78));
process.exit(fail ? 1 : 0);
