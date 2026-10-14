package com.halfhalf.musicplayer;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;

public class MainActivity extends BridgeActivity {
    @Override public void onCreate(Bundle savedInstanceState) {
        registerPlugin(PlaybackSessionPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
