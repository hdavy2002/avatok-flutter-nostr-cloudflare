package ai.avatok.streamcall

import android.content.Context
import android.content.Intent
import android.app.Application
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import io.getstream.android.push.firebase.FirebasePushDeviceGenerator
import io.getstream.result.Result
import io.getstream.video.android.core.Call
import io.getstream.video.android.core.EventSubscription
import io.getstream.video.android.core.GEO
import io.getstream.video.android.core.RealtimeConnection
import io.getstream.video.android.core.StreamVideo
import io.getstream.video.android.core.StreamVideoBuilder
import io.getstream.video.android.core.notifications.NotificationConfig
import io.getstream.video.android.core.notifications.handlers.StreamDefaultNotificationHandler
import io.getstream.video.android.core.socket.common.token.TokenProvider
import io.getstream.video.android.core.model.RejectReason
import io.getstream.video.android.core.internal.InternalStreamVideoApi
import io.getstream.video.android.model.User
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.atomic.AtomicBoolean
import io.getstream.android.video.generated.models.CallAcceptedEvent
import io.getstream.android.video.generated.models.CallEndedEvent
import io.getstream.android.video.generated.models.CallRejectedEvent

private data class StoredCredentials(
    val userId: String,
    val apiKey: String,
    val token: String,
    val expiresAtMs: Long,
)

/** Process-wide Stream owner shared by foreground and headless Flutter engines. */
internal object StreamCallRuntime {
    private const val PREFS = "avatok_stream_call_credentials_v1"
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val main = Handler(Looper.getMainLooper())
    private val sinks = CopyOnWriteArraySet<EventChannel.EventSink>()
    private val pendingEvents = ArrayDeque<Map<String, Any?>>()
    private val pendingEventsLock = Any()
    @Volatile private var appContext: Context? = null
    private val calls = ConcurrentHashMap<String, Call>()
    private val callTypes = ConcurrentHashMap<String, String>()
    private val callerWaiting = ConcurrentHashMap.newKeySet<String>()
    private val acceptingCalls = ConcurrentHashMap.newKeySet<String>()
    private val joiningCalls = ConcurrentHashMap.newKeySet<String>()
    private val joinedCalls = ConcurrentHashMap.newKeySet<String>()
    private val callJobs = ConcurrentHashMap<String, MutableList<Job>>()
    private var clientEvents: EventSubscription? = null

    private fun prefs(context: Context) = EncryptedSharedPreferences.create(
        context,
        PREFS,
        MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

    fun persist(context: Context, args: Map<*, *>): StoredCredentials {
        val credentials = StoredCredentials(
            userId = args["user_id"]?.toString().orEmpty(),
            apiKey = args["api_key"]?.toString().orEmpty(),
            token = args["token"]?.toString().orEmpty(),
            expiresAtMs = (args["expires_at_ms"] as? Number)?.toLong() ?: 0L,
        )
        require(credentials.userId.isNotBlank()) { "missing user_id" }
        require(credentials.apiKey.isNotBlank()) { "missing api_key" }
        require(credentials.token.isNotBlank()) { "missing token" }
        prefs(context).edit()
            .putString("user_id", credentials.userId)
            .putString("api_key", credentials.apiKey)
            .putString("token", credentials.token)
            .putLong("expires_at_ms", credentials.expiresAtMs)
            .apply()
        return credentials
    }

    private fun read(context: Context): StoredCredentials? = runCatching {
        val p = prefs(context)
        StoredCredentials(
            userId = p.getString("user_id", "").orEmpty(),
            apiKey = p.getString("api_key", "").orEmpty(),
            token = p.getString("token", "").orEmpty(),
            expiresAtMs = p.getLong("expires_at_ms", 0L),
        ).takeIf { it.userId.isNotBlank() && it.apiKey.isNotBlank() && it.token.isNotBlank() }
    }.getOrNull()

    @Synchronized
    fun bootstrap(context: Context): StreamVideo? {
        appContext = context.applicationContext
        StreamVideo.instanceOrNull()?.let { return it }
        val credentials = read(context) ?: return null
        if (credentials.expiresAtMs in 1..System.currentTimeMillis()) return null
        val app = context.applicationContext
        val client = StreamVideoBuilder(
            context = app,
            apiKey = credentials.apiKey,
            geo = GEO.GlobalEdgeNetwork,
            user = User(id = credentials.userId),
            token = credentials.token,
            tokenProvider = object : TokenProvider {
                override suspend fun loadToken(): String = read(app)?.token.orEmpty()
            },
            notificationConfig = NotificationConfig(
                // Stream is the sole ring owner for pilot calls. Suppressing
                // this in foreground would leave no Answer surface because the
                // legacy CallKit route correctly ignores Stream-owned rings.
                hideRingingNotificationInForeground = false,
                notificationHandler = StreamDefaultNotificationHandler(
                    application = app as Application,
                    hideRingingNotificationInForeground = false,
                ),
                pushDeviceGenerators = listOf(
                    FirebasePushDeviceGenerator(context = app, providerName = "firebase"),
                ),
            ),
        ).build()
        observeClient(client)
        emit("__client__", "client_ready", mapOf("sdk_version" to "1.9.2"))
        return client
    }

    private fun observeClient(client: StreamVideo) {
        clientEvents?.dispose()
        clientEvents = client.subscribe { event ->
            val cid = when (event) {
                is CallAcceptedEvent -> event.callCid
                is CallRejectedEvent -> event.callCid
                is CallEndedEvent -> event.callCid
                else -> null
            } ?: return@subscribe
            val callId = cid.substringAfter(':', cid)
            when (event) {
                is CallAcceptedEvent -> if (callerWaiting.remove(callId)) {
                    calls[callId]?.let { call -> scope.launch { joinNow(callId, call) } }
                }
                is CallRejectedEvent -> emit(
                    callId,
                    "rejected",
                    mapOf("reason" to (event.reason?.toString() ?: "declined")),
                )
                is CallEndedEvent -> emit(callId, "disconnected", mapOf("reason" to "ended"))
            }
        }
    }

    fun addSink(sink: EventChannel.EventSink) {
        sinks.add(sink)
        val backlog = synchronized(pendingEventsLock) {
            pendingEvents.toList().also { pendingEvents.clear() }
        }
        backlog.forEach { payload -> runCatching { sink.success(payload) } }
    }
    fun removeSink(sink: EventChannel.EventSink?) { if (sink != null) sinks.remove(sink) }

    fun emit(callId: String, event: String, extra: Map<String, Any?> = emptyMap()) {
        val payload = HashMap<String, Any?>()
        payload["call_id"] = callId
        payload["event"] = event
        payload.putAll(extra)
        main.post {
            if (sinks.isEmpty()) {
                synchronized(pendingEventsLock) {
                    if (pendingEvents.size >= 100) pendingEvents.removeFirst()
                    pendingEvents.addLast(payload)
                }
            } else {
                sinks.forEach { runCatching { it.success(payload) } }
            }
        }
    }

    fun prepareCall(context: Context, args: Map<*, *>) {
        val credentials = persist(context, args)
        val existing = StreamVideo.instanceOrNull()
        if (existing != null && existing.userId != credentials.userId) {
            disconnect(context, clearCredentials = false)
        }
        bootstrap(context)
    }

    fun currentCredentials(context: Context, callId: String): Map<String, Any?>? {
        val credentials = read(context) ?: return null
        if (credentials.expiresAtMs in 1..System.currentTimeMillis()) return null
        return mapOf(
            "call_id" to callId,
            "user_id" to credentials.userId,
            "api_key" to credentials.apiKey,
            "token" to credentials.token,
            "expires_at_ms" to credentials.expiresAtMs,
            "call_type" to (callTypes[callId] ?: "default"),
        )
    }

    fun join(context: Context, args: Map<*, *>) {
        prepareCall(context, args)
        val client = bootstrap(context) ?: error("stream client unavailable")
        val callId = args["call_id"]?.toString().orEmpty()
        val callType = args["call_type"]?.toString()?.ifBlank { "default" } ?: "default"
        require(callId.isNotBlank()) { "missing call_id" }
        val call = client.call(callType, callId)
        calls[callId] = call
        callTypes[callId] = callType
        observeCall(callId, call)
        val waitForAccept = args["wait_for_accept"] == true
        val acceptBeforeJoin = args["accept_before_join"] == true
        emit(callId, "join_started", mapOf("role" to (args["role"]?.toString() ?: "unknown")))
        if (joinedCalls.contains(callId)) {
            emit(callId, "connected", mapOf("resumed_from_native_accept" to true))
            return
        }
        if (acceptingCalls.contains(callId) || joiningCalls.contains(callId)) return
        if (waitForAccept) {
            callerWaiting.add(callId)
            emit(callId, "waiting_for_accept")
            return
        }
        scope.launch {
            if (acceptBeforeJoin) {
                if (!acceptingCalls.add(callId)) return@launch
                val accepted = try { call.accept() } finally { acceptingCalls.remove(callId) }
                if (accepted !is Result.Success) {
                    emit(callId, "error", mapOf("reason" to "accept_failed"))
                    return@launch
                }
                emit(callId, "accepted")
            }
            joinNow(callId, call)
        }
    }

    private suspend fun joinNow(callId: String, call: Call) {
        if (joinedCalls.contains(callId) || !joiningCalls.add(callId)) return
        call.camera.disable()
        val joinedAt = System.currentTimeMillis()
        try {
            val joined = call.join()
            if (joined !is Result.Success) {
                emit(callId, "error", mapOf("reason" to "join_failed"))
                return
            }
            joinedCalls.add(callId)
            call.camera.disable()
            call.microphone.setEnabled(true)
            emit(callId, "connected", mapOf("join_ms" to (System.currentTimeMillis() - joinedAt)))
        } finally {
            joiningCalls.remove(callId)
        }
    }

    /** Accept and join immediately from Stream's native notification action. */
    fun handleIntent(context: Context, intent: Intent?): Boolean {
        if (intent?.action != "io.getstream.video.android.action.ACCEPT_CALL") return false
        val cid = intent.getStringExtra("io.getstream.video.android.intent-extra.call_cid")
            ?.takeIf { it.contains(':') } ?: return false
        val callType = cid.substringBefore(':')
        val callId = cid.substringAfter(':')
        val client = bootstrap(context) ?: run {
            emit(callId, "error", mapOf("reason" to "native_accept_credentials_unavailable"))
            return false
        }
        val call = calls.computeIfAbsent(callId) { client.call(callType, callId) }
        callTypes[callId] = callType
        observeCall(callId, call)
        if (joinedCalls.contains(callId) || !acceptingCalls.add(callId)) return true
        emit(callId, "accept_intent_received", mapOf("cold_native_path" to true))
        scope.launch {
            val startedAt = System.currentTimeMillis()
            try {
                emit(callId, "accept_started")
                val accepted = call.accept()
                if (accepted !is Result.Success) {
                    emit(callId, "error", mapOf("reason" to "native_accept_failed"))
                    return@launch
                }
                emit(callId, "accepted", mapOf("accept_ms" to (System.currentTimeMillis() - startedAt)))
                joinNow(callId, call)
            } finally {
                acceptingCalls.remove(callId)
            }
        }
        return true
    }

    private fun observeCall(callId: String, call: Call) {
        if (callJobs.containsKey(callId)) return
        val jobs = mutableListOf<Job>()
        jobs += scope.launch {
            call.state.connection.collectLatest { state ->
                when (state) {
                    is RealtimeConnection.Reconnecting -> emit(callId, "reconnecting")
                    is RealtimeConnection.Connected -> emit(callId, "reconnected")
                    is RealtimeConnection.Failed -> emit(callId, "error", mapOf("reason" to "connection_failed"))
                    is RealtimeConnection.Disconnected -> emit(callId, "disconnected")
                    else -> Unit
                }
            }
        }
        jobs += scope.launch {
            val observed = HashSet<String>()
            call.state.remoteParticipants.collectLatest { participants ->
                participants.forEach { participant ->
                    val key = participant.sessionId
                    if (!observed.add(key)) return@forEach
                    emit(callId, "remote_join")
                    val trackReported = AtomicBoolean(false)
                    val audioReported = AtomicBoolean(false)
                    launch {
                        participant.audioTrack.collectLatest { track ->
                            if (track != null && trackReported.compareAndSet(false, true)) {
                                emit(callId, "audio_track_added")
                            }
                        }
                    }
                    launch {
                        participant.audioLevel.collectLatest { level ->
                            if (trackReported.get() && level > 0f &&
                                audioReported.compareAndSet(false, true)) {
                                emit(callId, "first_audio_playout", mapOf("inbound_audio_level" to level))
                            }
                        }
                    }
                }
            }
        }
        jobs += observeQuality(callId, call)
        callJobs[callId] = jobs
    }

    /** Strictly sanitized WebRTC aggregates; never forward raw RTCStats. */
    @OptIn(InternalStreamVideoApi::class)
    private fun observeQuality(callId: String, call: Call): Job = scope.launch {
        var previousAtMs = 0L
        var previousBytesReceived = -1.0
        var previousBytesSent = -1.0
        call.statsReport.collectLatest { report ->
            report ?: return@collectLatest
            val inbound = report.subscriber?.origin?.statsMap?.values
                ?.firstOrNull { stat ->
                    stat.type == "inbound-rtp" &&
                        (stat.members["kind"] == "audio" || stat.members["mediaType"] == "audio")
                }
            val outbound = report.publisher?.origin?.statsMap?.values
                ?.firstOrNull { stat ->
                    stat.type == "outbound-rtp" &&
                        (stat.members["kind"] == "audio" || stat.members["mediaType"] == "audio")
                }
            val allStats = buildList {
                report.subscriber?.origin?.statsMap?.values?.forEach { add(it) }
                report.publisher?.origin?.statsMap?.values?.forEach { add(it) }
            }
            val pair = allStats.firstOrNull { stat ->
                stat.type == "candidate-pair" &&
                    (stat.members["selected"] == true || stat.members["nominated"] == true)
            }
            val codec = allStats.firstOrNull { stat ->
                stat.type == "codec" &&
                    stat.members["mimeType"]?.toString()?.startsWith("audio/", true) == true
            }
            fun number(value: Any?): Double? = (value as? Number)?.toDouble()
            val packetsReceived = number(inbound?.members?.get("packetsReceived"))
            val packetsLost = number(inbound?.members?.get("packetsLost"))
            val bytesReceived = number(inbound?.members?.get("bytesReceived"))
            val bytesSent = number(outbound?.members?.get("bytesSent"))
            val packetTotal = (packetsReceived ?: 0.0) + (packetsLost ?: 0.0)
            val safe = linkedMapOf<String, Any?>()
            number(pair?.members?.get("currentRoundTripTime"))?.let { safe["rtt_ms"] = it * 1000 }
            number(inbound?.members?.get("jitter"))?.let { safe["jitter_ms"] = it * 1000 }
            if (packetsLost != null && packetTotal > 0) safe["packet_loss_pct"] = packetsLost * 100 / packetTotal
            number(inbound?.members?.get("audioLevel"))?.let { safe["inbound_audio_level"] = it }
            number(outbound?.members?.get("audioLevel"))?.let { safe["outbound_mic_level"] = it }
            bytesReceived?.let { safe["bytes_received"] = it }
            bytesSent?.let { safe["bytes_sent"] = it }
            packetsReceived?.let { safe["packets_received"] = it }
            number(outbound?.members?.get("packetsSent"))?.let { safe["packets_sent"] = it }
            packetsLost?.let { safe["packets_lost"] = it }
            number(pair?.members?.get("availableOutgoingBitrate"))?.let {
                safe["available_bandwidth_kbps"] = it / 1000
            }
            codec?.members?.get("mimeType")?.toString()?.let { safe["codec_audio"] = it }
            number(codec?.members?.get("clockRate"))?.let { safe["sample_rate"] = it }
            number(codec?.members?.get("channels"))?.let { safe["channels"] = it }
            report.local?.let {
                safe["sfu"] = it.sfu
                safe["sdk_version"] = it.sdkVersion
            }
            appContext?.let { context ->
                safe["network_type"] = networkType(context)
                safe["audio_route"] = audioRoute(context)
                safe["device_model"] = Build.MODEL
                safe["android_sdk"] = Build.VERSION.SDK_INT
                val battery = (context.getSystemService(Context.BATTERY_SERVICE) as? BatteryManager)
                    ?.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY) ?: -1
                if (battery in 0..100) safe["battery_level"] = battery
            }
            val nowMs = System.currentTimeMillis()
            val elapsedMs = nowMs - previousAtMs
            if (elapsedMs > 0 && previousAtMs > 0) {
                if (bytesReceived != null && previousBytesReceived >= 0 && bytesReceived >= previousBytesReceived) {
                    safe["inbound_kbps"] = (bytesReceived - previousBytesReceived) * 8 / elapsedMs
                }
                if (bytesSent != null && previousBytesSent >= 0 && bytesSent >= previousBytesSent) {
                    safe["outbound_kbps"] = (bytesSent - previousBytesSent) * 8 / elapsedMs
                }
            }
            previousAtMs = nowMs
            if (bytesReceived != null) previousBytesReceived = bytesReceived
            if (bytesSent != null) previousBytesSent = bytesSent
            if (safe.isNotEmpty()) emit(callId, "quality_sample", safe)
        }
    }

    private fun networkType(context: Context): String {
        val manager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            ?: return "unknown"
        val capabilities = manager.getNetworkCapabilities(manager.activeNetwork) ?: return "offline"
        return when {
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN) -> "vpn"
            else -> "other"
        }
    }

    private fun audioRoute(context: Context): String {
        val manager = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
            ?: return "unknown"
        val device = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            manager.communicationDevice
        } else {
            manager.getDevices(AudioManager.GET_DEVICES_OUTPUTS).firstOrNull { candidate ->
                candidate.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO ||
                    candidate.type == AudioDeviceInfo.TYPE_WIRED_HEADSET ||
                    candidate.type == AudioDeviceInfo.TYPE_WIRED_HEADPHONES
            }
        }
        return when (device?.type) {
            AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
            AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> "bluetooth"
            AudioDeviceInfo.TYPE_WIRED_HEADSET,
            AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
            AudioDeviceInfo.TYPE_USB_HEADSET -> "headset"
            AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "earpiece"
            AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "speaker"
            null -> if (manager.isSpeakerphoneOn) "speaker" else "earpiece"
            else -> "other"
        }
    }

    fun setMic(callId: String, enabled: Boolean) {
        calls[callId]?.microphone?.setEnabled(enabled)
    }

    fun reject(callId: String, caller: Boolean) {
        calls[callId]?.let { call ->
            scope.launch {
                call.reject(if (caller) RejectReason.Cancel else RejectReason.Decline)
                call.leave()
                emit(callId, "rejected", mapOf("reason" to if (caller) "cancelled" else "declined"))
            }
        }
    }

    fun leave(callId: String) {
        callerWaiting.remove(callId)
        callJobs.remove(callId)?.forEach { it.cancel() }
        calls.remove(callId)?.leave()
        acceptingCalls.remove(callId)
        joiningCalls.remove(callId)
        joinedCalls.remove(callId)
        callTypes.remove(callId)
        emit(callId, "left")
    }

    @Synchronized
    fun disconnect(context: Context, clearCredentials: Boolean = true) {
        calls.keys.toList().forEach(::leave)
        clientEvents?.dispose()
        clientEvents = null
        StreamVideo.instanceOrNull()?.logOut()
        StreamVideo.removeClient()
        if (clearCredentials) prefs(context).edit().clear().apply()
    }
}

class StreamCallBridgePlugin : FlutterPlugin,
    MethodChannel.MethodCallHandler,
    EventChannel.StreamHandler {
    private lateinit var context: Context
    private var methods: MethodChannel? = null
    private var events: EventChannel? = null
    private var sink: EventChannel.EventSink? = null

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        context = binding.applicationContext
        methods = MethodChannel(binding.binaryMessenger, "avatok/stream_call").also {
            it.setMethodCallHandler(this)
        }
        events = EventChannel(binding.binaryMessenger, "avatok/stream_call/events").also {
            it.setStreamHandler(this)
        }
        StreamCallRuntime.bootstrap(context)
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        StreamCallRuntime.removeSink(sink)
        sink = null
        methods?.setMethodCallHandler(null)
        events?.setStreamHandler(null)
        methods = null
        events = null
    }

    override fun onListen(arguments: Any?, eventSink: EventChannel.EventSink) {
        sink = eventSink
        StreamCallRuntime.addSink(eventSink)
    }

    override fun onCancel(arguments: Any?) {
        StreamCallRuntime.removeSink(sink)
        sink = null
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        val args = call.arguments as? Map<*, *> ?: emptyMap<String, Any?>()
        runCatching {
            when (call.method) {
                "current_credentials" -> {
                    result.success(StreamCallRuntime.currentCredentials(
                        context, args["call_id"]?.toString().orEmpty(),
                    ))
                    return
                }
                "initialize", "refresh_credentials", "show_incoming" ->
                    StreamCallRuntime.prepareCall(context, args)
                "join" -> StreamCallRuntime.join(context, args)
                "set_mic" -> StreamCallRuntime.setMic(
                    args["call_id"]?.toString().orEmpty(), args["enabled"] == true,
                )
                "set_camera" -> if (args["enabled"] == true) error("audio_only")
                "set_mode" -> if (args["mode"]?.toString() == "video") error("audio_only")
                "reject" -> StreamCallRuntime.reject(
                    args["call_id"]?.toString().orEmpty(), args["role"] == "caller",
                )
                "leave" -> StreamCallRuntime.leave(args["call_id"]?.toString().orEmpty())
                "disconnect" -> StreamCallRuntime.disconnect(context)
                else -> {
                    result.notImplemented()
                    return
                }
            }
            result.success(null)
        }.onFailure { error ->
            result.error("stream_${call.method}_failed", error.javaClass.simpleName, null)
        }
    }

    companion object {
        @JvmStatic fun bootstrap(context: Context) {
            StreamCallRuntime.bootstrap(context.applicationContext)
        }

        @JvmStatic fun handleIntent(context: Context, intent: Intent?): Boolean =
            StreamCallRuntime.handleIntent(context.applicationContext, intent)
    }
}
