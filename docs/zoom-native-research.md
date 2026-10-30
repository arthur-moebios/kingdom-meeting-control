# Pesquisa: controle interno do Zoom para Windows

Status em 2026-10-28: **chamadas e estados locais observados; recepção remota e estabilidade ainda não validadas**.
A versão web continua sendo a versão oficial. Não foi alterado o backend,
o painel, a configuração padrão ou o executável em Downloads para esta pesquisa.

O objetivo é compartilhar a janela de mídia do JW Library pelo Zoom nativo,
com áudio e otimização para vídeo, e encerrar o compartilhamento a cada mídia.
O usuário excluiu automação por cliques/UIA e o uso do SDK público do Zoom.
O uso previsto é pessoal; a inclusão do Zoom junto do aplicativo foi autorizada.
Isso não comprova que um executável isolado seja suficiente para empacotar o cliente.

## Evidências e limites

Binários instalados do Zoom 7.1.9.48550, analisados sem modificar seus bytes:

| Componente | SHA-256 | Resultado |
|---|---|---|
| `zVideoUI.dll` | `bd40c94d3eb1118e1c89e0216f6902f86b12eb9babf138ab05c844e98aef7749` | Exporta consultas de estado e `ShareApiBridge::StopShare`. |
| `zToolSuiteIPCHost.dll` | `a551242987e871b54709b6b70645c0e744b118012b3fdac3a2e0ed24a26af0e5` | Contém mensagens de compartilhamento e adaptadores para a interface interna de reunião. |
| `zoom_meeting_bridge.dll` | `417c53cd26dfd8c24d6b9225db18bdc4fc03ec198aa2dac8f61c80322bc5f2b2` | Exporta `GetActiveMeeting` e `GetMeetingByConfInstType`; contém a implementação de `ZMMeetingBridgeShareHelperV2`. |

O REA/Ghidra 12.1.4 produziu as evidências estáticas. O inventário PE/RTTI
feito pelos scripts locais é evidência suplementar, não saída do REA.
Os nomes internos que contêm `SDK` pertencem aos binários instalados;
não foi adicionado SDK público como dependência do projeto.

### Caminho concreto encontrado

Em `zToolSuiteIPCHost.dll`, RVA `0xa2118` carrega a ponte interna e resolve
`InitMeetingBridgeEx`, `GetActiveMeeting` e `GetMeetingByConfInstType`.
Evidência REA: `ev_2011e4147821de676493e069200f87efa2cd8e1b5e9a2833fd1fd0c8753a8b40`.

RVA `0xa2adc` usa `GetMeetingByConfInstType`. RVA `0xa2ba0` obtém a
interface de compartilhamento pelo slot `0x88` da reunião retornada. Sem
uma reunião válida, retorna uma implementação padrão. Os adaptadores de
`CShareToolkit` chamam slots dessa interface, sem passar por controles de tela.
Isso é observado no código; execução, assinaturas e thread ainda precisam ser validadas.
Evidência REA: `ev_8c5ab7bd4ef832e1407f81d76a9107dbb9727db73dbbafe9ca3a78bf233454ac`.

O parser da mensagem `StartAppShare` aceita um campo 1 contendo
`IPCSDK_vector_void`. Esse tipo contém itens repetidos no campo 1, serializados
como sequências de bytes. No despacho do comando de tipo `0x41`, esses itens
são convertidos em valores inteiros de 64 bits antes do encaminhamento.
Ainda não está comprovado em execução que esses valores correspondam aos HWNDs
esperados, nem que o comando esteja disponível no contexto atual.
Evidências REA: `ev_736bc410c01e2be40832f86325de9d3964fe1fb9253b5797209672fee4b9457a`,
`ev_1d19d4787514ddca264a26943d29d44386166456c79ac78173d85b82ee5ddf7e`,
`ev_02abd0f6ac8a4eb4a07650a286eeca98dc1f6d10ea8647c0df656aca534b5668`.

RVA `0x488f0` constrói uma requisição de serviço interno com:

- serviço: `in-conf-share-service`;
- operação: `enable-optimize-for-shared-video-feature`;
- parâmetro JSON: `isEnable`, booleano.

A mensagem protobuf correspondente também usa um booleano no campo 1.
Isso comprova a estrutura encontrada no binário, não um endpoint externo
disponível nem a autorização/negociação necessária para usá-lo.
Evidências REA: `ev_cc3f654035e656d6a4593547cbfe71f61dc17522987e643c0b6a6159379d846c`,
`ev_67772c1c51ce395d91bd9f4fe381ab068558d89f7d1b0cce924bdd4bc070f7d9`.

### Implementações na ponte de reunião

Em `zoom_meeting_bridge.dll`, o RTTI identifica a interface de
`ZMMeetingBridgeShareHelperV2` na vtable RVA `0x195b90`, com ajuste de objeto
de `0x28` bytes. Índices abaixo são contados a partir de zero e valem somente
para o hash registrado. Não somar esse ajuste novamente a um ponteiro de
interface que já foi retornado pela reunião.

| Operação observada | Slot / RVA do método | Evidência |
|---|---|---|
| Início com lista de janelas (candidato para `StartAppShare`) | 3 / `0x3fcc0` | Copia um vetor de elementos de 8 bytes e encaminha `HandleStartShare` com tipo 1. |
| Parada | 35 / `0x42d80` | Implementação com diagnóstico `StopShare`; recebe um segundo argumento de 64 bits cuja semântica completa ainda está pendente. |
| Áudio do computador | 20 / `0x412a0` | Implementação com diagnóstico `EnableShareComputerSoundFeature`; recebe habilitação e seletor de contexto. |
| Otimização para vídeo | 56 / `0x47a50` | Implementação com diagnóstico `EnableOptimizeForSharedVideoFeature`; recebe habilitação e seletor de contexto. |
| Modo do áudio | 59 / `0x480a0` | Implementação com diagnóstico `SetAudioShareMode`; o valor do enum precisa ser recuperado. |

O fluxo `HandleStartShare` (RVA `0x4dc7c`) encaminha para `ShareContent`
(RVA `0x4e5d4`). Para o tipo 1, este último lê os elementos do vetor como
`HWND` e chama `IsWindow` antes de iniciar. Isso estabelece que existe um
caminho por identificador de janela, além dos nomes das mensagens.
Não estabelece que a chamada a partir de uma thread arbitrária seja válida.

A assembly do método de início preserva `RDX` até a cópia do vetor; o
pseudocódigo inicial omitia esse argumento. Não derivar ABI apenas das
assinaturas inferidas pelo decompilador. A cópia local é liberada pelo código
da ponte; qualquer invocação futura precisa respeitar a representação do
vetor e o allocator usado pelo processo.

Evidências REA principais:
`ev_d1789e362d3f059b668e5077ae2d44a1fbb49dc1a005fda1553cb4251bcab5d1`
(assembly do início),
`ev_eb9fdc71e905da5ea2b2de7b29fdcd8ef9799e5475aa19c0b74195950790451d`
(cópia do vetor),
`ev_316d069cc64d7abaa3e6ecd0aa2c5bc67bd5f123034186611cc69678659ec762`
(`ShareContent` e validação de HWND),
`ev_548d45b99a78243e5fe999938184fc174e54b688180b9bbdc1a044d5b65d314c`
(parada),
`ev_627f2c771a8d8e9a78f1ddc7cf7b787459ba69600543e4c0ebe24e4b390f691b`
(áudio do computador),
`ev_4733da77ce276656371831af6fac77e73f9175f0f037689ae6dda2a0b2aa866c`
(otimização).

`GetActiveMeeting` (RVA `0x23390`) retorna zero se a ponte não está
inicializada e, caso contrário, delega ao objeto interno. Não inicializar uma
segunda ponte às cegas para tentar obter uma instância.

### Primeiro ensaio da ponte em execução

O `zoom-bridge-probe.py` anexou ao processo de reunião, conferiu os hashes
dos módulos e chamou `GetActiveMeeting`. O objeto retornado tem getter de
compartilhamento no RVA `0x1be30`. A assembly desse getter mostra que ele usa
um `shared_ptr` no offset `0x29c8` da instância de reunião e retorna diretamente
o ponteiro armazenado. Esse ponteiro **já está ajustado para a interface**:
sua vtable correspondeu ao RVA `0x195b90`. Não somar `0x28` novamente.

Uma consulta subsequente executou na thread principal do Zoom, por um hook
temporário de retorno de `DispatchMessageW`, sem gerar cliques ou teclas.
O hook é removido depois da chamada ou de um timeout de 8 segundos. Uma
proteção impede executar a mesma tarefa novamente durante processamento
reentrante de mensagens.

Com a reunião ainda na prévia de entrada, o resultado foi:
`inMeetingRaw=0`, `shareStatusRaw=0`, `sendingSource=0x0`, `canStartRaw=1`.
Portanto, `CanStartShare` isoladamente não comprova presença na reunião.
O ensaio de início exige `inMeetingRaw=1` e ausência de compartilhamento prévio.
A obtenção da interface foi comprovada nessa etapa; os testes subsequentes
de início/parada estão registrados abaixo.

Os comandos experimentais ficam exclusivamente em `scripts/research/`.
`query` consulta a thread selecionada; `start` recebe um HWND explícito;
`stop`, `audio` e `optimize` são mutações manuais de pesquisa. Nenhum comando
é chamado pelo servidor ou pelo detector oficial. O processo do Zoom não é
encerrado ao descarregar o agente.

### Observação em execução anterior

Um agente Frida de pesquisa conseguiu anexar ao processo do Zoom, consultar
os módulos e chamar `UICommandBridge::IsInMeeting()` na versão identificada.
A chamada retornou `0`. Sua relação com o estado real da reunião não foi
corroborada; não tratar esse resultado como detecção validada.
O agente foi descarregado e a sessão desanexada, sem encerrar o Zoom.
Esse primeiro ensaio não validava início, encerramento ou otimização.

### Ensaio posterior em reunião real

Na reunião de teste autorizada pelo usuário, as chamadas abaixo executaram
na thread principal do processo nativo. Nenhum controle de tela do Zoom foi
acionado, e nenhum SDK público foi usado:

| Ação | Evidência de execução |
|---|---|
| Confirmar entrada | `UserConfirmAVPreview` retornou 1; consulta posterior passou de `inMeetingRaw=0` para 1, mas a prévia permaneceu aberta. Isso não valida o fluxo completo de entrada. |
| Iniciar janela do JW | HWND e PID validados imediatamente antes da chamada; retorno 1; estado de compartilhamento passou de 0 para 2 e surgiu uma fonte de envio não nula. |
| Ativar áudio do computador | Getter `IsShareComputerSoundFeatureOn` passou de 0 para 1. |
| Ativar otimização de vídeo | Getter `IsOptimizeForSharedVideoFeatureOn` passou de 0 para 1. |
| Encerrar compartilhamento | Estado voltou de 2 para 0 e fonte de envio voltou a nulo. |
| Repetir início/parada | Segundo início também retornou 1 e recuperou fonte de envio; áudio/otimização permaneceram configurados. |

As duas chamadas de início levaram 3 ms e 2 ms. As paradas medidas levaram
118 ms e 130 ms. **Esses tempos são das chamadas internas**, não medem a
primeira imagem ou áudio recebido em outro dispositivo e não comprovam
ausência de perda do início de vídeo. Confirmação visual remota e vídeo
com áudio continuam pendentes.

O usuário informou que a imagem não apareceu corretamente no outro dispositivo
e que o aplicativo ficou em “Ingressar”. A inspeção visual confirmou duas
janelas: a reunião e uma prévia que não foi encerrada. Não tratar os retornos
locais como validação de transmissão ou da entrada autônoma.

A confirmação de prévia usa `ZMMeetingBridgeMeetingHelperV2`, interface
vtable RVA `0x197ab8`, método RVA `0x70c30`, slot 17. A instância é obtida
a partir da interface RVA `0x197b50` armazenada no offset `0x2a58` da reunião,
com ajuste adicional de 8 bytes. A chamada foi `(this, null, 0, 0)`.
O método encaminha os dois últimos argumentos a campos identificados nos
literais do código como `audio_on` e `video_on`, ambos desligados no ensaio.
O destino concreto observado está em `zVideoApp.dll`, RVA `0xc11a0`, hash
`013b84868cb1d2d6c1a45359194d7e090bad87cd1e0ef7e46eba9efbf2f3d2c6`.
Evidência estática da ponte:
`ev_7c7d779baf259c53a6710d795b1f2364385a944931b86bad9ef4e426d72e28a8`.

Os getters de verificação de áudio e otimização são os RVAs `0x41090` e
`0x475c0`. A consulta de modo de áudio está no RVA `0x48380`.
Evidências REA: `ev_1eff1722ea034a0978a6a7464c174008384892c753b460bdfcdee0ff2346a1a0`,
`ev_a1b87b2b63cff8090eac5ec40aeb462040d7353c7762df582a9d1c8acc5ecd3c`.

Os resultados completos estão nos arquivos locais `bridge-confirm-preview.json`,
`bridge-start.json`, `bridge-after-start.json`, `bridge-audio.json`,
`bridge-optimize.json`, `bridge-stop.json`, `bridge-after-stop.json`,
`bridge-start-second.json` e `bridge-second-confirmation.json`.
`bridge-runtime-validation-evidence.json` preserva as evidências estáticas
adicionais; os resultados Frida são evidência suplementar de execução.

### Controlador experimental de mídia

`zoom-native-media-watch.py` mantém a sessão Frida aberta e consome os eventos
do mesmo observador UIA usado pela versão web. Ele foi separado do aplicativo
oficial e exige PID/thread explícitos, reunião ativa e versão conhecida.

- Início sem debounce quando há mídia e um HWND identificado.
- Fim com 100 ms de confirmação; erros de leitura não viram eventos de fim.
- Reconfiguração ao trocar imagem/vídeo, mesmo reutilizando o HWND.
- Troca de HWND encerra o compartilhamento anterior antes de iniciar o novo.
- Uma fonte já ativa só pode ser adotada fornecendo explicitamente seu ponteiro.
- Cada ensaio tem duração limitada e descarrega o agente ao terminar.

Sete testes do `MediaPolicy` cobrem início, fim, oscilações curtas, falhas de
leitura, mudança de tipo, janela ambígua e recriação do HWND. Eles não substituem
a validação do ciclo real do JW nem a recepção de vídeo/áudio.

```powershell
# Usar o Python que contém o Frida de pesquisa; não faz parte do runtime oficial.
python scripts/research/zoom-native-media-watch.py --meeting-id <numero> --duration 180 --log runtime/data/zoom-native-research/native-auto-media.jsonl
```

PID e thread são opcionais:
sem ambos, a descoberta lê as janelas do processo instalado do Zoom e recusa
ambiguidade. A identificação final da reunião é conferida por `GetMeetingID`.
`IsConfReady` também é exigido antes das ações de mídia; o marcador
`IsInMeeting` isoladamente não basta.

### Falha na inspeção experimental e correção

Uma inspeção de dados de janela tentou interpretar um valor nulo como ponteiro
de objeto. O dump local do processo registrou `0xc0000005`, leitura de nulo,
em `frida-agent.dll` RVA `0x162d73`, na thread principal. O Zoom reiniciou e
mostrou seu relatório de falha. Nenhum relatório foi enviado pelo agente.
O resumo foi obtido por parsing local do minidump, não pelo REA.

O comando `inspect-preview` e a varredura exploratória de ponteiros foram
removidos. O acesso restante passa por checagem de região legível e limites
antes de ler ponteiros. `try/catch` em JavaScript não protege contra o crash
handler nativo do Zoom interceptar uma violação de acesso antes do Frida.
Um teste de regressão verifica que candidatos nulos, não mapeados, sem
permissão de leitura ou fora dos limites nunca chegam à leitura nativa.

Após a reconexão, a identidade interna confirmou `1234567890`,
`IsConfReady=1` e uma fonte de envio após abertura de uma imagem real.
Isso ainda não comprova recepção no outro dispositivo. O controlador
experimental registrou também um ciclo real de imagem aberta/fechada:
início automático e parada com fonte de envio retornando a nulo.
Na parada automática observada, a chamada levou 223 ms, além do debounce
de fim de 100 ms e do agendamento na thread principal.

A segunda tela com o texto de Mateus 5:3 era o fundo de espera, e não uma
mídia em execução. O detector corretamente permaneceu inativo até abrir
uma imagem pelo visualizador do JW Library. Não adicionar detecção por
brilho ou presença de pixels para confundir esse fundo com mídia ativa.

### Identidade, presença e prévia: verificações adicionais

`GetMeetingID` confirmou o número da sala, e `IsConfReady` retornou 1 após
a reconexão. `ZMMeetingBridgeMeetingHelperV2::GetParticipantsCount` foi
identificado pelo REA no RVA `0x6f920`, slot 37 da interface RVA `0x197b50`.
É uma consulta `(this, int filtro)` que retorna um inteiro. Com filtro 0,
o ensaio retornou **1 participante**. Não há, nessa observação, evidência
de um segundo receptor conectado. Evidência REA:
`ev_4a9c7949c860940e45765d5a4e8d78d84eda26a7862e60a621e5d46b00f40454`.
Resultado local: `bridge-participants-count.json`.

A configuração de prévia foi rastreada em `zUIClient.dll` através de
`CMeetingSettingDataModel::UpdateDisplayPreviewWhenJoinMeeting` (RVA `0x8d640`)
e do callback de alteração (RVA `0x94b40`). O código possui dois caminhos:
o helper da ponte de reunião usa getter/setter nos slots `0x190`/`0x188`,
com tipo 1; a interface global usa `0xc0`/`0xc8`, com valor invertido em relação
à opção de exibir prévia. Evidências REA:
`ev_3782f44508cc7d1d5a2a4f7fb3f5b797606e1a3a73a4e78a400ad367a455e9d4`
e `ev_46ba75715924df57a4fee20bb31ab3ce2c7a426fa14ddb273abc0d851b5eb41e`.

Na primeira tentativa, o getter global retornou falha (0), e nenhum setter
desse caminho foi executado. Os comandos `skip-preview` e `preview-setting`
foram retirados do probe; a solução posterior está descrita abaixo.

### Preferências internas de ingresso

Em `cmmbiz.dll`, as exportações `QueryIDViaKnownStr`,
`QueryBooleanPolicyValueFromMemory` e `UpdateUserSettingAsBoolean` permitem
ler e atualizar a preferência normal do usuário, respeitando o provedor do
cliente. Não exigem SDK público nem automação de cliques.
`AlwaysShowVideoPreviewDialog` correspondeu ao ID 236. A alteração de 1 para
0 foi confirmada por leitura nos processos principal e de reunião. O ciclo
de restaurar 1 e reaplicar 0 também foi confirmado. Backup original em
`preview-native-preference-backup.json`. Evidência estática REA do setter:
`ev_5b6e1c525dc1c605a7379a525ac8a422da06dd9220a4410a27f1f96826ebb34f`.

Para o ensaio de novo ingresso, `TurnOffVideoCameraOnJoin` (191) e
`MuteVoIPWhenJoinMeeting` (206) foram alterados de 0 para 1, com leitura
confirmatória e backup em `entry-native-preferences-backup.json`.
Os arquivos `.reg` da tentativa anterior não são necessários: a escrita
HKCU automática foi recusada pelo Windows. Depois, o operador confirmou a
aplicação manual; a leitura do Registro confirmou DWORD 0 em
`HKCU\Software\Policies\Zoom\Zoom Meetings\Meetings\AlwaysShowVideoPreviewDialog`.
Portanto, a validação final de ingresso tem tanto a preferência interna
quanto essa política aplicadas; não isola qual delas foi decisiva.

O comando `leave-alone` chama `LeaveOrEndMeeting` (RVA `0x667e0`) somente
na sala autorizada 1234567890, sem compartilhamento e com contagem filtrada
e total de usuários iguais a 1. No ensaio, o processo de reunião encerrou
após o despacho. Não extrapolar a semântica do parâmetro para encerrar
reuniões com outros participantes. Evidência REA:
`ev_740c74ec9601e84953ebf48239981c09071077797b714f82f7377a197a31913d`.

O novo ingresso pelo protocolo `zoommtg` foi confirmado no processo 28644:
ID 1234567890, `IsInMeeting=1`, `IsConfReady=1`, 29 participantes e nenhuma
fonte de compartilhamento ativa. A inspeção visual confirmou a reunião
aberta, sem prévia de vídeo/Ingresso, câmera desligada e áudio ainda não
conectado. Apareceram os diálogos de audioconferência e recuperação do
anfitrião, não acionados. Havia reunião real em andamento; os ensaios de
compartilhamento e saída foram suspensos para preservar a sessão.
Resultado: `rejoin-query.json`. Uma tentativa anterior de instrumentar o
processo transitório 12428 recebeu `VirtualAllocEx` acesso negado; não foi
tratada como ingresso validado nem repetida nesse processo.

O ensaio posterior manteve o mesmo processo de reunião por cinco minutos,
sem novo reinício observado, e encerrou sua própria fonte de envio ao terminar.
Isso não é uma validação geral de estabilidade, nem substitui a recepção remota.

## Reprodução da análise estática

Executar a partir da raiz do repositório, com o Zoom instalado:

```powershell
node scripts/research/zoom-native-inventory.mjs --module zoom_meeting_bridge.dll --output runtime/data/zoom-native-research/bridge-inventory.json
node scripts/research/zoom-native-rtti.mjs "$env:APPDATA/Zoom/bin/zoom_meeting_bridge.dll" 'MeetingBridgeShareHelperV2' runtime/data/zoom-native-research/bridge-rtti.json
```

Os scripts só leem os binários. Endereços relatados são RVAs ou endereços
estáticos; não são endereços válidos de execução sob ASLR. O inventário RTTI
identifica tabelas e ponteiros de métodos, sem inferir suas assinaturas.

Evidências completas e resultados locais ficam em
`runtime/data/zoom-native-research/`, ignorado pelo Git. O pacote
`toolsuite-evidence.json` retém 66 registros REA; `toolsuite-analysis.json`
retém o snapshot da sessão. Não distribuir esses arquivos como parte do app.
`bridge-evidence.json` e `bridge-analysis.json` preservam a análise da ponte.

## Próxima validação necessária

Leitura passiva de participantes e enquetes, resultados observados e a
matriz de paridade com o web estão em [zoom-native-readers.md](zoom-native-readers.md).

O trabalho de mute/unmute, admissão, mãos e controles de anfitrião está em
[zoom-native-controls.md](zoom-native-controls.md). A camada contém 17
comandos experimentais com simulação offline por padrão, sem execução na
reunião em andamento. Não confundir essa implementação com recursos já
validados em uso real ou integrados ao painel oficial.

1. Confirmar imagem recebida no outro dispositivo e o ciclo real de abertura/fechamento no JW.
2. Medir primeiro quadro, áudio e parada com um vídeo real; não confundir tempo da chamada com latência remota.
3. Validar ownership, recuperação de falhas e mudanças de instância/versão antes de integrar ao app.
4. Ampliar controle autônomo da reunião sem substituir o modo web oficial nesta fase.

Não há seletor nativo no painel nem mudança do modo oficial nesta etapa.
