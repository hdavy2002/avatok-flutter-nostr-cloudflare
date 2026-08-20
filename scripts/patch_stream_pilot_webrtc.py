#!/usr/bin/env python3
"""Adapt the Android source tree to Stream's WebRTC fork for pilot builds only.

Stream core uses fork-only M125 APIs, so substituting AvaTOK's WebRTC AAR is not
safe. The fork omits AvaTOK's custom decoded-playback callback. This strict CI
patch keeps flutter_webrtc usable for the dark rollback path while making call
recording and live translation explicitly unavailable in the Stream pilot.
"""

from __future__ import annotations

import os
from pathlib import Path
import re
import sys


EXPECTED_VERSION = "0.12.12+hotfix.1"


def fail(message: str) -> None:
    print(f"::error::{message}", file=sys.stderr)
    raise SystemExit(1)


def replace_checked(path: Path, old: str, new: str, label: str) -> None:
    if not path.is_file():
        fail(f"{label}: expected file missing: {path}")
    text = path.read_text()
    if new in text and old not in text:
        # flutter-action restores PUB_CACHE between workflow runs. This script
        # deliberately patches that cache, so a later run can legitimately see
        # the exact verified post-patch source already in place.
        return
    if old not in text:
        fail(f"{label}: expected source shape changed; refusing an unverified patch")
    path.write_text(text.replace(old, new, 1))


def main() -> None:
    if len(sys.argv) != 2:
        fail("usage: patch_stream_pilot_webrtc.py <app-directory>")
    app = Path(sys.argv[1]).resolve()
    lock = (app / "pubspec.lock").read_text()
    match = re.search(
        r"^  flutter_webrtc:\n(?:    .*\n)*?    version: \"([^\"]+)\"$",
        lock,
        re.MULTILINE,
    )
    if not match or match.group(1) != EXPECTED_VERSION:
        found = match.group(1) if match else "missing"
        fail(f"flutter_webrtc {found}; pilot patch requires {EXPECTED_VERSION}")

    pub_cache = Path(os.environ.get("PUB_CACHE", Path.home() / ".pub-cache"))
    package = pub_cache / "hosted" / "pub.dev" / f"flutter_webrtc-{EXPECTED_VERSION}"
    java = package / "android/src/main/java/com/cloudwebrtc/webrtc"

    adapter = java / "audio/PlaybackSamplesReadyCallbackAdapter.java"
    expected_adapter = """package com.cloudwebrtc.webrtc.audio;

import org.webrtc.audio.JavaAudioDeviceModule;

import java.util.ArrayList;
import java.util.List;

public class PlaybackSamplesReadyCallbackAdapter
        implements JavaAudioDeviceModule.PlaybackSamplesReadyCallback {
    public PlaybackSamplesReadyCallbackAdapter() {}

    List<JavaAudioDeviceModule.PlaybackSamplesReadyCallback> callbacks = new ArrayList<>();

    public void addCallback(JavaAudioDeviceModule.PlaybackSamplesReadyCallback callback) {
        synchronized (callbacks) {
            callbacks.add(callback);
        }
    }

    public void removeCallback(JavaAudioDeviceModule.PlaybackSamplesReadyCallback callback) {
        synchronized (callbacks) {
            callbacks.remove(callback);
        }
    }

    @Override
    public void onWebRtcAudioTrackSamplesReady(JavaAudioDeviceModule.AudioSamples audioSamples) {
        for (JavaAudioDeviceModule.PlaybackSamplesReadyCallback callback : callbacks) {
            callback.onWebRtcAudioTrackSamplesReady(audioSamples);
        }
    }
}
"""
    no_op_adapter = """package com.cloudwebrtc.webrtc.audio;

/** Stream pilot compatibility shell. The Stream WebRTC fork has no decoded
 * playback callback, so optional consumers are disabled by the app stubs. */
public final class PlaybackSamplesReadyCallbackAdapter {
    public PlaybackSamplesReadyCallbackAdapter() {}
    public void addCallback(Object callback) {}
    public void removeCallback(Object callback) {}
}
"""
    adapter_text = adapter.read_text()
    if adapter_text == no_op_adapter:
        # The shared CI pub cache may already contain our exact verified shell
        # from an earlier Stream build. Treat only that byte-for-byte form as
        # idempotent; every other source shape still fails closed.
        pass
    elif adapter_text == expected_adapter:
        adapter.write_text(no_op_adapter)
    else:
        fail("flutter_webrtc playback adapter source changed; refusing an unverified patch")

    handler = java / "MethodCallHandlerImpl.java"
    replace_checked(
        handler,
        "    audioDeviceModuleBuilder.setPlaybackSamplesReadyCallback(playbackSamplesReadyCallbackAdapter);\n",
        "    // Stream pilot: fork has no decoded-playback callback.\n",
        "flutter_webrtc audio builder",
    )

    translation = app / "android/app/src/main/java/ai/avatok/calltranslation/CallTranslationAudioPlugin.java"
    if "JavaAudioDeviceModule.PlaybackSamplesReadyCallback" not in translation.read_text():
        fail("call translation source shape changed; refusing an unverified stub")
    translation.write_text("""package ai.avatok.calltranslation;

import androidx.annotation.NonNull;
import io.flutter.embedding.engine.plugins.FlutterPlugin;
import io.flutter.plugin.common.EventChannel;
import io.flutter.plugin.common.MethodCall;
import io.flutter.plugin.common.MethodChannel;

/** Fail-closed Stream pilot stub: decoded playback PCM is unavailable. */
public final class CallTranslationAudioPlugin implements FlutterPlugin,
        MethodChannel.MethodCallHandler, EventChannel.StreamHandler {
    public static volatile Object boundWebRtcPlugin;
    private MethodChannel methods;
    private EventChannel events;

    @Override public void onAttachedToEngine(@NonNull FlutterPluginBinding binding) {
        methods = new MethodChannel(binding.getBinaryMessenger(), "avatok/call_translation_audio");
        methods.setMethodCallHandler(this);
        events = new EventChannel(binding.getBinaryMessenger(), "avatok/call_translation_audio_events");
        events.setStreamHandler(this);
    }
    @Override public void onDetachedFromEngine(@NonNull FlutterPluginBinding binding) {
        methods.setMethodCallHandler(null); events.setStreamHandler(null);
    }
    @Override public void onListen(Object arguments, EventChannel.EventSink sink) {}
    @Override public void onCancel(Object arguments) {}
    @Override public void onMethodCall(@NonNull MethodCall call, @NonNull MethodChannel.Result result) {
        if (call.method.equals("isSupported")) result.success(false);
        else if (call.method.equals("lastProbeFailure")) result.success("stream_pilot_no_playback_pcm");
        else if (call.method.equals("lastProbeSource")) result.success("none");
        else if (call.method.equals("stop")) result.success(null);
        else result.error("stream_pilot_unavailable", "Live translation is unavailable in the Stream pilot", null);
    }
}
""")

    recorder = app / "android/app/src/main/kotlin/ai/avatok/callrecord/CallRecorderPlugin.kt"
    if "JavaAudioDeviceModule.PlaybackSamplesReadyCallback" not in recorder.read_text():
        fail("call recorder source shape changed; refusing an unverified stub")
    recorder.write_text("""package ai.avatok.callrecord

import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel

/** Fail-closed Stream pilot stub: decoded playback PCM is unavailable. */
class CallRecorderPlugin : FlutterPlugin, MethodChannel.MethodCallHandler, EventChannel.StreamHandler {
    companion object {
        const val OUT_RATE = 32000
        @JvmField var boundWebRtcPlugin: Any? = null
    }
    private var methods: MethodChannel? = null
    private var events: EventChannel? = null
    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        methods = MethodChannel(binding.binaryMessenger, "avatok/call_record").also { it.setMethodCallHandler(this) }
        events = EventChannel(binding.binaryMessenger, "avatok/call_record/events").also { it.setStreamHandler(this) }
    }
    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        methods?.setMethodCallHandler(null); events?.setStreamHandler(null)
    }
    override fun onListen(arguments: Any?, sink: EventChannel.EventSink) {}
    override fun onCancel(arguments: Any?) {}
    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "start", "stop", "pause", "resume" -> result.success(mapOf("ok" to false, "error" to "stream_pilot_unavailable"))
            "state" -> result.success(mapOf("recording" to false, "paused" to false))
            "recoverOrphans" -> result.success(mapOf("recovered" to emptyList<Any>()))
            "freeBytes" -> result.success(null)
            "cancel" -> result.success(null)
            else -> result.notImplemented()
        }
    }
}
""")
    print(f"Stream pilot WebRTC compatibility applied for flutter_webrtc {EXPECTED_VERSION}")


if __name__ == "__main__":
    main()
