# Known Limitations & Honest Status

This file is the single source of truth for **what does not yet work, what is
unproven, and what is impossible with the current approach.** The project's
rules forbid presenting experimental features as functional — this file exists
to keep that honest.

Legend: ✅ works · 🟡 implemented but **needs live validation** · 🔬 experimental ·
⛔ not implemented / known blocker.

## Toolchain / environment (observed on this machine, 2026‑10‑26)
- Node **v24.22.1**, npm **11.19.1**. ✅
- `pnpm` **not installed** → project uses **npm workspaces**. ✅
- `git` **not installed** → no repo initialized; install Git if version control
  is wanted. ⛔ (not required to run the app)
- Persistence uses Node's **built‑in `node:sqlite`** (no native build needed).
  It is marked *experimental* by Node and may print a warning; chosen over
  `better-sqlite3` to avoid native‑compile failures. 🟡

## Zoom automation
- Launch persistent Chromium + navigate to Zoom Web. ✅ (prototype)
- Auth‑state detection (authenticated vs. sign‑in needed). 🟡 selector‑based,
  validate live.
- Assisted manual login (human does login + MFA in the visible window). ✅ flow;
  🟡 completion detection.
- Join existing meeting. ✅ VERIFIED live. An authenticated host is taken
  straight into `/start`; the adapter detects the in‑meeting toolbar.
- Auto‑join at startup + host entry. ✅ VERIFIED (re‑enters on restart).
- **Start meeting as host.** ✅ works in practice because the authenticated
  owner opening the join URL lands in `/start` (own PMI). The separate
  `/zoom/start` host‑start API stays 501 (not needed).
- Participant list. ✅ VERIFIED (2026‑10‑26) via `.participants-li` + aria‑label
  parsing. Shows name, host/co‑host, mute, hand. Panel is React‑Virtualized, so
  very large meetings can be partial (flagged); raised hands sort to the top so
  they stay visible.
- Raised‑hand detection. ✅ VERIFIED — read from the row aria‑label
  (`,hand raised`).
- **Raised‑hand ordering.** 🟡 approximated by our detection time
  (`handOrderSource: "detection-time"`); good enough as hands sort to the top.
- Mute flag per participant. ✅ from aria‑label (`audio muted`/`unmuted`); `null`
  when not stated.
- Auto‑admit from waiting room. ✅ VERIFIED (clicked "Admit"; `admitted` count
  returned). Needs a waiting participant to exercise.
- Lock "unmute themselves". 🟡 path VERIFIED (Host Tools → Participants →
  "Unmute Themselves" switch); not toggled on a live congregation yet.
- Hide browser off‑screen (CDP). 🟡 implemented; confirm visually on the host PC.

## Screen sharing (VERIFIED live 2026‑10‑26)
- **Entire‑monitor share is IMPOSSIBLE in Zoom Web.** Zoom calls
  `getDisplayMedia({video:{displaySurface:"window"}, monitorTypeSurfaces:"exclude"})`
  — it only offers a **window or a browser tab**, never a full screen. ⛔ (hard
  Zoom limitation, not a code issue).
- **Sharing the JW Library WINDOW works. ✅** With Chromium launched
  `--auto-select-desktop-capture-source-by-title="JW Library"`, clicking Zoom's
  Share auto‑picks that window (no OS picker) and the content broadcasts
  correctly — confirmed by a second viewer. JW Library is a UWP app yet still
  captures fine (not black). Sharing the window (not the monitor) is also safer:
  nothing else on the screen leaks.
- Stop share. ✅ clicks Zoom's "Stop Share".
- **Automatic trigger via UI Automation.** 🟡 implemented (2026-10-28), replacing
  projector-brightness polling. A persistent worker observes JW media controls
  and invokes the existing share flow on change. The idle JW Library case has
  been checked locally; image/video transitions and broadcast latency still
  need live validation. See [JW detection](jw-media-detection.md).
- Automatic stop waits 100ms after the media context disappears;
  temporary observation failures preserve the last activity state.
- **System/media audio sharing.** 🔬 getDisplayMedia requested audio too; whether
  JW media audio actually rides along is unconfirmed — validate with sound.
- Config: `share.mode="automatic"` + `share.autoSourceTitle="JW Library"` enables
  it; the capture flag is applied at Chromium launch (restart to change it).

## Presentation monitor (Windows)
- Enumerate displays. 🟡 via PowerShell/WMI query; stable monitor ids are
  best‑effort.
- Identify projector vs. primary. 🟡 heuristic + operator confirmation.
- Read-only UI Automation media detection. 🟡 event subscriptions plus a one-second
  reconciliation scan; no projector brightness threshold. Selectors are adapted
  from JarbasJWL and may require updates when JW Library changes its UI.
- A media UI context is not proof of actual projection or playback. Validate
  images, muted videos, hidden controls, and JW restart locally before use.

## Server / security
- REST + WebSocket + SQLite + state machine. ✅
- Admin vs. viewer roles with token auth. 🟡 basic; tighten before exposing.
- Bound to loopback / local network only by default. ✅
- No public exposure by default. ✅

## Assistência: tempo real e push para o Mapas JW (2026-11-07)
Integração **opcional e privada**: sem configuração o push fica inativo e nenhuma
requisição de rede é feita (um clone limpo deste repositório não fala com ninguém).
- Evento `attendance.changed`, assistência de HOJE no `Snapshot` (`attendance`),
  `GET /api/v1/attendance/today` e `:date` completo. ✅ cobertos por testes
  automatizados (Fastify `inject`, SQLite real em memória); 🟡 **não** exibidos
  ainda em tablet real — o consumo no tablet é outra tarefa.
- Outbox SQLite (`attendance_outbox`), worker com backoff 5 s → 5 min, timeout de
  10 s, 401/422/outros 4xx como erro permanente. 🟡 **NÃO validado contra um
  backend Laravel real**: o contrato (`POST /api/kmc/assistencia`) foi testado só
  com `fetch` simulado. Códigos HTTP, corpo de resposta e `Retry-After` reais
  ainda precisam ser observados ponta a ponta.
- Token e URL vêm do store local (`kv` `mapasjw.config`, gravado pelo pareamento)
  ou, como fallback, de `KMC_MAPASJW_URL`/`KMC_MAPASJW_TOKEN`/`KMC_MAPASJW_INSTANCE`.
  ⛔ O token do store fica em texto no SQLite local (mesmo nível de proteção do disco do PC).
- **Pareamento (implementado, NÃO validado ao vivo).** Painel "Mapas JW" em Configurações:
  o KMC pede (`POST <base>/api/kmc/instancias/solicitar`), mostra o CÓDIGO, um gestor
  aprova no Mapas JW conferindo o código, e o KMC consulta a cada 5 s (backoff até 30 s
  em erro de rede) até receber o token, que é gravado em `mapasjw.config` antes de
  qualquer outra coisa (o servidor só o entrega uma vez). Rotas admin:
  `POST/GET /api/v1/mapasjw/pair`, `POST .../pair/cancel`, `POST /api/v1/mapasjw/disconnect`
  (as de escrita exigem Origin == Host). Chaves do kv: `mapasjw.pairing` (solicitação,
  com o segredo só enquanto pendente), `mapasjw.config`, `mapasjw.authFailed`.
  🟡 Coberto só por testes com `fetch` simulado e pelo contrato descrito pelo outro
  lado; **o fluxo contra um Mapas JW real nunca foi exercitado a partir desta UI**, nem
  a tela em navegador (só typecheck e build do dashboard). Hipóteses não confirmadas:
  404/410 na consulta tratados como "expirada"; outros 4xx como erro final; 5xx, 429 e
  falha de rede como transitórios; "aprovada" sem token tratada como token perdido (o
  pareamento tem de ser refeito, revogando a aprovação antiga no Mapas JW).
  Desconectar apaga só a cópia local: a aprovação continua existindo no Mapas JW até um
  gestor revogá-la lá. Se a conexão vier de `KMC_MAPASJW_*`, Desconectar não a remove
  (o painel avisa); o que foi pareado pelo painel tem prioridade sobre o ambiente.
  Fila de saída e troca de congregação: Desconectar descarta os envios pendentes (a
  confirmação do painel informa quantos), e um pareamento novo também descarta o que
  estiver pendente antes de reenfileirar a assistência de hoje (o item que levou 401 não
  é reenviado sozinho). Além disso cada item da fila guarda a marca do destino
  (impressão digital de URL + token) e o envio recusa, como falha permanente e sem
  rede, qualquer item cuja marca não bata com a configuração atual, inclusive linhas
  antigas sem marca. Consequência: trocar o token (ou o `KMC_MAPASJW_*`) com itens
  pendentes os descarta em vez de entregá-los. Vencida a `expira_em`, o KMC faz UMA
  consulta final antes de marcar a solicitação como expirada.
- `tipo` (`meio_semana`/`fim_de_semana`/`outra`) vem de `meeting.kind`, validado
  contra a semana ISO e o dia da semana; reunião não carregada ou em conflito vira
  `outra`. 🟡 Heurística; depende de a reunião da semana estar carregada no KMC.
- Com `authEnabled=false` (sem `KMC_ADMIN_TOKEN`/`KMC_VIEWER_TOKEN`) qualquer
  aparelho da rede local é admin e vê a assistência no snapshot; o servidor emite
  `system.warning` na partida, mas o comportamento padrão **não** foi alterado.
- O presencial por data é podado em ~90 dias (`Db.setPresencial`); o outbox é
  independente e guarda 30 dias de histórico de envios.
- Os testes do servidor com SQLite exigem Node 22+ (`node:sqlite`) e usam um shim
  de alias no `vitest.config.ts`, porque o Vite 5 não resolve `node:sqlite`.

## PWA: papel Painel, barra inferior e Sala B no fim de semana (2026-11-07)
- **Papel `painel`** (campo `painel: boolean` por aparelho em `remote.devices`, separado de
  `DeviceAccess`). Nasce `false`; aparelhos antigos migram como `false`; só o operador liga, em
  `POST /api/v1/remote/devices/:id/painel` (admin + Origin igual ao Host). Aparelhos com `painel`
  recebem no `RemoteTimerState` o campo opcional `painel` (mãos levantadas com nome, anúncios e
  assistência de hoje); os demais não recebem esses campos no payload. 🟡 Testado só com vitest
  sobre o payload (HTTP e WebSocket simulados). Ligar o painel faz **nomes de participantes
  saírem pela internet** (túnel Cloudflare) para aquele aparelho; o servidor não tem como saber
  quem de fato segura o celular.
- **Ordem das mãos.** `handRaisedAt` é o horário em que o servidor DETECTOU a mão, não o horário
  real; a aba Painel mostra "detectada há cerca de N min" e avisa quando a lista é parcial.
  A aba é somente leitura (não dispensa mãos, ao contrário do app da tribuna).
- **Sala B no fim de semana.** Regra: `deriveTipo(meeting.kind, dia)` (reunião carregada validada
  contra a semana ISO e o dia); `fim_de_semana` => sem Sala B, `meio_semana` => com Sala B, e sem
  reunião carregada/em conflito vale o dia (sábado/domingo = sem Sala B). Nesse caso o servidor
  devolve a Sala B sem partes, recusa comandos (`room_b_weekend`) e o PWA esconde seletor e aba.
  Aparelho com acesso só `b` vê uma mensagem explicando. 🟡 Heurística: uma reunião especial de
  Sala B num fim de semana não é suportada de propósito.
- **NÃO VALIDADO AO VIVO.** A nova tela (barra de 5 abas, aba Painel, mensagem da Sala B) foi
  compilada e tipada (`build:dashboard`, `typecheck`), mas **não foi aberta em navegador nem em
  celular real**: layout, safe-area, rolagem e a barra fixa sobre o conteúdo estão sem verificação
  visual. Também não foi exercitado com Zoom real nem pelo túnel Cloudflare. O botão central
  elevado do padrão do Mapas JW não foi reproduzido.

## Windows startup
- Task Scheduler "at logon" agent + watchdog. 🟡 script provided
  (`scripts/install-windows.ps1`), validate on the target PC.
- **Must run in the interactive session** (Chromium needs a desktop); a Session‑0
  Windows Service cannot drive the browser/capture. Documented, not attempted.

## Recommended authoritative alternative
For reliable participant/reaction/host data, the **Zoom Meeting SDK + REST API +
Webhooks** is the correct long‑term source and avoids DOM fragility entirely. It
requires a Zoom Marketplace app and is out of scope for this browser‑automation
phase, but is the recommended next architectural step.
