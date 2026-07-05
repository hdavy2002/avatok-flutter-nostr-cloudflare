package ai.avatok.avavoiceaudio

import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothHeadset
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.AutomaticGainControl
import android.media.audiofx.NoiseSuppressor
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

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
        const val TELEPHONY_EVENT_CHANNEL = "avatok/voice_audio/telephony"

        // CALL-BG-B2/B3: a static reference to the live plugin instance (there is at
        // most one — one Flutter engine per process) so CallForegroundService and
        // MainActivity can push events to Dart without needing a Binder/bind() dance.
        // Null when no Flutter engine is attached (e.g. process died); callers must
        // handle that (the broadcast fallback in CallForegroundService covers it).
        @Volatile
        private var activeInstance: AvaVoiceAudioPlugin? = null

        /// CALL-BG-B2: called by CallForegroundService when the notification's
        /// "Hang up" action is tapped. Forwards to Dart's onNotificationHangup
        /// callback (wired by CallSession.hangup()) via the method channel.
        fun notifyHangupRequested(callId: String) {
            activeInstance?.emit("onNotificationHangup", mapOf("callId" to callId))
        }

        /// CALL-BG-B3: called by MainActivity.onCreate/onNewIntent when the app was
        /// launched/foregrounded by tapping the ongoing-call notification. Forwards to
        /// Dart's onNotificationTapReturnToCall(callId) callback so the app can route
        /// back to the active call screen instead of landing on the last route.
        fun notifyNotificationTap(callId: String) {
            activeInstance?.emit("onNotificationTapReturnToCall", mapOf("callId" to callId))
        }
    }

    private var methodChannel: MethodChannel? = null
    private var eventChannel: EventChannel? = null
    private var telephonyEventChannel: EventChannel? = null
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

    // CALLFIX-18: Bluetooth headset / wired headset routing
    private var bluetoothHeadset: BluetoothHeadset? = null
    private var headsetReceiver: BroadcastReceiver? = null
    private var currentRoute: String = "earpiece" // earpiece|speaker|bluetooth

    // CALLFIX-R2: P2P call active flag — gates proximity/telephony events during WebRTC calls
    // (running.get() only reflects Gemini native calls, not P2P calls via flutter_webrtc)
    private val p2pActive = AtomicBoolean(false)

    // CALLFIX-19: Proximity sensor for screen-off during earpiece calls
    private var proximitySensor: Sensor? = null
    private var sensorManager: SensorManager? = null
    private var proximityWakeLock: PowerManager.WakeLock? = null
    private val proximitySensorListener = object : SensorEventListener {
        override fun onSensorChanged(event: SensorEvent?) {
            if (event != null && currentRoute == "earpiece" && (running.get() || p2pActive.get())) {
                val distance = event.values[0]
                try {
                    val pm = appContext?.getSystemService(Context.POWER_SERVICE) as? PowerManager
                    if (distance < 5) { // Near ear
                        if (proximityWakeLock?.isHeld != true) {
                            proximityWakeLock = pm?.newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, "avatok:proximity")
                            proximityWakeLock?.acquire()
                        }
                    } else { // Far from ear
                        if (proximityWakeLock?.isHeld == true) proximityWakeLock?.release()
                    }
                } catch (_: Throwable) {}
            }
        }
        override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}
    }

    // CALLFIX-23: Telephony monitoring (cellular call interruption).
    // Listens to AudioManager mode changes or TelephonyManager state to detect
    // when a cellular call comes in during a VoIP call.
    private var telephonySink: EventChannel.EventSink? = null
    private var telephonyMonitoring = AtomicBoolean(false)

    // Telemetry counters (surfaced to Dart on stop / on error).
    private val framesCaptured = AtomicLong(0)
    private val bytesPlayed = AtomicLong(0)
    private val captureErrors = AtomicLong(0)
    private val playErrors = AtomicLong(0)

    // Push a diagnostic event to Dart (LiveVoiceController forwards it to PostHog).
    private fun emit(name: String, data: Map<String, Any?> = emptyMap()) {
        val payload = HashMap<String, Any?>(data)
        payload["name"] = name
        main.post { try { methodChannel?.invokeMethod("event", payload) } catch (_: Throwable) {} }
    }

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        appContext = binding.applicationContext
        methodChannel = MethodChannel(binding.binaryMessenger, METHOD_CHANNEL).also {
            it.setMethodCallHandler(this)
        }
        eventChannel = EventChannel(binding.binaryMessenger, EVENT_CHANNEL).also {
            it.setStreamHandler(this)
        }
        // CALLFIX-23: set up the telephony event channel for cellular call interruption events.
        telephonyEventChannel = EventChannel(binding.binaryMessenger, TELEPHONY_EVENT_CHANNEL).also {
            it.setStreamHandler(object : EventChannel.StreamHandler {
                override fun onListen(arguments: Any?, sink: EventChannel.EventSink?) {
                    telephonySink = sink
                }
                override fun onCancel(arguments: Any?) {
                    telephonySink = null
                }
            })
        }
        // CALL-BG-B2/B3: register as the active instance so CallForegroundService /
        // MainActivity can reach Dart via the static helpers above.
        activeInstance = this
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        stopEngine()
        stopTelephonyMonitoring()
        if (activeInstance === this) activeInstance = null
        methodChannel?.setMethodCallHandler(null)
        eventChannel?.setStreamHandler(null)
        telephonyEventChannel?.setStreamHandler(null)
        methodChannel = null
        eventChannel = null
        telephonyEventChannel = null
        appContext = null
    }

    override fun onListen(arguments: Any?, sink: EventChannel.EventSink?) { micSink = sink }
    override fun onCancel(arguments: Any?) { micSink = null }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "isSupported" -> result.success(true)
            "canUseFullScreenIntent" -> {
                // CALL-FSI-1: Android 14+ (API 34) revokes USE_FULL_SCREEN_INTENT for
                // non-dialer apps unless the user grants it. Below API 34 it is granted
                // by manifest declaration alone, so report true there.
                result.success(canUseFullScreenIntent())
            }
            "openFullScreenIntentSettings" -> {
                // CALL-FSI-1: deep-link to the per-app "Full screen intents" settings
                // page (ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, API 34+) so the user
                // can grant lock-screen call UI. Returns true if an activity was launched.
                result.success(openFullScreenIntentSettings())
            }
            "start" -> {
                val micRate = (call.argument<Int>("micSampleRate")) ?: 16000
                val playRate = (call.argument<Int>("playSampleRate")) ?: 24000
                val speaker = (call.argument<Boolean>("speaker")) ?: true
                // Returns a rich diagnostics map (ok + AEC/NS/AGC state + buffers …)
                // so the Dart side can pinpoint init failures in PostHog.
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
            "startP2pAudioMode" -> {
                // CALLFIX-16: start P2P call audio mode (VOICE_COMMUNICATION + AEC/NS/AGC)
                startP2pAudioMode()
                result.success(null)
            }
            "stopP2pAudioMode" -> {
                // CALLFIX-16: restore normal audio mode on call end
                stopP2pAudioMode()
                result.success(null)
            }
            "getAudioRoute" -> {
                // CALLFIX-18: return current audio route (earpiece|speaker|bluetooth|headset)
                result.success(getCurrentRoute())
            }
            "setAudioRoute" -> {
                // CALLFIX-18: set audio route by name
                val route = call.argument<String>("route") ?: "earpiece"
                setAudioRoute(route)
                result.success(null)
            }
            "startBluetoothSco" -> {
                // CALLFIX-18: start Bluetooth SCO (audio data exchange)
                startBluetoothSco()
                result.success(null)
            }
            "stopBluetoothSco" -> {
                // CALLFIX-18: stop Bluetooth SCO
                stopBluetoothSco()
                result.success(null)
            }
            "startProximitySensor" -> {
                // CALLFIX-19: start proximity sensor for earpiece calls
                startProximitySensor()
                result.success(null)
            }
            "stopProximitySensor" -> {
                // CALLFIX-19: stop proximity sensor
                stopProximitySensor()
                result.success(null)
            }
            "startCallForegroundService" -> {
                // CALLFIX-20 / CALL-BG-B1/B4: start foreground service for ongoing
                // calls. isVideo determines whether the service declares the camera
                // foregroundServiceType bit (Android 14+ requirement).
                val callId = call.argument<String>("callId") ?: ""
                val peerName = call.argument<String>("peerName") ?: "Unknown"
                val isVideo = call.argument<Boolean>("isVideo") ?: false
                startCallForegroundService(callId, peerName, isVideo)
                result.success(null)
            }
            "stopCallForegroundService" -> {
                // CALLFIX-20: stop foreground service on call end
                stopCallForegroundService()
                result.success(null)
            }
            "startTelephonyMonitoring" -> {
                // CALLFIX-23: listen for cellular call interruption (GSM call during VoIP)
                startTelephonyMonitoring()
                result.success(null)
            }
            "stopTelephonyMonitoring" -> {
                // CALLFIX-23: stop listening for cellular call interruption
                stopTelephonyMonitoring()
                result.success(null)
            }
            "startP2pCall" -> {
                // CALLFIX-R2: mark P2P WebRTC call as active (for gates on proximity/telephony)
                p2pActive.set(true)
                result.success(null)
            }
            "stopP2pCall" -> {
                // CALLFIX-R2: mark P2P WebRTC call as inactive
                p2pActive.set(false)
                result.success(null)
            }
            "stop" -> {
                // Return final throughput/error counters so Dart can log a rich
                // voice_live_native_end (heard-nothing vs no-mic, AEC health, etc.).
                val stats = mapOf(
                    "frames_captured" to framesCaptured.get(),
                    "bytes_played" to bytesPlayed.get(),
                    "capture_errors" to captureErrors.get(),
                    "play_errors" to playErrors.get()
                )
                stopEngine()
                result.success(stats)
            }
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

    private fun startEngine(micRate: Int, playRate: Int, speaker: Boolean): Map<String, Any?> {
        if (running.get()) return mapOf("ok" to true, "reason" to "already_running")
        framesCaptured.set(0); bytesPlayed.set(0); captureErrors.set(0); playErrors.set(0)
        try {
            val am = audioManager() ?: return mapOf("ok" to false, "reason" to "no_audio_manager")
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
                return mapOf(
                    "ok" to false, "reason" to "record_not_initialized",
                    "record_state" to r.state, "track_state" to t.state,
                    "in_buf" to inBuf, "out_buf" to outBuf
                )
            }
            val trackState = t.state
            val session = r.audioSessionId
            // Platform AEC/NS/AGC. Record availability + whether each actually enabled
            // — THE key signal for "speaker echo not cancelled" diagnosis.
            val aecAvail = AcousticEchoCanceler.isAvailable()
            val nsAvail = NoiseSuppressor.isAvailable()
            val agcAvail = AutomaticGainControl.isAvailable()
            var aecOn = false; var nsOn = false; var agcOn = false
            // setEnabled(boolean) returns int, so call it directly (no `enabled =`).
            if (aecAvail) {
                aec = AcousticEchoCanceler.create(session)?.also { it.setEnabled(true) }
                aecOn = aec?.enabled ?: false
            }
            if (nsAvail) {
                ns = NoiseSuppressor.create(session)?.also { it.setEnabled(true) }
                nsOn = ns?.enabled ?: false
            }
            if (agcAvail) {
                agc = AutomaticGainControl.create(session)?.also { it.setEnabled(true) }
                agcOn = agc?.enabled ?: false
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
                        val w = try { tk.write(chunk, off, chunk.size - off) }
                                catch (e: Throwable) { playErrors.incrementAndGet(); emit("play_error", mapOf("error" to (e.message ?: e.toString()))); -1 }
                        if (w <= 0) break
                        off += w
                    }
                    if (off > 0) bytesPlayed.addAndGet(off.toLong())
                }
            }.also { it.isDaemon = true; it.start() }

            // capture loop → stream PCM frames to Dart (~40ms frames)
            val frame = ByteArray(maxOf(inBuf, micRate / 25 * 2)) // ~40ms
            captureThread = Thread {
                val rec = record
                while (running.get() && rec != null) {
                    val n = try { rec.read(frame, 0, frame.size) }
                            catch (e: Throwable) { captureErrors.incrementAndGet(); emit("capture_error", mapOf("error" to (e.message ?: e.toString()))); -1 }
                    if (n > 0) {
                        framesCaptured.incrementAndGet()
                        val out = frame.copyOf(n)
                        main.post { micSink?.success(out) }
                    } else if (n < 0) break
                }
            }.also { it.isDaemon = true; it.start() }

            return mapOf(
                "ok" to true,
                "aec_available" to aecAvail, "aec_enabled" to aecOn,
                "ns_available" to nsAvail, "ns_enabled" to nsOn,
                "agc_available" to agcAvail, "agc_enabled" to agcOn,
                "record_state" to AudioRecord.STATE_INITIALIZED,
                "track_state" to trackState,
                "session_id" to session,
                "mic_rate" to micRate, "play_rate" to playRate,
                "in_buf" to inBuf, "out_buf" to outBuf,
                "speaker" to speaker
            )
        } catch (e: Throwable) {
            stopEngine()
            return mapOf("ok" to false, "reason" to "exception", "error" to (e.message ?: e.toString()))
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
        stopProximitySensor() // CALLFIX-19: clean up proximity sensor
        try { stopBluetoothSco() } catch (_: Throwable) {} // CALLFIX-18
        stopTelephonyMonitoring() // CALLFIX-23: clean up telephony monitoring
        try {
            val am = audioManager()
            @Suppress("DEPRECATION")
            am?.isSpeakerphoneOn = false
            am?.mode = prevAudioMode
        } catch (_: Throwable) {}
    }

    // CALL-FOCUS-1: audio-focus request + change listener. Previously focus was
    // requested with a NULL listener, so when another app (WhatsApp, a cellular
    // call, a video) grabbed focus we were never told — our capture kept feeding a
    // route the system had reassigned and the caller heard silence / got cut off.
    // Now we register an OnAudioFocusChangeListener: on LOSS(_TRANSIENT) we emit
    // 'onAudioFocusLost' → Dart holds the call (mute + "on hold"), on GAIN we emit
    // 'onAudioFocusRegained' → Dart resumes. The RTC session is kept alive
    // throughout; we never end the call from a focus change.
    private var focusRequest: AudioFocusRequest? = null
    private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
        when (change) {
            AudioManager.AUDIOFOCUS_LOSS,
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT,
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK ->
                emit("onAudioFocusLost", mapOf("change" to change))
            AudioManager.AUDIOFOCUS_GAIN,
            AudioManager.AUDIOFOCUS_GAIN_TRANSIENT,
            AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK ->
                emit("onAudioFocusRegained", mapOf("change" to change))
        }
    }

    // CALLFIX-16: Start P2P call audio mode with hardware AEC/NS/AGC + audio focus.
    // Called at P2P call start (after getUserMedia) to set the platform to
    // VOICE_COMMUNICATION mode and request audio focus so the platform applies
    // hardware echo cancellation, noise suppression, and automatic gain control.
    private fun startP2pAudioMode() {
        try {
            val am = audioManager() ?: return
            prevAudioMode = am.mode
            am.mode = AudioManager.MODE_IN_COMMUNICATION
            // Request transient audio focus for voice communication (music/media
            // pauses) WITH a change listener so we can hold/resume the call.
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    val attrs = AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build()
                    val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                        .setAudioAttributes(attrs)
                        .setOnAudioFocusChangeListener(focusListener, main)
                        .build()
                    focusRequest = req
                    am.requestAudioFocus(req)
                } else {
                    @Suppress("DEPRECATION")
                    am.requestAudioFocus(focusListener, AudioManager.STREAM_VOICE_CALL,
                        AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                }
            } catch (_: Throwable) {}
        } catch (_: Throwable) {}
    }

    // CALLFIX-16: Stop P2P call audio mode and restore normal audio.
    // Called on call end to restore the normal audio mode and release audio focus
    // so music/media can resume. CALL-FOCUS-1: abandon focus properly (via the
    // stored request on O+) so the listener is cleanly deregistered.
    private fun stopP2pAudioMode() {
        try {
            val am = audioManager() ?: return
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    focusRequest?.let { am.abandonAudioFocusRequest(it) }
                    focusRequest = null
                } else {
                    @Suppress("DEPRECATION")
                    am.abandonAudioFocus(focusListener)
                }
            } catch (_: Throwable) {}
            am.mode = prevAudioMode
        } catch (_: Throwable) {}
    }

    // CALLFIX-18: Audio routing — Bluetooth, wired headset, earpiece, speaker.
    private fun getCurrentRoute(): String = currentRoute

    private fun setAudioRoute(route: String) {
        try {
            val am = audioManager() ?: return
            when (route) {
                "speaker" -> {
                    stopBluetoothSco()
                    @Suppress("DEPRECATION")
                    am.isSpeakerphoneOn = true
                    currentRoute = "speaker"
                }
                "earpiece" -> {
                    stopBluetoothSco()
                    @Suppress("DEPRECATION")
                    am.isSpeakerphoneOn = false
                    currentRoute = "earpiece"
                }
                "bluetooth" -> {
                    startBluetoothSco()
                    @Suppress("DEPRECATION")
                    am.isSpeakerphoneOn = false
                    currentRoute = "bluetooth"
                }
            }
            emit("audio_route_changed", mapOf("route" to currentRoute))
        } catch (_: Throwable) {}
    }

    private fun startBluetoothSco() {
        try {
            val am = audioManager() ?: return
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                // API 31+: setCommunicationDevice with DEVICE_OUT_BLUETOOTH_SCO
                // (implementation requires Android device config; for now, use startBluetoothSco)
            }
            am.startBluetoothSco()
        } catch (_: Throwable) {}
    }

    private fun stopBluetoothSco() {
        try {
            val am = audioManager() ?: return
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                // API 31+: clearCommunicationDevice
            }
            am.stopBluetoothSco()
        } catch (_: Throwable) {}
    }

    // CALLFIX-19: Proximity sensor — turn screen off during earpiece audio calls.
    private fun startProximitySensor() {
        try {
            if (currentRoute != "earpiece") return // only for earpiece route
            sensorManager = appContext?.getSystemService(Context.SENSOR_SERVICE) as? SensorManager
            if (sensorManager != null) {
                proximitySensor = sensorManager?.getDefaultSensor(Sensor.TYPE_PROXIMITY)
                if (proximitySensor != null) {
                    sensorManager?.registerListener(proximitySensorListener, proximitySensor,
                        SensorManager.SENSOR_DELAY_NORMAL)
                    emit("proximity_sensor_enabled", emptyMap())
                }
            }
        } catch (_: Throwable) {}
    }

    private fun stopProximitySensor() {
        try {
            sensorManager?.unregisterListener(proximitySensorListener)
            if (proximityWakeLock?.isHeld == true) proximityWakeLock?.release()
            proximityWakeLock = null
            sensorManager = null
            proximitySensor = null
            emit("proximity_sensor_disabled", emptyMap())
        } catch (_: Throwable) {}
    }

    // CALLFIX-20 / CALL-BG-B1/B4: Start foreground service to keep calls alive while
    // backgrounded. The service shows an ongoing-call notification with a chronometer
    // and hang-up action. Called at CALL SETUP (dial placed / incoming accepted), not
    // on P2P connect, so a call backgrounded while still ringing/connecting survives.
    private fun startCallForegroundService(callId: String, peerName: String, isVideo: Boolean) {
        try {
            val intent = Intent(appContext, CallForegroundService::class.java).apply {
                putExtra("callId", callId)
                putExtra("peerName", peerName)
                putExtra("isVideo", isVideo)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                // Android 8+: must use startForegroundService, not startService.
                appContext?.startForegroundService(intent)
            } else {
                // Older API: startService is sufficient.
                appContext?.startService(intent)
            }
            emit("call_foreground_service_started", mapOf("call_id" to callId, "is_video" to isVideo))
        } catch (e: Throwable) {
            emit("call_foreground_service_error", mapOf("error" to (e.message ?: e.toString())))
        }
    }

    // CALLFIX-20: Stop foreground service on call end.
    private fun stopCallForegroundService() {
        try {
            val intent = Intent(appContext, CallForegroundService::class.java)
            appContext?.stopService(intent)
            emit("call_foreground_service_stopped", emptyMap())
        } catch (e: Throwable) {
            emit("call_foreground_service_error", mapOf("error" to (e.message ?: e.toString())))
        }
    }

    // CALL-FSI-1: whether the app may post full-screen-intent notifications (the
    // lock-screen incoming-call UI). On API 34+ this can be revoked by the user and
    // must be checked at runtime; on older APIs the manifest permission suffices.
    private fun canUseFullScreenIntent(): Boolean {
        return try {
            if (Build.VERSION.SDK_INT >= 34) {
                val nm = appContext?.getSystemService(Context.NOTIFICATION_SERVICE)
                    as? android.app.NotificationManager
                nm?.canUseFullScreenIntent() ?: false
            } else {
                true // granted by manifest declaration on API < 34
            }
        } catch (_: Throwable) {
            true // never block the ring path on a check failure
        }
    }

    // CALL-FSI-1: open the system per-app "Full screen intents" settings page so the
    // user can grant the permission. API 34+ only; returns false otherwise.
    private fun openFullScreenIntentSettings(): Boolean {
        return try {
            if (Build.VERSION.SDK_INT >= 34) {
                val pkg = appContext?.packageName ?: return false
                val intent = Intent(
                    android.provider.Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT,
                    android.net.Uri.parse("package:$pkg")
                ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                appContext?.startActivity(intent)
                true
            } else {
                false
            }
        } catch (_: Throwable) {
            false
        }
    }

    // CALLFIX-23: Listen for cellular call interruption (GSM call during VoIP).
    // Uses AudioManager.OnModeChangedListener (API 31+) or polls audio mode changes
    // to detect when a cellular call comes in. Emits 'held'/'resumed' events to Dart.
    private var audioModeListener: AudioManager.OnModeChangedListener? = null

    private fun startTelephonyMonitoring() {
        if (telephonyMonitoring.getAndSet(true)) return // already listening
        try {
            val am = audioManager() ?: return
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                // API 31+: use OnModeChangedListener for audio mode changes.
                audioModeListener = AudioManager.OnModeChangedListener { mode ->
                    // When a cellular call comes in, AudioManager mode may change to MODE_IN_CALL.
                    // We detect a cellular call when mode is MODE_IN_CALL but we're in a VoIP call
                    // (either Gemini native via running.get() or P2P via p2pActive.get()).
                    // CALLFIX-R2: gate on both running and p2pActive
                    if (mode == AudioManager.MODE_IN_CALL && (running.get() || p2pActive.get())) {
                        // Cellular call is active while we're in a VoIP call.
                        val evt = mapOf<String, Any>("state" to "held")
                        main.post { try { telephonySink?.success(evt) } catch (_: Throwable) {} }
                    } else if (mode == AudioManager.MODE_IN_COMMUNICATION && (running.get() || p2pActive.get())) {
                        // Back to our call (cellular call ended).
                        val evt = mapOf<String, Any>("state" to "resumed")
                        main.post { try { telephonySink?.success(evt) } catch (_: Throwable) {} }
                    }
                }
                // CALLFIX-R1: addOnModeChangedListener requires Executor + OnModeChangedListener on API 31+
                val executor = java.util.concurrent.Executor { r -> main.post(r) }
                am.addOnModeChangedListener(executor, audioModeListener!!)
            }
            emit("telephony_monitoring_started", emptyMap())
        } catch (e: Throwable) {
            telephonyMonitoring.set(false)
            emit("telephony_monitoring_error", mapOf("error" to (e.message ?: e.toString())))
        }
    }

    private fun stopTelephonyMonitoring() {
        if (!telephonyMonitoring.getAndSet(false)) return // not listening
        try {
            val am = audioManager() ?: return
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && audioModeListener != null) {
                // CALLFIX-R10: removeOnModeChangedListener takes ONLY the listener (no Executor)
                am.removeOnModeChangedListener(audioModeListener!!)
            }
            audioModeListener = null
            emit("telephony_monitoring_stopped", emptyMap())
        } catch (e: Throwable) {
            emit("telephony_monitoring_error", mapOf("error" to (e.message ?: e.toString())))
        }
    }
}
