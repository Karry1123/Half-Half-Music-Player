package com.halfhalf.musicplayer;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.media.AudioAttributes;
import android.media.AudioPlaybackConfiguration;
import android.media.AudioManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "AudioGuard")
public class AudioGuardPlugin extends Plugin {
    private AudioManager manager;
    private boolean registered, inCall;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final BroadcastReceiver noisy = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            if (AudioManager.ACTION_AUDIO_BECOMING_NOISY.equals(intent.getAction()))
                notifyListeners("becomingNoisy", new JSObject());
        }
    };
    private boolean callActive() {
        if (manager == null) return false;
        int mode = manager.getMode();
        return mode == AudioManager.MODE_IN_CALL || mode == AudioManager.MODE_IN_COMMUNICATION
            || mode == AudioManager.MODE_RINGTONE;
    }
    private void emit(String state) {
        JSObject data = new JSObject();
        data.put("state", state);
        notifyListeners("interruption", data);
    }
    private final Runnable pollCall = new Runnable() {
        @Override public void run() {
            if (!registered) return;
            boolean active = callActive();
            if (active != inCall) { inCall = active; emit(active ? "lossTransient" : "gain"); }
            handler.postDelayed(this, 500);
        }
    };
    @Override public void load() {
        manager = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
    }
    // Bridge compatibility: WebView is the sole audio-focus owner.
    @PluginMethod public void requestFocus(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            try {
                if (!registered) {
                    IntentFilter filter = new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY);
                    if (Build.VERSION.SDK_INT >= 33) getContext().registerReceiver(noisy, filter, Context.RECEIVER_EXPORTED);
                    else getContext().registerReceiver(noisy, filter);
                    registered = true;
                    handler.post(pollCall);
                }
                JSObject data = new JSObject();
                data.put("granted", true);
                call.resolve(data);
            } catch (RuntimeException e) { abandon(); call.reject("Unable to monitor audio", e); }
        });
    }
    // Called only after the main element stays paused, with preview stopped.
    // Public configurations are anonymized; getClientUid is not a public API.
    @PluginMethod public void getInterruption(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            JSObject data = new JSObject();
            try {
                if (callActive()) { inCall = true; data.put("state", "lossTransient"); }
                else if (manager != null && Build.VERSION.SDK_INT >= 26) {
                    for (AudioPlaybackConfiguration config : manager.getActivePlaybackConfigurations()) {
                        int usage = config.getAudioAttributes().getUsage();
                        if (usage == AudioAttributes.USAGE_MEDIA || usage == AudioAttributes.USAGE_GAME) {
                            data.put("state", "loss");
                            break;
                        }
                    }
                }
                call.resolve(data);
            } catch (RuntimeException e) { call.resolve(data); }
        });
    }
    private void abandon() {
        handler.removeCallbacks(pollCall);
        inCall = false;
        if (registered) {
            try { getContext().unregisterReceiver(noisy); } catch (IllegalArgumentException ignored) { }
            registered = false;
        }
    }
    @PluginMethod public void abandonFocus(PluginCall call) {
        getActivity().runOnUiThread(() -> { abandon(); call.resolve(); });
    }
    @Override protected void handleOnDestroy() { abandon(); }
}
