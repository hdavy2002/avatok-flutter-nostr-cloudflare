package com.hellofraands.hf_app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build
import android.os.Bundle
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import java.io.File

class MainActivity : FlutterActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        // Install-level only: Android excludes this directory from cloud backup and
        // device transfer, and removes it on uninstall. Account changes leave it alone.
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "hf/install_intro")
            .setMethodCallHandler { call, result ->
                try {
                    val marker = File(noBackupFilesDir, "intro_completed_v1")
                    when (call.method) {
                        "isCompleted" -> result.success(marker.isFile)
                        "complete" -> {
                            if (!marker.isFile && !marker.createNewFile()) {
                                result.error("storage_unavailable", "Could not save intro completion", null)
                            } else {
                                result.success(true)
                            }
                        }
                        else -> result.notImplemented()
                    }
                } catch (_: Exception) {
                    result.error("storage_unavailable", "Intro storage unavailable", null)
                }
            }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        createDefaultChannel()
    }

    // The channel the worker's pushes name (data.channelId "hf_default"). Created here so no
    // flutter_local_notifications package is needed. The id lives in res/values/hf_notification.xml.
    private fun createDefaultChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(NotificationManager::class.java) ?: return
        val channel = NotificationChannel(
            getString(R.string.hf_notification_channel_id),
            getString(R.string.app_name),
            NotificationManager.IMPORTANCE_HIGH,
        )
        manager.createNotificationChannel(channel)
    }
}
