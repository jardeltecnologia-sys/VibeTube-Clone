# Lyra em mensagens de voz (Android) — projeto e receita de build

Este documento descreve como adicionar o codec de voz **Lyra** (Google) às
**mensagens de voz** do SpeedVox no app Android, e por que ele **não** se aplica
às chamadas ao vivo na arquitetura atual.

> Status: **groundwork**. A parte de áudio em Opus (otimizada, multiplataforma)
> já está implementada e em produção. A parte nativa do Lyra descrita aqui
> precisa ser compilada e testada numa máquina com toolchain Android (NDK +
> Bazel) e em um device real — não dá para validar no ambiente de CI atual.

---

## Por que Lyra NÃO entra nas chamadas ao vivo

O app Android é um **WebView fino**: o `mobile/capacitor.config.json` aponta
`server.url` para o site, então o Android só abre o SpeedVox web dentro de um
navegador embutido. As chamadas ao vivo usam o `RTCPeerConnection` **de dentro
do WebView**, cuja pilha WebRTC é a do sistema — não há API suportada para
injetar um codec nativo (Lyra) nesse pipeline.

Ter Lyra em chamada ao vivo exigiria reescrever as chamadas em **WebRTC nativo**
com um build customizado do `libwebrtc` — o app deixaria de ser wrapper fino e
viraria um cliente nativo separado, só Android. Fora de escopo por ora.

Mensagens de voz são **store-and-forward** (grava → comprime → envia bytes →
decodifica do outro lado), então **não dependem do WebRTC** e podem usar Lyra
via um plugin nativo do Capacitor.

---

## Quanto se ganha

Áudio de 10 s, mono:

| Codec | Bitrate | Tamanho ~10 s |
|-------|---------|---------------|
| Opus (padrão navegador) | 48–128 kbps | 60–160 KB |
| **Opus 24 kbps (já implementado)** | 24 kbps | ~30 KB |
| Lyra | 3.2 kbps | ~4 KB |
| Lyra | 6 kbps | ~7.5 KB |

O Opus a 24 kbps mono já resolve a maior parte do problema em rede lenta e
funciona em **todas** as plataformas. O Lyra leva a um patamar de 2G/EDGE, mas
só entre dispositivos que tenham o decoder.

---

## Arquitetura do plugin (mensagens de voz)

```
[ WebView / JS ]                         [ Nativo Android (Capacitor plugin) ]
 grava PCM 16kHz mono   --- bridge --->   LyraCodec.encode(pcm)  -> bytes Lyra
 (Web Audio AudioWorklet)                 LyraCodec.decode(bytes) -> PCM
 toca PCM (Web Audio)   <--- bridge ---
```

### Fallback de interoperabilidade (obrigatório)

O destinatário pode estar na web/desktop (sem Lyra). Regras:

1. **Detecção de capacidade**: o remetente só usa Lyra se
   `Capacitor.isPluginAvailable('LyraCodec')` for verdadeiro **e** houver sinal
   de que o destino também suporta (ver "negociação" abaixo).
2. **Padrão universal = Opus** (`audio/webm;codecs=opus`, já implementado). Toda
   mensagem de voz continua enviável a qualquer plataforma.
3. **Lyra é opt-in Android↔Android.** A mensagem Lyra vai com MIME
   `audio/lyra` + metadados (`sampleRate`, `durationMs`, `bitrate`). Se o
   destinatário não puder decodificar, a UI mostra "áudio otimizado — abra no
   app Android" (ou o servidor pode armazenar também uma cópia Opus de
   fallback, ao custo de duplicar o upload).

### Negociação de suporte

Adicionar um campo no perfil/usuário, p.ex. `capabilities: ['lyra']`,
publicado quando o app Android com o plugin faz login. O remetente só escolhe
Lyra se **todos** os participantes do chat anunciarem `lyra`. Em grupo misto,
cai para Opus.

---

## API do plugin Capacitor (contrato JS)

```ts
// mobile/lyra-plugin/src/definitions.ts
export interface LyraCodecPlugin {
  isAvailable(): Promise<{ available: boolean }>;
  // pcm: base64 de Int16 little-endian, 16 kHz mono
  encode(opts: { pcm: string; bitrate?: 3200 | 6000 | 9200 }):
    Promise<{ data: string /* base64 dos bytes Lyra */ }>;
  decode(opts: { data: string }):
    Promise<{ pcm: string /* base64 Int16 16kHz mono */ }>;
}
```

No `app.js`, o ponto de extensão já está marcado em `toggleVoiceRecording()`
(comentário "where a native Lyra encoder would slot in"). O fluxo Lyra:

1. capturar PCM com `AudioContext` + `AudioWorkletNode` (em vez de
   `MediaRecorder`), downsample para 16 kHz mono Int16;
2. `LyraCodec.encode({ pcm })` → bytes;
3. `api.upload(file 'audio/lyra')` e `queueAndSend({ type:'audio',
   mediaMime:'audio/lyra', ... })`.

Reprodução: ao tocar uma mensagem `audio/lyra`, `LyraCodec.decode` → PCM →
`AudioBufferSourceNode`.

---

## Lado nativo (Android / Kotlin + JNI)

```kotlin
// mobile/lyra-plugin/android/.../LyraCodecPlugin.kt  (esqueleto)
@CapacitorPlugin(name = "LyraCodec")
class LyraCodecPlugin : Plugin() {
  @PluginMethod fun isAvailable(call: PluginCall) {
    call.resolve(JSObject().put("available", LyraNative.ready()))
  }
  @PluginMethod fun encode(call: PluginCall) {
    val pcm = Base64.decode(call.getString("pcm"), Base64.DEFAULT)
    val bitrate = call.getInt("bitrate") ?: 6000
    val out = LyraNative.encode(pcm, bitrate) // JNI -> liblyra.so
    call.resolve(JSObject().put("data", Base64.encodeToString(out, Base64.NO_WRAP)))
  }
  @PluginMethod fun decode(call: PluginCall) {
    val data = Base64.decode(call.getString("data"), Base64.DEFAULT)
    val pcm = LyraNative.decode(data) // JNI -> liblyra.so
    call.resolve(JSObject().put("pcm", Base64.encodeToString(pcm, Base64.NO_WRAP)))
  }
}
// object LyraNative { external fun encode(...); external fun decode(...); ... }
```

A `liblyra.so` + os modelos `.tflite` é a parte que precisa ser compilada.

---

## Receita de build do Lyra para Android

1. Clonar `https://github.com/google/lyra` (Bazel).
2. Instalar **Bazel** e **Android NDK** (r25+). Exportar `ANDROID_NDK_HOME` e
   `ANDROID_HOME`.
3. Compilar a lib nativa para os ABIs alvo (mínimo `arm64-v8a`; idealmente
   `armeabi-v7a` também):
   ```bash
   bazel build -c opt --config=android_arm64 //lyra:liblyra.so
   ```
   (Pode ser necessário expor `encode/decode` numa camada JNI própria, pois o
   exemplo oficial é um `android_binary`, não uma `.aar`.)
4. Copiar `liblyra.so` para
   `mobile/lyra-plugin/android/src/main/jniLibs/<abi>/` e os modelos `.tflite`
   para `.../assets/lyra/` (carregar com caminho de assets em runtime).
5. Registrar o plugin no app Capacitor e rodar `npx cap sync android`.

### CI

O workflow atual (`.github/workflows/android-apk.yml`) usa apenas
`setup-android` + `assembleDebug`. Para Lyra seria preciso adicionar **Bazel**,
o **NDK** e um passo de build da `liblyra.so` (com cache do Bazel), aumentando
muito o tempo e a fragilidade do CI. Recomenda-se compilar a `.so` **uma vez**,
versioná-la como binário no plugin (ou numa Release) e só consumi-la no CI do
APK — evitando compilar Lyra a cada build.

---

## Resumo do que falta para concluir

- [ ] Compilar `liblyra.so` (arm64-v8a, armeabi-v7a) + camada JNI encode/decode.
- [ ] Plugin Capacitor `LyraCodec` (Kotlin) consumindo a `.so` e os modelos.
- [ ] Captura PCM via AudioWorklet (16 kHz mono) e reprodução PCM no JS.
- [ ] Negociação de capacidade (`capabilities: ['lyra']`) + fallback Opus.
- [ ] Testar em devices reais (Android↔Android) e medir tamanho/qualidade.
- [ ] (Opcional) Decoder Lyra em WASM para web/desktop ouvirem áudios Lyra.
