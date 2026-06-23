# VibeTube Mesh / SpeedVox Offline Mode — Arquitetura

> Documento da **Fase 0** (auditoria e preparação) do roadmap de modo offline.
> Status atual: **Fases 0, 1 e 2 implementadas.** As fases 3+ (Android, BLE,
> Wi-Fi Direct, LAN, sync online completo) são posteriores.

## Objetivo

Adicionar ao SpeedVox um **modo de comunicação offline** (inspirado em Bitchat,
Briar, Bridgefy, Meshtastic), como **camada adicional** — sem quebrar chat,
login, chamadas WebRTC, TURN, domínio, Docker ou infraestrutura atuais.

Sistema híbrido:

- **Online**: SpeedVox atual (servidor, WebSocket, WebRTC).
- **Offline local**: BLE / Wi-Fi Direct / LAN, via app Android nativo.
- **Sync**: quando a internet volta, reconciliar mensagens permitidas.

## Branch

O documento de especificação sugere a branch `feature/vibetube-mesh-offline`.
Por restrição da sessão de desenvolvimento atual, o trabalho está sendo feito em
`claude/speedvox-messaging-app-teo2c0`. Ao integrar, renomear/abrir a branch
canônica conforme o padrão do time.

## Auditoria da estrutura atual (Fase 0)

```
VibeTube-Clone/
├── server/                 # backend Node/Express (CommonJS)
│   ├── index.js            # monta rotas /api/*, estáticos, SPA fallback
│   ├── config.js           # config + feature flags (agora inclui config.mesh)
│   ├── db.js               # better-sqlite3, schema + migrações idempotentes
│   ├── realtime.js         # Socket.IO: chat, presença, sinalização WebRTC/mesh
│   ├── auth-middleware.js  # requireAuth, getTokenFromReq
│   ├── util.js             # id(), now(), JWT, publicUser()
│   └── routes/             # auth, users, chats, messages, …, mesh (novo)
├── public/                 # PWA (ESM, sem bundler)
│   └── js/                 # app.js, mesh.js (protótipo web), mesh-nearby.js, …
├── packages/
│   └── mesh-core/          # NÚCLEO independente de plataforma (Fase 2, novo)
├── mobile/                 # casca Capacitor Android (WebView) + plugin Nearby
├── desktop/                # casca Electron
├── Dockerfile, docker-compose.yml, Caddyfile, fly.toml, render.yaml, Procfile
└── .env.example            # inclui as flags MESH_*
```

Pontos de produção que **não** devem ser alterados sem autorização: Cloudflare,
`chat.vibetube.com.br`, `turn.vibetube.com.br`, coturn, Docker principal, login
Google, WebRTC online, endpoints existentes, banco atual.

## Feature flags (Fase 0)

Em `server/config.js` (`config.mesh`), lidas de variáveis de ambiente — nada
hardcoded, defaults seguros:

| Flag | Padrão | Função |
|---|---|---|
| `MESH_ENABLED` | 1 | Liga os endpoints `/api/mesh/*`. |
| `MESH_SYNC_ENABLED` | 1 | Aceita lotes de sync offline. |
| `MESH_ANDROID_ENABLED` | 1 | Sinaliza ao cliente que há build Android. |
| `MESH_WEB_DIAGNOSTIC_ONLY` | 1 | No navegador, só explicação + diagnóstico. |
| `MESH_MAX_MESSAGE_BYTES` | 4096 | Tamanho máx. por envelope no sync. |
| `MESH_MAX_BATCH_SIZE` | 100 | Máx. de mensagens por lote de sync. |
| `MESH_MAX_TTL` | 5 | TTL (saltos) máximo aceito. |
| `MESH_MAX_OFFLINE_RETENTION_DAYS` | 7 | Retenção de mensagens sincronizadas. |
| `MESH_ALLOW_ATTACHMENTS_OFFLINE` | 0 | Anexos offline (fase posterior). |

## Camadas

```
Aplicação (app / UI)
      │
   mesh-core  ← Fase 2: identidade, envelope assinado, cripto E2E, dedup, TTL
      │           (independente de plataforma; Web Crypto API)
      ├──────── Transporte WebRTC (online, sinalizado pelo servidor) [protótipo web]
      └──────── Transporte Nativo (offline): BLE / Wi-Fi Direct / LAN  [Fases 4–8]
      │
   Backend SpeedVox
      └── /api/mesh/* ← Fase 1: status, config, register-device, sync
```

O conteúdo privado trafega **cifrado** (AES-256-GCM com chave derivada via
X25519+HKDF); relays intermediários encaminham sem conseguir ler. Cada envelope
é **assinado** (Ed25519); o `deviceId` é derivado da chave pública de assinatura,
então identidades são auto-certificáveis e não dependem de IMEI/telefone.

## Segurança (resumo; detalhe em fase de hardening)

- Chaves privadas **nunca** saem do dispositivo; só a identidade pública é
  registrada/compartilhada.
- Nenhum segredo (tokens, TURN, JWT, chaves) em tela, logs ou commits.
- Credenciais sempre via variável de ambiente, mascaráveis e rotacionáveis.
- Anti-spam **local-first** (offline não tem moderação central em tempo real):
  TTL, limite de tamanho, limite de hops, assinatura obrigatória, dedup,
  rate-limit por peer (camada a completar nas fases seguintes).

## O que foi entregue por fase

### Fase 0 — Auditoria e Preparação ✅
- Este documento.
- Feature flags `config.mesh` + `.env.example`.
- Nenhum comportamento atual alterado.

### Fase 1 — Backend Mesh Config + Sync Stub ✅
- `GET /api/mesh/status`, `GET /api/mesh/config`,
  `POST /api/mesh/register-device`, `POST /api/mesh/sync` (validação básica).
- Tabelas `mesh_devices` e `mesh_messages` (aditivas).
- Testes: `node mesh-backend-test.js` (15 checks), garantindo que `/api/health`
  e `/api/ice` seguem íntegros e que nenhum segredo é exposto.

### Fase 2 — Mesh Core (biblioteca compartilhada) ✅
- Pacote `packages/mesh-core` (ESM, Web Crypto): `generateDeviceIdentity`,
  `createEnvelope`, `signEnvelope`, `verifyEnvelope`, `encryptMessage`,
  `decryptMessage`, `shouldForward`, `markSeen`/`hasSeen`, `decrementTTL`,
  `serializeMessage`/`deserializeMessage`.
- Testes: `npm test` em `packages/mesh-core` (28 checks): identidade, assinatura
  (+ detecção de adulteração/spoof), cripto E2E (+ terceiro não lê), dedup, TTL,
  serialização.

## Desvios conscientes da especificação

1. **Linguagem do core**: a spec ilustra `.ts`; o projeto é JS puro sem bundler,
   então `mesh-core` é **ESM JavaScript** (roda em Node, browser e WebView). Pode
   ser migrado para TypeScript quando o projeto adotar um pipeline de build.
2. **Curvas**: usamos Web Crypto nativo (Ed25519 + X25519 + AES-256-GCM + HKDF),
   exatamente a recomendação da spec, sem dependências externas. Requer Node 20+
   e navegadores recentes (Chrome 137+, Safari 17+, Firefox 119+) para
   Ed25519/X25519 — aceitável porque a cripto pesada roda no Android/Node, e o
   navegador é "diagnóstico apenas".
3. **Branch**: ver seção *Branch* acima.

## Próximas fases (não implementadas aqui)

3. Android APK base (Kotlin nativo ou RN com módulos nativos).
4. BLE Discovery · 5. BLE Messaging · 6. Multi-hop · 7. Wi-Fi Direct ·
8. LAN local · 9. Sync online completo · 10. Hardening de segurança ·
11. Empacotamento do APK.
