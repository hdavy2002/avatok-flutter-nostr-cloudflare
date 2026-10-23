package com.hellofraands.hf_app

import android.app.Activity
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.provider.OpenableColumns
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import java.io.File

class MainActivity : FlutterActivity() {
    // [HF-MERCH-APP-1] The gallery chooser for merch art: answers are delivered from onActivityResult.
    private var pendingPick: MethodChannel.Result? = null

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

        // [HF-MERCH-APP-1] pickImage: the system chooser for one PNG or JPEG. The file is copied into the app cache and the
        // answer is {path, name, mime}; null means she backed out. No permission is needed (the chooser hands over one file).
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "hf/merch_art")
            .setMethodCallHandler { call, result ->
                if (call.method != "pickImage") {
                    result.notImplemented()
                } else if (pendingPick != null) {
                    result.error("busy", "A picture is already being chosen", null)
                } else {
                    try {
                        val intent = Intent(Intent.ACTION_GET_CONTENT)
                        intent.type = "image/*"
                        intent.addCategory(Intent.CATEGORY_OPENABLE)
                        intent.putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("image/png", "image/jpeg"))
                        pendingPick = result
                        @Suppress("DEPRECATION")
                        startActivityForResult(intent, PICK_ART)
                    } catch (_: Exception) {
                        pendingPick = null
                        result.error("unavailable", "No picture chooser on this phone", null)
                    }
                }
            }
    }

    @Suppress("DEPRECATION")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode != PICK_ART) {
            super.onActivityResult(requestCode, resultCode, data)
            return
        }
        val result = pendingPick ?: return
        pendingPick = null
        val uri = data?.data
        if (resultCode != Activity.RESULT_OK || uri == null) {
            result.success(null)
            return
        }
        Thread {
            try {
                var name = "art"
                contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                    if (c.moveToFirst()) {
                        val i = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                        if (i >= 0) name = c.getString(i) ?: "art"
                    }
                }
                val mime = contentResolver.getType(uri) ?: ""
                val out = File(cacheDir, "merch_art_" + System.currentTimeMillis())
                var total = 0L
                var tooBig = false
                val input = contentResolver.openInputStream(uri) ?: throw IllegalStateException("no stream")
                input.use { src ->
                    out.outputStream().use { sink ->
                        val buf = ByteArray(64 * 1024)
                        while (true) {
                            val n = src.read(buf)
                            if (n < 0) break
                            total += n
                            if (total > MAX_ART_BYTES) {
                                tooBig = true
                                break
                            }
                            sink.write(buf, 0, n)
                        }
                    }
                }
                if (tooBig) {
                    out.delete()
                    runOnUiThread { result.error("too_large", "The picture must be 15 MB or smaller", null) }
                } else {
                    runOnUiThread { result.success(mapOf("path" to out.absolutePath, "name" to name, "mime" to mime)) }
                }
            } catch (_: Exception) {
                runOnUiThread { result.error("read_failed", "Could not read that picture", null) }
            }
        }.start()
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

    companion object {
        private const val PICK_ART = 7311
        private const val MAX_ART_BYTES = 15L * 1024 * 1024
    }
}
