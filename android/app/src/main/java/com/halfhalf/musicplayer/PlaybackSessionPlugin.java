package com.halfhalf.musicplayer;

import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Handler;
import android.os.Looper;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** System media keys/lock-screen transport for the existing WebView player. */
@CapacitorPlugin(name = "PlaybackSession")
public class PlaybackSessionPlugin extends Plugin {
    private MediaSession session;
    @Override public void load() {
        session = new MediaSession(getContext(), "HalfHalfPlayback");
        session.setCallback(new MediaSession.Callback() {
            @Override public void onPlay() { action("play", 0); }
            @Override public void onPause() { action("pause", 0); }
            @Override public void onStop() { action("pause", 0); }
            @Override public void onSkipToNext() { action("next", 0); }
            @Override public void onSkipToPrevious() { action("prev", 0); }
            @Override public void onSeekTo(long pos) { action("seek", pos / 1000.0); }
        }, new Handler(Looper.getMainLooper()));
    }
    private void action(String name, double position) {
        JSObject data = new JSObject();
        data.put("action", name); data.put("position", position);
        notifyListeners("action", data);
    }
    @PluginMethod public void update(PluginCall call) {
        boolean active = call.getBoolean("active", false);
        boolean playing = call.getBoolean("playing", false);
        session.setMetadata(new MediaMetadata.Builder()
            .putString(MediaMetadata.METADATA_KEY_TITLE, call.getString("title", "Half&Half"))
            .putString(MediaMetadata.METADATA_KEY_ARTIST, call.getString("artist", ""))
            .putString(MediaMetadata.METADATA_KEY_ALBUM, "Half&Half")
            .putLong(MediaMetadata.METADATA_KEY_DURATION, Math.round(call.getDouble("duration", 0.0) * 1000))
            .build());
        long actions = PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE | PlaybackState.ACTION_PLAY_PAUSE
            | PlaybackState.ACTION_STOP | PlaybackState.ACTION_SEEK_TO | PlaybackState.ACTION_SKIP_TO_PREVIOUS;
        if (call.getBoolean("canNext", false)) actions |= PlaybackState.ACTION_SKIP_TO_NEXT;
        session.setPlaybackState(new PlaybackState.Builder().setActions(actions)
            .setState(!active ? PlaybackState.STATE_NONE : playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED,
                Math.round(call.getDouble("position", 0.0) * 1000), playing ? 1f : 0f).build());
        session.setActive(active);
        call.resolve();
    }
    @Override protected void handleOnDestroy() {
        if (session != null) { session.setActive(false); session.release(); }
    }
}
