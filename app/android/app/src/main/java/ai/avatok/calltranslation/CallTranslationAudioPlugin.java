package ai.avatok.calltranslation;

import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioTrack;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;

import androidx.annotation.NonNull;

import com.cloudwebrtc.webrtc.FlutterWebRTCPlugin;
import com.cloudwebrtc.webrtc.audio.PlaybackSamplesReadyCallbackAdapter;

import org.json.JSONArray;
import org.json.JSONObject;
import org.webrtc.audio.JavaAudioDeviceModule;

import java.io.ByteArrayOutputStream;
import java.lang.reflect.Field;
import java.util.ArrayDeque;
import java.util.concurrent.TimeUnit;

import io.flutter.embedding.engine.plugins.FlutterPlugin;
import io.flutter.plugin.common.EventChannel;
import io.flutter.plugin.common.MethodCall;
import io.flutter.plugin.common.MethodChannel;
import okhttp3.OkHttpClient;
import okhttp3.HttpUrl;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

/**
 * Android bridge for payer-local 1:1 call translation.
 *
 * It consumes flutter_webrtc's decoded playback callback, resamples that
 * incoming call audio to PCM16/16 kHz, and hands it to a bounded queue drained
 * by a dedicated sender thread that talks to a constrained Gemini Live socket.
 * The original WebRTC AudioTrack is muted only after the server has charged the
 * first minute; translated PCM16/24 kHz is played on a separate voice-call
 * AudioTrack. No second microphone or CallRoom PCM relay is used.
 *
 * THE INVARIANT: translation may fail or stall; the underlying call must stay
 * usable and the original audio must be restored automatically. The mute lives
 * here (native) precisely so restoration works even when Dart is wedged — see
 * the dead-air guard below.
 *
 * Privacy: no transcript text, no audio bytes and nothing audio-derived is ever
 * logged or emitted. Counters, timings, state names and error categories only.
 */
public final class CallTranslationAudioPlugin implements FlutterPlugin,
        MethodChannel.MethodCallHandler, EventChannel.StreamHandler,
        JavaAudioDeviceModule.PlaybackSamplesReadyCallback {

    private static final String METHOD = "avatok/call_translation_audio";
    private static final String EVENTS = "avatok/call_translation_audio_events";
    private static final String MODEL = "gemini-3.5-live-translate-preview";
    /**
     * [CALL-TRANSLATE-APIVER-1] ONE place for the provider API version in this layer.
     * Must move in lockstep with {@code CALL_TRANSLATION_API_VERSION} in
     * worker/src/routes/call_translation.ts — a token minted under one version and
     * presented to a socket on another is precisely the failure a scattered literal
     * causes. Live Translate now requires v1beta for ephemeral-token sessions;
     * production's old v1alpha mint returned HTTP 400 on 2026-08-15.
     */
    private static final String API_VERSION = "v1beta";
    /**
     * [CALL-TRANSLATE-APIVER-1] The CONSTRAINED method — not plain BidiGenerateContent.
     *
     * An ephemeral token (a name beginning {@code auth_tokens/}) authenticates ONLY
     * against {@code BidiGenerateContentConstrained}. Probed against the live endpoint
     * on 2026-08-04, with a deliberately bogus token, on both v1beta and v1alpha:
     *
     *   BidiGenerateContent            -> close 1008 "Method doesn't allow unregistered
     *                                     callers (callers without established identity).
     *                                     Please use API Key ..."   (access_token IGNORED)
     *   BidiGenerateContentConstrained -> close 1007 "Missing or malformed auth token in
     *                                     request. Obtain one from CreateAuthToken and
     *                                     pass it in an `access_token` query parameter"
     *                                                               (access_token READ)
     *
     * i.e. the URL this used to build could never have authenticated, whatever the token.
     * The official SDK agrees: @google/genai switches method to
     * BidiGenerateContentConstrained and keyName to access_token the moment the api key
     * starts with "auth_tokens/". The same lesson is already recorded, from a live
     * verification, in app/lib/features/avachat/voice_call/live_voice_controller.dart.
     */
    private static final String WS_URL = "wss://generativelanguage.googleapis.com/ws/"
            + "google.ai.generativelanguage." + API_VERSION
            + ".GenerativeService.BidiGenerateContentConstrained";

    /** ~3 s of 100 ms uplink chunks. Overflow drops the OLDEST (stale-audio policy). */
    private static final int UPLINK_QUEUE_CAPACITY = 30;
    /** No translated PCM for this long (while the far end is actually speaking) = dead air. */
    private static final long STALL_THRESHOLD_MS = 2_000L;
    /** Input counts as "flowing" only if voiced audio was seen this recently. */
    private static final long INPUT_ACTIVE_WINDOW_MS = 1_500L;
    /** Anti-flap: never re-mute sooner than this after falling back. */
    private static final long MIN_FALLBACK_MS = 800L;
    /** Anti-flap: a single late chunk must not end a fallback; require sustained PCM. */
    private static final int RECOVER_PCM_BYTES = 9_600; // 200 ms @ 24 kHz mono PCM16
    private static final long DEGRADED_WINDOW_MS = 60_000L;
    private static final int DEGRADED_CYCLES = 2;
    private static final long DEGRADED_REEMIT_MS = 30_000L;
    private static final long GUARD_TICK_MS = 250L;
    private static final long STATS_INTERVAL_MS = 30_000L;
    /** Peak amplitude (of 32767) above which an input chunk counts as speech, not silence. */
    private static final int VOICE_PEAK_THRESHOLD = 600;

    /** Reasons carried on stalled/recovered events. Categories only — never content. */
    public static final String REASON_DEAD_AIR = "dead_air";
    public static final String REASON_SWITCHING = "switching";
    /** Fallback/cancel reason tags are categories, never content — hard-capped defensively. */
    private static final int MAX_REASON_LEN = 40;

    private final Handler main = new Handler(Looper.getMainLooper());
    private final Object audioLock = new Object();
    private final Object queueLock = new Object();
    private final Object fallbackLock = new Object();
    private final ByteArrayOutputStream pcm16k = new ByteArrayOutputStream(4096);
    private final ArrayDeque<byte[]> uplinkQueue = new ArrayDeque<>(UPLINK_QUEUE_CAPACITY);
    private final long[] stallCycleAt = new long[8];
    private final OkHttpClient http = new OkHttpClient.Builder()
            .pingInterval(20, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .build();

    private MethodChannel methodChannel;
    private EventChannel eventChannel;
    private EventChannel.EventSink eventSink;
    private PlaybackSamplesReadyCallbackAdapter playbackAdapter;
    private volatile WebSocket socket;
    /**
     * The make-before-break socket. Volatile because it is written from the MethodChannel
     * (main) thread and read from BOTH sockets' OkHttp reader threads during a cutover.
     */
    private volatile WebSocket pendingSocket;
    private AudioTrack translatedTrack;
    /**
     * D-3: volatile. Written from the guard thread, the OkHttp reader threads, the decoded-audio
     * callback and main; a stale read here means restoring volume on a dead AudioTrack while the
     * live one stays at 0 — a permanently silent call, the invariant failing in the worst way.
     */
    private volatile AudioTrack webRtcOutputTrack;
    private volatile MethodChannel.Result pendingPrepare;
    private boolean attached;
    private volatile boolean prepared;
    private volatile boolean active;
    private volatile boolean paid;
    private volatile boolean stopping;
    /** D-7: only the prepare that armed a timeout may be failed by it. */
    private volatile int prepareGeneration;
    private int resamplePhase;
    private int lastInputRate;
    /** D-3: volatile, and set to 0 to force a fresh lookup before any unmute. */
    private volatile long lastOutputLookupMs;
    private String authToken;
    /**
     * The language of the LIVE session — never the one a pending socket is trying to reach.
     * Committed only on the pending socket's {@code setupComplete} (see
     * {@link #handleProviderMessage}), so a failed switch leaves it describing what the user
     * is actually hearing.
     */
    private volatile String targetLanguage;
    private String resumeHandle;

    // --- worker threads -----------------------------------------------------
    private Thread senderThread;
    private volatile boolean senderRunning;
    private Thread guardThread;
    private volatile boolean guardRunning;

    // --- dead-air guard state (all under fallbackLock unless volatile) -------
    private volatile boolean fallbackActive;
    private String fallbackReason;
    /**
     * D-2: whether the CURRENTLY OPEN fallback is a dead-air one. Deliberate fallbacks
     * (language switch, route change, focus blip) must not move the stall statistics or the
     * degraded-cycle window, or two clean language switches inside 60 s tell the user his
     * connection is unstable and poison the p95 thresholds derived from stall_count/stall_ms.
     */
    private boolean fallbackWasDeadAir;
    private long fallbackStartedAtMs;
    private volatile long lastTranslatedPcmMs;
    private volatile long lastVoiceInputMs;
    private int recoverPcmBytes;
    private int stallCycleIndex;
    private long lastDegradedEmitMs;

    // --- telemetry counters (no content, ever) ------------------------------
    private volatile long sessionStartedAtMs;
    private volatile int stallCount;        // DEAD-AIR fallbacks only (D-2)
    private volatile long stallMsTotal;     // DEAD-AIR fallback duration only (D-2)
    private volatile int fallbackCount;     // deliberate fallbacks: switching/route/focus
    private volatile long fallbackMsTotal;  // deliberate fallback duration
    private volatile int pcmDropCount;      // uplink chunks dropped on queue overflow
    private volatile int uplinkFailCount;   // webSocket.send() returned false / threw
    private volatile int uplinkSentCount;
    private volatile int queuePeak;
    private volatile int shortWriteCount;   // AudioTrack.write wrote fewer bytes than offered
    private volatile long shortWriteBytes;
    private volatile int playbackErrorCount; // AudioTrack.write returned a negative error code
    private volatile int translatedChunkCount;
    private volatile long lastStatsEmitMs;

    @Override
    public void onAttachedToEngine(@NonNull FlutterPluginBinding binding) {
        methodChannel = new MethodChannel(binding.getBinaryMessenger(), METHOD);
        methodChannel.setMethodCallHandler(this);
        eventChannel = new EventChannel(binding.getBinaryMessenger(), EVENTS);
        eventChannel.setStreamHandler(this);
    }

    @Override
    public void onDetachedFromEngine(@NonNull FlutterPluginBinding binding) {
        stopInternal(false);
        detachPlaybackCallback();
        methodChannel.setMethodCallHandler(null);
        eventChannel.setStreamHandler(null);
        methodChannel = null;
        eventChannel = null;
    }

    @Override
    public void onListen(Object arguments, EventChannel.EventSink events) {
        eventSink = events;
    }

    @Override
    public void onCancel(Object arguments) {
        eventSink = null;
    }

    @Override
    public void onMethodCall(@NonNull MethodCall call, @NonNull MethodChannel.Result result) {
        switch (call.method) {
            case "isSupported": {
                // [CALL-TRANSLATE-PROBE-OBS-1] Still returns a plain bool for the existing
                // caller, but publishes WHY it was false on the event channel so
                // `call_translation_native_probe` can carry a real cause instead of a bare
                // `unsupported`. See lastAdapterResolveFailure for the 2026-08-04 incident.
                boolean supported = resolvePlaybackAdapter(false) != null;
                if (!supported) emit("probe_unsupported_reason", lastAdapterResolveFailure);
                result.success(supported);
                break;
            }
            case "lastProbeSource":
                // [CALL-TRANSLATE-BIND-1] "engine_bound" | "shared_singleton" |
                // "engine_bound_singleton_mismatch" | "none".
                result.success(lastAdapterSource);
                break;
            case "lastProbeFailure":
                // [CALL-TRANSLATE-PROBE-OBS-1] Pull-based twin of the event above, so the
                // Dart retry ladder can attach a cause to the terminal
                // `call_translation_native_probe result=unsupported` without depending on
                // the event channel being subscribed at that moment.
                result.success(lastAdapterResolveFailure);
                break;
            case "prepare":
                String token = call.argument("token");
                String targetLanguage = call.argument("targetLanguage");
                if (token == null || token.isEmpty() || targetLanguage == null || targetLanguage.isEmpty()) {
                    result.error("invalid_arguments", "token and targetLanguage are required", null);
                    return;
                }
                prepare(token, targetLanguage, result);
                break;
            case "activate":
                if (!prepared || socket == null) {
                    result.error("not_prepared", "Gemini session is not ready", null);
                    return;
                }
                active = true;
                ensureTranslatedTrack();
                result.success(true);
                break;
            case "commitPaid":
                if (!active) {
                    result.error("not_active", "Translation transport is not active", null);
                } else {
                    paid = true;
                    // The guard measures dead air from the moment the original is muted.
                    lastTranslatedPcmMs = System.currentTimeMillis();
                    lastOutputLookupMs = 0L; // D-3: fresh handle across the transition
                    applyOutputMute();
                    result.success(true);
                }
                break;
            case "resume": {
                String replacement = call.argument("token");
                String handle = call.argument("handle");
                // OPTIONAL. Absent (the plain-resume case) => the pending socket announces the
                // LIVE language and behaviour is unchanged. Present => Phase C's language switch.
                String nextLanguage = call.argument("targetLanguage");
                if (replacement == null || replacement.isEmpty() || handle == null || handle.isEmpty()) {
                    result.error("invalid_resume", "token and handle are required", null);
                } else {
                    authToken = replacement;
                    // `this.` is load-bearing: case "prepare" declares a local `targetLanguage`
                    // and switch cases share one scope, so a bare read resolves to that local.
                    connectSocket(handle, nextLanguage == null || nextLanguage.isEmpty()
                            ? this.targetLanguage : nextLanguage);
                    result.success(true);
                }
                break;
            }
            case "switchLanguage": {
                // Phase C make-before-break: open a SECOND socket announcing the new language
                // while the live one keeps translating. The live session is untouched until the
                // new socket reports setupComplete.
                String switchToken = call.argument("token");
                String switchLanguage = call.argument("targetLanguage");
                String switchHandle = call.argument("handle"); // optional; null = fresh session
                if (!prepared || socket == null) {
                    result.error("not_prepared", "Gemini session is not ready", null);
                    return;
                }
                if (switchToken == null || switchToken.isEmpty()
                        || switchLanguage == null || switchLanguage.isEmpty()) {
                    result.error("invalid_arguments", "token and targetLanguage are required", null);
                    return;
                }
                if (pendingSocket != null) {
                    // Guardrail: one in-flight switch at a time. Dart queues the latest request.
                    result.error("switch_in_flight", "A session cutover is already in flight", null);
                    return;
                }
                authToken = switchToken;
                connectSocket(switchHandle == null || switchHandle.isEmpty() ? null : switchHandle,
                        switchLanguage);
                result.success(true);
                break;
            }
            case "cancelSwitch": {
                // D-4: the ONLY way Dart can abandon a cutover it has given up on (its own
                // cutover_timeout). Without it `pendingSocket` stayed non-null for the rest of
                // the call, so every later switch returned `switch_in_flight` AND goAway-driven
                // provider resume — gated on `pendingSocket == null` — was silently dead.
                //
                // Touches the pending socket and NOTHING else: the live socket, `targetLanguage`,
                // `active`, `paid` and the fallback state are all left exactly as they are, so
                // the user keeps hearing the language he is already being translated into.
                String cancelReason = call.argument("reason");
                boolean cancelled = abandonPendingSocket(cancelReason == null || cancelReason.isEmpty()
                        ? "cancelled" : cancelReason);
                result.success(cancelled);
                break;
            }
            case "setFallback": {
                Boolean enabled = call.argument("enabled");
                String reason = call.argument("reason");
                if (enabled == null) {
                    result.error("invalid_arguments", "enabled is required", null);
                    return;
                }
                setFallbackToOriginal(enabled, tag(reason, REASON_SWITCHING));
                result.success(true);
                break;
            }
            case "stats":
                emitStats(false);
                result.success(true);
                break;
            case "stop":
                stopInternal(false);
                result.success(true);
                break;
            default:
                result.notImplemented();
        }
    }

    private void prepare(String token, String targetLanguage, MethodChannel.Result result) {
        stopInternal(false);
        if (playbackAdapter == null) playbackAdapter = resolvePlaybackAdapter(true);
        if (playbackAdapter == null) {
            result.error("webrtc_playback_unavailable", "Decoded WebRTC playback callback unavailable", null);
            return;
        }
        if (!attached) {
            playbackAdapter.addCallback(this);
            attached = true;
        }
        stopping = false;
        pendingPrepare = result;
        authToken = token;
        this.targetLanguage = targetLanguage;
        resetTelemetry();
        startSenderThread();
        startGuardThread();
        connectSocket(null, targetLanguage);

        // D-7: the timeout is scoped to THIS prepare. A second prepare inside 15 s — a discarded
        // warm-up followed by the real start is exactly that shape — used to be killed by the
        // FIRST prepare's timer, because the old runnable only checked `pendingPrepare != null`.
        final int generation = ++prepareGeneration;
        main.postDelayed(() -> {
            if (prepareGeneration != generation) return; // superseded or stopped: not ours to fail
            if (pendingPrepare != null) {
                failPrepare("provider_timeout", "Gemini setup did not complete in time");
                stopInternal(true);
            }
        }, 15_000);
    }

    /**
     * D-4: closes and clears the pending (make-before-break) socket without touching the live
     * session. Safe to call from any thread and idempotent.
     *
     * <p>The abandoned socket's {@code onFailure}/{@code onClosed}/{@code onMessage} callbacks
     * are already inert once it is neither {@link #socket} nor {@link #pendingSocket} — every
     * listener path identity-checks against those two fields — so cancelling cannot fail the
     * live session or steal it via a late {@code setupComplete}.
     *
     * @return true if a pending socket was actually abandoned.
     */
    private boolean abandonPendingSocket(String reason) {
        WebSocket pending = pendingSocket;
        if (pending == null) return false;
        pendingSocket = null;
        if (pending != socket) {
            // cancel(), not close(): no close handshake to wait on, and the callbacks it fires
            // are ignored by the identity checks above.
            try { pending.cancel(); } catch (Exception ignored) {}
        }
        JSONObject extra = new JSONObject();
        try {
            extra.put("liveLanguage", targetLanguage == null ? "" : targetLanguage);
        } catch (Exception ignored) {}
        emitJson("switch_cancelled", tag(reason, "cancelled"), extra);
        return true;
    }

    /** Category tags only — bounded, never content. */
    private static String tag(String reason, String fallbackTag) {
        if (reason == null || reason.isEmpty()) return fallbackTag;
        return reason.length() > MAX_REASON_LEN ? reason.substring(0, MAX_REASON_LEN) : reason;
    }

    /**
     * Opens a socket that announces {@code language} in its setup frame.
     *
     * The language is captured PER SOCKET rather than read from {@link #targetLanguage} at
     * send time: during a Phase C cutover two sockets are alive on two OkHttp reader threads,
     * and the pending one must announce the NEW language (matching the new token's
     * {@code liveConnectConstraints.config}) while the live one keeps translating in the old one.
     * The field is only moved to the new value once THIS socket reaches setupComplete.
     */
    private void connectSocket(String handle, String language) {
        final String socketLanguage = language;
        // D-4: never orphan a previous pending socket by overwriting the field — that leaked a
        // live socket and left the abandon bookkeeping inconsistent.
        abandonPendingSocket("superseded");
        HttpUrl socketUrl = HttpUrl.get(WS_URL).newBuilder()
                .addQueryParameter("access_token", authToken)
                .build();
        Request request = new Request.Builder()
                .url(socketUrl)
                .build();
        pendingSocket = http.newWebSocket(request, new WebSocketListener() {
            @Override
            public void onOpen(@NonNull WebSocket webSocket, @NonNull Response response) {
                try {
                    JSONObject translation = new JSONObject()
                            .put("targetLanguageCode", socketLanguage)
                            .put("echoTargetLanguage", false);
                    // NOTE: input/outputAudioTranscription are deliberately ABSENT — captions are
                    // deferred and the minted token constraints omit them too. The
                    // two setups MUST match or the provider rejects the session.
                    //
                    // [CALL-TRANSLATE-APIVER-2] Keep the WebSocket setup semantically identical
                    // to the v1beta token constraint. The wire setup uses generationConfig while
                    // the token's REST constraint calls the same object `config`.
                    JSONObject generation = new JSONObject()
                            .put("responseModalities", new JSONArray().put("AUDIO"))
                            .put("translationConfig", translation);
                    JSONObject setup = new JSONObject()
                            .put("model", "models/" + MODEL)
                            .put("generationConfig", generation)
                            .put("sessionResumption", handle == null
                                    ? new JSONObject()
                                    : new JSONObject().put("handle", handle))
                            .put("contextWindowCompression", new JSONObject()
                                    .put("slidingWindow", new JSONObject()));
                    webSocket.send(new JSONObject().put("setup", setup).toString());
                } catch (Exception e) {
                    // L-1: exception CATEGORY only. Provider-derived strings can carry the frame.
                    failPrepare("setup_failed", errorCategory(e));
                }
            }

            @Override
            public void onMessage(@NonNull WebSocket webSocket, @NonNull String text) {
                handleProviderMessage(webSocket, text, socketLanguage);
            }

            @Override
            public void onFailure(@NonNull WebSocket webSocket, @NonNull Throwable t, Response response) {
                if (stopping) return;
                if (webSocket == pendingSocket && socket != null && webSocket != socket) {
                    // The LIVE socket survives, so targetLanguage is deliberately NOT touched —
                    // it must keep describing what the user is actually hearing.
                    pendingSocket = null;
                    emitJson("resume_failed", errorCategory(t),
                            pendingFailureExtra(socketLanguage, -1));
                    return;
                }
                if (webSocket != socket && webSocket != pendingSocket) return;
                failPrepare("provider_failed", errorCategory(t));
                emit("provider_error", errorCategory(t));
                stopInternal(true);
            }

            @Override
            public void onClosed(@NonNull WebSocket webSocket, int code, @NonNull String reason) {
                if (stopping) return;
                // D-5: the SAME pending-vs-live discrimination onFailure has. A provider that
                // refuses a switch token answers with a close frame (1008/1011 is the normal
                // shape), and killing a working translation for that defeats the whole
                // "failure is cheap" premise of make-before-break.
                if (webSocket == pendingSocket && socket != null && webSocket != socket) {
                    pendingSocket = null;
                    emitJson("resume_failed", "closed_" + code,
                            pendingFailureExtra(socketLanguage, code));
                    return;
                }
                if (webSocket != socket && webSocket != pendingSocket) return;
                // L-1: the provider's close `reason` string is provider-authored text and never
                // crosses the channel — the numeric code is the category.
                emit("provider_closed", "closed_" + code);
                stopInternal(true);
            }
        });
    }

    /** Shared by the pending-socket failure and close paths. Language CODES + counters only. */
    private JSONObject pendingFailureExtra(String socketLanguage, int closeCode) {
        JSONObject extra = new JSONObject();
        try {
            boolean wasSwitch = socketLanguage != null && !socketLanguage.equals(targetLanguage);
            extra.put("switching", wasSwitch);
            // Language CODES only (e.g. "es") — never content.
            if (wasSwitch) extra.put("attemptedLanguage", socketLanguage);
            extra.put("liveLanguage", targetLanguage == null ? "" : targetLanguage);
            if (closeCode >= 0) extra.put("closeCode", closeCode);
        } catch (Exception ignored) {}
        return extra;
    }

    /**
     * L-1: a stable, bounded category for an exception. NEVER {@code getMessage()} — org.json
     * embeds the offending payload in its message, and a provider frame contains base64 audio in
     * {@code inlineData.data}. No audio-derived content may cross the channel, ever.
     */
    private static String errorCategory(Throwable t) {
        if (t == null) return "unknown";
        String name = t.getClass().getSimpleName();
        return name == null || name.isEmpty() ? "unknown" : name;
    }

    private void handleProviderMessage(WebSocket webSocket, String text, String socketLanguage) {
        // D-4: an abandoned socket is neither the live one nor the pending one. Its frames are
        // dropped here so a late setupComplete from a cancelled cutover can never steal the
        // session or move `targetLanguage` away from what the user is actually hearing.
        if (webSocket != socket && webSocket != pendingSocket) return;
        try {
            JSONObject message = new JSONObject(text);
            if (message.has("setupComplete")) {
                WebSocket previous = socket;
                String previousLanguage = targetLanguage;
                boolean languageChanged = socketLanguage != null
                        && !socketLanguage.equals(previousLanguage);
                socket = webSocket;
                // COMMIT POINT. Only now — the provider has accepted this socket and it is the
                // live one — does the plugin's idea of the session language move. If the pending
                // socket had failed instead, the field still names the language the user hears,
                // so a later plain `resume` announces the right one.
                if (socketLanguage != null) targetLanguage = socketLanguage;
                if (pendingSocket == webSocket) pendingSocket = null;
                prepared = true;
                // [CALL-TRANSLATE-CRASH-1] Atomic take + crash-proof reply.
                MethodChannel.Result result = takePendingPrepare();
                if (result != null) safeReply(() -> result.success(true));
                if (previous != null && previous != webSocket) previous.close(1000, "resumed");
                emit("ready", null);
                if (previous != null && previous != webSocket && languageChanged) {
                    // Phase C cutover completed. Dart re-mutes via the A4 guard's own recovery
                    // path (first sustained translated PCM) — this event is the UI signal, not
                    // the audio one. Codes and timings only; never content.
                    JSONObject extra = new JSONObject();
                    try {
                        extra.put("previousLanguage", previousLanguage == null ? "" : previousLanguage);
                        extra.put("sinceLastAudioMs",
                                Math.max(0L, System.currentTimeMillis() - lastTranslatedPcmMs));
                    } catch (Exception ignored) {}
                    emitJson("language_switched", socketLanguage, extra);
                }
                return;
            }
            JSONObject resumption = message.optJSONObject("sessionResumptionUpdate");
            if (resumption != null && resumption.optBoolean("resumable", false)) {
                String next = resumption.optString("newHandle", "");
                if (!next.isEmpty()) resumeHandle = next;
            }
            if (message.has("goAway") && active && resumeHandle != null
                    && !resumeHandle.isEmpty() && pendingSocket == null) {
                emit("resume_token_needed", resumeHandle);
            }
            JSONObject content = message.optJSONObject("serverContent");
            if (content == null) return;
            // Transcription is disabled in setup; any outputTranscription that still arrives is
            // ignored on purpose — captions are deferred and content never leaves this method.
            JSONObject turn = content.optJSONObject("modelTurn");
            if (turn == null) return;
            JSONArray parts = turn.optJSONArray("parts");
            if (parts == null) return;
            for (int i = 0; i < parts.length(); i++) {
                JSONObject inline = parts.optJSONObject(i) == null ? null
                        : parts.optJSONObject(i).optJSONObject("inlineData");
                if (inline == null) continue;
                String data = inline.optString("data", "");
                if (!data.isEmpty()) playTranslated(Base64.decode(data, Base64.DEFAULT));
            }
        } catch (Exception e) {
            // L-1: FIXED category. `new JSONObject(rawProviderFrame)` throwing embeds the frame —
            // which carries base64 audio in inlineData.data — in its message. It never leaves here.
            emit("protocol_error", "provider_frame_parse");
        }
    }

    // ------------------------------------------------------------------------
    // A5 — decoded-audio callback: resample + enqueue ONLY. No network work here.
    // ------------------------------------------------------------------------

    @Override
    public void onWebRtcAudioTrackSamplesReady(JavaAudioDeviceModule.AudioSamples samples) {
        if (!active || socket == null || samples.getAudioFormat() != AudioFormat.ENCODING_PCM_16BIT) return;
        if (paid) applyOutputMute();
        byte[] chunk = resampleTo16k(samples.getData(), samples.getSampleRate(), samples.getChannelCount());
        if (chunk == null) return;
        enqueueUplink(chunk);
    }

    /** Bounded queue; on overflow the OLDEST chunk goes (stale audio is worse than a gap). */
    private void enqueueUplink(byte[] chunk) {
        synchronized (queueLock) {
            while (uplinkQueue.size() >= UPLINK_QUEUE_CAPACITY) {
                uplinkQueue.pollFirst();
                pcmDropCount++;
            }
            uplinkQueue.addLast(chunk);
            if (uplinkQueue.size() > queuePeak) queuePeak = uplinkQueue.size();
            queueLock.notifyAll();
        }
    }

    private void startSenderThread() {
        stopSenderThread();
        senderRunning = true;
        senderThread = new Thread(this::senderLoop, "avatok-xlate-uplink");
        senderThread.setDaemon(true);
        senderThread.start();
    }

    private void stopSenderThread() {
        senderRunning = false;
        Thread t = senderThread;
        senderThread = null;
        synchronized (queueLock) {
            uplinkQueue.clear();
            queueLock.notifyAll();
        }
        if (t != null) t.interrupt();
    }

    private void senderLoop() {
        while (senderRunning) {
            byte[] chunk;
            synchronized (queueLock) {
                while (senderRunning && uplinkQueue.isEmpty()) {
                    try {
                        queueLock.wait(200L);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                        return;
                    }
                }
                if (!senderRunning) return;
                chunk = uplinkQueue.pollFirst();
            }
            if (chunk == null) continue;
            WebSocket ws = socket;
            if (ws == null || !active) continue;
            try {
                JSONObject audio = new JSONObject()
                        .put("data", Base64.encodeToString(chunk, Base64.NO_WRAP))
                        .put("mimeType", "audio/pcm;rate=16000");
                boolean queued = ws.send(new JSONObject()
                        .put("realtimeInput", new JSONObject().put("audio", audio)).toString());
                if (queued) uplinkSentCount++;
                else uplinkFailCount++;
            } catch (Exception e) {
                uplinkFailCount++;
                // L-1: fixed category. The chunk being encoded IS audio; its message must not leak.
                emit("protocol_error", "uplink_encode_failed");
            }
        }
    }

    /**
     * Produces exact 100 ms (3200-byte) PCM16 mono chunks, and tracks whether the far end is
     * actually speaking (peak amplitude) so the dead-air guard never fires on genuine silence.
     */
    private byte[] resampleTo16k(byte[] input, int sampleRate, int channels) {
        if (input == null || input.length < 2 || sampleRate <= 0 || channels <= 0) return null;
        int peak = 0;
        synchronized (audioLock) {
            if (lastInputRate != sampleRate) {
                resamplePhase = 0;
                lastInputRate = sampleRate;
                pcm16k.reset();
            }
            int frameBytes = channels * 2;
            for (int offset = 0; offset + frameBytes <= input.length; offset += frameBytes) {
                int mixed = 0;
                for (int channel = 0; channel < channels; channel++) {
                    int p = offset + channel * 2;
                    mixed += (short) ((input[p] & 0xff) | (input[p + 1] << 8));
                }
                short mono = (short) (mixed / channels);
                int magnitude = mono < 0 ? -mono : mono;
                if (magnitude > peak) peak = magnitude;
                resamplePhase += 16_000;
                if (resamplePhase >= sampleRate) {
                    resamplePhase -= sampleRate;
                    pcm16k.write(mono & 0xff);
                    pcm16k.write((mono >> 8) & 0xff);
                }
            }
            if (peak >= VOICE_PEAK_THRESHOLD) lastVoiceInputMs = System.currentTimeMillis();
            if (pcm16k.size() < 3200) return null;
            byte[] all = pcm16k.toByteArray();
            byte[] out = new byte[3200];
            System.arraycopy(all, 0, out, 0, 3200);
            pcm16k.reset();
            if (all.length > 3200) pcm16k.write(all, 3200, all.length - 3200);
            return out;
        }
    }

    private void ensureTranslatedTrack() {
        if (translatedTrack != null) return;
        int min = AudioTrack.getMinBufferSize(24_000, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT);
        translatedTrack = new AudioTrack.Builder()
                .setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build())
                .setAudioFormat(new AudioFormat.Builder()
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .setSampleRate(24_000)
                        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                        .build())
                .setBufferSizeInBytes(Math.max(min * 2, 9600))
                .setTransferMode(AudioTrack.MODE_STREAM)
                .build();
        translatedTrack.play();
    }

    private void playTranslated(byte[] pcm24k) {
        if (!active || pcm24k == null || pcm24k.length == 0) return;
        ensureTranslatedTrack();
        int written;
        try {
            written = translatedTrack.write(pcm24k, 0, pcm24k.length, AudioTrack.WRITE_NON_BLOCKING);
        } catch (Exception e) {
            playbackErrorCount++;
            return;
        }
        if (written < 0) {
            playbackErrorCount++;
        } else if (written < pcm24k.length) {
            shortWriteCount++;
            shortWriteBytes += (pcm24k.length - written);
        }
        translatedChunkCount++;
        onTranslatedPcm(pcm24k.length);
    }

    // ------------------------------------------------------------------------
    // A4 — dead-air guard
    // ------------------------------------------------------------------------

    /**
     * Restores or re-mutes the ORIGINAL decoded call audio. Public so Phase C's mid-call
     * language switch can hold the original audio open across the cutover
     * ({@code setFallbackToOriginal(true, REASON_SWITCHING)}); the guard's own
     * recovery path re-mutes automatically once translated PCM flows again.
     *
     * @param fallback true = play the original speaker (translation muted-out),
     *                 false = return to translated-only playback.
     * @param reason   short category tag (e.g. {@code dead_air}, {@code switching}).
     *                 Never content — it is emitted to Dart and telemetry.
     */
    public void setFallbackToOriginal(boolean fallback, String reason) {
        String tag = (reason == null || reason.isEmpty()) ? REASON_DEAD_AIR : reason;
        long now = System.currentTimeMillis();
        boolean changedOn = false;
        boolean changedOff = false;
        boolean deadAir = false;
        long duration = 0L;
        int cyclesInWindow = 0;
        boolean degraded = false;

        synchronized (fallbackLock) {
            if (fallback) {
                if (fallbackActive) return;
                fallbackActive = true;
                fallbackReason = tag;
                fallbackStartedAtMs = now;
                recoverPcmBytes = 0;
                // D-2: ONLY dead air is a stall. A language switch, a route change or a focus
                // blip is a deliberate fallback and must not inflate stall_count / stall_ms.
                deadAir = REASON_DEAD_AIR.equals(tag);
                fallbackWasDeadAir = deadAir;
                if (deadAir) stallCount++; else fallbackCount++;
                changedOn = true;
            } else {
                if (!fallbackActive) return;
                fallbackActive = false;
                duration = now - fallbackStartedAtMs;
                recoverPcmBytes = 0;
                tag = fallbackReason == null ? tag : fallbackReason;
                fallbackReason = null;
                // The kind is decided by the fallback that OPENED, not by this call's reason —
                // recovery is driven by translated PCM and passes reason == null.
                deadAir = fallbackWasDeadAir;
                fallbackWasDeadAir = false;
                if (deadAir) {
                    stallMsTotal += duration;
                    // D-2: the degraded-cycle window is a DEAD-AIR window. Two clean language
                    // switches inside 60 s must never produce "Translation quality is unstable".
                    stallCycleAt[stallCycleIndex % stallCycleAt.length] = now;
                    stallCycleIndex++;
                    for (long at : stallCycleAt) {
                        if (at > 0 && now - at <= DEGRADED_WINDOW_MS) cyclesInWindow++;
                    }
                    if (cyclesInWindow >= DEGRADED_CYCLES
                            && now - lastDegradedEmitMs >= DEGRADED_REEMIT_MS) {
                        lastDegradedEmitMs = now;
                        degraded = true;
                    }
                } else {
                    fallbackMsTotal += duration;
                }
                changedOff = true;
            }
        }

        // D-3: force a fresh AudioTrack lookup across the transition. flutter_webrtc recreates
        // its output track on route changes; restoring volume on a stale handle would leave the
        // live one at 0 — a permanently silent call.
        lastOutputLookupMs = 0L;
        // The mute itself lives outside the lock; it only touches the WebRTC AudioTrack volume.
        applyOutputMute();

        if (changedOn) {
            JSONObject extra = new JSONObject();
            try {
                extra.put("reason", tag);
                extra.put("deadAir", deadAir);
                extra.put("stallCount", stallCount);
                extra.put("fallbackCount", fallbackCount);
                extra.put("sinceLastAudioMs", Math.max(0L, now - lastTranslatedPcmMs));
            } catch (Exception ignored) {}
            emitJson("stalled", tag, extra);
        }
        if (changedOff) {
            JSONObject extra = new JSONObject();
            try {
                extra.put("reason", tag);
                extra.put("deadAir", deadAir);
                // stallDurationMs stays the duration of THIS fallback whatever its kind (Dart
                // already reads it); only the accumulated stall totals are dead-air-only.
                extra.put("stallDurationMs", duration);
                extra.put("stallCount", stallCount);
                extra.put("stallMsTotal", stallMsTotal);
                extra.put("fallbackCount", fallbackCount);
                extra.put("fallbackMsTotal", fallbackMsTotal);
            } catch (Exception ignored) {}
            emitJson("recovered", tag, extra);
            if (degraded) {
                JSONObject deg = new JSONObject();
                try {
                    deg.put("cyclesInWindow", cyclesInWindow);
                    deg.put("windowMs", DEGRADED_WINDOW_MS);
                    deg.put("stallCount", stallCount);
                    deg.put("stallMsTotal", stallMsTotal);
                } catch (Exception ignored) {}
                emitJson("stall_degraded", REASON_DEAD_AIR, deg);
            }
        }
    }

    /** Called on every translated chunk; ends a fallback once PCM is sustained (anti-flap). */
    private void onTranslatedPcm(int bytes) {
        long now = System.currentTimeMillis();
        lastTranslatedPcmMs = now;
        if (!fallbackActive) return;
        boolean recover = false;
        synchronized (fallbackLock) {
            if (!fallbackActive) return;
            recoverPcmBytes += bytes;
            if (recoverPcmBytes >= RECOVER_PCM_BYTES
                    && now - fallbackStartedAtMs >= MIN_FALLBACK_MS) {
                recover = true;
            }
        }
        if (recover) setFallbackToOriginal(false, null);
    }

    private void startGuardThread() {
        stopGuardThread();
        guardRunning = true;
        guardThread = new Thread(this::guardLoop, "avatok-xlate-guard");
        guardThread.setDaemon(true);
        guardThread.start();
    }

    private void stopGuardThread() {
        guardRunning = false;
        Thread t = guardThread;
        guardThread = null;
        if (t != null) t.interrupt();
    }

    private void guardLoop() {
        while (guardRunning) {
            try {
                Thread.sleep(GUARD_TICK_MS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            }
            if (!guardRunning) return;
            long now = System.currentTimeMillis();
            // Input counts as flowing if the far end spoke since the last translated chunk, or
            // is speaking right now. Genuine silence on the call therefore never trips the guard.
            boolean inputFlowing = lastVoiceInputMs > lastTranslatedPcmMs
                    || (lastVoiceInputMs > 0 && now - lastVoiceInputMs <= INPUT_ACTIVE_WINDOW_MS);
            if (active && paid && !fallbackActive && inputFlowing
                    && now - lastTranslatedPcmMs >= STALL_THRESHOLD_MS) {
                // Dead air: the far end is speaking but no translated audio has arrived.
                setFallbackToOriginal(true, REASON_DEAD_AIR);
            }
            if (active && now - lastStatsEmitMs >= STATS_INTERVAL_MS) emitStats(false);
        }
    }

    /**
     * [CALL-TRANSLATE-PROBE-OBS-1] Last reason {@link #resolvePlaybackAdapter} returned null.
     *
     * <p>The resolver has FIVE distinct null exits and, before 2026-08-05, every one of them
     * returned a bare `false` to `isSupported` with nothing written anywhere. That produced the
     * 2026-08-04 dead end: both a real motorola edge 70 fusion (build 10507) AND the emulator
     * reported `call_translation_pill_visibility reason=native_unsupported` with
     * `call_translation_native_probe result=unsupported attempts=5`, and there was no way to tell
     * whether flutter_webrtc had not attached yet, the reflected field had been renamed by a
     * package bump, or R8 had stripped it. The same phone reported `shown` on build 10506 an hour
     * earlier, so this is a real regression that the telemetry could not localise.
     *
     * <p>Never make this silent again: every exit path must set a distinct token here.
     */
    private volatile String lastAdapterResolveFailure = "none";

    /**
     * [CALL-TRANSLATE-BIND-1 2026-08-05] The flutter_webrtc plugin belonging to the engine we
     * are actually running in, set by MainActivity.configureFlutterEngine.
     *
     * <p>Preferred over {@link FlutterWebRTCPlugin#sharedSingleton}, which is assigned in that
     * plugin's CONSTRUCTOR — so whichever instance was built most recently owns the static,
     * regardless of which one is running the call. Every Flutter engine created over the
     * process lifetime (activity recreation, a cold start from a notification tap) constructs a
     * fresh one and silently steals the pointer, and the stolen-from instance is the one that
     * actually ran {@code initialize()} and therefore the only one holding a non-null adapter.
     * That is the shape of the 2026-08-04 failure: `adapter_field_null` on both devices, with
     * the translate control never appearing.
     */
    public static volatile FlutterWebRTCPlugin boundWebRtcPlugin;

    /** Which source resolved the plugin last — reported alongside the failure cause. */
    private volatile String lastAdapterSource = "none";

    private PlaybackSamplesReadyCallbackAdapter resolvePlaybackAdapter(boolean emitFailure) {
        try {
            // Engine-bound instance first; the global static only as a fallback.
            FlutterWebRTCPlugin plugin = boundWebRtcPlugin;
            lastAdapterSource = plugin != null ? "engine_bound" : "shared_singleton";
            if (plugin == null) plugin = FlutterWebRTCPlugin.sharedSingleton;
            else if (FlutterWebRTCPlugin.sharedSingleton != plugin) {
                // Direct proof that the static was pointing somewhere else. If this
                // ever shows up in telemetry, the old code could not have worked.
                lastAdapterSource = "engine_bound_singleton_mismatch";
            }
            if (plugin == null) {
                lastAdapterResolveFailure = "webrtc_singleton_null";
                return null;
            }
            Field handlerField = FlutterWebRTCPlugin.class.getDeclaredField("methodCallHandler");
            handlerField.setAccessible(true);
            Object handler = handlerField.get(plugin);
            if (handler == null) {
                lastAdapterResolveFailure = "method_call_handler_null";
                return null;
            }
            Field adapterField = handler.getClass().getField("playbackSamplesReadyCallbackAdapter");
            Object adapter = adapterField.get(handler);
            if (adapter == null) {
                lastAdapterResolveFailure = "adapter_field_null";
                return null;
            }
            if (!(adapter instanceof PlaybackSamplesReadyCallbackAdapter)) {
                // Two copies of the class on the classpath, or a package bump changed the type.
                lastAdapterResolveFailure =
                        "adapter_type_mismatch:" + adapter.getClass().getName();
                return null;
            }
            lastAdapterResolveFailure = "none";
            return (PlaybackSamplesReadyCallbackAdapter) adapter;
        } catch (Exception e) {
            // NoSuchFieldException here = the reflected field was renamed by a flutter_webrtc
            // bump or stripped by R8. Carry the exception class so the two are distinguishable.
            lastAdapterResolveFailure = "exception:" + e.getClass().getSimpleName();
            if (emitFailure) emit("bridge_error", errorCategory(e));
            return null;
        }
    }

    /** Single decision point: original audio is muted only while paid AND not falling back. */
    private void applyOutputMute() {
        muteWebRtcOutput(paid && active && !fallbackActive);
    }

    /**
     * Mutes/restores only flutter_webrtc's decoded incoming playback sink.
     *
     * <p>D-3: the cached handle can be up to 1 s stale and flutter_webrtc recreates its
     * AudioTrack on route changes. Callers force a fresh lookup across any transition by setting
     * {@link #lastOutputLookupMs} to 0; on top of that, an UNMUTE also restores the previously
     * cached track when the lookup returned a different (or no) one, so a track we muted can
     * never be left at volume 0.
     */
    private void muteWebRtcOutput(boolean mute) {
        AudioTrack previous = webRtcOutputTrack;
        long now = System.currentTimeMillis();
        if (webRtcOutputTrack == null || lastOutputLookupMs == 0L
                || now - lastOutputLookupMs > 1000) {
            lastOutputLookupMs = now;
            try {
                FlutterWebRTCPlugin plugin = FlutterWebRTCPlugin.sharedSingleton;
                Field handlerField = FlutterWebRTCPlugin.class.getDeclaredField("methodCallHandler");
                handlerField.setAccessible(true);
                Object handler = handlerField.get(plugin);
                Field admField = handler.getClass().getDeclaredField("audioDeviceModule");
                admField.setAccessible(true);
                Object adm = admField.get(handler);
                Field outputField = adm.getClass().getDeclaredField("audioOutput");
                outputField.setAccessible(true);
                Object output = outputField.get(adm);
                Field trackField = output.getClass().getDeclaredField("audioTrack");
                trackField.setAccessible(true);
                Object track = trackField.get(output);
                if (track instanceof AudioTrack) webRtcOutputTrack = (AudioTrack) track;
            } catch (Exception ignored) {
                webRtcOutputTrack = null;
            }
        }
        AudioTrack track = webRtcOutputTrack;
        if (track != null) {
            try { track.setVolume(mute ? 0f : 1f); } catch (Exception ignored) {}
        }
        if (!mute && previous != null && previous != track) {
            // A track we may have muted was replaced (or the lookup failed). Restore it too —
            // leaving it at 0 is the permanently-silent-call failure.
            try { previous.setVolume(1f); } catch (Exception ignored) {}
        }
    }

    /**
     * [CALL-TRANSLATE-CRASH-1 2026-08-16] Atomic hand-off of the stored prepare
     * reply. `pendingPrepare` used to be read-then-nulled from TWO threads with
     * no lock — the OkHttp reader thread (setupComplete success) and whichever
     * thread called {@link #failPrepare} — so both could grab the SAME
     * MethodChannel.Result and reply to it twice. The second reply throws
     * java.lang.IllegalStateException("Reply already submitted"), which is an
     * uncaught FATAL on Android: the first time translation ever started
     * end-to-end in production (2026-08-16 12:28 UTC), it crashed BOTH phones
     * ~9ms after session_created. One synchronized taker means exactly one
     * winner; the safeReply guard below makes any residual double reply a no-op
     * instead of a process death.
     */
    private synchronized MethodChannel.Result takePendingPrepare() {
        MethodChannel.Result result = pendingPrepare;
        pendingPrepare = null;
        return result;
    }

    /** Reply on the main thread; never let a duplicate reply kill the process. */
    private void safeReply(Runnable reply) {
        main.post(() -> {
            try {
                reply.run();
            } catch (IllegalStateException ignored) {
                // Reply already submitted — the other racer won. Losing this
                // reply is harmless; crashing the call was not.
            }
        });
    }

    private void failPrepare(String code, String message) {
        MethodChannel.Result result = takePendingPrepare();
        if (result != null) safeReply(() -> result.error(code, message == null ? code : message, null));
    }

    private void emit(String type, String value) {
        emitJson(type, value, null);
    }

    /**
     * Emits {@code {"type":..,"value":..,<extra keys>}}. Extra keys are counters/timings only —
     * never transcript text or anything audio-derived.
     */
    private void emitJson(String type, String value, JSONObject extra) {
        EventChannel.EventSink sink = eventSink;
        if (sink == null) return;
        main.post(() -> {
            JSONObject payload = new JSONObject();
            try {
                payload.put("type", type);
                if (value != null) payload.put("value", value);
                if (extra != null) {
                    JSONArray names = extra.names();
                    if (names != null) {
                        for (int i = 0; i < names.length(); i++) {
                            String key = names.optString(i);
                            if (key != null && !key.isEmpty()) payload.put(key, extra.opt(key));
                        }
                    }
                }
                sink.success(payload.toString());
            } catch (Exception ignored) {}
        });
    }

    private void resetTelemetry() {
        synchronized (fallbackLock) {
            fallbackActive = false;
            fallbackReason = null;
            fallbackWasDeadAir = false;
            fallbackStartedAtMs = 0L;
            recoverPcmBytes = 0;
            stallCycleIndex = 0;
            lastDegradedEmitMs = 0L;
            for (int i = 0; i < stallCycleAt.length; i++) stallCycleAt[i] = 0L;
        }
        synchronized (queueLock) {
            uplinkQueue.clear();
        }
        long now = System.currentTimeMillis();
        sessionStartedAtMs = now;
        lastStatsEmitMs = now;
        lastTranslatedPcmMs = now;
        lastVoiceInputMs = 0L;
        stallCount = 0;
        stallMsTotal = 0L;
        fallbackCount = 0;
        fallbackMsTotal = 0L;
        pcmDropCount = 0;
        uplinkFailCount = 0;
        uplinkSentCount = 0;
        queuePeak = 0;
        shortWriteCount = 0;
        shortWriteBytes = 0L;
        playbackErrorCount = 0;
        translatedChunkCount = 0;
    }

    /** Counters only. Emitted periodically and once with {@code final:true} at session end. */
    private void emitStats(boolean isFinal) {
        long now = System.currentTimeMillis();
        lastStatsEmitMs = now;
        JSONObject stats = new JSONObject();
        try {
            // D-2: stall* is DEAD AIR only; deliberate fallbacks (switch/route/focus) are
            // counted separately so the p95 stall thresholds are not poisoned by them.
            stats.put("stallCount", stallCount);
            stats.put("stallMsTotal", stallMsTotal);
            stats.put("fallbackCount", fallbackCount);
            stats.put("fallbackMsTotal", fallbackMsTotal);
            stats.put("pcmDropCount", pcmDropCount);
            stats.put("uplinkFailCount", uplinkFailCount);
            stats.put("uplinkSentCount", uplinkSentCount);
            stats.put("queuePeak", queuePeak);
            stats.put("queueCapacity", UPLINK_QUEUE_CAPACITY);
            stats.put("shortWriteCount", shortWriteCount);
            stats.put("shortWriteBytes", shortWriteBytes);
            stats.put("playbackErrorCount", playbackErrorCount);
            stats.put("translatedChunkCount", translatedChunkCount);
            stats.put("uptimeMs", sessionStartedAtMs == 0L ? 0L : now - sessionStartedAtMs);
            stats.put("fallbackActive", fallbackActive);
            stats.put("final", isFinal);
        } catch (Exception ignored) {}
        emitJson("stats", isFinal ? "final" : "periodic", stats);
    }

    private void stopInternal(boolean providerFailure) {
        boolean wasRunning = active || prepared || senderRunning || guardRunning;
        stopping = true;
        active = false;
        paid = false;
        prepared = false;
        prepareGeneration++; // D-7: invalidate any armed prepare timeout
        stopGuardThread();
        stopSenderThread();
        if (wasRunning) emitStats(true);
        synchronized (fallbackLock) {
            fallbackActive = false;
            fallbackReason = null;
            fallbackWasDeadAir = false;
        }
        failPrepare("stopped", "Translation stopped");
        // D-3: `active=false` above stops the callback refreshing the cached output track, so the
        // handle here may name an AudioTrack flutter_webrtc has already replaced (a route change
        // is exactly when it does). Force a fresh lookup, then unmute BOTH the live track and the
        // one we were holding — restoring the wrong one leaves the call permanently silent.
        lastOutputLookupMs = 0L;
        muteWebRtcOutput(false);
        webRtcOutputTrack = null;
        lastOutputLookupMs = 0L;
        WebSocket oldSocket = socket;
        socket = null;
        WebSocket oldPendingSocket = pendingSocket;
        pendingSocket = null;
        if (oldSocket != null) oldSocket.close(1000, providerFailure ? "provider failure" : "stopped");
        if (oldPendingSocket != null && oldPendingSocket != oldSocket) oldPendingSocket.close(1000, "stopped");
        if (translatedTrack != null) {
            try { translatedTrack.pause(); } catch (Exception ignored) {}
            try { translatedTrack.flush(); } catch (Exception ignored) {}
            try { translatedTrack.release(); } catch (Exception ignored) {}
            translatedTrack = null;
        }
        synchronized (audioLock) {
            pcm16k.reset();
            resamplePhase = 0;
            lastInputRate = 0;
        }
        authToken = null;
        targetLanguage = null;
        resumeHandle = null;
    }

    private void detachPlaybackCallback() {
        if (attached && playbackAdapter != null) {
            try { playbackAdapter.removeCallback(this); } catch (Exception ignored) {}
        }
        attached = false;
        playbackAdapter = null;
    }
}
