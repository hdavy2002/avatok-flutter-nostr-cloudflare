package com.hellofraands.hf_app

import android.app.Activity
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Intent
import android.net.Uri
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
    private var pendingMulti = false
    private var pendingMax = 5

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

        // [HF-MERCH-APP-1] pickImage / pickImages: the system chooser for PNG or JPEG pictures (WebP too when allowWebp is true).
        // pickImage answers {path, name, mime} for one picture; pickImages (up to max, default 5) answers a list of the same maps,
        // where a picture that could not be taken is {name, error}. null means she backed out. No permission is needed.
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "hf/merch_art")
            .setMethodCallHandler { call, result ->
                val multi = call.method == "pickImages"
                if (call.method != "pickImage" && !multi) {
                    result.notImplemented()
                } else if (pendingPick != null) {
                    result.error("busy", "A picture is already being chosen", null)
                } else {
                    try {
                        val allowWebp = call.argument<Boolean>("allowWebp") == true
                        val max = (call.argument<Int>("max") ?: 5).coerceIn(1, 10)
                        val intent = Intent(Intent.ACTION_GET_CONTENT)
                        intent.type = "image/*"
                        intent.addCategory(Intent.CATEGORY_OPENABLE)
                        val types = if (allowWebp) arrayOf("image/png", "image/jpeg", "image/webp") else arrayOf("image/png", "image/jpeg")
                        intent.putExtra(Intent.EXTRA_MIME_TYPES, types)
                        if (multi) intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                        pendingMulti = multi
                        pendingMax = max
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

    /// Copies one chosen picture into the app cache. Answers {path, name, mime}, or {name, error} when it is too big or unreadable.
    private fun copyPicked(uri: Uri): Map<String, String> {
        var name = "art"
        try {
            contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                if (c.moveToFirst()) {
                    val i = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    if (i >= 0) name = c.getString(i) ?: "art"
                }
            }
            val mime = contentResolver.getType(uri) ?: ""
            val out = File(cacheDir, "merch_art_" + System.nanoTime())
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
                return mapOf("name" to name, "error" to "too_large")
            }
            return mapOf("path" to out.absolutePath, "name" to name, "mime" to mime)
        } catch (_: Exception) {
            return mapOf("name" to name, "error" to "read_failed")
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
        val multi = pendingMulti
        val max = pendingMax
        val uris = ArrayList<Uri>()
        val clip = data?.clipData
        if (clip != null) {
            for (i in 0 until clip.itemCount) {
                val u = clip.getItemAt(i).uri
                if (u != null) uris.add(u)
            }
        } else {
            val u = data?.data
            if (u != null) uris.add(u)
        }
        if (resultCode != Activity.RESULT_OK || uris.isEmpty()) {
            result.success(null)
            return
        }
        val take = if (multi) uris.take(max) else uris.take(1)
        Thread {
            val answers = take.map { copyPicked(it) }
            runOnUiThread {
                if (multi) {
                    result.success(answers)
                } else {
                    val first = answers[0]
                    val err = first["error"]
                    if (err == null) {
                        result.success(first)
                    } else if (err == "too_large") {
                        result.error("too_large", "The picture must be 15 MB or smaller", null)
                    } else {
                        result.error("read_failed", "Could not read that picture", null)
                    }
                }
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
