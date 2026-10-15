package com.halfhalf.musicplayer;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
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
    private AudioFocusRequest request;
    private boolean registered;
    private final BroadcastReceiver noisy = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            if (AudioManager.ACTION_AUDIO_BECOMING_NOISY.equals(intent.getAction()))
                notifyListeners("becomingNoisy", new JSObject());
        }
    };
    private final AudioManager.OnAudioFocusChangeListener listener = change -> {
        String state;
        switch (change) {
            case AudioManager.AUDIOFOCUS_LOSS: state = "loss"; break;
            case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT: state = "lossTransient"; break;
            case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK: state = "lossTransientCanDuck"; break;
            case AudioManager.AUDIOFOCUS_GAIN: state = "gain"; break;
            default: return;
        }
        JSObject data = new JSObject();
        data.put("state", state);
        notifyListeners("focusChange", data);
    };
    @Override public void load() {
        manager = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        if (Build.VERSION.SDK_INT >= 26) {
            request = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                .setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build())
                .setOnAudioFocusChangeListener(listener, new Handler(Looper.getMainLooper()))
                .setWillPauseWhenDucked(false).setAcceptsDelayedFocusGain(false).build();
        }
    }
    @PluginMethod public void requestFocus(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            try {
                if (!registered) {
                    IntentFilter filter = new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY);
                    if (Build.VERSION.SDK_INT >= 33) getContext().registerReceiver(noisy, filter, Context.RECEIVER_EXPORTED);
                    else getContext().registerReceiver(noisy, filter);
                    registered = true;
                }
                int result = Build.VERSION.SDK_INT >= 26 ? manager.requestAudioFocus(request)
                    : manager.requestAudioFocus(listener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN);
                if (result != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) abandon();
                JSObject data = new JSObject();
                data.put("granted", result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED);
                call.resolve(data);
            } catch (RuntimeException e) { abandon(); call.reject("无法获取音频焦点", e); }
        });
    }
    private void abandon() {
        if (manager != null) {
            if (Build.VERSION.SDK_INT >= 26 && request != null) manager.abandonAudioFocusRequest(request);
            else manager.abandonAudioFocus(listener);
        }
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
