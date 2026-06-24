#!/usr/bin/env bash
# Finaliza o deploy de produção do SpeedVox/VibeTube com segurança.
#
# O que faz, em ordem:
#   1. Ajusta o .env (PUBLIC_URL etc.) de forma idempotente.
#   2. Migração ÚNICA: se ainda não há banco em ./data, copia os dados de dentro
#      do container atual (docker cp — independe do nome do volume).
#   3. Para/renomeia o container antigo (libera o nome e a porta 3017).
#   4. Sobe pela definição de produção (docker-compose.prod.yml: nginx + 3017,
#      sem Caddy).
#   5. Valida o /api/health. Se falhar, faz ROLLBACK para o container anterior.
#
# Uso (no servidor Hostinger, como root):
#   cd /opt/speedvox
#   git fetch origin main && git reset --hard origin/main
#   bash deploy/finish-deploy.sh
#
# Seguro de rodar mais de uma vez: depois do primeiro sucesso, ele só refaz o
# build e recria o container (sem mexer nos dados já migrados).

set -Eeuo pipefail

APP_DIR="/opt/speedvox"
PUBLIC_URL_VALUE="https://chat.vibetube.com.br"
COMPOSE="docker-compose.prod.yml"
HEALTH="http://127.0.0.1:3017/api/health"

cd "$APP_DIR"

echo "============================================================"
echo " FINALIZAR DEPLOY - $(date -Is)"
echo "============================================================"

# --- 1) .env idempotente -------------------------------------------------
touch .env
set_env() {
  local k="$1" v="$2"
  if grep -qE "^${k}=" .env; then sed -i "s|^${k}=.*|${k}=${v}|" .env; else echo "${k}=${v}" >> .env; fi
}
set_env NODE_ENV production
set_env PUBLIC_URL "$PUBLIC_URL_VALUE"
set_env MESH_ENABLED 1
set_env MESH_SYNC_ENABLED 1
set_env MESH_WEB_DIAGNOSTIC_ONLY 0
echo "[.env] PUBLIC_URL e flags MESH ajustadas (JWT_SECRET e demais preservados)."

mkdir -p data uploads

# --- 2) migração única dos dados ----------------------------------------
OLD_RUNNING="$(docker ps -aqf 'name=^speedvox-app-1$' || true)"
if [ ! -f data/speedvox.db ] && [ -n "$OLD_RUNNING" ]; then
  echo "[migração] Copiando dados de dentro do container atual..."
  docker cp "speedvox-app-1:/app/data/."    ./data/    || true
  docker cp "speedvox-app-1:/app/uploads/." ./uploads/ || true
  echo "[migração] Conteúdo de ./data:"; ls -la data | sed 's/^/   /'
else
  echo "[migração] Pulada (já há ./data/speedvox.db ou não há container antigo)."
fi

# --- 3) liberar nome/porta do container antigo ---------------------------
STAMP="$(date +%s)"
if [ -n "$OLD_RUNNING" ]; then
  echo "[swap] Parando e renomeando o container antigo -> speedvox-app-old-$STAMP"
  docker stop speedvox-app-1 || true
  docker rename speedvox-app-1 "speedvox-app-old-$STAMP" || true
fi

# --- 4) subir produção ---------------------------------------------------
echo "[up] docker compose -f $COMPOSE up -d --build"
docker compose -f "$COMPOSE" up -d --build

# --- 5) validar + rollback se preciso ------------------------------------
echo "[validação] Aguardando o app responder em $HEALTH ..."
ok=0
for _ in $(seq 1 15); do
  if curl -fsS "$HEALTH" >/dev/null 2>&1; then ok=1; break; fi
  sleep 3
done

if [ "$ok" = "1" ]; then
  echo "✅ Health OK. Produção no ar."
  echo -n "   mesh status: "; curl -fsS http://127.0.0.1:3017/api/mesh/status || true; echo
  echo "[limpeza] Removendo containers antigos renomeados..."
  for c in $(docker ps -aqf 'name=speedvox-app-old' || true); do docker rm -f "$c" || true; done
  echo "============================================================"
  echo " DEPLOY FINALIZADO COM SUCESSO"
  echo "============================================================"
else
  echo "❌ Health falhou. Iniciando ROLLBACK..."
  docker compose -f "$COMPOSE" down || true
  OLDC="$(docker ps -aqf 'name=speedvox-app-old' | head -1 || true)"
  if [ -n "$OLDC" ]; then
    docker rename "$OLDC" speedvox-app-1 || true
    docker start speedvox-app-1 || true
    echo "↩️  Rollback concluído: o container anterior voltou no ar."
  else
    echo "⚠️  Não havia container anterior para restaurar."
  fi
  echo "Logs do app novo (para diagnóstico):"
  docker compose -f "$COMPOSE" logs --tail 80 || true
  exit 1
fi
