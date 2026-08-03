package ai.avatok.calltranslation;

import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioManager;
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
 * incoming call audio to PCM16/16 kHz, and sends it directly to a constrained
 * Gemini Live socket. The original WebRTC AudioTrack is muted only after the
 * server has charged the first minute; translated PCM16/24 kHz is played on a
 * separate voice-call AudioTrack. No second microphone or CallRoom PCM relay is
 * used.
 */
public final class CallTranslationAudioPlugin implements FlutterPlugin,
        MethodChannel.MethodCallHandler, EventChannel.StreamHandler,
        JavaAudioDeviceModule.PlaybackSamplesReadyCallback {

    private static final String METHOD = "avatok/call_translation_audio";
    private static final String EVENTS = "avatok/call_translation_audio_events";
    private static final String MODEL = "gemini-3.5-live-translate-preview";
    private static final String WS_URL = "wss://generativelanguage.googleapis.com/ws/"
            + "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

    private final Handler main = new Handler(Looper.getMainLooper());
    private final Object audioLock = new Object();
    private final ByteArrayOutputStream pcm16k = new ByteArrayOutputStream(4096);
    private final OkHttpClient http = new OkHttpClient.Builder()
            .pingInterval(20, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .build();

    private MethodChannel methodChannel;
    private EventChannel eventChannel;
    private EventChannel.EventSink eventSink;
    private PlaybackSamplesReadyCallbackAdapter playbackAdapter;
    private WebSocket socket;
    private WebSocket pendingSocket;
    private AudioTrack translatedTrack;
    private AudioTrack webRtcOutputTrack;
    private MethodChannel.Result pendingPrepare;
    private boolean attached;
    private boolean prepared;
    private boolean active;
    private boolean paid;
    private boolean stopping;
    private int resamplePhase;
    private int lastInputRate;
    private long lastOutputLookupMs;
    private String authToken;
    private String targetLanguage;
    private String resumeHandle;

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
            case "isSupported":
                result.success(resolvePlaybackAdapter(false) != null);
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
                    muteWebRtcOutput(true);
                    result.success(true);
                }
                break;
            case "resume":
                String replacement = call.argument("token");
                String handle = call.argument("handle");
                if (replacement == null || replacement.isEmpty() || handle == null || handle.isEmpty()) {
                    result.error("invalid_resume", "token and handle are required", null);
                } else {
                    authToken = replacement;
                    connectSocket(handle);
                    result.success(true);
                }
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
        connectSocket(null);

        main.postDelayed(() -> {
            if (pendingPrepare != null) {
                failPrepare("provider_timeout", "Gemini setup did not complete in time");
                stopInternal(true);
            }
        }, 15_000);
    }

    private void connectSocket(String handle) {
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
                            .put("targetLanguageCode", targetLanguage)
                            .put("echoTargetLanguage", false);
                    JSONObject generation = new JSONObject()
                            .put("responseModalities", new JSONArray().put("AUDIO"))
                            .put("inputAudioTranscription", new JSONObject())
                            .put("outputAudioTranscription", new JSONObject())
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
                    failPrepare("setup_failed", e.getMessage());
                }
            }

            @Override
            public void onMessage(@NonNull WebSocket webSocket, @NonNull String text) {
                handleProviderMessage(webSocket, text);
            }

            @Override
            public void onFailure(@NonNull WebSocket webSocket, @NonNull Throwable t, Response response) {
                if (stopping) return;
                if (webSocket == pendingSocket && socket != null) {
                    pendingSocket = null;
                    emit("resume_failed", t.getMessage());
                    return;
                }
                if (webSocket != socket && webSocket != pendingSocket) return;
                failPrepare("provider_failed", t.getMessage());
                emit("provider_error", t.getMessage());
                stopInternal(true);
            }

            @Override
            public void onClosed(@NonNull WebSocket webSocket, int code, @NonNull String reason) {
                if (stopping) return;
                if (webSocket != socket && webSocket != pendingSocket) return;
                emit("provider_closed", reason);
                stopInternal(true);
            }
        });
    }

    private void handleProviderMessage(WebSocket webSocket, String text) {
        try {
            JSONObject message = new JSONObject(text);
            if (message.has("setupComplete")) {
                WebSocket previous = socket;
                socket = webSocket;
                if (pendingSocket == webSocket) pendingSocket = null;
                prepared = true;
                MethodChannel.Result result = pendingPrepare;
                pendingPrepare = null;
                if (result != null) main.post(() -> result.success(true));
                if (previous != null && previous != webSocket) previous.close(1000, "resumed");
                emit("ready", null);
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
            JSONObject transcription = content.optJSONObject("outputTranscription");
            if (transcription != null) emit("caption", transcription.optString("text", ""));
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
            emit("protocol_error", e.getMessage());
        }
    }

    @Override
    public void onWebRtcAudioTrackSamplesReady(JavaAudioDeviceModule.AudioSamples samples) {
        if (!active || socket == null || samples.getAudioFormat() != AudioFormat.ENCODING_PCM_16BIT) return;
        if (paid) muteWebRtcOutput(true);
        byte[] chunk = resampleTo16k(samples.getData(), samples.getSampleRate(), samples.getChannelCount());
        if (chunk == null) return;
        try {
            JSONObject audio = new JSONObject()
                    .put("data", Base64.encodeToString(chunk, Base64.NO_WRAP))
                    .put("mimeType", "audio/pcm;rate=16000");
            socket.send(new JSONObject().put("realtimeInput", new JSONObject().put("audio", audio)).toString());
        } catch (Exception e) {
            emit("protocol_error", e.getMessage());
        }
    }

    /** Produces exact 100 ms (3200-byte) PCM16 mono chunks. */
    private byte[] resampleTo16k(byte[] input, int sampleRate, int channels) {
        if (input == null || input.length < 2 || sampleRate <= 0 || channels <= 0) return null;
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
                resamplePhase += 16_000;
                if (resamplePhase >= sampleRate) {
                    resamplePhase -= sampleRate;
                    pcm16k.write(mono & 0xff);
                    pcm16k.write((mono >> 8) & 0xff);
                }
            }
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
        translatedTrack.write(pcm24k, 0, pcm24k.length, AudioTrack.WRITE_NON_BLOCKING);
    }

    private PlaybackSamplesReadyCallbackAdapter resolvePlaybackAdapter(boolean emitFailure) {
        try {
            FlutterWebRTCPlugin plugin = FlutterWebRTCPlugin.sharedSingleton;
            if (plugin == null) return null;
            Field handlerField = FlutterWebRTCPlugin.class.getDeclaredField("methodCallHandler");
            handlerField.setAccessible(true);
            Object handler = handlerField.get(plugin);
            if (handler == null) return null;
            Field adapterField = handler.getClass().getField("playbackSamplesReadyCallbackAdapter");
            Object adapter = adapterField.get(handler);
            return adapter instanceof PlaybackSamplesReadyCallbackAdapter
                    ? (PlaybackSamplesReadyCallbackAdapter) adapter : null;
        } catch (Exception e) {
            if (emitFailure) emit("bridge_error", e.getMessage());
            return null;
        }
    }

    /** Mutes/restores only flutter_webrtc's decoded incoming playback sink. */
    private void muteWebRtcOutput(boolean mute) {
        long now = System.currentTimeMillis();
        if (webRtcOutputTrack == null || now - lastOutputLookupMs > 1000) {
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
        if (webRtcOutputTrack != null) {
            try { webRtcOutputTrack.setVolume(mute ? 0f : 1f); } catch (Exception ignored) {}
        }
    }

    private void failPrepare(String code, String message) {
        MethodChannel.Result result = pendingPrepare;
        pendingPrepare = null;
        if (result != null) main.post(() -> result.error(code, message == null ? code : message, null));
    }

    private void emit(String type, String value) {
        EventChannel.EventSink sink = eventSink;
        if (sink == null) return;
        main.post(() -> {
            JSONObject payload = new JSONObject();
            try {
                payload.put("type", type);
                if (value != null) payload.put("value", value);
                sink.success(payload.toString());
            } catch (Exception ignored) {}
        });
    }

    private void stopInternal(boolean providerFailure) {
        stopping = true;
        active = false;
        paid = false;
        prepared = false;
        failPrepare("stopped", "Translation stopped");
        muteWebRtcOutput(false);
        webRtcOutputTrack = null;
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
