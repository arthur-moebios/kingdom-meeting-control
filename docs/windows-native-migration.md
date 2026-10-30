# Migração do painel completo para Zoom desktop

Estado em 29/10/2026: migração principal instalada; integração visual ao JW e
alguns controles ainda precisam de validação. Não considerar paridade total.

## Arquitetura e dados

`KMC_ZOOM_BACKEND=native` seleciona `NativeZoomService` no servidor existente.
O dashboard completo, programação WOL, cronômetros, anúncios, tablet, controle
remoto, WebSocket, configurações e histórico usam os mesmos serviços da versão
web. O backend web continua sendo o padrão quando a variável não está presente.
O WebView2 exibe nossa interface; a reunião usa Zoom.exe, sem abrir Zoom Web.

O servidor principal nativo atende na porta 4319 e o controlador local em
127.0.0.1:4318. O controlador admite comandos somente de uma lista fixa, por
POST JSON de origem local. A fila de comandos usa a conexão Frida já ativa,
despachando na thread principal do Zoom com sala, papel, hashes e vtables
verificados. Não utiliza o SDK público nem cliques em controles do Zoom.
O vínculo também exige PID correspondente e uma observação recente da
identidade da reunião. O fechamento do processo pai encerra os servidores
filhos por seus pipes de entrada, evitando controladores órfãos.

O instalador `scripts/install-native.ps1` constrói o pacote, inclui Python e
Frida locais e importa os dados via `VACUUM INTO` para `data-native/kmc.sqlite`.
Uma instalação existente preserva seu banco. O banco original da versão web
não é modificado. A compilação simples permanece em
`scripts/build-windows-launcher.ps1`.

## Inicialização

A tarefa `KingdomMeetingControlNative` abre o app dez segundos após o logon do
usuário, com token interativo, sem elevação, e sem limite de execução. O botão
**Iniciar com Windows** ativa ou remove essa tarefa. O caminho da ação é o
caminho físico resolvido do executável: a instalação iniciada pelo Codex MSIX
pode ser redirecionada para seu LocalCache. Python e Frida são resolvidos
relativamente ao pacote, permitindo execução fora do contexto do Codex.

O teste com `Start-ScheduledTask` abriu a versão instalada fora desse contexto;
o backend confirmou a sala 1234567890 ativa, com anfitrião local e um
participante. O resultado 0x41301 indica tarefa em execução, como esperado para
um app aberto. O logon completo do Windows ainda não foi ensaiado.

O cliente já autenticado abriu a sala através de `zoommtg://zoom.us/join`.
A tentativa com `/start` apenas abriu a tela principal nesta instalação. O
caminho de ingresso confirmou papel de anfitrião para a conta/sala testada.
Não armazena senha da conta nem automatiza autenticação. As credenciais da
reunião continuam no banco local de configurações.

## Recursos e evidência

| Recurso | Estado |
|---|---|
| Imagem do JW automática | Usuário confirmou recepção e atraso percebido zero antes desta migração. |
| Encerrar por mídia | Controlador existente preservado, com debounce de 100 ms. Precisa repetir após integração visual. |
| Vídeo, áudio e otimização | SMTC identificou o vídeo real; usuário confirmou imagem e som corretos no receptor. Getters locais confirmaram som e otimização habilitados. |
| Admissão automática | Teste real: espera 1→0 e participantes 1→2 após solicitação aceita. |
| Participantes/mãos | Leitura passiva integrada à tela completa; transições reais de mão ainda pendentes. |
| Bloquear/liberar microfone | API do app exercitada; agora aguarda o getter nativo refletir o valor solicitado. |
| Pedir unmute individual | Seleção por ID após nome único; nomes duplicados são rejeitados. Efeito remoto depende do Zoom/participante e permanece pendente. |
| Lançar enquete | Despacho nativo local exercitado. Recepção/votação no outro dispositivo não foi confirmada. |
| Resultados/assistência | Leitura e histórico integrados. Denominador indisponível permanece null. Assistência soma votos × alternativa numérica. |
| Recuperar anfitrião | Comando protegido por elegibilidade, com opção automática; troca real de anfitrião pendente. |
| Sair/entrar e reconectar | Caminhos integrados e exercitados. Foi corrigido o leitor que seguia um PID encerrado após a reunião mudar de processo. |
| Microfone ao ingressar | Conecta primeiro o áudio do computador e depois solicita mute/unmute em ingresso novo. Teste direto confirmou unmute pela leitura do participante; sequência completa ao ingressar ainda precisa ser repetida. |
| Ligar/escolher câmera | Ainda não portado; campos sinalizados e desabilitados na interface nativa. |
| Prévia do anfitrião | Depende do vídeo estar renderizado no layout do Zoom; não é um fluxo independente por participante. |

## Janela única com JW Library

O botão **Abrir JW Library** usa a ativação do aplicativo instalado. **Janela
única** hospeda somente a janela de operação do JW em um painel da nossa
janela; o dashboard fica no outro painel, com divisor ajustável. A janela de
mídia permanece separada com o mesmo HWND. Desativar ou fechar normalmente
restaura pai, estilos e posição da janela de operação.

Isso não insere conteúdo no painel de estudo pessoal nem altera o botão de
diamante do JW. Usa `SetParent`, com verificação de DPI antes da alteração para
evitar reset de escala no processo da projeção. Referência:
[Microsoft SetParent](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setparent).

O operador relatou integração com problemas de tamanho/interação. Foi encontrado
um conflito: o acoplamento antigo podia reduzir a janela completa a 380 px,
abaixo do espaço necessário aos dois painéis. Esse botão foi removido do modo
completo; o workspace agora maximiza e calcula as duas colunas, com mínimos
compatíveis. A descoberta por UIA foi movida para uma tarefa em segundo plano.
Também foi observado que a CoreWindow UWP conservava as dimensões anteriores
após a moldura mudar de tamanho. O host agora sincroniza a superfície de conteúdo
identificada pela UIA com a área cliente da janela de operação, inclusive ao
restaurá-la. Não altera a CoreWindow da projeção.
A correção ainda precisa ser confirmada visualmente pelo operador. Não ativar
esse modo por padrão antes de validar escala, foco, teclado, redimensionamento,
minimização/restauração e a captura da mídia após a mudança.

O tamanho mínimo agora respeita a área de trabalho do monitor, incluindo as
bordas da janela, e recalcula o mínimo da coluna do JW ao redimensionar.
O dashboard quebra o cabeçalho e reduz espaçamentos em colunas de até 400 px.

Após reabrir a sala, foi observado um controlador com script Frida destruído
ainda indicando execução. O worker agora encerra ao perder processo, sessão ou
script, permitindo nova descoberta pelo serviço. A consulta de conexão continua
mesmo sem mídia ou com compartilhamento pausado manualmente. Após instalar e
reabrir, a API confirmou sala ativa, anfitrião local, um participante e ausência
de erro, com PID correspondente ao leitor passivo.

No teste seguinte, o prazo de três segundos do observador UIA encerrava todo
o controlador e provocava alternância entre reunião ativa e novo ingresso.
A recuperação agora reinicia somente o subprocesso do detector, com 30 segundos
para inicialização e 15 segundos entre leituras válidas. Os comandos e consultas
do Zoom continuam funcionando; leituras ausentes não são tratadas como fim de
mídia. O teste real registrou oito amostras durante 35 segundos, todas em
`IN_MEETING`, inclusive durante a falha e reinicialização do detector. Evidência
local: `runtime/data/zoom-native-research/observer-recovery-live-test.json`.
A UIA do JW continuou indisponível nesse ensaio; vídeo, áudio recebido e término
do compartilhamento ainda não foram validados.

Foi integrado um segundo leitor independente, `watch-jw-playback.ps1`, usando
as sessões de mídia do Windows (SMTC). Exige o AUMID exato do JW e reprodução do
tipo Video; Playing e Paused mantêm o contexto. A projeção nativa é aceita
somente quando há uma única ApplicationFrameWindow visível, não minimizada,
não cloaked, desabilitada e topmost, com CoreWindow pertencente ao processo JW.
Esses atributos foram observados na projeção ajustada pelo JwlMediaWin; sem
essa identificação, o fallback recusa compartilhar outra janela.

No primeiro ensaio, o HWND 14025062 foi identificado e compartilhado: 48,1 ms
entre a detecção e o retorno do comando de início; 156,4 ms até a primeira
consulta confirmar a fonte ativa. Os getters do Zoom retornaram otimização=1
e áudio do computador=1. Isso confirma o estado local, sem medir o primeiro
quadro ou o áudio recebido pelo outro participante. Evidência local:
`runtime/data/zoom-native-research/smtc-video-share-live-test.json`.

A fusão preserva UIA para imagens e não interpreta ausência de sessão SMTC
como fim de uma imagem. O fallback SMTC não detecta imagens. Os novos testes
cobrem vídeo com UIA ausente, encerramento, descarte de amostras antigas e
preservação de imagens durante falhas da UIA. São 24 testes Python. O usuário
confirmou imagem e som corretos no receptor; a parada automática também foi
observada. O último ajuste de prioridade do encerramento ainda aguarda reteste.

Ocultar/Ver Zoom controla somente a janela da reunião
(`ConfMultiTabContentWndClass`, com processo verificado). Ao reexibir, restaura
uma reunião minimizada, traz a janela ao monitor do dashboard, limita o tamanho
à área útil e pede foco. A janela principal (`ZPPTMainFrmWndClassEx`) não é
movida por esse controle. O teste real confirmou monitor coincidente, janela
dentro da área útil e geometria/visibilidade da tela inicial preservadas ao
ocultar. Evidência: `runtime/data/zoom-native-research/meeting-window-toggle-test.json`.

Anúncios: o formulário só marca o envio como salvo após receber a resposta e
não reaplica um snapshot antigo nessa transição. Texto digitado durante o
envio e rascunhos após falha são preservados. O teste isolado
`node scripts/test-announcements-ui.mjs` cobre esses três cenários sem enviar
anúncios ao tablet ou alterar o banco real.

## Operação em meia tela (1920×1080)

O dashboard nativo abre na visão compacta: cronômetro e partes à esquerda,
assistência/enquetes abaixo dele; câmera no topo direito, seguida pelos
controles do Zoom e participantes. Anúncios, celular
e ferramentas avançadas ficam em abas, sem desmontar os editores ao alternar.
Programação/WOL fica em um controle expansível do cronômetro.

As divisórias permitem ajustar largura do cronômetro e altura do cronômetro
em relação à assistência. Funcionam por arraste ou setas
do teclado. **Ajustar** altera o tamanho do relógio, restaura proporções e
alterna para a visão completa. As preferências são locais e persistentes.

A divisória abaixo da câmera ajusta a prévia entre 80 e 300 px CSS; clique duplo
restaura 160 px. A altura fica no armazenamento local do WebView. A prévia
continua nativa: o dashboard comunica os limites da região ao host por
WebMessage, com conversão de DPI e validação da origem. É ocultada quando um
modal cobre o painel e acompanha redimensionamento e rolagem. Posição, tamanho
e maximização da janela ficam em `native-window-layout.txt`, com ajuste à área
útil se a configuração dos monitores mudar.

O teste isolado em 960×790 px confirmou ausência de rolagem da página e seis
alternativas de assistência visíveis. A lista das partes tem rolagem interna;
câmera e assistência não mudam de posição quando a programação é reduzida a
duas partes. Foram testados arraste de divisórias, restauração após recarregar
e ocultação da prévia durante modais. A altura da câmera foi alterada e
restaurada em teste real do app Windows, já na nova localização.
Prévia isolada: `runtime/data/zoom-native-research/operator-half-screen.png`.

## Verificação atual

Typecheck, build do dashboard e servidor, e compilação C# x64 passaram. São 26
testes Vitest, 16 testes Node da pesquisa e 19 testes Python. Os novos testes
impedem uma lista passiva em cache ou uma sala diferente de serem apresentadas
como reunião ativa e rejeitam participantes com nomes duplicados.

Durante os testes, o helper de interação voltou a retornar `GetCursorPos:
0x80070005` e capturas pretas, embora a árvore de acessibilidade estivesse
legível. A interação gráfica foi interrompida; testes por API continuaram na
reunião de teste autorizada. O feedback do operador permanece necessário para
concluir a validação da janela única.
