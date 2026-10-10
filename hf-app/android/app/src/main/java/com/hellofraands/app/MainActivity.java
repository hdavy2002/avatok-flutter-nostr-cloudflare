package com.hellofraands.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

/**
 * Camera and microphone: no native permission code is needed here. When the website calls getUserMedia,
 * Capacitor's BridgeWebChromeClient.onPermissionRequest asks Android for CAMERA / RECORD_AUDIO
 * (the manifest declares them), then grants or denies the WebView request from the person's answer.
 */
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // [HF-APP-5] Local plugins must be registered before super.onCreate() builds the bridge.
        registerPlugin(HfSettingsPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
