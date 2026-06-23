# Malha sem infraestrutura (Nearby / BLE / Wi-Fi Direct) — projeto e build

Este documento descreve a comunicação **sem internet e sem nenhuma
infraestrutura** do SpeedVox: pessoas com o app por perto formam uma malha
ad-hoc (Bluetooth / BLE / Wi-Fi Direct) e conseguem trocar mensagens — e
disparar um **SOS** — para a família em caso de perigo ou desastre.

> Status: **camada web pronta e testada; camada nativa em groundwork.**
> O protocolo de malha (multi-salto, store-and-forward, SOS) roda no navegador
> e tem testes automatizados (`node mesh-test.mjs`). O transporte nativo Android
> (plugin Capacitor de Nearby Connections) tem o código-fonte aqui, mas precisa
> ser **compilado e testado num toolchain Android real com 2+ aparelhos** — não
> dá para validar no CI atual nem dentro de um navegador comum.

---

## Por que precisa de nativo

Um app **web/PWA não consegue descobrir aparelhos por perto sozinho**. O
WebRTC (usado quando há internet) precisa de um canal de sinalização para trocar
SDP/ICE, e o navegador **não tem acesso a Bluetooth/BLE/Wi-Fi Direct/mDNS** para
fazer isso offline. Logo, para o cenário "apagão total, sem rede nenhuma", a
descoberta e o transporte têm de vir de um **plugin nativo**.

No Android, a **Google Nearby Connections API** resolve isso: com a estratégia
`P2P_CLUSTER` ela combina Bluetooth clássico, BLE e Wi-Fi (Direct/hotspot) sob
uma única API, **sem internet e sem ponto de acesso**, e suporta topologia
muitos-para-muitos — exatamente uma malha.

---

## Arquitetura (duas camadas)

```
  Aplicação (app.js)
        │  sendMessage(to, msg) · sos(data) · eventos 'message'/'sos'/'delivered'
        ▼
  PROTOCOLO  (public/js/mesh.js)         ← testável, transport-agnóstico
   envelope {id,origin,to,ttl,kind,data}
   • dedup (seen)         • flood multi-salto com TTL
   • store-and-forward    • ACK de entrega    • SOS broadcast
        │  addLink(peerId, send) · receiveFrame(peerId, raw)
        ├───────────────────────────────┐
        ▼                               ▼
  TRANSPORTE WebRTC               TRANSPORTE NATIVO
  (mesh.js, via servidor)         (public/js/mesh-nearby.js → plugin)
  usado quando há internet        Nearby Connections (BLE/Wi-Fi Direct)
                                  usado no apagão total
```

Os dois transportes alimentam **o mesmo** protocolo. Um peer WebRTC (online) e
um peer Bluetooth (offline) repassam mensagens um para o outro de forma
transparente — quem está online vira uma ponte para quem não está.

O protocolo nunca inspeciona o conteúdo (`data`): se a conversa usa E2EE, o que
trafega é texto cifrado, então **relays intermediários não conseguem ler**.

---

## Arquivos

| Arquivo | Papel |
|---|---|
| `public/js/mesh.js` | Protocolo de malha (flood/TTL/dedup/store-forward/ACK/SOS) + transporte WebRTC. |
| `public/js/mesh-nearby.js` | Ponte JS para o plugin nativo (no-op em navegador comum). |
| `mobile/android/.../nearby/SpeedvoxNearbyPlugin.java` | Plugin Capacitor sobre Nearby Connections. |
| `mobile/android/.../mobile/MainActivity.java` | Registra o plugin. |
| `mesh-test.mjs` | Testes do protocolo (12 checks). |

---

## Permissões (AndroidManifest.xml)

O `AndroidManifest.xml` é gerado por `cap add android`. Após gerá-lo, adicione:

```xml
<!-- Bluetooth / BLE -->
<uses-permission android:name="android.permission.BLUETOOTH_ADVERTISE" />
<uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />
<uses-permission android:name="android.permission.BLUETOOTH_SCAN"
    android:usesPermissionFlags="neverForLocation" />

<!-- Necessárias para BLE em Android ≤ 11 -->
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION"
    android:maxSdkVersion="30" />
<uses-permission android:name="android.permission.BLUETOOTH"
    android:maxSdkVersion="30" />
<uses-permission android:name="android.permission.BLUETOOTH_ADMIN"
    android:maxSdkVersion="30" />

<!-- Wi-Fi (Direct/hotspot) usado pelo Nearby -->
<uses-permission android:name="android.permission.ACCESS_WIFI_STATE" />
<uses-permission android:name="android.permission.CHANGE_WIFI_STATE" />
<uses-permission android:name="android.permission.NEARBY_WIFI_DEVICES"
    android:usesPermissionFlags="neverForLocation" />
```

As permissões de runtime (Bluetooth/localização) precisam ser **pedidas em
tempo de execução** na primeira ativação do modo mesh. Isso pode ser feito com
`@capacitor/core` + um pedido nativo no `start()` do plugin (não incluído aqui
para manter o groundwork enxuto).

---

## Dependência Gradle

Já adicionada em `mobile/android/app/build.gradle`:

```gradle
implementation 'com.google.android.gms:play-services-nearby:19.3.0'
```

---

## Build e teste (precisa de toolchain Android + 2 aparelhos)

```bash
# 1. Copiar a web para o app e gerar o projeto Android
cd mobile
cp -r ../public/* www/         # ou apontar webDir/server.url conforme o deploy
npm install
npx cap add android            # gera AndroidManifest.xml
# 2. Adicionar as permissões acima ao AndroidManifest.xml
# 3. Sincronizar e compilar
npx cap sync android
npx cap open android           # abre no Android Studio → Run
```

Para validar a malha **offline de verdade**:

1. Instale o APK em **dois (ou mais) aparelhos**.
2. Coloque todos em **modo avião com Bluetooth ligado** (ou Wi-Fi sem internet).
3. Ative **Modo mesh** em cada um (Perfil → Modo mesh).
4. Envie uma mensagem de um para o outro — deve chegar via Bluetooth/Wi-Fi
   Direct. Com três aparelhos em linha (A–B–C, sem A enxergar C diretamente),
   confirme o **multi-salto**.
5. Toque em **🆘 Emergência (SOS)** e confirme que o alerta aparece em todos.

---

## API do plugin (JS ↔ nativo)

```
SpeedvoxNearby.start({ userId, displayName })   // anuncia + descobre
SpeedvoxNearby.stop()
SpeedvoxNearby.send({ endpointId, data })        // data = frame do protocolo (string)

// eventos
addListener('peerConnected', ({ endpointId, userId }) => …)
addListener('peerLost',      ({ endpointId }) => …)
addListener('payload',       ({ endpointId, data }) => …)
addListener('meshError',     ({ phase, message }) => …)
```

---

## Limitações conhecidas / próximos passos

- **iOS**: equivalente seria um plugin sobre **MultipeerConnectivity**. Não
  incluído ainda; a ponte JS (`mesh-nearby.js`) já é genérica e serviria a ele.
- **Alcance**: Nearby usa rádios de curto alcance (dezenas de metros). O
  multi-salto estende isso encadeando aparelhos, mas não substitui rádio LoRa.
- **Permissões de runtime**: o pedido de permissões Bluetooth/localização na
  ativação ainda precisa ser implementado no plugin para uma UX limpa.
- **Bateria**: anunciar+descobrir continuamente consome bateria; convém ligar o
  modo mesh sob demanda (já é opt-in) e/ou só em emergência.
