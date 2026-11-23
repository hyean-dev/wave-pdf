package io.github.hyeandev.wavepdf;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.Base64;

import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * Files in and out of the APK:
 *  - PDFs opened from other apps (Drive "open with", file manager, share) → "fileOpened" event
 *  - save back to that original (when the other app allows it), save as a new file, share to another app
 */
@CapacitorPlugin(name = "WaveFile")
public class WaveFilePlugin extends Plugin {
    private File pendingSave;

    @Override
    public void load() { handle(getActivity().getIntent()); }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        handle(intent);
    }

    private void handle(Intent intent) {
        if (intent == null) return;
        Uri uri = null;
        String action = intent.getAction();
        if (Intent.ACTION_VIEW.equals(action)) uri = intent.getData();
        else if (Intent.ACTION_SEND.equals(action)) uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
        if (uri == null) return;
        intent.setAction(null); // don't reopen it after a rotation
        try {
            ContentResolver cr = getContext().getContentResolver();
            String name = displayName(uri);
            File dir = new File(getContext().getCacheDir(), "opened");
            dir.mkdirs();
            File f = new File(dir, System.currentTimeMillis() + ".pdf");
            try (InputStream in = cr.openInputStream(uri); OutputStream out = new FileOutputStream(f)) { copy(in, out); }
            boolean writable = (intent.getFlags() & Intent.FLAG_GRANT_WRITE_URI_PERMISSION) != 0;
            JSObject d = new JSObject();
            d.put("path", f.getAbsolutePath());
            d.put("name", name);
            d.put("uri", uri.toString());
            d.put("writable", writable);
            notifyListeners("fileOpened", d, true);
        } catch (Exception e) {
            JSObject d = new JSObject();
            d.put("error", String.valueOf(e.getMessage()));
            notifyListeners("fileOpened", d, true);
        }
    }

    private String displayName(Uri uri) {
        String name = null;
        try (Cursor c = getContext().getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst()) name = c.getString(0);
        } catch (Exception ignored) {}
        if (name == null) name = uri.getLastPathSegment();
        if (name == null) name = "문서.pdf";
        if (!name.toLowerCase().endsWith(".pdf")) name += ".pdf";
        return name;
    }

    private static void copy(InputStream in, OutputStream out) throws Exception {
        byte[] buf = new byte[65536];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
    }

    /** overwrite the file the PDF was opened from */
    @PluginMethod
    public void save(PluginCall call) {
        try {
            Uri uri = Uri.parse(call.getString("uri"));
            byte[] data = Base64.decode(call.getString("data"), Base64.DEFAULT);
            try (OutputStream out = getContext().getContentResolver().openOutputStream(uri, "wt")) {
                if (out == null) throw new Exception("no stream");
                out.write(data);
            }
            call.resolve();
        } catch (Exception e) {
            call.reject("이 파일에는 직접 저장할 수 없어요: " + e.getMessage());
        }
    }

    /** "save as": the system file picker chooses where */
    @PluginMethod
    public void saveAs(PluginCall call) {
        try {
            byte[] data = Base64.decode(call.getString("data"), Base64.DEFAULT);
            pendingSave = new File(getContext().getCacheDir(), "save.pdf");
            try (OutputStream out = new FileOutputStream(pendingSave)) { out.write(data); }
            Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
            i.addCategory(Intent.CATEGORY_OPENABLE);
            i.setType("application/pdf");
            i.putExtra(Intent.EXTRA_TITLE, call.getString("name", "문서.pdf"));
            startActivityForResult(call, i, "saveAsDone");
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @ActivityCallback
    private void saveAsDone(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            call.reject("CANCELLED");
            return;
        }
        Uri uri = result.getData().getData();
        try (InputStream in = new java.io.FileInputStream(pendingSave);
             OutputStream out = getContext().getContentResolver().openOutputStream(uri, "wt")) {
            copy(in, out);
            JSObject r = new JSObject();
            r.put("uri", uri.toString());
            r.put("name", displayName(uri));
            call.resolve(r);
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    /** share sheet (e.g. "Drive에 저장") */
    @PluginMethod
    public void share(PluginCall call) {
        try {
            byte[] data = Base64.decode(call.getString("data"), Base64.DEFAULT);
            File dir = new File(getContext().getCacheDir(), "share");
            dir.mkdirs();
            File f = new File(dir, call.getString("name", "문서.pdf"));
            try (OutputStream out = new FileOutputStream(f)) { out.write(data); }
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", f);
            Intent i = new Intent(Intent.ACTION_SEND);
            i.setType("application/pdf");
            i.putExtra(Intent.EXTRA_STREAM, uri);
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            getActivity().startActivity(Intent.createChooser(i, "공유"));
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }
}
