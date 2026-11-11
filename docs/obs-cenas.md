# Cenas do OBS (câmera virtual do Zoom)

O app controla as **cenas do OBS Studio** — os "cortes" de câmera (Orador, Leitura,
Mesa, Cadeiras, etc.) — e troca de cena **sozinho ao iniciar o cronômetro de uma
parte**, seguindo um mapa configurável. O operador pode trocar na mão a qualquer
momento, pelo painel do PC ou pelo celular.

O OBS faz todo o vídeo e áudio; o app é só o **controle remoto** dele. O Zoom
continua usando a **OBS Virtual Camera** como câmera — o app não troca a câmera do
Zoom, só a cena que o OBS envia.

## 1. Preparar o OBS (uma vez)

1. No OBS, crie suas **cenas** (ex.: `Geral`, `Orador`, `Leitura`, `Mesa`,
   `Cadeiras`). Com câmera única grande-angular, cada cena é um recorte
   (Transformar → Editar transformação, ou o filtro Cortar/Preencher) esticado
   para preencher a saída.
2. **Iniciar a Câmera Virtual** (botão no canto inferior direito do OBS). No Zoom,
   escolha **OBS Virtual Camera** como câmera.
3. Ligue o **Servidor WebSocket**: menu **Ferramentas → Configurações do Servidor
   WebSocket** → marque *Ativar servidor WebSocket*. Anote a **porta** (padrão
   `4455`) e a **senha** (ou defina uma). Precisa de **OBS 28 ou mais novo**.

> Áudio: neste salão o áudio vai da mesa de som direto para o Zoom, então o OBS
> cuida **só do vídeo**. Nada de cabo de áudio virtual.

## 2. Configurar no app

Painel do operador → **⚙ Configurações → OBS Studio (cenas → câmera virtual)**:

- **Ligar a integração com o OBS.**
- **Endereço:** `ws://127.0.0.1:4455` (ajuste a porta se mudou).
- **Senha do WebSocket:** a mesma do OBS.
- **Trocar de cena automaticamente ao iniciar a parte:** ligado (a automação).
- **Cena padrão (fallback):** a cena usada quando nenhuma regra casa (ex.:
  `Geral`). Vazio = não troca sozinho nessas partes.

Quando o OBS está conectado, os campos de cena viram listas com as cenas reais do
OBS — sem digitar nome errado.

## 2.1 Conferente: o app prepara o OBS

O app pode cuidar da prontidão do OBS para a reunião:

- **Abrir o OBS se estiver fechado** — ligue *"Abrir o OBS automaticamente se não
  estiver rodando"*. O app detecta o `obs64.exe` (em `Program Files`; ou informe o
  caminho) e abre minimizado na bandeja, com `--startvirtualcam`.
- **Ligar a câmera virtual** — com *"Iniciar a câmera virtual ao conectar"*, assim
  que conecta, se a câmera virtual estiver desligada, o app a liga (é o que faz o
  Zoom enxergar a "OBS Virtual Camera").
- **Botão "Preparar OBS"** — no cartão de cenas do painel (Windows app): abre o OBS
  se fechado e garante a câmera virtual na hora. Útil antes de começar.

> Tudo do OBS (configuração, cenas, "Preparar") fica **só no Windows app**, para o
> operador. O celular (PWA) controla apenas os cronômetros — mas **iniciar o
> cronômetro de uma parte pelo celular também dispara a cena**, porque a automação
> roda no servidor, não na interface.

Pré-requisito: o **Servidor WebSocket** precisa estar ligado no OBS (passo 1.3) e
ficar marcado para iniciar junto com o OBS — o app não consegue ligá-lo sozinho.
Se o OBS abrir mas o app seguir "sem OBS", confira o WebSocket nas configurações
do OBS.

## 3. O mapa parte → cena

Cada regra tem um **trecho** e uma **cena**. Ao iniciar o cronômetro de uma parte,
a **primeira** regra cujo trecho aparece no *título + seção* da parte (sem
distinção de maiúsculas) define a cena. Exemplos de fim de semana:

| Trecho    | Cena    |
|-----------|---------|
| `Discurso`  | `Orador`  |
| `Sentinela` | `Leitura` |

No meio de semana, as partes vêm do WOL com títulos variados; use trechos como
`Leitura da Bíblia`, `Tesouros`, `Joias`, `Necessidades`, `Estudo bíblico`. O botão
**Sugerir palavras-chave** preenche os trechos comuns — você só escolhe a cena de
cada um. O mapa é persistente (vale toda semana).

## 4. Trocar por reunião (local diferente)

Quando um proferimento é feito em outro lugar, abra a parte no cronômetro (painel
do PC) e escolha a **cena** no seletor da parte (🎬 Cena). Isso **vence o mapa**,
mas só **nesta reunião** — ao recarregar a programação, volta ao automático. O
mapa padrão continua intacto.

## 4.1 Parar o cronômetro volta à cena padrão

Quando o cronômetro **para** (a parte que corria é pausada e nenhuma outra começa),
o OBS **volta sozinho à cena de repouso**: a **primeira cena do OBS** (ex.: `Orador`)
ou a que você escolher em **Cena ao parar**. Ex.: *Iniciando conversas* começa e corta
para a cena dela; ao parar o cronômetro, o OBS volta para `Orador`. Passar direto de
uma parte para outra **não** passa pela cena de repouso (a próxima parte aplica a dela).

- **Voltar à cena padrão quando o cronômetro parar:** ligado por padrão; desligue para
  manter a cena atual ao parar.
- **Cena ao parar:** vazio = a primeira cena da lista do OBS. Retomar a mesma parte
  corta de novo para a cena dela.

## 5. No dia

- O cartão **Cenas (OBS)** aparece no painel e no celular quando a integração está
  ligada: mostra a cena atual e botões para cortar na mão.
- Dar **play** no cronômetro de uma parte → o OBS corta para a cena mapeada.
- Cortar na mão numa cena → fica até a **próxima** parte começar.
- Como o Zoom usa a OBS Virtual Camera, a prévia "Câmera do anfitrião" no painel
  passa a mostrar a própria cena cortada do OBS.

## Sincronia áudio × vídeo

O som vai da mesa **direto** para o microfone do notebook (quase instantâneo), mas
o vídeo passa por câmera → OBS → câmera virtual → Zoom, o que **atrasa a imagem**
alguns quadros. Os lábios aparecem um pouco depois do som. Para alinhar:

1. **Reduza o atraso do vídeo primeiro (costuma resolver):**
   - No OBS, clique na fonte da câmera (*Dispositivo de Captura de Vídeo*) →
     **Propriedades** → **Buffering: Desativar**. É o maior atraso do caminho.
   - Evite filtros pesados; mantenha resolução/FPS da saída iguais aos da câmera.
   - No Zoom não há o que ajustar — ele não controla esse atraso.
   - Em muitos casos o descompasso cai para algo imperceptível.

2. **Se ainda notar, atrase o áudio para casar com o vídeo (correção definitiva):**
   - Instale o **VB-CABLE** (cabo de áudio virtual).
   - Leve o áudio da mesa para dentro do OBS (uma entrada de áudio) e, em
     **Propriedades de Áudio Avançadas**, ajuste o **Deslocamento de sincronia
     (ms)** dessa fonte até os lábios baterem com o som.
   - Mande o áudio do OBS (*Monitoramento*) para o **VB-CABLE** e, no Zoom,
     selecione o **VB-CABLE** como **microfone** (desative o mic do notebook no
     Zoom para não duplicar o áudio).
   - Agora áudio e vídeo saem os dois pelo OBS, e você ajusta o atraso em ms com
     precisão. Esse caminho reintroduz o VB-CABLE — vale só quando o passo 1 não
     basta.

> O app não mexe no áudio nem no atraso do vídeo: a sincronia é configuração do
> OBS e do roteamento de áudio, não do app.

## Resolução (ordem)

```
override da parte (nesta reunião) → regra do mapa → cena padrão → (nada: não troca)
ao parar o cronômetro:  Cena ao parar → primeira cena do OBS → (nada: não troca)
```

A automação acompanha **só a reunião do salão principal** (a Sala B não controla o
OBS). Se o OBS estiver fechado ou o WebSocket desligado, o app apenas mostra
"sem OBS" e reconecta sozinho — nada trava.
