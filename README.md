# SpeedVox

Aplicativo de mensagens em tempo real no estilo WhatsApp — **sem exigir número de
telefone**. Os usuários se cadastram com **e-mail** ou entram com a **conta do
Google**. Funciona em dados móveis e Wi-Fi, é instalável como PWA e tem uma
arquitetura **preparada para rede mesh** (peer-to-peer) para resiliência em caso
de apagão ou queda do servidor central.

> Construído como um app web/PWA full-stack: Node.js + Express + Socket.IO no
> backend, SQLite para persistência e um frontend PWA em JavaScript puro, sem
> etapa de build.

---

## ✨ Funcionalidades

- **Cadastro sem telefone** — e-mail/senha (com hash bcrypt) ou Google Sign-In (OAuth 2.0).
- **Mensagens em tempo real** via WebSocket (Socket.IO).
- **Conversas 1:1 e em grupo**.
- **Chamadas de voz e vídeo 1:1** (WebRTC — mídia peer-to-peer, servidor só sinaliza).
- **Mensagens de voz** (gravação com MediaRecorder e player no chat).
- **Encontrar contatos** por nome de usuário, nome de exibição ou e-mail (sem agenda telefônica).
- **Status de entrega**: ✓ enviada, ✓✓ entregue, ✓✓ azul lida.
- **Indicador "digitando…"**.
- **Presença** online / visto por último.
- **Envio de mídia** (imagens e arquivos até 25 MB).
- **Responder, reagir e apagar mensagens** (para todos).
- **Contadores de não lidas** e ordenação por atividade.
- **PWA instalável** com service worker (app-shell em cache, abre offline).
- **Modo mesh** (experimental) — canais WebRTC peer-to-peer entre usuários.

---

## 🚀 Como rodar

Pré-requisitos: **Node.js 20+**.

```bash
npm install
cp .env.example .env      # ajuste as variáveis (veja abaixo)
npm start                 # ou: npm run dev  (reinício automático)
```

Acesse **http://localhost:3000**. Crie uma conta com e-mail e comece a conversar.
Para testar conversas reais, abra uma segunda aba/navegador anônimo e cadastre
outro usuário.

### Variáveis de ambiente (`.env`)

| Variável | Descrição |
|---|---|
| `PORT` | Porta HTTP (padrão `3000`). |
| `PUBLIC_URL` | URL pública do servidor (usada no OAuth e em links de mídia). |
| `JWT_SECRET` | Segredo para assinar os tokens de sessão. **Troque em produção.** |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Credenciais do Google Sign-In (opcional). |

### Ativando o login com Google

1. Crie credenciais OAuth em <https://console.cloud.google.com/apis/credentials>.
2. Em **Authorized redirect URIs**, adicione: `{PUBLIC_URL}/api/auth/google/callback`
   (ex.: `http://localhost:3000/api/auth/google/callback`).
3. Preencha `GOOGLE_CLIENT_ID` e `GOOGLE_CLIENT_SECRET` no `.env` e reinicie.

Sem essas credenciais, o app funciona normalmente com e-mail/senha e o botão do
Google fica oculto automaticamente.

---

## 🏗️ Arquitetura

```
speedvox/
├── server/
│   ├── index.js          # bootstrap Express + Socket.IO + estáticos
│   ├── config.js         # configuração + loader de .env (sem dependências)
│   ├── db.js             # SQLite (better-sqlite3) + schema
│   ├── chat-service.js   # regras de chat (resumos, membros, serialização)
│   ├── realtime.js       # handlers Socket.IO (mensagens, presença, recibos, mesh)
│   ├── auth-middleware.js # autenticação JWT para REST
│   ├── util.js           # helpers (ids, tokens, validação)
│   └── routes/           # auth, users, chats, upload (REST)
└── public/               # PWA (frontend, sem build)
    ├── index.html
    ├── css/styles.css
    ├── js/app.js         # UI + estado + integração socket/mesh/chamadas
    ├── js/api.js         # cliente REST
    ├── js/calls.js       # chamadas de voz/vídeo 1:1 (WebRTC + UI)
    ├── js/mesh.js        # gerenciador de mesh WebRTC
    ├── service-worker.js # cache do app-shell
    └── manifest.webmanifest
```

**Camadas:**
- **REST** (`/api/*`) cuida de cadastro/login, busca de usuários, listagem e
  criação de chats, histórico de mensagens e upload de mídia.
- **Socket.IO** cuida de tudo que é tempo real: envio de mensagens, presença,
  "digitando", recibos de entrega/leitura, reações, exclusão e sinalização mesh.
- **SQLite** persiste usuários, chats, membros, mensagens, recibos e reações.

---

## 📡 Modo mesh (resiliência em apagão)

O objetivo do mesh é manter as conversas fluindo **mesmo quando o servidor
central está inacessível** (apagão, torre de celular congestionada, rede só local).

**O que já existe (`public/js/mesh.js`):**
- Conexões **WebRTC `RTCPeerConnection` + `DataChannel`** diretas entre pares.
- **Sinalização** (troca de SDP/ICE) feita pelo servidor quando ele está online.
- **Broadcast/flooding** de mensagens entre os pares conectados — a base do relay mesh.
- Camada **agnóstica de transporte**: basta fornecer uma função `sendSignal` e
  alimentar os sinais recebidos.

**Roteiro para mesh offline real (sem servidor):**
A sinalização hoje depende do servidor. Para um mesh verdadeiramente offline, o
transporte de sinalização deve ser trocado por um canal serverless — por exemplo,
**Bluetooth LE**, **Wi-Fi Direct** ou **mDNS na LAN** — encapsulado por um shell
nativo (Capacitor/Cortando para Android/iOS, ou Electron no desktop). Como o
`MeshManager` é desacoplado do transporte, essa evolução não exige reescrever a
lógica de pares, apenas plugar um novo `sendSignal`/`onSignal`. Mensagens
trafegariam por flooding com deduplicação por `id`, e seriam reconciliadas com o
servidor quando a conectividade voltasse.

---

## 🔒 Segurança

- Senhas com **bcrypt**; sessões com **JWT** (expiração de 30 dias).
- Sockets autenticados no handshake; cada operação valida a participação no chat.
- Uploads limitados a 25 MB.
- **Nota:** a criptografia atual é em trânsito (HTTPS/TLS quando hospedado com
  TLS). Criptografia ponta-a-ponta (E2EE) é o próximo passo natural — ver roteiro.

---

## 🗺️ Próximos passos

- Criptografia ponta-a-ponta (Signal Protocol / libsignal).
- Chamadas de voz/vídeo em grupo (o 1:1 já está implementado).
- Status/stories e encaminhamento de mensagens.
- Notificações push (Web Push) e shell nativo (Android/iOS) para mesh offline real.

---

## 🧪 Stack

Node.js · Express · Socket.IO · better-sqlite3 · bcryptjs · jsonwebtoken · multer ·
WebRTC · PWA (Service Worker + Web App Manifest).
