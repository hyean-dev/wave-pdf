package io.github.hyeandev.wavepdf;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(WaveFilePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
