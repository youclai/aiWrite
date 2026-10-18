package com.novelai.writer;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.security.KeyStore;
import java.security.SecureRandom;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * M3-b 原生密钥存储插件（F55 密钥不进主库的底座）：JS 侧 window.Capacitor.Plugins.SecureStore。
 * 契约（与 www/js/secureStore.js keyProviderFromNative 严格对齐，勿改名）：
 *   getKey() -> { value: base64(32 字节 AES-256 主密钥) }
 * 设计：主密钥本身不直接落盘。用 Android Keystore 里一枚不可导出的 AES-GCM 包裹密钥
 *   把 32 字节主密钥加密封装，密文 + IV 存 SharedPreferences；每次 getKey 由 Keystore 解包回明文。
 *   因此明文密钥从不写入磁盘/SQLite/备份，仅在内存中短暂存在并交给 WebView 的 WebCrypto。
 * 说明：纯 Java（App 模块未启用 Kotlin）；Base64 用 android.util（minSdk24 无 java.util.Base64）；NO_WRAP 保证无换行，JS 端 atob 可解。
 * caveats：若 Keystore 包裹密钥因系统重置/恢复出厂而丢失，将重新生成主密钥（既有密文条目会失效，属预期安全行为）。
 */
@CapacitorPlugin(name = "SecureStore")
public class SecureStorePlugin extends Plugin {

    private static final String ANDROID_KEYSTORE = "AndroidKeyStore";
    private static final String WRAP_ALIAS = "novel_wrap_key";
    private static final String PREFS = "novel_secure";
    private static final String PREF_IV = "mk_iv";
    private static final String PREF_CT = "mk_ct";

    private static final int MASTER_LEN = 32;   // AES-256 主密钥：JS 侧强制要求 32 字节
    private static final int IV_LEN = 12;       // GCM 推荐 96-bit IV
    private static final int TAG_BITS = 128;    // GCM 认证标签位长

    private final SecureRandom random = new SecureRandom();

    @PluginMethod
    public void getKey(PluginCall call) {
        try {
            SharedPreferences prefs = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            String ivB64 = prefs.getString(PREF_IV, null);
            String ctB64 = prefs.getString(PREF_CT, null);

            SecretKey wrapKey = getOrCreateWrapKey();
            byte[] master = null;

            // 已有封装主密钥：尝试解包（Keystore 内不可导出密钥解密，明文只在此瞬间出现在内存）
            if (ivB64 != null && ctB64 != null) {
                try {
                    master = unwrap(wrapKey, decode(ivB64), decode(ctB64));
                } catch (Exception e) {
                    master = null; // 包裹密钥丢失/数据损坏 → 走下方重新生成
                }
            }

            // 首次（或解包失败）：随机生成 32 字节主密钥，用 Keystore 包裹后持久化
            if (master == null || master.length != MASTER_LEN) {
                master = new byte[MASTER_LEN];
                random.nextBytes(master);
                // AndroidKeyStore 的 AES-GCM 密钥强制“随机化加密”，禁止调用方自带 IV，
                // 否则 Cipher.init 抛 "Caller-provided IV not permitted"。故让 Cipher 自行生成 IV，再取回落盘。
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.ENCRYPT_MODE, wrapKey);
                byte[] iv = cipher.getIV();
                byte[] ct = cipher.doFinal(master);
                prefs.edit()
                        .putString(PREF_IV, encode(iv))
                        .putString(PREF_CT, encode(ct))
                        .apply();
            }

            JSObject ret = new JSObject();
            ret.put("value", encode(master));
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("SecureStore.getKey 失败："
                    + (e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage()));
        }
    }

    private SecretKey getOrCreateWrapKey() throws Exception {
        KeyStore ks = KeyStore.getInstance(ANDROID_KEYSTORE);
        ks.load(null);
        KeyStore.Entry existing = ks.getEntry(WRAP_ALIAS, null);
        if (existing instanceof KeyStore.SecretKeyEntry) {
            return ((KeyStore.SecretKeyEntry) existing).getSecretKey();
        }
        KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE);
        KeyGenParameterSpec spec = new KeyGenParameterSpec.Builder(
                WRAP_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(128)          // 包裹密钥长度与主密钥无关；128 位兼容性最好
                .setRandomizedEncryptionRequired(true)
                .build();
        kg.init(spec);
        return kg.generateKey();
    }

    private byte[] unwrap(SecretKey key, byte[] iv, byte[] ciphertext) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(TAG_BITS, iv));
        return cipher.doFinal(ciphertext);
    }

    private static String encode(byte[] b) {
        return Base64.encodeToString(b, Base64.NO_WRAP);
    }

    private static byte[] decode(String s) {
        return Base64.decode(s, Base64.DEFAULT);
    }
}
