package com.halfhalf.musicplayer;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.LinearGradient;
import android.graphics.Shader;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.PorterDuff;
import android.graphics.PorterDuffXfermode;
import android.util.Log;
import android.util.LruCache;
import android.os.Bundle;
import android.view.View;
import android.widget.RemoteViews;
import java.util.Locale;
import java.io.File;

/**
 * Home-screen "now playing" widget (4x2). It is a snapshot of {@link PlaybackStateStore}: the service
 * refreshes it on every state change and every 30 s while playing. Buttons go to the service while it
 * is alive; otherwise they open the app carrying the action, because nothing else could answer them.
 */
public class PlayerWidgetProvider extends AppWidgetProvider {
    private static final String TAG = "PlayerWidget";
    public static final String ACTION_REFRESH = "com.halfhalf.musicplayer.WIDGET_REFRESH";
    private static final int ART_PX = 256;
    private static final LruCache<String, Bitmap> BACKGROUNDS = new LruCache<>(8);
    private static String artworkKey = "";
    private static Bitmap cachedArtwork;
    private static int dominant;

    /** Re-render every placed widget of every size. */
    public static void refreshAll(Context context) {
        try {
            AppWidgetManager manager = AppWidgetManager.getInstance(context);
            render(context, manager, manager.getAppWidgetIds(new ComponentName(context, PlayerWidgetProvider.class)), R.layout.widget_player);
            render(context, manager, manager.getAppWidgetIds(new ComponentName(context, PlayerWidgetSmallProvider.class)), R.layout.widget_player_small);
        } catch (Exception e) {
            Log.w(TAG, "refresh failed: " + e);
        }
    }

    @Override public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
        render(context, manager, ids, layout());
    }

    @Override public void onAppWidgetOptionsChanged(Context context, AppWidgetManager manager,
            int id, Bundle options) {
        render(context, manager, new int[] { id }, layout());
    }

    @Override public void onReceive(Context context, Intent intent) {
        if (ACTION_REFRESH.equals(intent.getAction())) { refreshAll(context); return; }
        super.onReceive(context, intent);
    }

    protected int layout() { return R.layout.widget_player; }

    static void render(Context context, AppWidgetManager manager, int[] ids, int layout) {
        if (ids == null || ids.length == 0) return;
        PlaybackStateStore.State s = PlaybackStateStore.load(context);
        Bitmap art = artwork(s);
        for (int id : ids) {
            Bitmap background = art == null ? null : background(context, manager.getAppWidgetOptions(id), s.trackId, layout);
            manager.updateAppWidget(id, build(context, s, art, background, layout));
        }
    }

    private static RemoteViews build(Context c, PlaybackStateStore.State s, Bitmap art, Bitmap background, int layout) {
        RemoteViews v = new RemoteViews(c.getPackageName(), layout);
        boolean hasTrack = !s.title.isEmpty();
        boolean live = s.serviceAlive && s.active;
        v.setImageViewBitmap(R.id.widget_background, background);
        v.setTextViewText(R.id.widget_title, hasTrack ? s.title : c.getString(R.string.widget_empty_title));
        v.setTextViewText(R.id.widget_artist, hasTrack ? s.artist : c.getString(R.string.widget_empty_hint));
        if (art != null) v.setImageViewBitmap(R.id.widget_art, art);
        else v.setImageViewResource(R.id.widget_art, R.drawable.widget_art_placeholder);
        v.setImageViewResource(R.id.widget_toggle, live && s.playing ? R.drawable.ic_pause : R.drawable.ic_play);
        v.setContentDescription(R.id.widget_toggle, c.getString(live && s.playing ? R.string.widget_pause : R.string.widget_play));

        if (layout == R.layout.widget_player) {
            String status;
            if (!hasTrack) status = "";
            else if (!live) status = c.getString(R.string.widget_open_to_resume);
            else if (s.playing && s.duration > 0) status = clock(s.currentPosition()) + " / " + clock(s.duration) + (s.subtitle.isEmpty() ? "" : " · " + s.subtitle);
            else if (s.playing) status = s.subtitle.isEmpty() ? c.getString(R.string.widget_playing) : s.subtitle;
            else status = c.getString(R.string.widget_paused);
            v.setTextViewText(R.id.widget_status, status);
            v.setViewVisibility(R.id.widget_status, status.isEmpty() ? View.GONE : View.VISIBLE);
            v.setViewVisibility(R.id.widget_progress, hasTrack && s.duration > 0 ? View.VISIBLE : View.GONE);
            v.setProgressBar(R.id.widget_progress, 1000,
                s.duration > 0 ? (int) Math.round(1000 * s.currentPosition() / s.duration) : 0, false);
        }
        v.setInt(R.id.widget_prev, "setAlpha", live && s.canPrev ? 255 : 110);
        v.setInt(R.id.widget_next, "setAlpha", live && s.canNext ? 255 : 110);
        v.setOnClickPendingIntent(R.id.widget_prev, live ? PlaybackService.serviceIntent(c, PlaybackService.ACTION_PREV, 11) : PlaybackService.contentIntent(c, "prev", 11));
        v.setOnClickPendingIntent(R.id.widget_next, live ? PlaybackService.serviceIntent(c, PlaybackService.ACTION_NEXT, 13) : PlaybackService.contentIntent(c, "next", 13));
        v.setOnClickPendingIntent(R.id.widget_toggle, live ? PlaybackService.serviceIntent(c, PlaybackService.ACTION_TOGGLE, 12) : PlaybackService.contentIntent(c, "play", 12));
        v.setOnClickPendingIntent(R.id.widget_root, PlaybackService.contentIntent(c, null, 10));
        return v;
    }

    private static String clock(double seconds) {
        long t = Math.max(0, Math.round(seconds));
        return String.format(Locale.US, "%d:%02d", t / 60, t % 60);
    }

    /** Invalidate when late-arriving artwork is written, even if the track ID has not changed. */
    private static Bitmap artwork(PlaybackStateStore.State s) {
        File file = new File(s.artworkPath);
        String key = s.title.isEmpty() ? "" : s.trackId + "|" + s.artworkPath + "|" + file.lastModified() + "|" + file.length();
        if (!key.equals(artworkKey) || (cachedArtwork == null && file.isFile() && !s.title.isEmpty())) {
            artworkKey = key;
            cachedArtwork = s.title.isEmpty() ? null : roundedArtwork(s.artworkPath);
            BACKGROUNDS.evictAll();
            if (cachedArtwork != null) dominant = dominantColour(cachedArtwork);
        }
        return cachedArtwork;
    }

    /** Saturation-weighted hue histogram from only 24x24 pixels; neutrals retain their own tone. */
    private static int dominantColour(Bitmap art) {
        Bitmap sample = Bitmap.createScaledBitmap(art, 24, 24, true);
        float[] weights = new float[24], red = new float[24], green = new float[24], blue = new float[24];
        float[] hsv = new float[3];
        long neutralR = 0, neutralG = 0, neutralB = 0;
        int count = 0, best = 0;
        for (int y = 0; y < 24; y++) for (int x = 0; x < 24; x++) {
            int pixel = sample.getPixel(x, y);
            if (Color.alpha(pixel) < 192) continue;
            neutralR += Color.red(pixel); neutralG += Color.green(pixel); neutralB += Color.blue(pixel); count++;
            Color.colorToHSV(pixel, hsv);
            if (hsv[1] < .18f || hsv[2] < .12f) continue;
            int bucket = Math.min(23, (int) (hsv[0] / 15));
            float weight = .25f + hsv[1] * .75f;
            weights[bucket] += weight;
            red[bucket] += Color.red(pixel) * weight;
            green[bucket] += Color.green(pixel) * weight;
            blue[bucket] += Color.blue(pixel) * weight;
        }
        sample.recycle();
        for (int i = 1; i < 24; i++) if (weights[i] > weights[best]) best = i;
        if (weights[best] > 0) return Color.rgb(Math.round(red[best] / weights[best]),
            Math.round(green[best] / weights[best]), Math.round(blue[best] / weights[best]));
        return count == 0 ? Color.rgb(40, 43, 53) : Color.rgb((int) (neutralR / count), (int) (neutralG / count), (int) (neutralB / count));
    }

    private static Bitmap background(Context c, Bundle options, String trackId, int layout) {
        boolean small = layout == R.layout.widget_player_small;
        int widthDp = Math.max(1, options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, small ? 144 : 280));
        int heightDp = Math.max(1, options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 148));
        float scale = Math.min(1f, Math.min(400f / widthDp, 200f / heightDp));
        int width = Math.max(1, Math.round(widthDp * scale)), height = Math.max(1, Math.round(heightDp * scale));
        String key = trackId + "|" + width + "|" + height;
        Bitmap bitmap = BACKGROUNDS.get(key);
        if (bitmap != null) return bitmap;
        float[] hsv = new float[3];
        Color.colorToHSV(dominant, hsv);
        // Cap brightness even for white/yellow artwork so cream labels always stay legible.
        hsv[1] *= .8f;
        hsv[2] = Math.min(.42f, .13f + hsv[2] * .32f);
        int mid = Color.HSVToColor(hsv);
        hsv[2] *= .48f;
        int deep = Color.HSVToColor(hsv);
        bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        paint.setShader(new LinearGradient(0, 0, width, height, mid, deep, Shader.TileMode.CLAMP));
        float radiusDp = c.getResources().getDimension(R.dimen.widget_corner_radius) / c.getResources().getDisplayMetrics().density;
        float radius = radiusDp * scale;
        new Canvas(bitmap).drawRoundRect(new RectF(0, 0, width, height), radius, radius, paint);
        BACKGROUNDS.put(key, bitmap);
        return bitmap;
    }

    /** Small, rounded copy of the cached artwork; RemoteViews bitmaps must stay well under the IPC limit. */
    private static Bitmap roundedArtwork(String path) {
        if (path == null || path.isEmpty()) return null;
        BitmapFactory.Options opts = new BitmapFactory.Options();
        opts.inJustDecodeBounds = true;
        BitmapFactory.decodeFile(path, opts);
        if (opts.outWidth <= 0) return null;
        opts.inJustDecodeBounds = false;
        opts.inSampleSize = Math.max(1, Math.min(opts.outWidth, opts.outHeight) / ART_PX);
        Bitmap src = BitmapFactory.decodeFile(path, opts);
        if (src == null) return null;
        int side = Math.min(src.getWidth(), src.getHeight());
        Bitmap out = Bitmap.createBitmap(ART_PX, ART_PX, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(out);
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.FILTER_BITMAP_FLAG);
        float radius = ART_PX * 0.12f;
        canvas.drawRoundRect(new RectF(0, 0, ART_PX, ART_PX), radius, radius, paint);
        paint.setXfermode(new PorterDuffXfermode(PorterDuff.Mode.SRC_IN));
        int left = (src.getWidth() - side) / 2, top = (src.getHeight() - side) / 2;
        canvas.drawBitmap(src, new android.graphics.Rect(left, top, left + side, top + side), new RectF(0, 0, ART_PX, ART_PX), paint);
        if (src != out) src.recycle();
        return out;
    }
}
