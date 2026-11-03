package com.halfhalf.musicplayer;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.media.AudioPlaybackConfiguration;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Audio interruptions for the WebView player: headphones unplugged, another media app, and phone calls.
 *
 * Calls run as a dedicated "call watch": nothing polls while music plays normally. A call is noticed
 * either by the audio mode listener (Android 12+) or when the WebView reports an external pause and
 * {@link #getInterruption} finds the phone in a call. From then on the plugin watches only for the call
 * to end, emits {@code callEnded} once, and stops watching.
 */
@CapacitorPlugin(name = "AudioGuard")
public class AudioGuardPlugin extends Plugin {
    private static final long CALL_POLL_MS = 500;
    private AudioManager manager;
    private boolean registered, inCall, watchingCall, modeListening;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private Object modeListener; // AudioManager.OnModeChangedListener, API 31+
    private final BroadcastReceiver noisy = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            if (AudioManager.ACTION_AUDIO_BECOMING_NOISY.equals(intent.getAction()))
                notifyListeners("becomingNoisy", new JSObject());
        }
    };

    private static boolean isCallMode(int mode) {
        return mode == AudioManager.MODE_IN_CALL || mode == AudioManager.MODE_IN_COMMUNICATION
            || mode == AudioManager.MODE_RINGTONE || (Build.VERSION.SDK_INT >= 30 && mode == AudioManager.MODE_CALL_SCREENING);
    }

    private boolean callActive() {
        return manager != null && isCallMode(manager.getMode());
    }

    private void emit(String state) {
        JSObject data = new JSObject();
        data.put("state", state);
        notifyListeners("interruption", data);
    }

    /** Enter call mode: tell the page once, then watch for the end of the call. */
    private void callStarted() {
        if (inCall) return;
        inCall = true;
        emit("callStart");
        watchCall();
    }

    private void callEnded() {
        if (!inCall) return;
        inCall = false;
        stopWatchingCall();
        emit("callEnded");
    }

    private final Runnable pollCall = new Runnable() {
        @Override public void run() {
            if (!watchingCall) return;
            if (callActive()) handler.postDelayed(this, CALL_POLL_MS);
            else callEnded();
        }
    };

    private void watchCall() {
        if (watchingCall) return;
        watchingCall = true;
        // The mode listener (API 31+) already delivers the end of the call; older versions poll briefly.
        if (!modeListening) handler.postDelayed(pollCall, CALL_POLL_MS);
    }

    private void stopWatchingCall() {
        watchingCall = false;
        handler.removeCallbacks(pollCall);
    }

    private void startModeListener() {
        if (modeListening || manager == null || Build.VERSION.SDK_INT < 31) return;
        AudioManager.OnModeChangedListener listener = mode -> {
            if (!registered) return;
            if (isCallMode(mode)) callStarted(); else callEnded();
        };
        manager.addOnModeChangedListener(getContext().getMainExecutor(), listener);
        modeListener = listener;
        modeListening = true;
    }

    private void stopModeListener() {
        if (!modeListening || manager == null) return;
        if (Build.VERSION.SDK_INT >= 31) manager.removeOnModeChangedListener((AudioManager.OnModeChangedListener) modeListener);
        modeListener = null;
        modeListening = false;
    }

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
                    startModeListener();
                    if (callActive()) callStarted();
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
                if (callActive()) {
                    data.put("state", "callStart");
                    if (!inCall) { inCall = true; watchCall(); } // the page learns about the call from this reply
                } else if (manager != null && Build.VERSION.SDK_INT >= 26) {
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
        stopWatchingCall();
        stopModeListener();
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
