package com.halfhalf.musicplayer;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.SystemClock;

/**
 * Last playback state pushed from the WebView, kept in SharedPreferences so the notification,
 * the media session and the home-screen widgets can render it even after the WebView is gone.
 */
public final class PlaybackStateStore {
    private static final String PREFS = "hh_playback";

    public static final class State {
        public boolean active, playing, hold, canNext, canPrev, serviceAlive, favorite, canChangeMode;
        public String trackId = "", title = "", artist = "", subtitle = "", artworkPath = "";
        public String playMode = "order", seedColor = "";
        public boolean lyricsEnabled = true;
        public String lyrics = "", lyricLines = "[]", currentLine = "";
        public double lyricOffset;
        public double duration, position;
        /** SystemClock.elapsedRealtime() when `position` was sampled. */
        public long positionAt;

        /** Position extrapolated to now while playing, clamped to the duration. */
        public double currentPosition() {
            double p = position;
            if (playing && positionAt > 0) p += (SystemClock.elapsedRealtime() - positionAt) / 1000.0;
            if (duration > 0) p = Math.min(duration, p);
            return Math.max(0, p);
        }
    }

    private PlaybackStateStore() {}

    static String normalizeMode(String mode) {
        return "loopAll".equals(mode) || "loopOne".equals(mode) || "shuffle".equals(mode) ? mode : "order";
    }

    static String normalizeSeed(String seed) {
        return seed != null && seed.matches("#[0-9a-fA-F]{6}") ? seed.toLowerCase(java.util.Locale.ROOT) : "";
    }

    private static SharedPreferences prefs(Context c) {
        return c.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    public static State load(Context c) {
        SharedPreferences p = prefs(c);
        State s = new State();
        s.active = p.getBoolean("active", false);
        s.playing = p.getBoolean("playing", false);
        s.hold = p.getBoolean("hold", false);
        s.canNext = p.getBoolean("canNext", false);
        s.canPrev = p.getBoolean("canPrev", false);
        s.favorite = p.getBoolean("favorite", false);
        s.canChangeMode = p.getBoolean("canChangeMode", false);
        s.playMode = normalizeMode(p.getString("playMode", "order"));
        s.seedColor = normalizeSeed(p.getString("seedColor", ""));
        s.serviceAlive = p.getBoolean("serviceAlive", false);
        s.trackId = p.getString("trackId", "");
        s.title = p.getString("title", "");
        s.artist = p.getString("artist", "");
        s.subtitle = p.getString("subtitle", "");
        s.lyricsEnabled = p.getBoolean("lyricsEnabled", true);
        s.lyrics = p.getString("lyrics", "");
        s.lyricLines = p.getString("lyricLines", "[]");
        s.currentLine = p.getString("currentLine", "");
        s.lyricOffset = Double.longBitsToDouble(p.getLong("lyricOffset", 0L));
        s.artworkPath = p.getString("artworkPath", "");
        s.duration = Double.longBitsToDouble(p.getLong("duration", 0L));
        s.position = Double.longBitsToDouble(p.getLong("position", 0L));
        s.positionAt = p.getLong("positionAt", 0L);
        return s;
    }

    public static void save(Context c, State s) {
        prefs(c).edit()
            .putBoolean("active", s.active).putBoolean("playing", s.playing).putBoolean("hold", s.hold)
            .putBoolean("canNext", s.canNext).putBoolean("canPrev", s.canPrev).putBoolean("serviceAlive", s.serviceAlive)
            .putBoolean("favorite", s.favorite).putBoolean("canChangeMode", s.canChangeMode)
            .putString("playMode", normalizeMode(s.playMode)).putString("seedColor", normalizeSeed(s.seedColor))
            .putString("trackId", s.trackId).putString("title", s.title).putString("artist", s.artist)
            .putString("subtitle", s.subtitle).putString("artworkPath", s.artworkPath)
            .putBoolean("lyricsEnabled", s.lyricsEnabled).putString("lyrics", s.lyrics)
            .putString("lyricLines", s.lyricLines).putString("currentLine", s.currentLine)
            .putLong("lyricOffset", Double.doubleToLongBits(s.lyricOffset))
            .putLong("duration", Double.doubleToLongBits(s.duration)).putLong("position", Double.doubleToLongBits(s.position))
            .putLong("positionAt", s.positionAt)
            .apply();
    }

    public static void setServiceAlive(Context c, boolean alive) {
        prefs(c).edit().putBoolean("serviceAlive", alive).apply();
    }

    /** Records the artwork file for a track; ignored when another track has become current meanwhile. */
    public static boolean setArtworkPath(Context c, String trackId, String path) {
        SharedPreferences p = prefs(c);
        if (!trackId.equals(p.getString("trackId", ""))) return false;
        p.edit().putString("artworkPath", path).apply();
        return true;
    }
}
