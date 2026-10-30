# Leitura nativa e paridade com o adaptador web

Em 2026-10-28, o leitor passivo recuperou **29 participantes e uma enquete**
da reunião aberta, sem injeção, chamadas remotas, cliques ou escrita no Zoom.
O executável em Downloads e o modo web oficial não foram alterados.
Um painel Windows experimental separado foi implementado; detalhes e limites
de validação em [windows-operator-panel.md](windows-operator-panel.md).

## Leitura disponível

`scripts/research/zoom-native-read.py` produz JSON com:

- participantes: ID interno, nome de exibição, mute, anfitrião, coanfitrião e mão levantada;
- sala de espera separada, segundo o indicador nativo de modo silencioso;
- eventos de entrada/saída e mãos, com ordem por horário de detecção;
- enquetes carregadas: ID, nome, perguntas, alternativas e contagens;
- resultados normalizados por pergunta, com campos desconhecidos nulos;
- carimbo de observação e indicador de leitura incompleta.

O identificador interno do usuário não é o número mostrado na janela do
Zoom. Nomes repetidos permanecem registros separados. O leitor não altera
os estados de mute, vídeo, anfitrião, enquetes ou compartilhamento.

Exemplo de uma leitura, usando um Python real instalado:

```powershell
python scripts/research/zoom-native-read.py --output runtime/data/zoom-native-research/native-read-snapshot.json
```

O PID é descoberto quando existe uma única reunião. `--pid` pode selecionar
uma instância explicitamente. `--watch-seconds 60` acompanha por um período
limitado; `--interval-ms 250` é o intervalo padrão. Não existe monitor
permanente instalado ou iniciado por esta pesquisa.

O ensaio executado durou três segundos, com sete leituras. O roster permaneceu
em 29, sem eventos falsos após a observação inicial. Houve um anfitrião, um
coanfitrião e nenhuma mão levantada. A interface já aberta confirmou a contagem
de 29 e os papéis de anfitrião/coanfitrião, apenas por leitura.
**Mudanças reais de mãos, entrada, saída, mute e espera ainda precisam de teste.**

## Enquete observada

Foi lida a enquete **Contagem de Assistência**, pergunta
“Quantas pessoas estão assistindo de sua casa?”, com 24 respostas:

| Alternativa | Respostas |
|---|---:|
| 1 | 16 |
| 2 | 6 |
| 3 | 1 |
| 4 | 1 |
| 5 | 0 |
| 6 | 0 |

Os resultados ficam em `polls.normalizedResults`, junto com os contadores
brutos em `polls.items`. O total de eleitores elegíveis **não foi identificado**:
`totalParticipants` é nulo e o resultado é marcado como parcial. Não usar a
quantidade de conexões como substituto. Percentuais são calculados a partir
das respostas e indicam essa origem; não alegam reproduzir o arredondamento
visual do Zoom. Apenas a contagem de pergunta de escolha única foi conferida.
Não foi iniciada, encerrada, compartilhada ou respondida nenhuma enquete.

## Mecanismo e evidências

O leitor abre o processo somente com consulta e `PROCESS_VM_READ`.
Usa `ReadProcessMemory`, sem Frida ou chamadas de código no alvo. Limita
vetores, valida hashes/vtables e confere novamente seus ponteiros depois
da leitura. Uma falha não vira roster vazio. No acompanhamento, o último
snapshot é preservado como incompleto e desatualizado.

O ID da reunião ainda não foi decodificado no caminho passivo. A identidade
da sessão usa ponteiros de contexto, não serve como autorização para ações.
O executor de controles continua verificando o ID real pelo caminho nativo
independente antes de qualquer mutação explicitamente solicitada.

REA/Ghidra estabeleceu estes caminhos principais:

| Caminho | Evidência |
|---|---|
| Gerenciador da reunião ativa | `ev_3df7b1a6d8e9484439279cb635fe2199b6be60d9ea43ce7c979c33cfdaffeded` |
| Vetor de usuários em `CmmUserList +0x18/+0x20` | `ev_78f36aab49a9965793ad20c93d846752d651db3704ecb18c4e23f0b049e92b90` |
| ID do usuário em `+0x2d8` | `ev_58c54d2c488ce0d003118cedbfd9fad53664bf507912ca7a51934bc871ecfa4b` |
| Estado da mão em `+0x5ac` | `ev_b849e3b32fa2dfc2b6f3bab9726c510532af121b076d5ca91d30d659628fc1f4` |
| Nome por ID, interface virtual `+0xd0` | `ev_5054acd8ab77a86417fba673d38ade309009378e3dfa3d7c3d750fea1bcc098c` |
| Host/cohost, interfaces virtuais `+0x1d0/+0x1d8` | `ev_23fa105ba1acb8517ec3c63e680e66e0addc915e4acf21b80028fa12bea4259a`, `ev_1280eafffd44417503b07b4c91f695e153f7dd1cc9f157de069d96c9e8e7cd96` |
| Vetor de enquetes em `CmmPollComponent +0x40/+0x48` | `ev_1c029a1fe7f47d27e128d7d977f843893929284f38bf8a2afc556d113d365051` |
| Atualização do modelo pelos resultados protobuf | `ev_95718eb92f618ef079333dd5dd89b856a94d5f0909ac1b070291493515678c8b` |
| Atualização das contagens de pergunta e alternativas | `ev_cad60ae259dc9e720ca54526ad4bb4caf666faf635e9a1cf0f87dec9617d2593` |

Capstone 5.0.3 e o inventário PE/RTTI complementaram a análise estática,
incluindo getters simples e a representação de `Cmm::CStringT<wchar_t>`.
São evidências suplementares, distintas do REA. A DLL nunca é carregada
pelos scripts de disassembly. Dependências de pesquisa ficam em runtime,
fora da distribuição do app.

Hashes adicionais fixados pelo leitor:

| DLL | SHA-256 |
|---|---|
| zVideoAppPlugin.dll | `67939de0ae3508071956204fc62b670bd51bd8b93c0d294b8f92ba4c0929e48f` |
| zWebService.dll | `c49409475e4a745ae10cd058fb66e19c2426105f479f0335149a0ba267c6ea45` |

Os pacotes `bridge-readers-evidence.json`, `video-users-evidence.json`,
`poll-component-evidence.json` e `poll-model-evidence.json` ficam em
`runtime/data/zoom-native-research`, ignorado pelo Git. Os snapshots contêm
dados pessoais da reunião e permanecem locais; não entram no app distribuído.

## Paridade: o que está pronto e o que ainda falta

| Recurso atual do web | Estado no nativo |
|---|---|
| Entrar e consultar reunião pronta | Ensaio anterior confirmado; preferência de prévia tratada |
| Login | Continua manual; autenticação completa não automatizada |
| Lista de participantes | Leitura passiva real disponível |
| Mute, host e cohost no roster | Leitura real disponível; transições pendentes de teste |
| Mãos e ordem | Estado lido; ordem por detecção implementada e testada com simulação |
| Espera | Indicador separado pelo leitor; cenário com espera real pendente |
| Admitir, mute/unmute e permitir reabertura | Executor experimental anterior; teste real adiado |
| Recuperar anfitrião e baixar mãos | Executor experimental anterior; teste real adiado |
| Enquetes e resultados | Leitura passiva real disponível; elegibilidade e tipos adicionais pendentes |
| Lançar/reiniciar enquete | Caminho interno localizado; ainda sem comando executável validado |
| Ligar/desligar câmera e escolher dispositivo | Ainda falta implementar e validar no adaptador nativo |
| Compartilhar mídia e otimização | Pesquisa anterior isolada; nenhum teste nesta reunião |
| Sair | Ensaio anterior restrito a sala com um único usuário; não generalizado |
| Diagnóstico | Snapshots passivos, hashes, contexto e contadores disponíveis |
| Integração e automações do painel | Continua web; leitor nativo ainda é ferramenta de pesquisa |

Há agora um painel nativo experimental **somente leitura** com lista, mãos,
enquetes e assistência ponderada, além de ferramentas de janela. As automações
que alteram a reunião continuam fora desse painel até a validação combinada.

Portanto, **a paridade completa ainda não foi concluída**. A leitura já
funciona sobre o cliente real; os controles que alteram a reunião aguardam
a sessão de teste combinada, e as lacunas acima não são marcadas como suporte.
