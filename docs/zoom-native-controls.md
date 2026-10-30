# Controles do Zoom nativo: protótipo isolado

Estado em 2026-10-28: implementação experimental com análise estática e testes
simulados. A admissão individual foi integrada ao painel nativo e ensaiada na sala
1234567890 após solicitação do operador: chamada aceita, espera de um para zero e
participantes de um para dois. Os demais comandos desta camada permanecem sem
ensaio de efeito na reunião. Sem integração ao painel web oficial.

O REA/Ghidra analisou os binários instalados do Zoom 7.1.9.48550. O catálogo
`scripts/research/zoom-native-controls.json` registra a identidade do binário,
interface, slot, RVA, argumentos e evidência de cada operação. O executor
não usa o SDK público nem ações na interface gráfica.

## Operações preparadas

| Comando | Função | Parâmetro explícito |
|---|---|---|
| `mute-self` | Silenciar o próprio microfone | — |
| `unmute-self` | Caminho de abertura do próprio microfone | — |
| `mute-participant` | Silenciar uma pessoa | `participantId` |
| `ask-unmute-participant` | Caminho nativo de unmute de uma pessoa | `participantId` |
| `mute-all` | Silenciar todos | `allowUnmute`, sem valor padrão |
| `ask-unmute-all` | Caminho nativo de unmute para todos | — |
| `admit-participant` | Admitir uma pessoa da espera | `participantId` |
| `admit-all` | Admitir todos da espera | — |
| `set-allow-unmute` | Permitir/bloquear reabertura do próprio microfone | `allowUnmute` |
| `lower-hand` | Baixar uma mão | `participantId` |
| `lower-all-hands` | Baixar todas as mãos, caminho de reunião normal | — |
| `reclaim-host` | Recuperar anfitrião pelo fluxo da conta | Elegibilidade consultada antes |
| `lock-meeting` | Bloquear novos ingressos | — |
| `unlock-meeting` | Desbloquear novos ingressos | — |
| `can-reclaim-host` | Consultar elegibilidade de recuperação | — |
| `allow-unmute-status` | Consultar permissão de reabrir o microfone | — |
| `microphone-status` | Consultar estado bruto do microfone | Enum ainda não normalizado |

Unmute passa pelas permissões e pelo consentimento implementados pelo
próprio Zoom. Não foi comprovado que abre o microfone remotamente, nem que
o participante sempre recebe um pedido. Por isso, o resultado separa
`acceptedLocally` de `effectConfirmed`; o segundo permanece falso até uma
observação posterior comprovar o efeito. A execução sem erro não basta.

`participantId` é o identificador interno atual da sessão. Não usar nome,
posição na lista ou presumir equivalência ao ID mostrado na interface.
A enumeração normalizada de participantes/espera e a associação desses
identificadores ainda precisam ser concluídas antes de integrar ao painel.

## Execução e isolamento

`scripts/research/zoom-native-controls.py` imprime um plano **sem conectar
ao Zoom por padrão**. Exemplo de simulação:

```powershell
python scripts/research/zoom-native-controls.py mute-all --meeting-id 1234567890 --allow-unmute false
```

Usar um Python real; nesta máquina o `python` global pode ser o alias da
Microsoft Store. Os testes locais usaram o Python 3.12 do runtime do Codex.

Somente `--execute` habilita conexão e chamada nativa no CLI. O controlador do
painel usa a mesma camada após ativação explícita das automações. PID/thread podem ser descobertos automaticamente quando há
uma única reunião; quando informados, ambos são obrigatórios.

Antes de cada despacho, a camada verifica:

- hashes de `zoom_meeting_bridge.dll`, `zVideoUI.dll` e `Cmmlib.dll`;
- sala solicitada, ingresso ativo e conferência pronta;
- papel atual de anfitrião/coanfitrião, conforme o comando;
- getter, interface, vtable e método esperado para a versão analisada;
- IDs inteiros não nulos e booleanos explícitos;
- elegibilidade nativa antes de recuperar anfitrião.

A chamada usa a thread principal e a mesma sinalização `WM_NULL` já
ensaiada no probe. Não seleciona janelas, envia teclas ou clica controles.
O executor desta camada não oferece comandos de compartilhamento ou saída.
Sua conexão é desfeita ao terminar, sem encerrar o Zoom.

## Evidência estática principal

| Caminho | RVA | Evidência REA |
|---|---|---|
| Mute de participante | `0x57e30` | `ev_5762a8826dbfad1e5359eeb466af8008f8220a781340a52143b37055d10b2ee2` |
| Unmute de participante | `0x57e60` | `ev_5e0bc17f0fb099ae749b02a05d9a2afb37d4816977d43c4adf15138422aa02ad` |
| Mute de todos | `0x59710` | `ev_f62f92f23780dd4599d14cb9f1690612f593029c84a35f919d2e2c6e05caae1d` |
| Admitir todos | `0xb39d0` | `ev_d2e5a9498dd401dac492d48840c47f3ff720d57589103fdc3075b2ca15d722eb` |
| Admitir uma pessoa | `0xb3fc0` | `ev_eaf9f286a594df5483ed75986c64c0e65d6928ecdc11d109747ec21f6a29f78e` |
| Permitir unmute | `0x6c630` | `ev_d30cc64ed27683b59f6eba838045231a711a1db4db44ee5a500bc271c6482615` |
| Baixar uma mão | `0xa8510` | `ev_0d0bd95a2ad0b7ce5886dfc6611e1c56879e849716d0cfc7b4f9dc6b7a8a6ae5` |
| Recuperar anfitrião | `0xa8f30` | `ev_1e5f5352fe619387f814c49a937e83bbcc11aa758598492d4a782b46af156832` |

O RTTI estático local é evidência suplementar; não substitui os corpos
analisados pelo REA. As assinaturas recuperadas e os deslocamentos novos
não foram validados em execução. O estado de cada comando é `static-only`.

## Verificações concluídas

- 9 testes JS novos: execução explícita, troca de sala, ingresso incompleto,
  IDs inválidos, escolha de permissão no mute-all, papéis, recuperação
  inelegível, aceite local sem confirmação remota e método nativo divergente.
- 3 testes Python novos: parâmetros e CLI que permanece offline, mesmo com
  PID inválido fornecido.
- 17 métodos e getters conferidos diretamente no PE, sem carregar a DLL,
  com `scripts/research/verify-zoom-native-controls.mjs`.
- Os 9 testes anteriores de ponteiro, prontidão e detecção de mídia também
  passaram. Nenhum teste automatizado se conectou à reunião.

## Trabalho restante

A leitura real de participantes, mãos e enquetes avançou em
[zoom-native-readers.md](zoom-native-readers.md). O leitor novo usa somente
memória passiva; os comandos de controle desta página não foram executados.

Validar estas chamadas numa sala de teste, com pelo menos um receptor,
observando efeitos, recusas e consentimento. Completar a leitura de
participantes, espera e ordem das mãos, incluindo ciclo de vida dos vetores
e strings nativos; não copiar estruturas alocadas sem conhecer o destructor.
Enquetes e seus resultados têm um leitor separado, ainda experimental. Depois disso,
integrar um adaptador nativo opcional ao serviço, preservando o web oficial.
