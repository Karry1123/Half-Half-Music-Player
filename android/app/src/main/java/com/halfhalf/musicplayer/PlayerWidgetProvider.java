package com.halfhalf.musicplayer;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Path;
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
    private static final LruCache<String, Bitmap> BUTTONS = new LruCache<>(12);
    private static String artworkKey = "";
    private static Bitmap cachedArtwork;
    private static int dominant;

    /** Re-render every placed widget of every size. */
    public static void refreshAll(Context context) {
        try {
            AppWidgetManager manager = AppWidgetManager.getInstance(context);
            render(context, manager, manager.getAppWidgetIds(new ComponentName(context, PlayerWidgetProvider.class)), R.layout.widget_player);
            render(context, manager, manager.getAppWidgetIds(new ComponentName(context, PlayerWidgetSmallProvider.class)), R.layout.widget_player_small);
            render(context, manager, manager.getAppWidgetIds(new ComponentName(context, PlayerWidgetBarProvider.class)), R.layout.widget_player_bar);
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
            Bundle options = manager.getAppWidgetOptions(id);
            int selectedLayout = layout == R.layout.widget_player_small
                && options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 118) < Math.max(148,
                    124 + (int) Math.ceil(18 * context.getResources().getConfiguration().fontScale))
                ? R.layout.widget_player_small_compact : layout;
            Palette palette = palette(context, art != null, s.seedColor);
            Bitmap background = art == null && s.seedColor.isEmpty() ? null : background(context, options, s.trackId, selectedLayout, palette);
            manager.updateAppWidget(id, build(context, s, art, background, selectedLayout, options, palette));
        }
    }

    private static RemoteViews build(Context c, PlaybackStateStore.State s, Bitmap art, Bitmap background, int layout, Bundle options, Palette palette) {
        RemoteViews v = new RemoteViews(c.getPackageName(), layout);
        boolean hasTrack = !s.title.isEmpty();
        boolean live = s.serviceAlive && s.active;
        v.setImageViewBitmap(R.id.widget_background, background);
        v.setTextViewText(R.id.widget_title, hasTrack ? s.title : c.getString(R.string.widget_empty_title));
        boolean small = layout == R.layout.widget_player_small || layout == R.layout.widget_player_small_compact;
        String trackDescription = hasTrack ? s.title + " \u00b7 " + s.artist : c.getString(R.string.widget_empty_hint);
        v.setContentDescription(R.id.widget_art, trackDescription);
        v.setContentDescription(R.id.widget_root, trackDescription);
        if (!small) v.setTextViewText(R.id.widget_artist, hasTrack ? s.artist : c.getString(R.string.widget_empty_hint));
        v.setTextColor(R.id.widget_title, palette.title);
        if (!small) v.setTextColor(R.id.widget_artist, palette.secondary);
        applyButton(v, R.id.widget_prev, R.id.widget_prev_background, palette.container, palette.icon, s.trackId, palette, small);
        applyButton(v, R.id.widget_next, R.id.widget_next_background, palette.container, palette.icon, s.trackId, palette, small);
        applyButton(v, R.id.widget_toggle, R.id.widget_toggle_background, palette.primary, palette.onPrimary, s.trackId, palette, small);
        if (art != null) v.setImageViewBitmap(R.id.widget_art, art);
        else v.setImageViewResource(R.id.widget_art, R.drawable.widget_art_placeholder);
        v.setImageViewResource(R.id.widget_toggle, live && s.playing ? R.drawable.ic_pause : R.drawable.ic_play);
        v.setContentDescription(R.id.widget_toggle, (live ? c.getString(s.playing ? R.string.widget_pause : R.string.widget_play) : c.getString(R.string.widget_open_to_resume)) + " \u00b7 " + trackDescription);

        if (layout == R.layout.widget_player) {
            boolean wide = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 250) >= 300;
            v.setViewVisibility(R.id.widget_mode_tile, wide ? View.VISIBLE : View.GONE);
            v.setViewVisibility(R.id.widget_favorite_tile, wide ? View.VISIBLE : View.GONE);
            boolean order = "order".equals(s.playMode);
            int modeIcon = "loopAll".equals(s.playMode) ? R.drawable.ic_repeat
                : "loopOne".equals(s.playMode) ? R.drawable.ic_repeat_one : R.drawable.ic_shuffle;
            int modeLabel = "loopAll".equals(s.playMode) ? R.string.widget_mode_loop_all
                : "loopOne".equals(s.playMode) ? R.string.widget_mode_loop_one
                : "shuffle".equals(s.playMode) ? R.string.widget_mode_shuffle : R.string.widget_mode_order;
            v.setImageViewResource(R.id.widget_mode, modeIcon);
            v.setImageViewResource(R.id.widget_favorite, s.favorite ? R.drawable.ic_heart : R.drawable.ic_heart_outline);
            applyButton(v, R.id.widget_mode, R.id.widget_mode_background,
                order ? palette.container : palette.primary, order ? palette.icon : palette.onPrimary, s.trackId, palette, false);
            applyButton(v, R.id.widget_favorite, R.id.widget_favorite_background,
                s.favorite ? palette.primary : palette.container, s.favorite ? palette.onPrimary : palette.icon, s.trackId, palette, false);
            v.setInt(R.id.widget_mode, "setAlpha", s.canChangeMode && !order ? 255 : 110);
            v.setBoolean(R.id.widget_mode, "setEnabled", hasTrack && s.canChangeMode);
            v.setBoolean(R.id.widget_favorite, "setEnabled", hasTrack);
            v.setContentDescription(R.id.widget_mode, c.getString(R.string.widget_mode) + " \u00b7 " + c.getString(modeLabel));
            v.setContentDescription(R.id.widget_favorite, c.getString(s.favorite ? R.string.widget_unfavorite : R.string.widget_favorite));
            v.setOnClickPendingIntent(R.id.widget_mode, live ? PlaybackService.serviceIntent(c, PlaybackService.ACTION_MODE, 14) : PlaybackService.contentIntent(c, "mode", 14));
            v.setOnClickPendingIntent(R.id.widget_favorite, live ? PlaybackService.serviceIntent(c, PlaybackService.ACTION_FAVORITE, 15) : PlaybackService.contentIntent(c, "favorite", 15));
            String status;
            if (!hasTrack) status = "";
            else if (!live) status = c.getString(R.string.widget_open_to_resume);
            else if (s.playing && s.duration > 0) status = clock(s.currentPosition()) + " / " + clock(s.duration) + (s.subtitle.isEmpty() ? "" : " \u00b7 " + s.subtitle);
            else if (s.playing) status = s.subtitle.isEmpty() ? c.getString(R.string.widget_playing) : s.subtitle;
            else status = c.getString(R.string.widget_paused);
            v.setTextViewText(R.id.widget_status, status);
            v.setViewVisibility(R.id.widget_status, status.isEmpty() ? View.GONE : View.VISIBLE);
            v.setViewVisibility(R.id.widget_progress, hasTrack && s.duration > 0 ? View.VISIBLE : View.GONE);
            v.setTextColor(R.id.widget_status, palette.secondary);
            double position = s.currentPosition();
            v.setImageViewBitmap(R.id.widget_progress, progress(c, options, s.duration > 0 ? position / s.duration : 0, live && s.playing, palette));
            v.setContentDescription(R.id.widget_progress, clock(position) + " / " + clock(s.duration));
        }
        v.setBoolean(R.id.widget_prev, "setEnabled", !live || s.canPrev);
        v.setBoolean(R.id.widget_next, "setEnabled", !live || s.canNext);
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
            BUTTONS.evictAll();
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

    private static Bitmap background(Context c, Bundle options, String trackId, int layout, Palette palette) {
        boolean small = layout == R.layout.widget_player_small || layout == R.layout.widget_player_small_compact;
        int widthDp = Math.max(1, options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, small ? 144 : 280));
        int heightDp = Math.max(1, options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 148));
        float scale = Math.min(1f, Math.min(400f / widthDp, 200f / heightDp));
        int width = Math.max(1, Math.round(widthDp * scale)), height = Math.max(1, Math.round(heightDp * scale));
        String key = artworkKey + "|" + trackId + "|" + palette.dark + "|" + palette.mid + "|" + palette.deep + "|" + width + "|" + height;
        Bitmap bitmap = BACKGROUNDS.get(key);
        if (bitmap != null) return bitmap;
        bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        paint.setShader(new LinearGradient(0, 0, width, height, palette.mid, palette.deep, Shader.TileMode.CLAMP));
        float radiusDp = c.getResources().getDimension(R.dimen.widget_corner_radius) / c.getResources().getDisplayMetrics().density;
        float radius = radiusDp * scale;
        new Canvas(bitmap).drawRoundRect(new RectF(0, 0, width, height), radius, radius, paint);
        BACKGROUNDS.put(key, bitmap);
        return bitmap;
    }

    private static final class Palette {
        int mid, deep, title, secondary, container, icon, primary, onPrimary;
        boolean dark;
    }

    private static int tone(float hue, float saturation, float value) {
        return Color.HSVToColor(new float[] {hue, saturation, value});
    }

    private static double luminance(int color) {
        double sum = 0;
        int[] channels = {Color.red(color), Color.green(color), Color.blue(color)};
        double[] weights = {.2126, .7152, .0722};
        for (int i = 0; i < 3; i++) {
            double v = channels[i] / 255.0;
            sum += weights[i] * (v <= .04045 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4));
        }
        return sum;
    }

    private static double contrast(int a, int b) {
        double x = luminance(a), y = luminance(b);
        return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
    }

    /** Clamp HSV value until the foreground meets the ratio against both gradient ends. */
    private static int readable(int color, int a, int b, double ratio, boolean lighten) {
        float[] hsv = new float[3];
        Color.colorToHSV(color, hsv);
        for (int i = 0; i <= 100; i++) {
            int candidate = Color.HSVToColor(hsv);
            if (contrast(candidate, a) >= ratio && contrast(candidate, b) >= ratio) return candidate;
            hsv[2] = Math.max(0, Math.min(1, hsv[2] + (lighten ? .01f : -.01f)));
        }
        return lighten ? Color.WHITE : Color.BLACK;
    }

    private static Palette palette(Context c, boolean artwork, String seedColor) {
        Palette p = new Palette();
        p.dark = (c.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
            == Configuration.UI_MODE_NIGHT_YES;
        if (!artwork && seedColor.isEmpty()) {
            p.mid = p.deep = c.getColor(R.color.widget_background);
            p.title = c.getColor(R.color.widget_text);
            p.secondary = c.getColor(R.color.widget_text_secondary);
            p.container = c.getColor(R.color.widget_surface);
            p.icon = p.title;
            p.primary = c.getColor(R.color.widget_accent);
            p.onPrimary = c.getColor(R.color.widget_on_accent);
            return p;
        }
        float[] hsv = new float[3];
        Color.colorToHSV(seedColor.isEmpty() ? dominant : Color.parseColor(seedColor), hsv);
        float h = hsv[0], sat = hsv[1];
        p.mid = tone(h, sat * (p.dark ? .8f : .12f), p.dark ? Math.min(.42f, .13f + hsv[2] * .32f) : .98f);
        p.deep = tone(h, sat * (p.dark ? .8f : .18f), p.dark ? (.13f + hsv[2] * .32f) * .48f : .88f);
        p.title = readable(tone(h, sat * .12f, p.dark ? .98f : .12f), p.mid, p.deep, 4.5, p.dark);
        p.secondary = readable(tone(h, sat * .18f, p.dark ? .8f : .32f), p.mid, p.deep, 4.5, p.dark);
        p.container = tone(h, sat * .35f, p.dark ? .48f : .78f);
        p.icon = readable(tone(h, sat * .1f, p.dark ? 1f : .12f), p.container, p.container, 3, p.dark);
        p.primary = tone(h, sat * .65f, p.dark ? .9f : .45f);
        p.onPrimary = readable(tone(h, sat * .1f, p.dark ? .08f : 1f), p.primary, p.primary, 3, !p.dark);
        return p;
    }

    private static void applyButton(RemoteViews v, int icon, int background, int color,
            int foreground, String track, Palette p, boolean tile) {
        String key = artworkKey + "|" + track + "|" + p.dark + "|" + tile + "|" + color;
        Bitmap bitmap = BUTTONS.get(key);
        if (bitmap == null) {
            bitmap = Bitmap.createBitmap(64, 64, Bitmap.Config.ARGB_8888);
            Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
            paint.setColor(color);
            float radius = tile ? 14 : 32;
            new Canvas(bitmap).drawRoundRect(new RectF(0, 0, 64, 64), radius, radius, paint);
            BUTTONS.put(key, bitmap);
        }
        v.setImageViewBitmap(background, bitmap);
        // XML tint uses the same default SRC_IN mode; replace it with the palette role.
        v.setInt(icon, "setColorFilter", foreground);
    }

    private static Bitmap progress(Context c, Bundle options, double fraction, boolean playing, Palette p) {
        float density = c.getResources().getDisplayMetrics().density;
        int width = Math.max(1, Math.min(1200, Math.round((options.getInt(
            AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 250) - 16) * density)));
        int height = Math.max(1, Math.min(96, Math.round(16 * density)));
        float unit = height / 16f;
        Bitmap bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bitmap);
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        paint.setStrokeWidth(4 * unit);
        paint.setStrokeCap(Paint.Cap.ROUND);
        float start = Math.min(4 * unit, width / 2f), end = width - start, y = height / 2f;
        float boundary = start + (end - start) * (float) Math.max(0, Math.min(1, fraction));
        paint.setColor(p.secondary);
        canvas.drawLine(boundary, y, end, y, paint);
        paint.setColor(p.title);
        paint.setStyle(Paint.Style.STROKE);
        Path wave = new Path();
        wave.moveTo(start, y);
        for (float x = start; x < boundary; x += 1) {
            // Fade the last wavelength to meet the thumb on the baseline.
            float envelope = Math.min(1, (boundary - x) / (20 * unit));
            wave.lineTo(x, y + (playing ? 3 * unit * envelope * (float) Math.sin((x - start) * Math.PI * 2 / (20 * unit)) : 0));
        }
        wave.lineTo(boundary, y);
        canvas.drawPath(wave, paint);
        paint.setStyle(Paint.Style.FILL);
        canvas.drawCircle(boundary, y, 4 * unit, paint);
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
