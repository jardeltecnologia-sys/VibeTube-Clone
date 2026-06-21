# Gerar o SpeedVox como aplicativo instalável

O SpeedVox é um app web (servidor Node + frontend PWA). Há três formas de
"instalá-lo":

1. **PWA** (mais simples, sem build) — abra o site no Chrome/Edge/Safari e use
   "Instalar app" / "Adicionar à tela inicial". Funciona em desktop e celular.
   Requer servir por **HTTPS** em produção (o `localhost` já conta como seguro).

2. **Desktop (Electron)** — um executável que empacota o servidor + o frontend e
   roda sozinho (não precisa hospedar backend). Veja abaixo.

3. **Android (Capacitor)** — um APK nativo que carrega o seu servidor SpeedVox
   hospedado. Veja abaixo.

---

## 2) Desktop com Electron (Windows / macOS / Linux)

A pasta `desktop/` contém o empacotador. Pré-requisitos: Node.js 20+ e as
ferramentas de build nativas do seu SO (no Windows, "Desktop development with
C++"; no macOS, Xcode CLT; no Linux, build-essential), porque o `better-sqlite3`
é compilado.

```bash
# 1. instale as dependências do servidor (na raiz do projeto)
npm install

# 2. entre na pasta desktop e instale o Electron + ferramentas
cd desktop
npm install

# 3. rode em modo desenvolvimento (abre a janela do app)
npm start
```

Para gerar o instalador (executável distribuível):

```bash
cd desktop
npm run dist        # gera em desktop/release/ (AppImage no Linux, .exe no Windows, .dmg no macOS)
# ou, só a pasta desempacotada, mais rápido para testar:
npm run dist:dir
```

Notas:
- `npm run dist` roda o `electron-rebuild` para recompilar o `better-sqlite3`
  contra a ABI do Electron e depois o `electron-builder`.
- O app guarda os dados (banco, uploads, chaves) na pasta de dados do usuário do
  SO (não no diretório do app), então funciona mesmo instalado em local somente
  leitura.
- Gere o instalador **no mesmo SO de destino** (electron-builder não faz
  cross-compile de instaladores nativos de forma confiável).

---

## 3) Android com Capacitor (APK)

A pasta `mobile/` contém um `capacitor.config.json` que faz o app nativo
**carregar o seu servidor SpeedVox hospedado** (padrão "remote URL"): o APK é uma
casca nativa em volta do PWA, então tudo continua mesma-origem e nada do frontend
precisa mudar. Pré-requisitos: Android Studio + JDK.

```bash
# em uma pasta nova do projeto Capacitor (ou na raiz, ajustando webDir):
npm install @capacitor/core @capacitor/cli @capacitor/android

# use o config de mobile/capacitor.config.json e ajuste "server.url" para a URL
# HTTPS pública do seu servidor SpeedVox, por exemplo https://chat.seudominio.com
npx cap init SpeedVox app.speedvox.mobile --web-dir public
# (copie o server.url do mobile/capacitor.config.json para o capacitor.config gerado)

npx cap add android
npx cap sync android
npx cap open android      # abre no Android Studio
```

No Android Studio: **Build > Build APK(s)** (ou Generate Signed Bundle/APK para
publicar na Play Store). O APK gerado abrirá o seu servidor SpeedVox como app.

Observações:
- O servidor precisa estar acessível por **HTTPS** (E2EE, câmera/microfone para
  chamadas e instalação de PWA exigem contexto seguro).
- Para notificações push nativas e mesh por Bluetooth/Wi-Fi Direct (modo
  blackout), seriam necessários plugins nativos do Capacitor — está no roteiro.

---

## Hospedar o servidor (para PWA e Android)

Qualquer host Node serve. Exemplo com proxy reverso TLS (recomendado):

- Rode `npm start` (porta 3000) atrás de um **Caddy** ou **Nginx** com HTTPS.
- Caddy (TLS automático) — `Caddyfile`:

  ```
  chat.seudominio.com {
      reverse_proxy 127.0.0.1:3000
  }
  ```

- Defina no `.env`: `PUBLIC_URL=https://chat.seudominio.com` e um `JWT_SECRET`
  longo e aleatório. Configure `VAPID_*` (push) e `TURN_*` (chamadas atrás de
  NAT) se desejar.
