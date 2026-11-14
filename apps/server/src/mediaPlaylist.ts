import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import type { RemoteMediaState } from "@kmc/shared-types";
import { JW_DEFAULT_THUMBNAIL_PNG, JW_PLAYLIST_INDEXES, JW_PLAYLIST_SCHEMA_VERSION, JW_PLAYLIST_TABLES, JW_PLAYLIST_TRIGGERS } from "./jwPlaylistSchema.js";

/**
 * Mídias enviadas pelo celular e a playlist do JW Library montada com elas.
 * Imagens chegam já em JPEG (o PWA converte e gera a miniatura); cânticos são só
 * uma referência (publicação sjjm + faixa) que o JW Library resolve sozinho.
 * Formato validado importando no JW Library — ver docs/jw-playlist.md.
 */
export const MEDIA_LIMITS = { items: 60, imageBytes: 8_000_000, thumbBytes: 300_000, label: 120, name: 80, songs: 200 } as const;
/** MEPS do português (Brasil), como veio na playlist de referência. */
const MEPS_LANGUAGE = 5;
const IMAGE_TICKS = 40_000_000; // 4 s, o padrão do JW Library para imagem
/** Vídeo do JW.org por referência (como o cântico): o JW Library toca o que ele mesmo tem ou baixa. */
export interface JwVideoRef { lank: string; keySymbol: string | null; documentId: number | null; issue: number; track: number; }
interface StoredItem { id: string; kind: "image" | "song" | "video"; label: string; song?: number; original?: string; video?: JwVideoRef; durationTicks?: number; }
export interface JwMediaInfo { title: string | null; durationTicks: number | null; thumb: Buffer | null; }
/**
 * Reconhece links de vídeo do JW.org (compartilhar → copiar link): `lank=pub-jwb-092_1_VIDEO`,
 * `.../pub-mwbv_202405_1_VIDEO`, `docid-502018518_1_VIDEO`.
 */
export function parseJwVideoLink(value: unknown): JwVideoRef | null {
  if (typeof value !== "string" || value.length > 600) return null;
  const m = /(pub|docid)-([A-Za-z0-9-]+?)(?:_(\d{6}|\d{8}))?_(\d{1,4})_VIDEO/.exec(value);
  if (!m) return null;
  const issue = m[3] ? Number(m[3].length === 6 ? m[3] + "00" : m[3]) : 0, track = Number(m[4]);
  if (m[1] === "docid") return /^\d{4,12}$/.test(m[2]!) && !m[3] ? { lank: m[0], keySymbol: null, documentId: Number(m[2]), issue: 0, track } : null;
  return { lank: m[0], keySymbol: m[2]!, documentId: null, issue, track };
}
/** Título, duração e capa no catálogo público do JW.org. Sem internet devolve tudo nulo e o item segue sem eles. */
export async function lookupJwMedia(lank: string, fetcher: typeof fetch = fetch): Promise<JwMediaInfo> {
  const none = { title: null, durationTicks: null, thumb: null };
  try {
    const response = await fetcher(`https://b.jw-cdn.org/apis/mediator/v1/media-items/T/${encodeURIComponent(lank)}`, { signal: AbortSignal.timeout(6000) });
    if (!response.ok) return none;
    const item = ((await response.json()) as { media?: { title?: unknown; duration?: unknown; images?: Record<string, Record<string, unknown>> }[] }).media?.[0];
    if (!item) return none;
    const images = item.images ?? {}, url = [images.wss?.sm, images.lss?.lg, images.sqr?.md, images.wss?.lg].find((u): u is string => typeof u === "string" && u.startsWith("https://") && /\.jpe?g$/i.test(u));
    let thumb: Buffer | null = null;
    if (url) try {
      const image = await fetcher(url, { signal: AbortSignal.timeout(6000) });
      const bytes = image.ok ? Buffer.from(await image.arrayBuffer()) : null;
      if (bytes && bytes.length <= MEDIA_LIMITS.thumbBytes && bytes[0] === 0xff && bytes[1] === 0xd8) thumb = bytes;
    } catch { /* fica a miniatura do celular */ }
    return { title: text(item.title, MEDIA_LIMITS.label) || null, durationTicks: typeof item.duration === "number" && item.duration > 0 ? Math.round(item.duration * 10_000_000) : null, thumb };
  } catch { return none; }
}
interface Stored { name: string; items: StoredItem[]; lastSentAt: string | null; }
const fail = (message: string) => Object.assign(new Error(message), { statusCode: 400 });
const ID = /^[a-f0-9]{24}$/;

function jpeg(value: unknown, limit: number, what: string): Buffer {
  if (typeof value !== "string" || !value || value.length > limit * 1.4) throw fail(`${what}: arquivo ausente ou grande demais.`);
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > limit || bytes.length < 100 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) throw fail(`${what}: envie uma imagem JPEG.`);
  return bytes;
}
const text = (value: unknown, limit: number) => (typeof value === "string" ? value.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, limit) : "");

let crcTable: Uint32Array | null = null;
function crc32(bytes: Buffer): number {
  if (!crcTable) { crcTable = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; } }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
/** ZIP mínimo (deflate, sem zip64): o suficiente para um .jwlplaylist. */
export function zip(files: { name: string; data: Buffer }[], when = new Date()): Buffer {
  const time = (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1);
  const date = ((when.getFullYear() - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate();
  const parts: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8"), packed = deflateRawSync(file.data), crc = crc32(file.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(file.data.length, 22); local.writeUInt16LE(name.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x0800, 8); entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(time, 12); entry.writeUInt16LE(date, 14); entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(packed.length, 20); entry.writeUInt32LE(file.data.length, 24); entry.writeUInt16LE(name.length, 28); entry.writeUInt32LE(offset, 42);
    parts.push(local, name, packed); central.push(entry, name);
    offset += local.length + name.length + packed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}
/** Lê um ZIP comum (stored/deflate, sem zip64) inteiro em memória; basta para um .jwlplaylist. */
export function unzip(buf: Buffer, maxEntryBytes = 40_000_000): Map<string, Buffer> {
  const bad = () => fail("Este arquivo não parece uma playlist do JW Library (.jwlplaylist).");
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) throw bad();
  const count = buf.readUInt16LE(end + 10), files = new Map<string, Buffer>();
  let at = buf.readUInt32LE(end + 16);
  try {
    for (let n = 0; n < count; n++) {
      if (buf.readUInt32LE(at) !== 0x02014b50) throw bad();
      const method = buf.readUInt16LE(at + 10), packed = buf.readUInt32LE(at + 20), size = buf.readUInt32LE(at + 24);
      const nameLength = buf.readUInt16LE(at + 28), extra = buf.readUInt16LE(at + 30), comment = buf.readUInt16LE(at + 32), offset = buf.readUInt32LE(at + 42);
      const name = buf.toString("utf8", at + 46, at + 46 + nameLength);
      at += 46 + nameLength + extra + comment;
      if (name.endsWith("/") || size > maxEntryBytes) continue;
      const start = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28), raw = buf.subarray(start, start + packed);
      if (method === 0) files.set(name, raw); else if (method === 8) files.set(name, inflateRawSync(raw, { maxOutputLength: maxEntryBytes }));
    }
  } catch (error) { if ((error as { statusCode?: number }).statusCode === 400) throw error; throw bad(); }
  return files;
}
const pad = (n: number) => String(n).padStart(2, "0");
function localStamp(d: Date): string {
  const off = -d.getTimezoneOffset(), sign = off < 0 ? "-" : "+", abs = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`;
}

export interface MediaPlaylistDeps { dir: string; clock?: () => Date; open?: (file: string) => boolean; lookup?: (lank: string) => Promise<JwMediaInfo>; }
export class MediaPlaylist {
  private stored: Stored;
  private readonly clock: () => Date;
  constructor(private readonly deps: MediaPlaylistDeps) {
    this.clock = deps.clock ?? (() => new Date());
    fs.mkdirSync(deps.dir, { recursive: true });
    this.stored = { name: "", items: [], lastSentAt: null };
    try {
      const value = JSON.parse(fs.readFileSync(this.index, "utf8")) as Partial<Stored>;
      if (Array.isArray(value.items)) this.stored = { name: text(value.name, MEDIA_LIMITS.name), lastSentAt: typeof value.lastSentAt === "string" ? value.lastSentAt : null,
        items: value.items.filter(i => i && ID.test(i.id) && (i.kind === "image" ? fs.existsSync(this.filePath(i.id)) : i.kind === "song" ? Number.isInteger(i.song) : i.kind === "video" && !!i.video && parseJwVideoLink(i.video.lank) !== null) && fs.existsSync(this.thumbPath(i.id))).slice(0, MEDIA_LIMITS.items) };
    } catch { /* primeira execução ou índice ilegível: começa vazio */ }
  }
  private get index() { return path.join(this.deps.dir, "index.json"); }
  private filePath(id: string) { return path.join(this.deps.dir, id + ".jpeg"); }
  private thumbPath(id: string) { return path.join(this.deps.dir, id + ".thumb.jpeg"); }
  private save() { const tmp = this.index + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(this.stored)); fs.renameSync(tmp, this.index); }
  private defaultName() { const d = this.clock(); return `Reunião ${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`; }
  private room() { if (this.stored.items.length >= MEDIA_LIMITS.items) throw fail(`Limite de ${MEDIA_LIMITS.items} itens na playlist.`); }
  private newId() { return randomUUID().replace(/-/g, "").slice(0, 24); }

  state(): RemoteMediaState {
    return { name: this.stored.name || this.defaultName(), lastSentAt: this.stored.lastSentAt,
      items: this.stored.items.map(({ id, kind, label, song }) => ({ id, kind, label, ...(song ? { song } : {}) })) };
  }
  thumb(id: string): Buffer | null { return ID.test(id) && this.stored.items.some(i => i.id === id) ? fs.readFileSync(this.thumbPath(id)) : null; }
  addImage(input: { filename?: unknown; label?: unknown; data?: unknown; thumb?: unknown }): RemoteMediaState {
    this.room();
    const data = jpeg(input.data, MEDIA_LIMITS.imageBytes, "Imagem"), thumb = jpeg(input.thumb, MEDIA_LIMITS.thumbBytes, "Miniatura");
    const id = this.newId(), original = text(input.filename, 120) || "imagem.jpeg";
    fs.writeFileSync(this.filePath(id), data); fs.writeFileSync(this.thumbPath(id), thumb);
    const n = this.stored.items.filter(i => i.kind === "image").length + 1;
    this.stored.items.push({ id, kind: "image", label: text(input.label, MEDIA_LIMITS.label) || `Imagem ${n}`, original });
    this.save(); return this.state();
  }
  private lookup(lank: string) { return (this.deps.lookup ?? lookupJwMedia)(lank); }
  async addSong(input: { number?: unknown; label?: unknown; thumb?: unknown }): Promise<RemoteMediaState> {
    this.room();
    const song = input.number;
    if (typeof song !== "number" || !Number.isInteger(song) || song < 1 || song > MEDIA_LIMITS.songs) throw fail("Informe o número do cântico.");
    const fallback = jpeg(input.thumb, MEDIA_LIMITS.thumbBytes, "Miniatura"), id = this.newId();
    // Título e capa vêm do JW.org quando há internet; a referência gravada na playlist não muda.
    const info = await this.lookup(`pub-sjjm_${song}_VIDEO`);
    this.room();
    fs.writeFileSync(this.thumbPath(id), info.thumb ?? fallback);
    this.stored.items.push({ id, kind: "song", song, label: text(input.label, MEDIA_LIMITS.label) || (info.title ? `Cântico ${info.title}` : `Cântico ${song}`) });
    this.save(); return this.state();
  }
  async addVideo(input: { url?: unknown; label?: unknown; thumb?: unknown }): Promise<RemoteMediaState> {
    this.room();
    const video = parseJwVideoLink(input.url);
    if (!video) throw fail("Link não reconhecido. No JW.org ou no JW Library, use Compartilhar no vídeo e cole o link aqui.");
    const fallback = jpeg(input.thumb, MEDIA_LIMITS.thumbBytes, "Miniatura"), id = this.newId(), info = await this.lookup(video.lank);
    this.room();
    fs.writeFileSync(this.thumbPath(id), info.thumb ?? fallback);
    this.stored.items.push({ id, kind: "video", video, label: text(input.label, MEDIA_LIMITS.label) || info.title || "Vídeo do JW.org", ...(info.durationTicks ? { durationTicks: info.durationTicks } : {}) });
    this.save(); return this.state();
  }
  /**
   * Abre uma playlist exportada do JW Library (.jwlplaylist) e ACRESCENTA os itens à playlist atual,
   * na ordem original; depois dá para reordenar, renomear e acrescentar mais coisas como sempre.
   * Imagens JPEG, cânticos e vídeos do JW.org entram; o resto (áudio, vídeo do aparelho, PNG) é contado em `skipped`.
   */
  importPlaylist(input: { data?: unknown; thumb?: unknown }): RemoteMediaState & { added: number; skipped: number; imported: string } {
    if (typeof input.data !== "string" || input.data.length < 100) throw fail("Escolha um arquivo .jwlplaylist.");
    const fallback = jpeg(input.thumb, MEDIA_LIMITS.thumbBytes, "Miniatura");
    const files = unzip(Buffer.from(input.data, "base64")), database = files.get("userData.db");
    if (!database) throw fail("Este arquivo não parece uma playlist do JW Library (.jwlplaylist).");
    const tmp = path.join(this.deps.dir, `import-${process.pid}-${Date.now()}.db`);
    fs.writeFileSync(tmp, database);
    const wasEmpty = this.stored.items.length === 0;
    let added = 0, skipped = 0, imported = "";
    const isJpeg = (b: Buffer | undefined, limit: number): b is Buffer => !!b && b.length > 100 && b.length <= limit && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    const db = new DatabaseSync(tmp);
    try {
      const tag = db.prepare("SELECT Name FROM Tag WHERE Type = 2 ORDER BY TagId LIMIT 1").get() as { Name?: string } | undefined;
      imported = text(tag?.Name, MEDIA_LIMITS.name);
      const rows = db.prepare("SELECT p.PlaylistItemId AS id, p.Label AS label, p.ThumbnailFilePath AS thumb FROM PlaylistItem p LEFT JOIN TagMap m ON m.PlaylistItemId = p.PlaylistItemId LEFT JOIN Tag t ON t.TagId = m.TagId AND t.Type = 2 ORDER BY t.TagId, m.Position, p.PlaylistItemId").all() as { id: number; label: string; thumb: string | null }[];
      const media = db.prepare("SELECT i.FilePath AS file, i.OriginalFilename AS original FROM PlaylistItemIndependentMediaMap m JOIN IndependentMedia i ON i.IndependentMediaId = m.IndependentMediaId WHERE m.PlaylistItemId = ?");
      const place = db.prepare("SELECT l.KeySymbol AS key, l.Track AS track, l.IssueTagNumber AS issue, l.DocumentId AS doc, m.BaseDurationTicks AS ticks FROM PlaylistItemLocationMap m JOIN Location l ON l.LocationId = m.LocationId WHERE m.PlaylistItemId = ?");
      for (const row of rows) {
        if (this.stored.items.length >= MEDIA_LIMITS.items) { skipped++; continue; }
        const label = text(row.label, MEDIA_LIMITS.label) || "Item", thumb = row.thumb ? files.get(row.thumb) : undefined, id = this.newId();
        const picture = media.get(row.id) as { file: string; original: string } | undefined;
        if (picture) {
          const data = files.get(picture.file);
          if (!isJpeg(data, MEDIA_LIMITS.imageBytes)) { skipped++; continue; }
          fs.writeFileSync(this.filePath(id), data); fs.writeFileSync(this.thumbPath(id), isJpeg(thumb, MEDIA_LIMITS.thumbBytes) ? thumb : isJpeg(data, MEDIA_LIMITS.thumbBytes) ? data : fallback);
          this.stored.items.push({ id, kind: "image", label, original: text(picture.original, 120) || "imagem.jpeg" }); added++; continue;
        }
        const where = place.get(row.id) as { key: string | null; track: number | null; issue: number | null; doc: number | null; ticks: number | null } | undefined;
        const lank = !where || !where.track ? null : where.doc ? `docid-${where.doc}_${where.track}_VIDEO` : where.key ? `pub-${where.key}${where.issue ? "_" + where.issue : ""}_${where.track}_VIDEO` : null;
        const video = parseJwVideoLink(lank);
        if (!video) { skipped++; continue; }
        fs.writeFileSync(this.thumbPath(id), isJpeg(thumb, MEDIA_LIMITS.thumbBytes) ? thumb : fallback);
        if (video.keySymbol === "sjjm" && !video.issue) this.stored.items.push({ id, kind: "song", song: video.track, label });
        else this.stored.items.push({ id, kind: "video", video, label, ...(where?.ticks ? { durationTicks: where.ticks } : {}) });
        added++;
      }
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode === 400) throw error;
      throw fail("Não consegui ler esta playlist. Exporte-a de novo pelo JW Library.");
    } finally { db.close(); fs.rmSync(tmp, { force: true }); }
    if (wasEmpty && !this.stored.name && imported) this.stored.name = imported;
    this.save();
    return { ...this.state(), added, skipped, imported };
  }
  update(input: { name?: unknown; order?: unknown; labels?: unknown; remove?: unknown }): RemoteMediaState {
    if (input.name !== undefined) this.stored.name = text(input.name, MEDIA_LIMITS.name);
    if (input.labels && typeof input.labels === "object") for (const [id, label] of Object.entries(input.labels as Record<string, unknown>)) {
      const item = this.stored.items.find(i => i.id === id), value = text(label, MEDIA_LIMITS.label);
      if (item && value) item.label = value;
    }
    if (Array.isArray(input.remove)) for (const id of input.remove) {
      const at = this.stored.items.findIndex(i => i.id === id);
      if (at < 0) continue;
      this.stored.items.splice(at, 1);
      for (const file of [this.filePath(id), this.thumbPath(id)]) fs.rmSync(file, { force: true });
    }
    if (Array.isArray(input.order)) {
      const wanted = input.order.filter((id): id is string => typeof id === "string");
      const rank = (id: string) => { const at = wanted.indexOf(id); return at < 0 ? wanted.length : at; };
      this.stored.items = this.stored.items.map((item, at) => ({ item, at })).sort((a, b) => rank(a.item.id) - rank(b.item.id) || a.at - b.at).map(e => e.item);
    }
    this.save(); return this.state();
  }
  clear(): RemoteMediaState { return this.update({ remove: this.stored.items.map(i => i.id), name: "" }); }

  /** Monta o .jwlplaylist em `<dir>/out` e devolve o caminho. */
  build(): string {
    if (!this.stored.items.length) throw fail("Adicione ao menos um item à playlist.");
    const now = this.clock(), name = this.state().name, out = path.join(this.deps.dir, "out");
    fs.mkdirSync(out, { recursive: true });
    const files: { name: string; data: Buffer }[] = [];
    const dbPath = path.join(out, `build-${process.pid}-${now.getTime()}.db`);
    fs.rmSync(dbPath, { force: true });
    const db = new DatabaseSync(dbPath);
    try {
      for (const sql of [...JW_PLAYLIST_TABLES, ...JW_PLAYLIST_INDEXES]) db.exec(sql);
      db.prepare("INSERT INTO LastModified VALUES (?)").run(now.toISOString().slice(0, 19) + "Z");
      db.prepare("INSERT INTO grdb_migrations VALUES (?)").run("v" + JW_PLAYLIST_SCHEMA_VERSION);
      db.exec("INSERT INTO PlaylistItemAccuracy VALUES (1,'Accurate'),(2,'NeedsUserVerification')");
      db.prepare("INSERT INTO Tag VALUES (1, 2, ?)").run(name);
      const media = db.prepare("INSERT INTO IndependentMedia(OriginalFilename,FilePath,MimeType,Hash) VALUES (?,?,'image/jpeg',?)");
      const addMedia = (data: Buffer, original: string) => {
        const file = randomUUID().toUpperCase() + ".jpeg";
        files.push({ name: file, data });
        return { id: Number(media.run(original, file, createHash("sha256").update(data).digest("hex")).lastInsertRowid), file };
      };
      const item = db.prepare("INSERT INTO PlaylistItem(Label,Accuracy,EndAction,ThumbnailFilePath) VALUES (?,1,?,?)");
      const tag = db.prepare("INSERT INTO TagMap(PlaylistItemId,TagId,Position) VALUES (?,1,?)");
      const location = db.prepare("INSERT INTO Location(DocumentId,Track,IssueTagNumber,KeySymbol,MepsLanguage,Type) VALUES (?,?,?,?,?,3)");
      const toLocation = db.prepare("INSERT INTO PlaylistItemLocationMap(PlaylistItemId,LocationId,MajorMultimediaType,BaseDurationTicks) VALUES (?,?,2,?)");
      const toMedia = db.prepare("INSERT INTO PlaylistItemIndependentMediaMap VALUES (?,?,?)");
      const locations = new Map<string, number>();
      this.stored.items.forEach((entry, position) => {
        const thumb = addMedia(fs.readFileSync(this.thumbPath(entry.id)), randomUUID().toUpperCase());
        // EndAction: 1 = segue (vídeo/cântico), 2 = para na imagem — como o JW Library exporta.
        const id = Number(item.run(entry.label, entry.kind === "image" ? 2 : 1, thumb.file).lastInsertRowid);
        tag.run(id, position);
        if (entry.kind !== "image") {
          const ref: JwVideoRef = entry.video ?? { lank: `pub-sjjm_${entry.song}_VIDEO`, keySymbol: "sjjm", documentId: null, issue: 0, track: entry.song! };
          // O mesmo cântico ou vídeo duas vezes reutiliza a linha de Location.
          if (!locations.has(ref.lank)) locations.set(ref.lank, Number(location.run(ref.documentId, ref.track, ref.issue, ref.keySymbol, MEPS_LANGUAGE).lastInsertRowid));
          toLocation.run(id, locations.get(ref.lank)!, entry.durationTicks ?? null);
        } else toMedia.run(id, addMedia(fs.readFileSync(this.filePath(entry.id)), entry.original || "imagem.jpeg").id, IMAGE_TICKS);
      });
      for (const sql of JW_PLAYLIST_TRIGGERS) db.exec(sql);
      db.exec(`PRAGMA user_version = ${JW_PLAYLIST_SCHEMA_VERSION}`);
    } finally { db.close(); }
    const database = fs.readFileSync(dbPath);
    fs.rmSync(dbPath, { force: true });
    const filename = (name.replace(/[\\/:*?"<>|\s]+/g, "_").replace(/^[_.]+|[_.]+$/g, "") || "KMC") + ".jwlplaylist", stamp = localStamp(now);
    const manifest = { type: 1, creationDate: stamp, userDataBackup: { hash: createHash("sha256").update(database).digest("hex"), lastModifiedDate: stamp,
      schemaVersion: JW_PLAYLIST_SCHEMA_VERSION, deviceName: "KMC", databaseName: "userData.db" }, name: filename, version: 1 };
    files.push({ name: "default_thumbnail.png", data: Buffer.from(JW_DEFAULT_THUMBNAIL_PNG, "base64") },
      { name: "manifest.json", data: Buffer.from(JSON.stringify(manifest)) }, { name: "userData.db", data: database });
    const target = path.join(out, filename), tmp = target + ".tmp";
    fs.writeFileSync(tmp, zip(files, now)); fs.renameSync(tmp, target);
    return target;
  }
  /** Monta a playlist e a abre no programa associado (JW Library), que pede a confirmação de importação. */
  send(): RemoteMediaState & { file: string; opened: boolean } {
    const file = this.build(), opened = (this.deps.open ?? openWithDefaultApp)(file);
    this.stored.lastSentAt = this.clock().toISOString(); this.save();
    return { ...this.state(), file, opened };
  }
}
function openWithDefaultApp(file: string): boolean {
  if (process.platform !== "win32") return false;
  try { spawn("explorer.exe", [file], { detached: true, stdio: "ignore", windowsHide: true }).on("error", () => {}).unref(); return true; }
  catch { return false; }
}
