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

## 5. No dia

- O cartão **Cenas (OBS)** aparece no painel e no celular quando a integração está
  ligada: mostra a cena atual, botões para cortar na mão e o estado da câmera
  virtual.
- Dar **play** no cronômetro de uma parte → o OBS corta para a cena mapeada.
- Cortar na mão numa cena → fica até a **próxima** parte começar.
- Como o Zoom usa a OBS Virtual Camera, a prévia "Câmera do anfitrião" no painel
  passa a mostrar a própria cena cortada do OBS.

## Resolução (ordem)

```
override da parte (nesta reunião) → regra do mapa → cena padrão → (nada: não troca)
```

A automação acompanha **só a reunião do salão principal** (a Sala B não controla o
OBS). Se o OBS estiver fechado ou o WebSocket desligado, o app apenas mostra
"sem OBS" e reconecta sozinho — nada trava.
