# Cloudflare e controlador mobile instalável

## Uso

1. Abra **Configurações → Cloudflare · Link fixo do celular**.
2. Clique em **Autorizar Cloudflare** e conclua a autorização no navegador. A
   conta precisa ter o domínio cadastrado e ativo na Cloudflare.
3. Digite um subdomínio HTTPS disponível, por exemplo
   `https://cronometro.seudominio.com`, e clique em **Criar e ativar link fixo**.
   O app cria um túnel e um registro DNS, sem sobrescrever registros existentes.
4. No dashboard, aba **Celular**, escaneie o QR ou abra o link fixo. No celular,
   informe o nome de quem está utilizando e toque em **Conectar este aparelho**,
   sem código. O nome é obrigatório e identifica o acesso no painel.
5. Android: use **Instalar no celular** quando disponível ou o menu do navegador.
   iPhone: **Compartilhar → Adicionar à Tela de Início**.

O link permanece igual ao reiniciar o app ou trocar o IP da conexão. O
computador precisa estar ligado, com o app aberto e internet disponível. O
conector inicia com o app quando configurado e é encerrado no fechamento normal.
O início com Windows utiliza a tarefa já existente do aplicativo.

Na aba Celular, a lista identifica cada aparelho por nome e data da conexão.
**Revogar acesso** desconecta só o aparelho escolhido; **Revogar todos** encerra
todas as sessões. O navegador guarda uma sessão HttpOnly por até 180 dias;
limpar cookies exige tocar novamente em **Conectar este aparelho**. Quem possui
o link pode conectar e também reconectar após uma revogação; não há aprovação ou
código de entrada. A revogação encerra o acesso atual e não bloqueia o aparelho
permanentemente. Sessões criadas pela versão anterior continuam válidas.

## Implementação

### Sala B e programações importadas

O seletor superior do PWA alterna entre **Salão principal** e **Sala B** usando
o mesmo pareamento. Todos os celulares pareados podem selecionar as duas salas.
A Sala B mantém cronômetros próprios, persistidos em `meeting.room-b`, e aceita
somente partes de **Faça Seu Melhor no Ministério**. Não aparece no dashboard,
no tablet ou no snapshot/eventos da reunião principal. Iniciar, pausar, zerar e
encerrar a Sala B não altera os tempos principais.

Em **Programação e nomes**, importe a exportação PDF de meio ou fim de semana
(até 8 MB e 20 páginas, com texto e sem senha). Todas as datas e nomes são
preparados de uma vez e guardados em uma biblioteca de até 120 datas. O PWA
carrega a programação de hoje ou a próxima data disponível automaticamente;
se o arquivo terminou, mantém a última disponível. Não há seletor de data ou
etapa de confirmação: o PDF inteiro é preparado automaticamente.
Na mudança do dia, a programação avança quando o controlador é acessado e não
há cronômetro em execução.
Quando o operador carrega uma semana do WOL, essa semana é a referência das
duas salas: o PWA mantém os cronômetros principais e associa os nomes do PDF
daquela semana. A Sala B usa somente designações da mesma semana, sem avançar
sozinha para uma semana diferente. Ambos os cabeçalhos mostram semana e data
da reunião. Se a semana principal mudar durante um cronômetro da Sala B, ele
é preservado e o PWA indica a diferença até que seja pausado.
Importar durante um cronômetro em execução preserva a medição até ele parar.

Sala B usa somente designações explícitas de Faça Seu Melhor no Ministério,
sem a leitura da Bíblia. Itens sem tempo explícito no PDF de meio de semana
não viram cronômetros; o fim de semana usa 30 e 60 minutos sugeridos quando o
arquivo não fornece duração. Visitas com dois discursos preservam os dois temas.
A opção de copiar o ministério da reunião principal continua disponível.
Os nomes do salão principal aparecem no PWA e no painel Windows. A Sala B e
seus nomes continuam exclusivos do PWA; o tablet mantém sua interface atual.
No fim de semana, a associação ao WOL usa a função das duas partes (discurso
e estudo), porque os títulos do discurso importado e do WOL são diferentes.
Importações e ajustes de nomes são persistidos no SQLite do computador por sala
e data. Ajustes atualizam também a programação importada, para sobreviver à
recriação dos IDs dos cronômetros. Reimportar a data atual atualiza os nomes sem
zerar uma medição em execução. O formulário recebe nomes que chegam depois das
partes e preserva edições durante atualizações ao vivo. Se a programação mudou
enquanto o formulário estava aberto, o backend recusa um salvamento com IDs antigos.
O extrator `pypdf` é incluído no pacote Windows; o PDF original não é guardado.

**Compartilhar imagem** abre diretamente o compartilhamento nativo de um PNG,
sem tela de resumo, texto, opções específicas de mensageiros ou escolha de nomes.
A imagem segue o modelo da programação: fundo branco, cabeçalho com data e sala,
faixas de seção, temas/durações à esquerda e nomes disponíveis à direita. O tempo
realizado aparece abaixo da parte. A numeração original é preservada.
O arquivo fica pronto em segundo plano para manter o gesto do usuário exigido
pelo compartilhamento nativo. Onde compartilhar arquivos não é suportado, o
mesmo botão baixa o PNG. Compartilhar não altera os cronômetros.

- `cloudflared.exe` Windows x64 2026.10.6 incluído no pacote. Download oficial e
  SHA-256 `d521b3bf68982165f0d06d76732f22d9a105ef057ff3ae4c0986f3a23190950f`.
  `scripts/ensure-cloudflared.ps1` confere o binário e inclui sua licença.
- Autorização pelo fluxo oficial `cloudflared tunnel login`. O certificado fica
  em `%USERPROFILE%\.cloudflared\cert.pem`; o app não recebe a senha da conta.
- Configuração e credenciais específicas em `data-native/cloudflare/` no pacote
  nativo (`dataDir/cloudflare/` em outros ambientes). Não entram no Git ou no
  snapshot enviado aos dashboards. Não compartilhe esses arquivos.
- Túnel local gerenciado pelo app, com hostname exato e fallback HTTP 404.
  Origem fixa `http://127.0.0.1:4320`; métricas/readiness em `127.0.0.1:4321`.
  Nenhuma porta de entrada do Windows é aberta por essa integração.
- O gateway público serve somente a página mobile, arquivos da PWA e
  `/remote-api/`. Dashboard, tablet, `/ws`, configurações e comandos do Zoom são
  recusados. O cliente recebe os cronômetros da sala selecionada, nomes opcionais,
  biblioteca de programações, limite de aviso e hora do servidor. Os comandos
  incluem importar/carregar programações e editar os nomes exclusivos do PWA.
- Entrada explícita sem código, com limite de criação de sessões por origem e
  até 64 aparelhos. A sessão é aleatória de 32 bytes; apenas seu hash é persistido em SQLite. Cookies
  são HttpOnly/SameSite Strict e Secure no hostname público HTTPS. Escritas e
  WebSocket verificam a origem. A revogação invalida REST e WebSocket.
- O manifest tem ícones PNG 192/512, modo standalone e URL inicial fixa. O
  service worker guarda somente a interface e arquivos estáticos. API, estado e
  comandos nunca são cacheados, enfileirados ou repetidos ao reconectar.
  Sem conexão, os comandos ficam desabilitados. O relógio considera o horário do
  servidor para reduzir diferenças do relógio do celular.

## Validação

Em 30/10/2026: compilação do dashboard e servidor e typecheck passaram. São 46
testes Vitest, incluindo isolamento do gateway, acesso sem código, expiração,
revogação individual e geral, preservação das sessões anteriores, origem e limite de conexões. O binário oficial validou o YAML de
ingress e a rota para o gateway local, sem criar recursos externos.

`node --import tsx scripts/test-mobile-pwa.ts` usa um gateway e uma reunião de
teste isolados. Validou pareamento, sessão HttpOnly, comando real na API de
teste, atualização por WebSocket, manifest, service worker, abertura offline,
bloqueio de comandos, reconexão e revogação. Também validou alternância de salas
com uma sessão, isolamento dos tempos, importação de todas as datas, avanço
automático sem interromper timers e compartilhamento direto do PNG identificado
como Sala B, com nomes automáticos. O teste usa um substituto da API de
compartilhamento, verifica o gesto ativo e não envia arquivos a aplicativos reais.
Não modifica a reunião real.

`node --import tsx scripts/test-mobile-names-persistence.ts` usa SQLite real em
arquivo temporário, reinicia duas vezes os serviços e verifica nomes editados,
dirigente, ajudante e restauração com novos IDs. O teste mobile também reproduz
nomes chegando atrasados, preservação da edição e reabertura após salvar.

A instalação em execução confirmou o conector incluído e gateway disponível,
página mobile HTTP 200 e configurações recusadas com HTTP 404. A interface de
configuração também foi verificada. Autorização de conta, criação de DNS e
conexão externa foram confirmadas depois em `cronometro.exemplo.com`. O CLI
confirmou que o hostname já está associado ao túnel criado pelo app. A página
pública e o manifest responderam HTTP 200; configurações administrativas foram
recusadas com 404 e estado sem pareamento com 401. Instalação física em
Android/iPhone permanece pendente.

O primeiro acesso reportou 502 quatro segundos após iniciar o conector. Na
investigação posterior, origem e acesso público já respondiam normalmente. O
status agora só mostra **Conectado · Link público verificado** quando o endereço
HTTPS responde 200 com o identificador da instância atual do app. A confirmação
é repetida a cada minuto; durante a publicação, a cada cinco segundos. O link
e o QR público aguardam essa confirmação.

## Referências

- [Cloudflare: criar túnel local](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/create-local-tunnel/)
- [Cloudflare: configuração de ingress](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/configuration-file/)
- [MDN: requisitos de instalação de PWA](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable)
