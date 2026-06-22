package ai.avatok.avavoiceaudio

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.AutomaticGainControl
import android.media.audiofx.NoiseSuppressor
import android.os.Handler
import android.os.Looper
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.atomic.AtomicBoolean

/**
 * AvaVoiceAudioPlugin — a full-duplex voice-call audio engine with PLATFORM echo
 * cancellation, for the online Gemini Live "AI Voice Agent" call.
 *
 * Why this exists: the previous path (the `record` plugin for the mic +
 * `flutter_pcm_sound` for Ava's audio) used two SEPARATE audio sessions — the mic's
 * hardware AEC referenced the voice-comm output, but Ava's audio played on the MEDIA
 * stream, so the AEC never cancelled her. On loudspeaker Ava heard herself and
 * answered herself. The fix is to put BOTH capture and playback on ONE
 * communication audio session so the platform AcousticEchoCanceler removes Ava's
 * voice from the mic → true full-duplex barge-in on speaker.
 *
 *  - Capture: AudioRecord(VOICE_COMMUNICATION) @ micSampleRate, with
 *    AcousticEchoCanceler + NoiseSuppressor + AutomaticGainControl attached to its
 *    session. Frames stream to Dart over the EventChannel (raw PCM16 bytes).
 *  - Playback: AudioTrack(USAGE_VOICE_COMMUNICATION / CONTENT_TYPE_SPEECH) @
 *    playSampleRate, fed Ava's PCM via the `feed` method.
 *  - Mode: AudioManager.MODE_IN_COMMUNICATION while the call is live; speaker route
 *    is user-controlled via `setSpeaker`.
 *
 * Channel: `avatok/voice_audio` (methods) + `avatok/voice_audio/mic` (mic PCM events).
 */
class AvaVoiceAudioPlugin : FlutterPlugin, MethodChannel.MethodCallHandler,
    EventChannel.StreamHandler {

    companion object {
        const val METHOD_CHANNEL = "avatok/voice_audio"
        const val EVENT_CHANNEL = "avatok/voice_audio/mic"
    }

    private var methodChannel: MethodChannel? = null
    private var eventChannel: EventChannel? = null
    private var appContext: Context? = null
    private val main = Handler(Looper.getMainLooper())

    private var micSink: EventChannel.EventSink? = null

    // Engine state
    private val running = AtomicBoolean(false)
    private var record: AudioRecord? = null
    private var track: AudioTrack? = null
    private var aec: AcousticEchoCanceler? = null
    private var ns: NoiseSuppressor? = null
    private var agc: AutomaticGainControl? = null
    private var captureThread: Thread? = null
    private var playThread: Thread? = null
    private val playQueue = LinkedBlockingQueue<ByteArray>()
    private var prevAudioMode = AudioManager.MODE_NORMAL

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        appContext = binding.applicationContext
        methodChannel = MethodChannel(binding.binaryMessenger, METHOD_CHANNEL).also {
            it.setMethodCallHandler(this)
        }
        eventChannel = EventChannel(binding.binaryMessenger, EVENT_CHANNEL).also {
            it.setStreamHandler(this)
        }
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        stopEngine()
        methodChannel?.setMethodCallHandler(null)
        eventChannel?.setStreamHandler(null)
        methodChannel = null
        eventChannel = null
        appContext = null
    }

    override fun onListen(arguments: Any?, sink: EventChannel.EventSink?) { micSink = sink }
    override fun onCancel(arguments: Any?) { micSink = null }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "isSupported" -> result.success(true)
            "start" -> {
                val micRate = (call.argument<Int>("micSampleRate")) ?: 16000
                val playRate = (call.argument<Int>("playSampleRate")) ?: 24000
                val speaker = (call.argument<Boolean>("speaker")) ?: true
                result.success(startEngine(micRate, playRate, speaker))
            }
            "feed" -> {
                val bytes = call.argument<ByteArray>("bytes")
                if (bytes != null && running.get()) playQueue.offer(bytes)
                result.success(null)
            }
            "setSpeaker" -> {
                setSpeaker(call.argument<Boolean>("on") ?: true)
                result.success(null)
            }
            "stop" -> { stopEngine(); result.success(null) }
            else -> result.notImplemented()
        }
    }

    private fun audioManager(): AudioManager? =
        appContext?.getSystemService(Context.AUDIO_SERVICE) as? AudioManager

    private fun setSpeaker(on: Boolean) {
        try {
            val am = audioManager() ?: return
            am.mode = AudioManager.MODE_IN_COMMUNICATION
            @Suppress("DEPRECATION")
            am.isSpeakerphoneOn = on
        } catch (_: Throwable) {}
    }

    private fun startEngine(micRate: Int, playRate: Int, speaker: Boolean): Boolean {
        if (running.get()) return true
        try {
            val am = audioManager() ?: return false
            prevAudioMode = am.mode
            am.mode = AudioManager.MODE_IN_COMMUNICATION
            @Suppress("DEPRECATION")
            am.isSpeakerphoneOn = speaker

            // ---- playback: AudioTrack on the VOICE_COMMUNICATION path ----
            val outMin = AudioTrack.getMinBufferSize(
                playRate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT
            )
            val outBuf = if (outMin > 0) outMin * 2 else playRate // ~0.5s fallback
            val t = AudioTrack.Builder()
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build()
                )
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .setSampleRate(playRate)
                        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                        .build()
                )
                .setBufferSizeInBytes(outBuf)
                .setTransferMode(AudioTrack.MODE_STREAM)
                .build()
            t.play()
            track = t

            // ---- capture: AudioRecord(VOICE_COMMUNICATION) + platform AEC/NS/AGC ----
            val inMin = AudioRecord.getMinBufferSize(
                micRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT
            )
            val inBuf = if (inMin > 0) inMin * 2 else micRate
            val r = AudioRecord(
                MediaRecorder.AudioSource.VOICE_COMMUNICATION,
                micRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, inBuf
            )
            if (r.state != AudioRecord.STATE_INITIALIZED) {
                // Usually a missing RECORD_AUDIO permission.
                r.release(); t.release(); track = null
                am.mode = prevAudioMode
                return false
            }
            val session = r.audioSessionId
            // setEnabled(boolean) returns int, so call it directly (no `enabled =`).
            if (AcousticEchoCanceler.isAvailable()) {
                aec = AcousticEchoCanceler.create(session)?.also { it.setEnabled(true) }
            }
            if (NoiseSuppressor.isAvailable()) {
                ns = NoiseSuppressor.create(session)?.also { it.setEnabled(true) }
            }
            if (AutomaticGainControl.isAvailable()) {
                agc = AutomaticGainControl.create(session)?.also { it.setEnabled(true) }
            }
            record = r

            running.set(true)
            r.startRecording()

            // playback pump
            playThread = Thread {
                val tk = track
                while (running.get() && tk != null) {
                    val chunk = try { playQueue.take() } catch (_: InterruptedException) { break }
                    if (!running.get()) break
                    var off = 0
                    while (off < chunk.size && running.get()) {
                        val w = try { tk.write(chunk, off, chunk.size - off) } catch (_: Throwable) { -1 }
                        if (w <= 0) break
                        off += w
                    }
                }
            }.also { it.isDaemon = true; it.start() }

            // capture loop → stream PCM frames to Dart (~40ms frames)
            val frame = ByteArray(maxOf(inBuf, micRate / 25 * 2)) // ~40ms
            captureThread = Thread {
                val rec = record
                while (running.get() && rec != null) {
                    val n = try { rec.read(frame, 0, frame.size) } catch (_: Throwable) { -1 }
                    if (n > 0) {
                        val out = frame.copyOf(n)
                        main.post { micSink?.success(out) }
                    } else if (n < 0) break
                }
            }.also { it.isDaemon = true; it.start() }

            return true
        } catch (_: Throwable) {
            stopEngine()
            return false
        }
    }

    private fun stopEngine() {
        running.set(false)
        playQueue.clear()
        playQueue.offer(ByteArray(0)) // unblock the play thread's take()
        try { captureThread?.interrupt() } catch (_: Throwable) {}
        try { playThread?.interrupt() } catch (_: Throwable) {}
        captureThread = null
        playThread = null
        try { record?.stop() } catch (_: Throwable) {}
        try { record?.release() } catch (_: Throwable) {}
        record = null
        try { aec?.release() } catch (_: Throwable) {}
        try { ns?.release() } catch (_: Throwable) {}
        try { agc?.release() } catch (_: Throwable) {}
        aec = null; ns = null; agc = null
        try { track?.pause(); track?.flush(); track?.release() } catch (_: Throwable) {}
        track = null
        try {
            val am = audioManager()
            @Suppress("DEPRECATION")
            am?.isSpeakerphoneOn = false
            am?.mode = prevAudioMode
        } catch (_: Throwable) {}
    }
}
