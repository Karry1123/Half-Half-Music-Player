package com.halfhalf.musicplayer;

/** 4x1 bar sharing state, palette and action rendering with the other widget sizes. */
public class PlayerWidgetBarProvider extends PlayerWidgetProvider {
    @Override protected int layout() { return R.layout.widget_player_bar; }
}
