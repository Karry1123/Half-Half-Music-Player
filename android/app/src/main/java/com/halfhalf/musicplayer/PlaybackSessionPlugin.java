package com.halfhalf.musicplayer;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Build;
import android.os.SystemClock;
import android.util.Base64;
import android.util.Log;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.File;
import java.io.FileOutputStream;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Comparator;

/**
 * JS entry point for system playback UI: the WebView pushes state and artwork in, and receives
 * "action" events (play / pause / next / prev / seek) from the notification, lock screen, media
 * keys and home-screen widgets.
 */
@CapacitorPlugin(name = "PlaybackSession", permissions = {
    @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
})
public class PlaybackSessionPlugin extends Plugin {
    private static final String TAG = "PlaybackSession";
    private static final int ARTWORK_MAX = 512;
    private static final int ARTWORK_CACHE_FILES = 40;
    private static volatile PlaybackSessionPlugin instance;
    private static String pendingLaunchAction;

    @Override public void load() {
        instance = this;
        String pending = pendingLaunchAction;
        pendingLaunchAction = null;
        if (pending != null) emit(pending, 0);
    }

    @Override protected void handleOnDestroy() {
        if (instance == this) instance = null;
    }

    private void emit(String action, double position) {
        JSObject data = new JSObject();
        data.put("action", action);
        data.put("position", position);
        // Retained: a cold start may deliver before the page has attached its listener.
        notifyListeners("action", data, true);
    }

    /** From the service (notification, media keys, widget): hand the action to the page or open the app with it. */
    static void dispatch(Context context, String action, double position) {
        PlaybackSessionPlugin live = instance;
        if (live != null) { live.emit(action, position); return; }
        try {
            PlaybackService.contentIntent(context, action, 7).send();
        } catch (Exception e) {
            Log.w(TAG, "cannot open app for action " + action + ": " + e);
        }
    }

    /** From MainActivity: a widget tapped while the service was not running launched the app with an action. */
    static void deliverLaunchAction(Intent intent) {
        if (intent == null) return;
        String action = intent.getStringExtra(PlaybackService.EXTRA_LAUNCH_ACTION);
        if (action == null || action.isEmpty()) return;
        intent.removeExtra(PlaybackService.EXTRA_LAUNCH_ACTION);
        PlaybackSessionPlugin live = instance;
        if (live != null) live.emit(action, 0);
        else pendingLaunchAction = action;
    }

    @PluginMethod public void update(PluginCall call) {
        Context c = getContext();
        PlaybackStateStore.State prev = PlaybackStateStore.load(c);
        PlaybackStateStore.State s = new PlaybackStateStore.State();
        s.active = call.getBoolean("active", false);
        s.playing = call.getBoolean("playing", false);
        s.hold = call.getBoolean("hold", s.playing);
        s.canNext = call.getBoolean("canNext", false);
        s.canPrev = call.getBoolean("canPrev", s.active);
        s.trackId = call.getString("trackId", "");
        s.title = call.getString("title", "");
        s.artist = call.getString("artist", "");
        s.subtitle = call.getString("subtitle", "");
        s.duration = call.getDouble("duration", 0.0);
        s.position = call.getDouble("position", 0.0);
        s.positionAt = SystemClock.elapsedRealtime();
        s.serviceAlive = prev.serviceAlive;
        if (s.trackId.equals(prev.trackId)) s.artworkPath = prev.artworkPath;
        else {
            File cached = artworkFile(c, s.trackId);
            s.artworkPath = cached.isFile() ? cached.getAbsolutePath() : "";
        }
        PlaybackStateStore.save(c, s);
        PlaybackService live = PlaybackService.running();
        if (s.active) PlaybackService.push(c, s.hold);
        else if (live != null) live.apply();
        else PlayerWidgetProvider.refreshAll(c);
        call.resolve();
    }

    /** Artwork for a track as base64 image bytes; cached on disk so the widget can show it after the app is gone. */
    @PluginMethod public void setArtwork(PluginCall call) {
        String id = call.getString("trackId", "");
        String data = call.getString("data", "");
        if (id.isEmpty() || data.isEmpty()) { call.reject("trackId and data are required"); return; }
        Context c = getContext();
        try {
            byte[] bytes = Base64.decode(data, Base64.DEFAULT);
            Bitmap bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
            if (bitmap == null) { call.reject("not an image"); return; }
            int w = bitmap.getWidth(), h = bitmap.getHeight();
            if (Math.max(w, h) > ARTWORK_MAX) {
                float k = ARTWORK_MAX / (float) Math.max(w, h);
                bitmap = Bitmap.createScaledBitmap(bitmap, Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k)), true);
            }
            File file = artworkFile(c, id);
            File tmp = new File(file.getPath() + ".tmp");
            try (FileOutputStream out = new FileOutputStream(tmp)) {
                bitmap.compress(Bitmap.CompressFormat.JPEG, 88, out);
            }
            if (!tmp.renameTo(file)) throw new IllegalStateException("rename failed");
            trimArtworkCache(file.getParentFile());
            if (PlaybackStateStore.setArtworkPath(c, id, file.getAbsolutePath())) {
                PlaybackService live = PlaybackService.running();
                if (live != null) live.apply(); else PlayerWidgetProvider.refreshAll(c);
            }
            call.resolve();
        } catch (Exception e) {
            call.reject("artwork failed: " + e.getMessage());
        }
    }

    @PluginMethod public void requestNotifications(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) { resolveGranted(call, true); return; }
        if (getPermissionState("notifications") == PermissionState.GRANTED) { resolveGranted(call, true); return; }
        requestPermissionForAlias("notifications", call, "onNotificationsResult");
    }

    @PermissionCallback private void onNotificationsResult(PluginCall call) {
        resolveGranted(call, getPermissionState("notifications") == PermissionState.GRANTED);
    }

    private void resolveGranted(PluginCall call, boolean granted) {
        JSObject r = new JSObject();
        r.put("granted", granted);
        call.resolve(r);
    }

    static File artworkFile(Context c, String trackId) {
        File dir = new File(c.getCacheDir(), "artwork");
        if (!dir.isDirectory()) dir.mkdirs();
        return new File(dir, hash(trackId) + ".jpg");
    }

    private static String hash(String s) {
        try {
            byte[] d = MessageDigest.getInstance("SHA-1").digest(s.getBytes("UTF-8"));
            StringBuilder b = new StringBuilder();
            for (byte x : d) b.append(String.format("%02x", x));
            return b.toString();
        } catch (Exception e) {
            return String.valueOf(s.hashCode());
        }
    }

    private static void trimArtworkCache(File dir) {
        File[] files = dir == null ? null : dir.listFiles((d, n) -> n.endsWith(".jpg"));
        if (files == null || files.length <= ARTWORK_CACHE_FILES) return;
        Arrays.sort(files, Comparator.comparingLong(File::lastModified));
        for (int i = 0; i < files.length - ARTWORK_CACHE_FILES; i++) files[i].delete();
    }
}
