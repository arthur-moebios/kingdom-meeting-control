# Fase 2 — Empacotamento e Distribuição

Plano técnico para transformar o protótipo (Node + dashboard web + automação) em
produtos instaláveis:

- **PC do Salão (Windows):** um **`.exe`** instalável, que roda sozinho ao ligar.
- **Tablet da tribuna (Android):** um **APK** em **modo quiósque** com
  **auto-update** pela rede local (sem Play Store, sem internet).

> Nada aqui precisa do PC agora — é o plano. As decisões marcadas **[DECIDIR]**
> são escolhas que confirmamos antes de implementar.

---

## 0. Visão geral da arquitetura final

```
          PC do Salão (Windows)  —  "kmc.exe"
   ┌───────────────────────────────────────────────┐
   │ Backend Node (Fastify)                         │
   │  • serve a API /api/v1 + WebSocket /ws         │
   │  • serve o dashboard do operador (estático)    │
   │  • serve a VIEW do tablet (estático)           │
   │  • hospeda o APK + manifesto de versão  ◄───┐  │
   │ Automação Zoom (Playwright + Chromium)      │  │
   │ Monitor de apresentação (brilho do projetor)│  │
   └───────────────────────────────────────────────┘
              ▲ LAN (Wi-Fi do Salão)              │ baixa APK novo
              │ dados (viewer, somente leitura)   │ (auto-update)
   ┌──────────┴───────────────┐                   │
   │ Tablet 10" (Android)      │───────────────────┘
   │  APK em modo quiósque     │
   │  WebView → view da tribuna│
   └───────────────────────────┘
```

Princípios que já valem e continuam:
- Configs em **SQLite** (`node:sqlite`, sem build nativo). ✅
- Tablet é **somente leitura** (viewer token; endpoints de controle dão 403).
- Nada exposto na internet por padrão; tudo na **LAN**.
- Os dois apps são **nativos** (EXE empacotado + APK Android nativo) e **se
  acham sozinhos na LAN, sem IP fixo** (mDNS/DNS-SD).

---

## 0.1 Descoberta na LAN — sem IP fixo (mDNS / DNS-SD) ✅ IMPLEMENTADO (backend)

O PC do Salão **anuncia** um serviço Zeroconf e o tablet **descobre** — nenhum IP
é digitado em lugar nenhum.

- **Serviço:** `_kmc._tcp.local.`, porta do backend (4317).
- **TXT:** `v=1`, `api=/api/v1`, `ws=/ws`, `name`, `host`, `version`.
- **Backend (feito):** `apps/server/src/discovery.ts` usa `bonjour-service` para
  publicar. **Validado** nesta máquina: um browser mDNS achou
  `Kingdom Meeting Control @ AVELL | host: AVELL | port: 4317` com os TXT. Há
  também `GET /api/v1/discovery` (sem auth) para o cliente confirmar o serviço.
- **Android (a fazer):** `NsdManager` (Network Service Discovery, nativo) procura
  `_kmc._tcp`, resolve host+porta, lê os TXT e conecta. Sem IP, sem config de rede.
- **Requisito de rede:** para o tablet alcançar o PC, o backend precisa escutar
  em **`0.0.0.0`** (hoje o padrão é `127.0.0.1` só loopback). O app já **avisa no
  log** quando está em loopback. O instalador do Windows vai configurar
  `KMC_HOST=0.0.0.0` (acesso restrito à LAN + token).
- **Pareamento/token [DECIDIR]:** como o tablet obtém o viewer token na 1ª vez —
  opções: (a) digitar uma vez na tela de setup; (b) QR/código mostrado no
  dashboard que o tablet lê; (c) endpoint de pareamento que o operador aprova no
  dashboard. Recomendo (b) ou (c) para quiósque. O IP nunca é digitado —
  descoberta cuida disso; só o token/pareamento.

---

## 1. App Windows como `.exe`

### 1.1 O que precisa virar "um app"
Hoje são dois processos de dev (backend via `tsx`, dashboard via Vite). Para
produção:
1. **Servir o dashboard e a view do tablet pelo próprio backend** (estático, via
   `@fastify/static`), em vez do Vite. Assim há **um processo só**.
2. Empacotar esse processo como executável.
3. Lidar com o **Chromium do Playwright** (é o ponto delicado — ver 1.3).
4. Instalador que configura **autostart ao logon** (já temos
   `scripts/install-windows.ps1`) e um ícone/bandeja.

### 1.2 Como gerar o executável — **[DECIDIR]**
Três caminhos, do mais leve ao mais "app de desktop":

| Opção | Como | Prós | Contras |
|---|---|---|---|
| **A. Node SEA** (recomendado) | `esbuild` junta backend+pacotes+estáticos num JS; Node 24 **Single Executable Applications** gera `kmc.exe` | Oficial, leve, sem runtime extra; usa o `node:sqlite` nativo | Sem janela/bandeja nativa (roda como serviço de console); auto-update manual |
| **B. Electron + electron-builder** | Empacota backend no processo principal + uma janela/bandeja | Janela e **bandeja nativas**, instalador NSIS pronto, **auto-update** embutido (electron-updater) | Pesado: traz um Chromium só pra UI, **além** do Chromium do Playwright |
| **C. `pkg`/`nexe`** | Bundlers antigos | — | **Arquivados/sem manutenção** → evitar |

**Recomendação:** **Opção A (Node SEA) + instalador Inno Setup**. O operador não
precisa de janela nativa — ele usa o dashboard no navegador. Se depois quiserem
uma bandeja com "status/abrir painel/recuperar", dá pra adicionar um
tray-launcher pequeno sem ir pro Electron inteiro.

### 1.3 O Chromium do Playwright (ponto crítico)
O `.exe` **não** consegue embutir o Chromium (~150 MB, binário externo). Opções:
- **Bundlar** o Chromium do Playwright dentro do instalador (copiar a pasta
  `ms-playwright/chromium-*`) e apontar `PLAYWRIGHT_BROWSERS_PATH` para ela.
  → **Recomendado**: instalação offline, versão fixa e previsível.
- Ou baixar no primeiro uso (`playwright install chromium`) — exige internet na
  primeira execução. Menos previsível.

### 1.4 Instalador — `KingdomMeetingControl-Setup.exe`
Com **Inno Setup** (gratuito, padrão no Windows), o instalador:
1. Copia `kmc.exe` + estáticos (dashboard/tablet) + pasta do Chromium.
2. Cria `runtime/` (perfil do Chromium, SQLite) em local de dados do usuário
   (`%LOCALAPPDATA%\KingdomMeetingControl`), **não** em Arquivos de Programas.
3. Gera `.env`/config inicial e **tokens aleatórios** (admin/viewer) na 1ª vez.
4. Registra a tarefa do **Agendador ao logon** (sessão interativa — Chromium
   precisa de desktop). Reusa a lógica de `install-windows.ps1`.
5. Cria atalhos (abrir dashboard, desinstalar).

### 1.5 Config: SQLite (já feito) — opção XML
Você mencionou "SQLite ou XML". **Já usamos SQLite** (`node:sqlite`) para
configs, eventos e auditoria — recomendo manter (consultável, transacional). XML
seria um passo atrás; se quiser um arquivo editável à mão, dá pra **exportar/
importar** as configs como XML/JSON por um endpoint, sem trocar o armazenamento.

### 1.6 Entregáveis Windows (Fase 2)
- [ ] `@fastify/static` servindo dashboard + tablet em produção.
- [ ] Script de bundle (`esbuild`) + geração do SEA (`kmc.exe`).
- [ ] Empacotar/− apontar o Chromium do Playwright.
- [ ] Script Inno Setup → `KingdomMeetingControl-Setup.exe`.
- [ ] Assinatura de código **[DECIDIR]** (evita aviso do SmartScreen; precisa de
      certificado — opcional para uso interno).
- [ ] Auto-update do Windows **[DECIDIR]** (não foi pedido; dá pra adicionar
      depois: checagem simples de versão + baixar novo setup).

---

## 2. App Android (APK) — quiósque + auto-update

### 2.1 Estratégia do app — **[DECIDIR]**
A view da tribuna já existe como web (`tablet.html`). Reaproveitar evita
reescrever a UI.

| Opção | O que é | Prós | Contras |
|---|---|---|---|
| **A. WebView nativa (Kotlin) envolvendo a view** (recomendado) | App Kotlin mínimo com uma `WebView` apontando pra view da tribuna na LAN | Controle total de **quiósque** (Lock Task) e **auto-update**; reusa a UI web; APK pequeno | Precisa de um projeto Android (Gradle) |
| **B. Capacitor** | Wrapper web→APK com plugins | Rápido de montar, ecossistema de plugins | Camada extra; kiosk/update via plugins de terceiros |
| **C. TWA (Bubblewrap)** | Abre a web como app | Simples | Exige **HTTPS** e update via **Play Store** → ruim pra LAN/quiósque |
| **D. UI nativa 100% (Kotlin/Compose)** | Reimplementar a tela consumindo a API/WS | Melhor desempenho | Duplica a UI; mais trabalho |

**Recomendação:** **Opção A** — WebView nativa em Kotlin. Melhor custo/controle
para um quiósque de LAN, e reaproveita a view que já funciona.

### 2.2 De onde a view carrega
- **WebView aponta para a LAN**: `http://<ip-do-PC>:<porta>/tablet.html?token=<viewer>`.
  Dados e UI vêm do PC do Salão. Simples; se o PC estiver desligado, tela de
  "sem conexão" (a view já reconecta sozinha).
- Alternativa: **assets embutidos** no APK (UI offline) + só os **dados** pela
  LAN. Mais robusto se a UI mudar pouco, mas o auto-update da UI teria que vir no
  APK. **[DECIDIR]** — recomendo começar apontando pra LAN (UI sempre atualizada
  pelo PC, APK muda pouco).

### 2.3 Modo quiósque (travar o tablet no app)
Android **Lock Task Mode** (app fixado, sem sair):
- Tablet **dedicado**: tornar o app **Device Owner** via ADB
  (`adb shell dpm set-device-owner <pkg>/<Receiver>`) num tablet recém-resetado.
  Device Owner permite **quiósque real** (sem botão home/recentes) e **instalar
  updates em silêncio**.
- Config no app: `startLockTask()`, `FLAG_KEEP_SCREEN_ON`, esconder barras,
  reiniciar o app no boot (BOOT_COMPLETED), brilho travado.
- **[DECIDIR]**: o tablet será dedicado só a isso? (recomendado para quiósque e
  para o update silencioso).

### 2.4 Auto-update sem Play Store (pela LAN)
O **PC do Salão hospeda** o APK e um manifesto de versão; o tablet checa e
atualiza:
1. Backend expõe (novos endpoints):
   - `GET /api/v1/app/tablet/latest` → `{ version, url, sha256, notes }`
   - `GET /api/v1/app/tablet/download` → o `.apk`
2. O app, periodicamente (ex.: a cada X h ou ao iniciar), compara a versão,
   baixa o APK novo, confere o `sha256`, e instala:
   - **Com Device Owner**: instalação **silenciosa** (`PackageInstaller`), ideal
     para quiósque — atualiza e reinicia sozinho.
   - **Sem Device Owner**: usa `REQUEST_INSTALL_PACKAGES` e mostra a tela de
     instalação (precisa de toque). Menos ideal pra quiósque.
3. Versão nova do APK é colocada no PC do Salão (pelo instalador do Windows ou um
   endpoint admin de upload) — assim **o update do tablet vem do próprio Salão**,
   sem internet.

### 2.5 Permissões / detalhes Android
- `INTERNET`, `ACCESS_NETWORK_STATE`, `WAKE_LOCK`, `RECEIVE_BOOT_COMPLETED`,
  `REQUEST_INSTALL_PACKAGES` (ou Device Owner para silencioso).
- Guardar o **viewer token** e a **URL do PC** em config do app (tela de setup
  protegida por PIN, ou provisionamento via ADB/arquivo).
- Reconment: WebView com JS habilitado, cache, e retry de conexão (a view já faz).

### 2.6 Entregáveis Android (Fase 2)
- [ ] Projeto Android (Kotlin) `apps/tablet-android/` com WebView + Lock Task.
- [ ] Tela de setup (URL do PC + viewer token + PIN) ou provisionamento.
- [ ] Serviço de auto-update (checar manifesto → baixar → instalar).
- [ ] Endpoints no backend: manifesto + download do APK (+ upload admin).
- [ ] Guia de provisionamento do tablet (reset → Device Owner via ADB → config).
- [ ] Assinatura do APK (keystore própria; obrigatória pra instalar/atualizar).

---

## 3. Mudanças no backend (para suportar a Fase 2)
- [ ] `@fastify/static`: servir `dashboard/dist` e `tablet.html` em produção.
- [ ] Endpoints de distribuição do APK: `/app/tablet/latest`, `/app/tablet/download`,
      e upload admin do APK.
- [ ] Config de produção (porta, bind na LAN com cuidado, tokens no 1º boot).
- [ ] Opcional: endpoint de export/import de configs em XML/JSON.

## 4. Pré-requisitos / ferramentas (quando formos implementar)
- **Windows exe**: Node 24 (SEA), `esbuild`, **Inno Setup**; (opcional)
  certificado de assinatura.
- **Android**: **Android Studio** + SDK + JDK 17, Gradle; um **tablet dedicado**
  para Device Owner/quiósque; `adb`.
- Nada disso está instalado nesta máquina ainda — faz parte do setup da Fase 2.

## 5. Ordem sugerida de execução
1. Backend servir estáticos em produção (dashboard + tablet) — base do resto.
2. Gerar o `kmc.exe` (SEA) + apontar/empacotar o Chromium → rodar sem Vite/tsx.
3. Instalador Inno Setup (autostart, runtime, tokens).
4. App Android WebView apontando pra LAN + Lock Task (quiósque).
5. Endpoints de distribuição do APK + auto-update no app.
6. Provisionamento do tablet (Device Owner) + update silencioso.
7. Assinaturas (APK obrigatório; exe opcional) e testes end-to-end.

## 6. Decisões a confirmar (resumo)
- **[DECIDIR]** Windows: **Node SEA** (recomendado) vs Electron.
- **[DECIDIR]** Chromium: **bundlar** no instalador (recomendado) vs baixar no 1º uso.
- **[DECIDIR]** Android: **WebView Kotlin** (recomendado) vs Capacitor.
- **[DECIDIR]** View do tablet: **carregar da LAN** (recomendado) vs embutir no APK.
- **[DECIDIR]** Tablet **dedicado** + **Device Owner** (recomendado p/ quiósque +
  update silencioso)?
- **[DECIDIR]** Assinatura de código do `.exe` (opcional) — APK é obrigatório.
