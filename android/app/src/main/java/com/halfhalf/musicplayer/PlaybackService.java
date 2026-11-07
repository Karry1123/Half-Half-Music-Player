package com.halfhalf.musicplayer;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.drawable.Icon;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.util.Log;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Foreground service that owns the MediaSession, the MediaStyle playback notification and the wake
 * lock. It renders whatever {@link PlaybackStateStore} holds; the WebView pushes state through
 * {@link PlaybackSessionPlugin}, and buttons here go back to the WebView as "action" events.
 */
public class PlaybackService extends Service {
    private static final String TAG = "PlaybackService";
    public static final String CHANNEL_ID = "playback";
    public static final int NOTIFICATION_ID = 4101;
    public static final String ACTION_UPDATE = "com.halfhalf.musicplayer.UPDATE";
    public static final String ACTION_PLAY = "com.halfhalf.musicplayer.PLAY";
    public static final String ACTION_PAUSE = "com.halfhalf.musicplayer.PAUSE";
    public static final String ACTION_TOGGLE = "com.halfhalf.musicplayer.TOGGLE";
    public static final String ACTION_NEXT = "com.halfhalf.musicplayer.NEXT";
    public static final String ACTION_PREV = "com.halfhalf.musicplayer.PREV";
    public static final String ACTION_FAVORITE = "com.halfhalf.musicplayer.FAVORITE";
    public static final String ACTION_MODE = "com.halfhalf.musicplayer.MODE";
    public static final String ACTION_STOP = "com.halfhalf.musicplayer.STOP";
    /** Extra carried by MainActivity launch intents from the widget when the service is not alive. */
    public static final String EXTRA_LAUNCH_ACTION = "hh.action";
    private static final long DETACH_DELAY_MS = 2000;
    private static final long WIDGET_TICK_MS = 30_000;

    private static volatile PlaybackService instance;

    private MediaSession session;
    private NotificationManager notifications;
    private PowerManager.WakeLock wakeLock;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private boolean foreground;
    private String artworkPath = "";
    private Bitmap artwork;
    private String lyricTrack = "", lyricSource = "", displayedLine = "", metadataKey = "";
    private JSONArray lyricCues = new JSONArray();
    private long lastLyricUpdate = -1000;

    public static PlaybackService running() { return instance; }

    /** Ask the service to re-render the stored state, starting it when needed. */
    public static void push(Context context, boolean wantForeground) {
        PlaybackService live = instance;
        Intent intent = new Intent(context, PlaybackService.class).setAction(ACTION_UPDATE);
        try {
            if (wantForeground && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent);
            else context.startService(intent);
        } catch (Exception e) {
            // Background start restrictions (Android 8+/12+): keep the notification and session fresh without
            // promoting to foreground; the WebView retries on the next visibilitychange.
            Log.w(TAG, "start refused, applying in place: " + e);
            if (live != null) live.apply();
        }
    }

    @Override public void onCreate() {
        super.onCreate();
        instance = this;
        notifications = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "音乐播放", NotificationManager.IMPORTANCE_LOW);
            channel.setShowBadge(false);
            channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            notifications.createNotificationChannel(channel);
        }
        session = new MediaSession(this, "HalfHalfPlayback");
        session.setCallback(new MediaSession.Callback() {
            @Override public void onPlay() { dispatch("play", 0); }
            @Override public void onPause() { dispatch("pause", 0); }
            @Override public void onStop() { dispatch("pause", 0); }
            @Override public void onSkipToNext() { dispatch("next", 0); }
            @Override public void onSkipToPrevious() { dispatch("prev", 0); }
            @Override public void onSeekTo(long pos) { dispatch("seek", pos / 1000.0); }
        }, handler);
        session.setSessionActivity(contentIntent(this, null, 0));
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "HalfHalf:playback");
        wakeLock.setReferenceCounted(false);
        PlaybackStateStore.setServiceAlive(this, true);
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? ACTION_UPDATE : intent.getAction();
        if (action == null) action = ACTION_UPDATE;
        switch (action) {
            case ACTION_PLAY: dispatch("play", 0); break;
            case ACTION_PAUSE: dispatch("pause", 0); break;
            case ACTION_NEXT: dispatch("next", 0); break;
            case ACTION_FAVORITE: dispatch("favorite", 0); break;
            case ACTION_MODE: dispatch("mode", 0); break;
            case ACTION_PREV: dispatch("prev", 0); break;
            case ACTION_TOGGLE: dispatch(PlaybackStateStore.load(this).playing ? "pause" : "play", 0); break;
            case ACTION_STOP: dispatch("pause", 0); shutdown(); return START_NOT_STICKY;
            default: break;
        }
        apply();
        return START_NOT_STICKY;
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override public void onTaskRemoved(Intent rootIntent) {
        // Swiped away from recents: the WebView is gone, so nothing could answer a button press.
        shutdown();
        super.onTaskRemoved(rootIntent);
    }

    @Override public void onDestroy() {
        instance = null;
        handler.removeCallbacksAndMessages(null);
        if (wakeLock.isHeld()) wakeLock.release();
        session.setActive(false);
        session.release();
        PlaybackStateStore.setServiceAlive(this, false);
        PlayerWidgetProvider.refreshAll(this);
        super.onDestroy();
    }

    private void dispatch(String action, double position) {
        PlaybackSessionPlugin.dispatch(this, action, position);
    }

    /** Render the stored state into session, notification, wake lock and widgets. */
    public void apply() {
        PlaybackStateStore.State s = PlaybackStateStore.load(this);
        if (!s.active) { shutdown(); return; }
        loadArtwork(s.artworkPath);
        updateLyricLine(s);
        publishMetadata(s);
        scheduleLyrics(s);
        long actions = PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE | PlaybackState.ACTION_PLAY_PAUSE
            | PlaybackState.ACTION_STOP | PlaybackState.ACTION_SEEK_TO;
        if (s.canNext) actions |= PlaybackState.ACTION_SKIP_TO_NEXT;
        if (s.canPrev) actions |= PlaybackState.ACTION_SKIP_TO_PREVIOUS;
        long updateTime = s.positionAt > 0 ? s.positionAt : SystemClock.elapsedRealtime();
        session.setPlaybackState(new PlaybackState.Builder().setActions(actions)
            .setState(s.playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED,
                Math.round(s.position * 1000), s.playing ? 1f : 0f, updateTime).build());
        session.setActive(true);

        Notification notification = buildNotification(s);
        handler.removeCallbacks(detach);
        handler.removeCallbacks(tick);
        if (s.hold) {
            // The wake lock is only for audible playback. While paused for a call or a transient focus loss
            // the foreground service alone keeps the process alive, and the system events that end the wait
            // (mode change, focus gain) wake the main thread on their own.
            if (s.playing && !wakeLock.isHeld()) wakeLock.acquire(6 * 60 * 60 * 1000L);
            if (!s.playing && wakeLock.isHeld()) wakeLock.release();
            promote(notification);
            if (s.playing) handler.postDelayed(tick, WIDGET_TICK_MS);
        } else {
            if (wakeLock.isHeld()) wakeLock.release();
            notifications.notify(NOTIFICATION_ID, notification);
            // Keep the notification for a resume tap, but drop foreground status (and its battery cost) shortly after.
            handler.postDelayed(detach, DETACH_DELAY_MS);
        }
        PlayerWidgetProvider.refreshAll(this);
    }

    /** Native boundary scheduling keeps lyrics moving even when the WebView is background-throttled. */
    public void applyLyrics() {
        handler.post(lyricTick);
    }

    private final Runnable lyricTick = () -> {
        PlaybackStateStore.State s = PlaybackStateStore.load(this);
        if (!s.active) return;
        updateLyricLine(s);
        if (publishMetadata(s)) notifications.notify(NOTIFICATION_ID, buildNotification(s));
        scheduleLyrics(s);
    };

    private void updateLyricLine(PlaybackStateStore.State s) {
        boolean newTrack = !lyricTrack.equals(s.trackId);
        if (newTrack || !lyricSource.equals(s.lyricLines)) {
            lyricTrack = s.trackId; lyricSource = s.lyricLines;
            try { lyricCues = new JSONArray(lyricSource); }
            catch (Exception ignored) { lyricCues = new JSONArray(); }
        }
        String line = s.lyricsEnabled ? s.currentLine : "";
        if (s.lyricsEnabled && lyricCues.length() > 0) {
            line = "";
            double position = s.currentPosition() + s.lyricOffset;
            for (int i = 0; i < lyricCues.length(); i++) {
                JSONObject cue = lyricCues.optJSONObject(i);
                if (cue == null || cue.optDouble("time", Double.MAX_VALUE) > position) break;
                line = cue.optString("text", "");
            }
        }
        long now = SystemClock.elapsedRealtime();
        if (newTrack || !s.lyricsEnabled || s.lyrics.isEmpty() || now - lastLyricUpdate >= 1000) {
            if (!line.equals(displayedLine) || newTrack) {
                displayedLine = line; lastLyricUpdate = now;
            }
        }
    }

    private void scheduleLyrics(PlaybackStateStore.State s) {
        handler.removeCallbacks(lyricTick);
        if (!s.active || !s.lyricsEnabled || lyricCues.length() == 0) return;
        long now = SystemClock.elapsedRealtime();
        // A seek/offset change can arrive within the throttle window, even while paused.
        long delay = Math.max(1, 1000 - (now - lastLyricUpdate));
        if (delay <= 1) {
            if (!s.playing) return;
            double position = s.currentPosition() + s.lyricOffset;
            delay = Long.MAX_VALUE;
            for (int i = 0; i < lyricCues.length(); i++) {
                JSONObject cue = lyricCues.optJSONObject(i);
                double time = cue == null ? -1 : cue.optDouble("time", -1);
                if (time > position) { delay = Math.max(1, (long) Math.ceil((time - position) * 1000)); break; }
            }
            if (delay == Long.MAX_VALUE) return;
        }
        handler.postDelayed(lyricTick, delay);
    }

    private String lyricSubtitle(PlaybackStateStore.State s) {
        if (!s.lyricsEnabled) return "";
        if (!displayedLine.isEmpty()) return displayedLine;
        return lyricCues.length() == 0 ? s.lyrics.split("\\n", 2)[0] : "";
    }

    private boolean publishMetadata(PlaybackStateStore.State s) {
        String lyric = lyricSubtitle(s);
        String description = s.lyricsEnabled ? s.lyrics : "";
        String key = new JSONArray().put(s.trackId).put(s.title).put(s.artist).put(s.subtitle)
            .put(String.valueOf(s.duration)).put(s.artworkPath).put(lyric).put(description).toString();
        if (key.equals(metadataKey)) return false;
        metadataKey = key;
        session.setMetadata(new MediaMetadata.Builder()
            .putString(MediaMetadata.METADATA_KEY_TITLE, s.title.isEmpty() ? "Half&Half" : s.title)
            .putString(MediaMetadata.METADATA_KEY_ARTIST, s.artist)
            .putString(MediaMetadata.METADATA_KEY_DISPLAY_TITLE, s.title.isEmpty() ? "Half&Half" : s.title)
            .putString(MediaMetadata.METADATA_KEY_DISPLAY_SUBTITLE, lyric.isEmpty() ? s.artist : lyric)
            .putString(MediaMetadata.METADATA_KEY_DISPLAY_DESCRIPTION, description.isEmpty() ? s.subtitle : description)
            .putString(MediaMetadata.METADATA_KEY_ALBUM, s.subtitle.isEmpty() ? "Half&Half" : s.subtitle)
            .putLong(MediaMetadata.METADATA_KEY_DURATION, Math.round(s.duration * 1000))
            .putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, artwork)
            .putBitmap(MediaMetadata.METADATA_KEY_ART, artwork)
            .build());
        return true;
    }

    private final Runnable detach = () -> {
        if (!foreground) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_DETACH);
        else stopForeground(false);
        foreground = false;
    };

    private final Runnable tick = new Runnable() {
        @Override public void run() {
            PlayerWidgetProvider.refreshAll(PlaybackService.this);
            if (PlaybackStateStore.load(PlaybackService.this).playing) handler.postDelayed(this, WIDGET_TICK_MS);
        }
    };

    private void promote(Notification notification) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q)
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
            else startForeground(NOTIFICATION_ID, notification);
            foreground = true;
        } catch (Exception e) {
            // ForegroundServiceStartNotAllowedException and friends: stay a plain notification.
            Log.w(TAG, "startForeground refused: " + e);
            notifications.notify(NOTIFICATION_ID, notification);
        }
    }

    private void shutdown() {
        handler.removeCallbacks(lyricTick);
        handler.removeCallbacks(detach);
        handler.removeCallbacks(tick);
        if (wakeLock.isHeld()) wakeLock.release();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_REMOVE);
        else stopForeground(true);
        foreground = false;
        notifications.cancel(NOTIFICATION_ID);
        session.setActive(false);
        stopSelf();
    }

    private void loadArtwork(String path) {
        if (path.equals(artworkPath) && (artwork != null || path.isEmpty())) return;
        artworkPath = path;
        artwork = path.isEmpty() ? null : BitmapFactory.decodeFile(path);
    }

    private Notification buildNotification(PlaybackStateStore.State s) {
        Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, CHANNEL_ID)
            : new Notification.Builder(this).setPriority(Notification.PRIORITY_LOW);
        b.setSmallIcon(R.drawable.ic_stat_music)
            .setContentTitle(s.title.isEmpty() ? "Half&Half" : s.title)
            .setContentText(lyricSubtitle(s).isEmpty() ? s.artist : lyricSubtitle(s))
            .setSubText(s.subtitle)
            .setContentIntent(contentIntent(this, null, 0))
            .setDeleteIntent(serviceIntent(this, ACTION_STOP, 5))
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setOngoing(s.hold);
        if (artwork != null) b.setLargeIcon(artwork);
        b.addAction(action(R.drawable.ic_skip_previous, "上一首", ACTION_PREV, 1));
        b.addAction(s.playing ? action(R.drawable.ic_pause, "暂停", ACTION_PAUSE, 2) : action(R.drawable.ic_play, "播放", ACTION_PLAY, 2));
        b.addAction(action(R.drawable.ic_skip_next, "下一首", ACTION_NEXT, 3));
        b.setStyle(new Notification.MediaStyle().setMediaSession(session.getSessionToken()).setShowActionsInCompactView(0, 1, 2));
        return b.build();
    }

    private Notification.Action action(int icon, String title, String action, int code) {
        return new Notification.Action.Builder(Icon.createWithResource(this, icon), title, serviceIntent(this, action, code)).build();
    }

    public static PendingIntent serviceIntent(Context c, String action, int code) {
        Intent i = new Intent(c, PlaybackService.class).setAction(action);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? PendingIntent.getForegroundService(c, code, i, flags)
            : PendingIntent.getService(c, code, i, flags);
    }

    /** Opens (or fronts) the app; with a launch action the WebView performs it once it is ready. */
    public static PendingIntent contentIntent(Context c, String launchAction, int code) {
        Intent i = new Intent(c, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (launchAction != null) i.setAction("hh." + launchAction).putExtra(EXTRA_LAUNCH_ACTION, launchAction);
        return PendingIntent.getActivity(c, 100 + code, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
}
