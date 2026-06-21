# Publicar o SpeedVox em HTTPS

> HTTPS é necessário em produção: a criptografia E2EE, o microfone/câmera das
> chamadas, as notificações push e a instalação como PWA só funcionam em
> contexto seguro. (`localhost` já conta como seguro para desenvolvimento.)

O servidor lê a porta de `PORT` e usa `JWT_SECRET` para as sessões. O endpoint
`/api/health` serve de healthcheck. Escolha um dos caminhos abaixo.

---

## A) Render — HTTPS grátis, sem servidor próprio (mais simples)

1. Suba este repositório para o seu GitHub.
2. Em <https://render.com> → **New + → Blueprint** → aponte para o repo.
   O `render.yaml` cria um Web Service em Docker, com `JWT_SECRET` gerado e
   healthcheck. Você recebe uma URL `https://SEU-APP.onrender.com`.
3. (Opcional) Em **Environment**, defina `PUBLIC_URL` com essa URL se for usar
   login com Google, e `VAPID_*` / `TURN_*` se quiser push e chamadas robustas.

⚠️ O plano grátis tem disco **efêmero**: o banco SQLite e os uploads reiniciam a
cada deploy. Para persistir, adicione um Disk em `/app/data` (plano pago) ou use
o Fly/Docker abaixo (que têm volume).

---

## B) Fly.io — HTTPS grátis + volume persistente

```bash
# instale o flyctl: https://fly.io/docs/hands-on/install-flyctl/
fly launch --no-deploy            # use o fly.toml deste repo
fly volumes create speedvox_data --size 1
fly secrets set JWT_SECRET="$(openssl rand -hex 32)"
fly deploy
```

A URL `https://SEU-APP.fly.dev` já vem com TLS. Os dados ficam no volume montado
em `/app/data`.

---

## C) VPS próprio com domínio — HTTPS automático via Caddy

Pré-requisitos: um servidor com Docker e um registro DNS (A) apontando, por
exemplo, `chat.seudominio.com` para o IP do servidor.

```bash
DOMAIN=chat.seudominio.com \
JWT_SECRET="$(openssl rand -hex 32)" \
PUBLIC_URL=https://chat.seudominio.com \
docker compose up -d --build
```

O Caddy obtém e renova os certificados Let's Encrypt automaticamente. Banco e
uploads ficam em volumes Docker (`speedvox-data`, `speedvox-uploads`).

---

## D) Qualquer host Node (Railway, etc.)

Com o `Procfile` (`web: node server/index.js`) plataformas como **Railway**
detectam e sobem o app com HTTPS automático. Defina `JWT_SECRET` nas variáveis
de ambiente. (Use um banco/volume persistente quando disponível.)

---

## Variáveis de ambiente úteis

| Variável | Para quê |
|---|---|
| `PORT` | porta HTTP (as plataformas costumam definir sozinhas). |
| `JWT_SECRET` | segredo das sessões — **defina um valor longo e aleatório**. |
| `PUBLIC_URL` | URL pública (usada no OAuth do Google e em links). |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | login com Google (opcional). |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Web Push (geradas no 1º boot se vazias). |
| `TURN_URL` / `TURN_USERNAME` / `TURN_CREDENTIAL` | chamadas atrás de NAT restritivo. |
| `SPEEDVOX_DATA_DIR` / `SPEEDVOX_UPLOAD_DIR` | onde gravar dados/uploads (padrão: `./data`, `./uploads`). |

Depois de publicar, abra a URL HTTPS, crie uma conta e, no celular/desktop, use
"Instalar app" para ter o SpeedVox como aplicativo (PWA). Para gerar instalador
desktop (Electron) ou APK (Android), veja **BUILD.md**.
