package com.picoagent;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Build;
import android.util.Log;
import com.unity3d.player.UnityPlayer;

/**
 * pico-spatial-mcp drive shim. Runtime-registered (manifest-declared receivers do not get
 * implicit `am broadcast -a <pkg>.DEBUG_CMD` on API 26+; runtime receivers do — same reason the
 * native lane registers in Application.onCreate). RECEIVER_EXPORTED on 33+ mirrors the native
 * apps. Plain .java in Plugins/Android: Unity's Gradle compiles it; ships as reviewable text.
 */
public final class PicoDebugCmdReceiver extends BroadcastReceiver {
    private static final String TAG = "PicoAgent";
    private static PicoDebugCmdReceiver sInstance;

    public static void register(Activity activity) {
        if (sInstance != null) return;
        sInstance = new PicoDebugCmdReceiver();
        IntentFilter filter = new IntentFilter(activity.getPackageName() + ".DEBUG_CMD");
        if (Build.VERSION.SDK_INT >= 33) {
            activity.registerReceiver(sInstance, filter, Context.RECEIVER_EXPORTED);
        } else {
            activity.registerReceiver(sInstance, filter);
        }
        Log.i(TAG, "DEBUG_CMD receiver registered for " + activity.getPackageName());
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        String cmd = intent == null ? null : intent.getStringExtra("cmd");
        if (cmd == null) return;
        Log.i(TAG, "DEBUG_CMD cmd=" + cmd);
        UnityPlayer.UnitySendMessage("PicoAgentBridge", "OnDebugCmd", cmd);
    }
}
