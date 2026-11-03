package com.halfhalf.musicplayer;

/** 2x2 variant: artwork with a play / pause button; shares rendering with {@link PlayerWidgetProvider}. */
public class PlayerWidgetSmallProvider extends PlayerWidgetProvider {
    @Override protected int layout() { return R.layout.widget_player_small; }
}
