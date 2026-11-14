# Formato `.jwpub` (publicações do JW Library)

Analisado em 14/11/2026 com a Sentinela de estudo de novembro/2026 (`w_T_202611.jwpub`, 3,7 MB).
Tudo abaixo foi observado nesse arquivo; o que não foi verificado está marcado.

## Como obter

API pública de links (sem login):

```
https://b.jw-cdn.org/apis/pub-media/GETPUBMEDIALINKS?output=json&pub=w&issue=202611&fileformat=JWPUB&langwritten=T
```

`files.T.JWPUB[0].file.url` aponta para o `.jwpub` e traz `checksum` (MD5) e `filesize`.
`pub=w` é a Sentinela de estudo (`issue=AAAAMM`); `mwb` é a apostila de reunião (`issue` bimestral). O mesmo
host já é usado em `mediaPlaylist.ts` (`mediator/v1/media-items`) para título e capa dos vídeos.

## Estrutura (duas camadas de ZIP)

```
w_T_202611.jwpub (ZIP)
├─ manifest.json      metadados: símbolo, ano, idioma MEPS (5 = pt-BR), schemaVersion 9, hash
└─ contents (ZIP)
   ├─ w_T_202611.db   SQLite com a publicação
   └─ *.jpg           imagens (capa, quadradas "sqr", de artigo "cnt_N", miniaturas)
```

## Banco SQLite (o que importa)

| Tabela | Uso |
| --- | --- |
| `Publication` | título, símbolo (`w26`), ano, `IssueTagNumber` (20261100), idioma |
| `Document` | um por artigo. `Class 40` = artigo de estudo; `ContextTitle` = **semana** ("4-10 DE JANEIRO DE 2027"); `Title` = título; `MepsDocumentId` |
| `Multimedia` | cada mídia: `MajorType 1` imagem (`FilePath` = nome do .jpg no ZIP interno), `MajorType 2` vídeo/áudio referenciado (`KeySymbol`, `Track`) |
| `DocumentMultimedia` | liga documento → mídia, com `BeginParagraphOrdinal` (posição no texto) |
| `DocumentMetadata` | `WEB:OnSiteAdDescription` repete a semana por extenso |
| `Hyperlink` / `Extract` | links internos e trechos de outras publicações (não usados aqui) |

Exemplo do estudo de 4-10/jan/2027 (`DocumentId 2`), em ordem de parágrafo:

1. `sjjm` faixa **36** (parágrafo 2) — cântico de abertura
2. `2026642_univ_cnt_1.jpg` (parágrafo 11), `..._cnt_2.jpg` (parágrafo 17) — imagens do artigo
3. `sjjm` faixa **159** (parágrafo 37) — cântico final

Os cânticos são exatamente a referência que o `.jwlplaylist` já usa: `KeySymbol='sjjm'`, `Track=nº`.
As imagens (`univ_cnt_N`) são JPEG, o formato que a aba Mídias aceita. `univ_sqr`/`T_cvr` são capas (não entram).

## Conteúdo do artigo

`Document.Content` é um BLOB cifrado (AES + deflate; chave derivada do idioma, símbolo e ano da publicação).
Não é necessário para extrair mídia, e **não foi decifrado** nesta análise. Títulos, semana, imagens e cânticos
estão em claro nas tabelas acima.

## Consequências para o KMC

- **Dá para extrair tudo o que o sábado precisa**: semana, título, cântico de abertura, imagens do artigo e cântico final.
- **Reaproveita o que existe**: `unzip` e `DatabaseSync` já estão em `mediaPlaylist.ts`; imagens JPEG e cânticos entram direto
  em `MediaPlaylist` (`addImage`, `addSong`).
- **Criar um `.jwpub` novo não é recomendado**: o formato é proprietário (conteúdo cifrado, hashes no manifest, MEPS), não há
  garantia de que o JW Library aceite um arquivo montado por nós, e não foi testado. O `.jwlplaylist` é o formato de
  importação que já funciona e já está validado.
