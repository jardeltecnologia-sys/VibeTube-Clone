# Deploy de produção (Hostinger + nginx) — SpeedVox/VibeTube

A produção roda atrás do **nginx** (TLS em 80/443), com o app em
`127.0.0.1:3017`. O `docker-compose.yml` da raiz é o **exemplo com Caddy** e
**não serve** para esta máquina (subiria o Caddy em 80/443, conflitando com o
nginx, e o app sem a porta 3017). Use sempre o **`docker-compose.prod.yml`**.

## 1) Migração única (preserva banco e uploads)

Faça isto **uma vez**, antes do primeiro `up` com o compose de produção. Os
dados hoje vivem dentro do container atual (volume do Docker). O `docker cp`
copia os arquivos de dentro do container — **sem precisar saber o nome do
volume** — para bind mounts visíveis em `./data` e `./uploads`.

```bash
cd /opt/speedvox

# 0) backup rápido (já existe um do deploy, mas reforce)
mkdir -p /opt/backups/speedvox/manual
docker cp speedvox-app-1:/app/data   /opt/backups/speedvox/manual/data-$(date +%F-%H%M) || true

# 1) extrair os dados atuais para bind mounts
mkdir -p data uploads
docker cp speedvox-app-1:/app/data/.    ./data/    || true
docker cp speedvox-app-1:/app/uploads/. ./uploads/ || true
ls -la data uploads        # confira que speedvox.db e a mídia estão aqui

# 2) parar/remover o container antigo (libera o nome e a porta 3017)
docker stop speedvox-app-1 && docker rename speedvox-app-1 speedvox-app-old

# 3) subir pela definição de produção
docker compose -f docker-compose.prod.yml up -d --build

# 4) validar
sleep 8
docker ps --filter name=speedvox-app-1
curl -fsS http://127.0.0.1:3017/api/health && echo " <- OK"
curl -fsS http://127.0.0.1:3017/api/mesh/status && echo

# 5) se OK, remover o antigo
docker rm -f speedvox-app-old
```

Rollback (se o health falhar):

```bash
docker compose -f docker-compose.prod.yml down
docker rename speedvox-app-old speedvox-app-1
docker start speedvox-app-1
```

## 2) Deploys seguintes (rotina)

Depois da migração, todo deploy é idempotente e sem conflito:

```bash
cd /opt/speedvox
git fetch origin main && git reset --hard origin/main
docker compose -f docker-compose.prod.yml up -d --build
```

> No script de deploy (PowerShell), troque a linha
> `docker compose up -d --build` por
> `docker compose -f docker-compose.prod.yml up -d --build`.
> O `git reset --hard origin/main` é seguro: `./data` e `./uploads` são
> ignorados pelo Git (não são apagados), e o `.env` também é preservado.

## 3) .env de produção

Mínimo recomendado (o `JWT_SECRET` já existente deve ser mantido — trocá-lo
desloga todo mundo):

```
NODE_ENV=production
PUBLIC_URL=https://chat.vibetube.com.br
# Google (login): a redirect URI no Google Console deve ser
#   https://chat.vibetube.com.br/api/auth/google/callback
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
# Mesh (todas são opcionais; default já é ligado)
MESH_ENABLED=1
MESH_SYNC_ENABLED=1
MESH_WEB_DIAGNOSTIC_ONLY=0
```

## 4) Checagem pública (Cloudflare/nginx)

```bash
curl -I https://chat.vibetube.com.br/
curl    https://chat.vibetube.com.br/api/health
curl -I https://chat.vibetube.com.br/manifest.webmanifest   # PWA instalável
```
