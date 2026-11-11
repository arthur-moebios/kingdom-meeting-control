# Mídias pelo celular → playlist do JW Library

Aparelhos com o papel **Painel** (liberado pelo operador, aparelho por aparelho) ganham no
controle remoto a aba **Mídias**. Nela a pessoa envia fotos, escolhe cânticos pelo número,
ordena, renomeia e toca em **Enviar ao JW Library**. O computador do salão monta um arquivo
`.jwlplaylist` e o abre no JW Library, que pede a confirmação de importação na tela do computador.

- Rotas: `/remote-api/media*` em `apps/server/src/mobileTimers.ts`; todas exigem aparelho pareado
  com o papel Painel, e as de escrita exigem mesma origem.
- Armazenamento: `<dataDir>/media/` (`index.json`, `<id>.jpeg`, `<id>.thumb.jpeg`, `out/*.jwlplaylist`).
- O celular converte qualquer imagem (inclusive HEIC) para JPEG de até 1920 px e gera a miniatura;
  o servidor só aceita JPEG. Limites em `MEDIA_LIMITS` (`mediaPlaylist.ts`).

## Formato `.jwlplaylist`

ZIP com `manifest.json`, `userData.db` (SQLite, esquema 16), as mídias, as miniaturas e
`default_thumbnail.png`. O esquema em `jwPlaylistSchema.ts` foi copiado de uma playlist exportada
pelo JW Library; as tabelas e índices são criados, os dados inseridos e só então os gatilhos.

| Item | Como é gravado |
| --- | --- |
| Playlist | `Tag(Type=2, Name)`; a ordem vem de `TagMap.Position` |
| Imagem | `PlaylistItem(EndAction=2)` + `IndependentMedia` + `PlaylistItemIndependentMediaMap(DurationTicks=40000000)` |
| Cântico | `PlaylistItem(EndAction=1)` + `Location(KeySymbol='sjjm', Track=nº, MepsLanguage=5, Type=3)` + `PlaylistItemLocationMap(MajorMultimediaType=2, BaseDurationTicks=NULL)` |
| Vídeo do JW.org (link) | como o cântico, com a chave do link: `pub-<símbolo>[_<edição>]_<faixa>_VIDEO` → `KeySymbol`, `IssueTagNumber` (AAAAMM00), `Track`; `docid-<id>_<faixa>_VIDEO` → `DocumentId`, `Track`. `BaseDurationTicks` vem do catálogo |
| Miniatura | uma linha em `IndependentMedia`, apontada por `PlaylistItem.ThumbnailFilePath` |

O cântico é só uma referência: o JW Library usa o vídeo do cântico que ele mesmo tem (ou baixa).
`manifest.userDataBackup.hash` é o SHA-256 do `userData.db`.

Título, duração e capa de cânticos e vídeos vêm do catálogo público (`b.jw-cdn.org/apis/mediator`); sem
internet o item entra com o título padrão e a miniatura feita no celular.

Quem tem o papel Painel também vê, em **Mais**, a lista de aparelhos e pode mudar a permissão e o
Painel dos outros (`/remote-api/devices*`); ninguém tira o Painel do próprio aparelho.

Validado importando no JW Library para Windows em 11/11/2026 (imagens com título próprio e
cânticos sem duração). Vídeo por link do JW.org usa o mesmo mecanismo do cântico, mas ainda não foi
conferido no JW Library. Arquivo de vídeo enviado pelo celular não é aceito. A confirmação da importação continua manual.
