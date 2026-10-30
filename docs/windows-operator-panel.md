# Painel Windows experimental: JW Library, Zoom e câmera

Para a versão com as telas completas e instalação por logon, consulte
[a migração de 29/10/2026](windows-native-migration.md). As etapas abaixo
registram também os ensaios do protótipo anterior.

Preferências confirmadas pelo operador: **painel lateral acoplado ao JW
Library** e **câmera do anfitrião atual**, inclusive quando ele está em outro
computador. O modo web permanece oficial.

## Versão preparada

Construir com `scripts/build-windows-launcher.ps1`, após
`npm run build:dashboard`. O resultado fica em
`runtime/windows-preview/KingdomMeetingControl.exe`.
O protótipo usa Python 3 local para a leitura passiva e WebView2 para o painel.
`native-python.txt` registra o caminho local: esta pasta ainda não é um
instalador portátil para outros computadores.

O executável detecta o pacote experimental pela presença de
`native-server.mjs` sem `server.mjs`. Também aceita `--native-research`.
Nesse modo, usa servidor experimental em `127.0.0.1:4318`, sem iniciar Chromium
e sem entrar/sair de reunião. A seção **Automações** permite ativar mídia do JW e
admissão automática para um ID de reunião explícito. O servidor inicia com as
opções desligadas; o operador as ativa pelo próprio painel. As chamadas usam a
interface interna do processo, sem clicar controles do Zoom e sem SDK público.
O controlador acompanha o tempo de vida do servidor. Recepção remota da mídia
permanece um teste separado.

Um pacote oficial com `server.mjs` mantém o modo web padrão. Os recursos de
desktop podem ser habilitados explicitamente com `--desktop-tools` ou
`--dock-jw`; não aparecem automaticamente no modo web oficial.

## Assistência

O dashboard web já calculava a soma de **respostas × valor da alternativa**.
O leitor e o painel nativos agora retornam/exibem `attendanceTotal` com a
mesma regra. Exemplo solicitado: `12 × 1 + 3 × 4 = 24`.
Na enquete real observada: `16 × 1 + 6 × 2 + 1 × 3 + 1 × 4 = 35` pessoas,
em 24 respostas. Alternativas não numéricas não recebem total de assistência.
Contagens inconsistentes também não são apresentadas como assistência válida.

## Controles da janela

- **Acoplar ao JW**: procura a janela de operação do JW Library, excluindo
  a janela de mídia identificada pelo seletor já existente. Acompanha sua
  posição; quando necessário, reduz a janela de operação para reservar o
  espaço lateral. Requer identificação inequívoca das duas janelas. Não
  reposiciona a janela de projeção. Desacoplar ou fechar restaura o tamanho
  que o próprio painel alterou.
- **Ocultar Zoom / Mostrar Zoom**: guarda posição e estilos da janela de
  reunião, retira sua entrada da barra/Alt+Tab e posiciona-a fora da área de
  trabalho virtual. Mantém a janela não minimizada para permitir composição.
  Não silencia, liga câmera, compartilha, encerra ou sai da reunião. Fechar o
  painel restaura a janela. Falha/crash do processo ainda exige recuperação
  manual da posição; não é uma ocultação persistente instalada no Windows.
- **Câmera do anfitrião**: identifica, por leitura de acessibilidade, a área
  de vídeo marcada como anfitrião no Zoom e usa uma miniatura DWM recortada.
  Não clica, fixa participantes ou muda a visualização do Zoom. Não usa o
  SDK do Zoom. Não liga câmeras. Quando o anfitrião não está renderizado na
  visualização atual, a prévia informa indisponibilidade. A fonte depende
  do layout do Zoom, e sua identificação é reavaliada periodicamente; ainda
  não é um fluxo direto de vídeo por participante.

O DWM exige janelas de origem e destino de nível superior. Por isso a prévia
usa uma janela auxiliar pertencente ao painel, posicionada dentro da área
reservada. Referências Microsoft:
[DwmRegisterThumbnail](https://learn.microsoft.com/en-us/windows/win32/api/dwmapi/nf-dwmapi-dwmregisterthumbnail),
[propriedades de recorte](https://learn.microsoft.com/en-us/windows/win32/api/dwmapi/ns-dwmapi-dwm_thumbnail_properties).

## Validação realizada e pendências

Compilação C# x64, build do dashboard e typecheck passaram. Os 21 testes
existentes do projeto passaram. A pesquisa passou em 19 testes Python,
12 testes Node e seis verificações C# de geometria, sem alterar janelas nos
testes simulados. O servidor foi testado com dados fictícios: rejeita
operações de controle, não serve arquivos fora do diretório público,
restringe o Host e sinaliza dados desatualizados.

O aplicativo experimental foi aberto com `--keep-zoom --no-dock`, exibindo
dados reais, 35 de assistência, participantes, mãos e alternativas.
A área do anfitrião foi identificada e a miniatura DWM registrada. **A
imagem não pôde ser confirmada visualmente**: a ferramenta de captura retornou
`IGraphicsCaptureItemInterop.CreateForMonitor ... 0x80070057` e a tentativa
de acoplar pelo próprio painel retornou `GetCursorPos ... 0x80070005`.
A sessão interativa aparenta estar bloqueada ou indisponível. O operador
foi solicitado a desbloqueá-la, e não houve novas tentativas de interação.

Falta validar na sessão desbloqueada: imagem correta e ao vivo, atualização
com Zoom fora da tela, acoplamento ao JW e restauração das duas janelas.
O acoplamento e a ocultação não são declarados como ensaiados com sucesso.
Nenhum comando de mídia, áudio, enquete ou participante foi executado na reunião.

### Validação após desbloqueio — 28/10/2026

A captura visual voltou a funcionar. O painel próprio foi inspecionado na tela,
com leitura ativa de participantes e assistência 35 em 24 respostas. O botão
**Ocultar Zoom** moveu a janela de reunião para fora da área virtual e ela deixou
de aparecer no inventário de janelas acessíveis ao operador. O botão **Mostrar
Zoom** restaurou a mesma janela para os limites anteriores `[0,5,908,823]`.
A leitura do painel permaneceu ativa durante a ocultação.

O JW Library foi aberto sem acionar mídia. O acoplamento posicionou a janela de
operação em `[0,0,520,1724]` e o painel em `[528,0,908,1724]`, preservando a
janela de mídia separada em `[59,66,674,693]`. O teste de restauração do JW foi
interrompido quando a ferramenta detectou entrada do operador; permanece pendente.

A prévia exibiu **Câmera do anfitrião fora da área visível do Zoom**. Portanto,
a imagem do anfitrião e sua atualização com o Zoom oculto continuam sem validação.
O protótipo ainda depende da composição do layout atual e não satisfaz uma
prévia independente desse layout. Nenhum controle da reunião foi acionado nessa etapa.

### Integração das automações — 28/10/2026

O painel anterior era somente leitura e não iniciava os controladores; portanto
não substituía a automação web. O servidor agora possui configuração local por
POST, restrita a origem local, JSON e ID de reunião explícito. O controlador lê
a espera a cada 500 ms, solicita admissão individual e usa o observador UIA
existente para a mídia, com reconciliação e debounce final de 100 ms. Verifica
sala, ingresso e prontidão imediatamente antes dos comandos de mídia. A admissão
também verifica papel e interfaces da versão instalada.

Ensaio real: havia um usuário na espera e um na reunião. `admit-participant` foi
aceito localmente; aproximadamente dois segundos depois a espera passou a zero e
a reunião a dois usuários. O ID pode mudar ao ingressar: essa transição de contagem
é evidência do efeito, mas o painel só emite `admission_confirmed` quando o mesmo
ID é encontrado na lista de participantes. Não confundir aceitação com confirmação.

O pacote atualizado foi compilado e aberto, com as duas automações ativadas para
1234567890. O processo relatou `running`, espera zero e mídia inativa. O operador
foi solicitado a abrir mídia e confirmar a recepção no outro dispositivo; esse
teste ainda está pendente. Typecheck, build e 19 testes Python passaram. Os testes
Node cobrem ativação, parada, separação entre envio local e recepção, origem HTTP
e bloqueio de comandos quando a sala muda. A versão web oficial foi preservada.
