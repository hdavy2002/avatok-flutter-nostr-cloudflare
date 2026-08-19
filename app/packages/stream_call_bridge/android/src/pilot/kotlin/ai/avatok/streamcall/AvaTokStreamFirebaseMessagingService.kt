package ai.avatok.streamcall

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import io.getstream.android.push.firebase.FirebaseMessagingDelegate

/** Stream-only FCM delegate; FlutterFire's receiver continues AvaTOK messages. */
class AvaTokStreamFirebaseMessagingService : FirebaseMessagingService() {
    override fun onMessageReceived(message: RemoteMessage) {
        if (message.data["sender"] != "stream.video") return
        val callId = message.data["call_cid"]?.substringAfter(':').orEmpty()
        StreamCallRuntime.emit(callId.ifEmpty { "__push__" }, "fcm_received", mapOf(
            "push_type" to message.data["type"].orEmpty(),
            "process_path" to "native_service",
        ))
        StreamCallRuntime.bootstrap(applicationContext)
        runCatching { FirebaseMessagingDelegate.handleRemoteMessage(message) }
            .onSuccess { handled ->
                StreamCallRuntime.emit(callId.ifEmpty { "__push__" }, "fcm_delegate_completed", mapOf(
                    "handled" to handled,
                ))
            }
            .onFailure { error ->
                StreamCallRuntime.emit(callId.ifEmpty { "__push__" }, "error", mapOf(
                    "reason" to "fcm_delegate_${error.javaClass.simpleName}",
                ))
            }
    }

    override fun onNewToken(token: String) {
        StreamCallRuntime.bootstrap(applicationContext)
        runCatching { FirebaseMessagingDelegate.registerFirebaseToken(token, "firebase") }
    }
}
