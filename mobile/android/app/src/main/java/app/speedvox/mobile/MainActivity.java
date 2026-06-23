package app.speedvox.mobile;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

import app.speedvox.nearby.SpeedvoxNearbyPlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register the zero-infrastructure mesh transport before the bridge starts.
        registerPlugin(SpeedvoxNearbyPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
