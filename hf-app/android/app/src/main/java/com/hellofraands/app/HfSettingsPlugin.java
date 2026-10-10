package com.hellofraands.app;

import android.content.Intent;
import android.net.Uri;
import android.provider.Settings;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * [HF-APP-5] Tiny local plugin: lets the website send the person to this app's Android settings page
 * (Permissions) after they tapped "Don't allow" on the camera or microphone prompt.
 * Web side: window.Capacitor.Plugins.HfSettings.openAppSettings()
 */
@CapacitorPlugin(name = "HfSettings")
public class HfSettingsPlugin extends Plugin {

    @PluginMethod
    public void openAppSettings(PluginCall call) {
        try {
            Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            intent.setData(Uri.fromParts("package", getContext().getPackageName(), null));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve(new JSObject());
        } catch (Exception e) {
            call.reject("Could not open the app settings", e);
        }
    }
}
