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
- **Criptografia ponta-a-ponta (E2EE)** nas conversas 1:1 — ECDH P-256 + AES-GCM
  (Web Crypto). A chave privada nunca sai do dispositivo; o servidor só
  armazena/relaia texto cifrado.
- **Conversas 1:1 e em grupo**, com **gestão de grupos**: renomear, foto do
  grupo, adicionar/remover participantes, promover/rebaixar admins, mensagens de
  sistema e transferência automática de admin ao sair.
- **Foto de perfil e de grupo** (upload de imagem).
- **Chamadas de voz e vídeo 1:1** (WebRTC — mídia peer-to-peer, servidor só
  sinaliza), com **TURN opcional** para redes restritivas e **histórico de
  chamadas** (incl. perdidas/recusadas) registrado na conversa.
- **Mensagens de voz** (gravação com MediaRecorder e player no chat).
- **Encontrar contatos** por nome de usuário, nome de exibição ou e-mail (sem agenda telefônica).
- **Status de entrega**: 🕐 pendente, ✓ enviada, ✓✓ entregue, ✓✓ azul lida, ⚠ falhou (toque para reenviar).
- **Envio resiliente (outbox offline)** — a mensagem aparece na hora (otimista), é
  enfileirada localmente e reenviada automaticamente ao reconectar; sem perda em
  redes móveis instáveis. Reconciliação por `clientId` evita duplicação.
- **Indicador "digitando…"**.
- **Presença** online / visto por último.
- **Envio de mídia** (imagens e arquivos até 25 MB).
- **Responder, reagir (seletor de emoji), editar, encaminhar e apagar mensagens** (para todos).
- **Contadores de não lidas** e ordenação por atividade.
- **Organização de conversas**: fixar (no topo), arquivar e silenciar — estado
  individual por usuário.
- **Busca de mensagens**: o servidor busca no texto claro (grupos e mensagens
  não cifradas); o cliente complementa buscando localmente nas mensagens E2EE já
  decifradas — o ciphertext nunca é exposto na busca.
- **Mensagens temporárias**: timer por conversa (24h / 7d / 90d); o servidor
  remove as mensagens vencidas e avisa os participantes em tempo real.
- **Bloquear contatos**: o bloqueado não chega até você (mensagens ocultas e
  presença escondida), e ele vê a mensagem como "enviada" sem saber do bloqueio.
- **Status / Stories**: posts de texto ou imagem que somem em 24h, visíveis aos
  seus contatos (quem compartilha conversa), com visualizador em tela cheia e
  lista de quem viu.
- **Notificações push (Web Push)**: receba mensagens com o app fechado. Respeita
  silenciar/bloquear e não revela o conteúdo de mensagens cifradas na notificação.
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
| `SWEEP_MS` | Intervalo (ms) da varredura de mensagens temporárias vencidas (padrão `15000`). |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Chaves Web Push. Se vazias, são geradas e persistidas em `data/vapid.json` no primeiro boot. |
| `TURN_URL` / `TURN_USERNAME` / `TURN_CREDENTIAL` | Servidor TURN para chamadas atrás de NAT restritivo (opcional). STUN já vem ligado. |
| `CALL_RING_MS` | Tempo de toque (ms) antes de uma chamada não atendida virar "perdida" (padrão `45000`). |
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
    ├── js/e2ee.js        # criptografia ponta-a-ponta (ECDH P-256 + AES-GCM)
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

- **Criptografia ponta-a-ponta (E2EE)** nas conversas 1:1: cada usuário tem um par
  de chaves **ECDH P-256** (Web Crypto). A chave privada fica apenas no
  dispositivo (localStorage); só a chave pública é publicada no servidor. Ambos os
  lados derivam o mesmo segredo via `ECDH(minhaPrivada, públicaDoOutro)` e cada
  mensagem é cifrada com **AES-GCM** (IV aleatório por mensagem). O servidor só
  armazena/relaia o texto cifrado — não consegue ler as mensagens.
- Senhas com **bcrypt**; sessões com **JWT** (expiração de 30 dias).
- Sockets autenticados no handshake; cada operação valida a participação no chat.
- Uploads limitados a 25 MB.
- **Limitações conhecidas (no roteiro):** o E2EE usa um segredo ECDH estático por
  par — é ponta-a-ponta, mas **ainda não tem forward secrecy** (próximo passo:
  Double Ratchet). Conversas em **grupo** e **mídia/voz** ainda não são cifradas
  fim-a-fim (apenas em trânsito via TLS). Verificação de impressão digital de
  chave (detecção de troca de chave) também está no roteiro.

---

## 🗺️ Próximos passos

- Forward secrecy via **Double Ratchet** (sobre as chaves de identidade já existentes).
- E2EE para **grupos** (sender keys) e para **mídia/mensagens de voz**.
- Verificação de chave (números de segurança / QR) entre contatos.
- Chamadas de voz/vídeo em grupo (o 1:1 já está implementado).
- Status/stories e encaminhamento de mensagens.
- Notificações push (Web Push) e shell nativo (Android/iOS) para mesh offline real.

---

## 🧪 Stack

Node.js · Express · Socket.IO · better-sqlite3 · bcryptjs · jsonwebtoken · multer ·
web-push · WebRTC · Web Crypto (ECDH/AES-GCM) · PWA (Service Worker + Web App Manifest).
