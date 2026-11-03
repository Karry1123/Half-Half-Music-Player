package com.halfhalf.musicplayer;

import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override public void onCreate(Bundle savedInstanceState) {
        registerPlugin(PlaybackSessionPlugin.class);
        registerPlugin(AudioGuardPlugin.class);
        super.onCreate(savedInstanceState);
        // Draw under the notch / punch hole in landscape too; the web layout pads with the injected
        // --safe-area-inset-* values, so nothing ends up hidden behind the cutout.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            WindowManager.LayoutParams lp = getWindow().getAttributes();
            lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            getWindow().setAttributes(lp);
        }
        PlaybackSessionPlugin.deliverLaunchAction(getIntent());
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        PlaybackSessionPlugin.deliverLaunchAction(intent);
    }
}
