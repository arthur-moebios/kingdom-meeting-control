import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { MediaPlaylist, lookupJwMedia, parseJwVideoLink, zip, type JwMediaInfo } from './mediaPlaylist.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const offline = async (): Promise<JwMediaInfo> => ({ title: null, durationTicks: null, thumb: null });
function library(open?: (file: string) => boolean, lookup: (lank: string) => Promise<JwMediaInfo> = offline) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kmc-media-')); dirs.push(dir);
  return { dir, media: new MediaPlaylist({ dir, clock: () => new Date('2026-11-14T18:00:00'), open, lookup }) };
}
// JPEG fictício: só o cabeçalho importa para a validação; o JW Library recebe o que o celular gerou.
const jpeg = (seed: string) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, seed)]).toString('base64');
function unzip(bytes: Buffer): Map<string, Buffer> {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])), files = new Map<string, Buffer>();
  let at = bytes.readUInt32LE(end + 16);
  for (let n = bytes.readUInt16LE(end + 10); n > 0; n--) {
    const packed = bytes.readUInt32LE(at + 20), nameLen = bytes.readUInt16LE(at + 28), local = bytes.readUInt32LE(at + 42);
    const name = bytes.subarray(at + 46, at + 46 + nameLen).toString('utf8');
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    files.set(name, inflateRawSync(bytes.subarray(start, start + packed)));
    at += 46 + nameLen + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
  }
  return files;
}

it('zip round-trips its entries', () => {
  const files = unzip(zip([{ name: 'a.txt', data: Buffer.from('olá') }, { name: 'b.bin', data: Buffer.alloc(5000, 7) }]));
  expect(files.get('a.txt')!.toString()).toBe('olá'); expect(files.get('b.bin')!.length).toBe(5000);
});

it('builds a JW Library playlist with images and songs in the chosen order', async () => {
  const { dir, media } = library();
  media.addImage({ filename: 'foto.heic', data: jpeg('a'), thumb: jpeg('b') });
  await media.addSong({ number: 151, thumb: jpeg('c') });
  media.addImage({ filename: 'outra.png', label: 'Mapa do território', data: jpeg('d'), thumb: jpeg('e') });
  await media.addSong({ number: 151, thumb: jpeg('f') });
  const ids = media.state().items.map(i => i.id);
  media.update({ name: 'Discurso 14/11', order: [ids[1]!, ids[0]!], labels: { [ids[0]!]: 'Abertura' } });
  expect(media.state().items.map(i => i.label)).toEqual(['Cântico 151', 'Abertura', 'Mapa do território', 'Cântico 151']);

  const file = media.build();
  expect(path.basename(file)).toBe('Discurso_14_11.jwlplaylist');
  const files = unzip(fs.readFileSync(file)), manifest = JSON.parse(files.get('manifest.json')!.toString());
  expect(manifest).toMatchObject({ type: 1, version: 1, name: 'Discurso_14_11.jwlplaylist', userDataBackup: { schemaVersion: 16, databaseName: 'userData.db' } });
  expect(manifest.userDataBackup.hash).toBe(createHash('sha256').update(files.get('userData.db')!).digest('hex'));
  expect(files.has('default_thumbnail.png')).toBe(true);

  const dbFile = path.join(dir, 'check.db'); fs.writeFileSync(dbFile, files.get('userData.db')!);
  const db = new DatabaseSync(dbFile);
  try {
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(16);
    expect((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check).toBe('ok');
    expect(db.prepare('SELECT Type, Name FROM Tag').all()).toEqual([{ Type: 2, Name: 'Discurso 14/11' }]);
    const rows = db.prepare(`SELECT p.Label, p.EndAction, p.ThumbnailFilePath thumb, l.KeySymbol, l.Track, lm.MajorMultimediaType kind, lm.BaseDurationTicks base, m.FilePath, m.OriginalFilename, m.Hash, im.DurationTicks
      FROM TagMap t JOIN PlaylistItem p USING(PlaylistItemId) LEFT JOIN PlaylistItemLocationMap lm USING(PlaylistItemId) LEFT JOIN Location l ON l.LocationId = lm.LocationId
      LEFT JOIN PlaylistItemIndependentMediaMap im USING(PlaylistItemId) LEFT JOIN IndependentMedia m USING(IndependentMediaId) ORDER BY t.Position`).all() as Record<string, string | number | null>[];
    expect(rows.map(r => [r.Label, r.EndAction, r.KeySymbol, r.Track, r.kind, r.base, r.OriginalFilename, r.DurationTicks])).toEqual([
      ['Cântico 151', 1, 'sjjm', 151, 2, null, null, null], ['Abertura', 2, null, null, null, null, 'foto.heic', 40000000],
      ['Mapa do território', 2, null, null, null, null, 'outra.png', 40000000], ['Cântico 151', 1, 'sjjm', 151, 2, null, null, null]]);
    expect((db.prepare('SELECT count(*) n FROM Location').get() as { n: number }).n).toBe(1);
    // Toda mídia e toda miniatura referenciada existe no pacote, com o hash do próprio arquivo.
    for (const row of rows) expect(files.has(String(row.thumb))).toBe(true);
    for (const row of db.prepare('SELECT FilePath, Hash FROM IndependentMedia').all() as { FilePath: string; Hash: string }[])
      expect(createHash('sha256').update(files.get(row.FilePath)!).digest('hex')).toBe(row.Hash);
    expect(files.size).toBe(3 + 6);
  } finally { db.close(); }
});

it('rejects what is not a JPEG, invalid songs and an empty playlist', async () => {
  const { media } = library();
  expect(() => media.addImage({ data: Buffer.alloc(300, 1).toString('base64'), thumb: jpeg('a') })).toThrow(/JPEG/);
  await expect(media.addSong({ number: 0, thumb: jpeg('a') })).rejects.toThrow(/cântico/);
  await expect(media.addSong({ number: '12', thumb: jpeg('a') })).rejects.toThrow(/cântico/);
  await expect(media.addVideo({ url: 'https://exemplo.test/video.mp4', thumb: jpeg('a') })).rejects.toThrow(/Link não reconhecido/);
  expect(() => media.build()).toThrow(/ao menos um item/);
  expect(media.state()).toMatchObject({ name: 'Reunião 14/11/2026', items: [] });
});

it('persists across restarts, removes files with the item and opens the playlist when sent', async () => {
  const opened: string[] = [], { dir, media } = library(file => { opened.push(file); return true; });
  media.addImage({ data: jpeg('a'), thumb: jpeg('b') }); await media.addSong({ number: 3, thumb: jpeg('c') });
  const again = new MediaPlaylist({ dir, lookup: offline, open: file => { opened.push(file); return true; } });
  expect(again.state().items.map(i => i.label)).toEqual(['Imagem 1', 'Cântico 3']);
  const [image] = again.state().items;
  expect(again.thumb(image!.id)).not.toBeNull(); expect(again.thumb('../index.json')).toBeNull();
  const sent = again.send();
  expect(sent.opened).toBe(true); expect(opened).toEqual([sent.file]); expect(sent.lastSentAt).not.toBeNull();
  again.update({ remove: [image!.id] });
  expect(fs.readdirSync(dir).filter(f => f.startsWith(image!.id))).toEqual([]);
  expect(again.clear().items).toEqual([]);
});

it('recognises JW.org video links and nothing else', () => {
  expect(parseJwVideoLink('https://www.jw.org/finder?srcid=share&wtlocale=T&lank=pub-jwb-092_1_VIDEO')).toEqual({ lank: 'pub-jwb-092_1_VIDEO', keySymbol: 'jwb-092', documentId: null, issue: 0, track: 1 });
  expect(parseJwVideoLink('https://www.jw.org/pt/biblioteca/videos/#pt/mediaitems/VODMinistryTools/pub-mwbv_202405_3_VIDEO')).toMatchObject({ keySymbol: 'mwbv', issue: 20240500, track: 3 });
  expect(parseJwVideoLink('https://www.jw.org/finder?lank=docid-502018518_1_VIDEO&wtlocale=T')).toEqual({ lank: 'docid-502018518_1_VIDEO', keySymbol: null, documentId: 502018518, issue: 0, track: 1 });
  for (const bad of ['https://youtu.be/abc', 'pub-sjjm_151_AUDIO', '', null, 'docid-abc_1_VIDEO']) expect(parseJwVideoLink(bad)).toBeNull();
});

it('adds a JW.org video by reference, with title, duration and cover from the catalogue', async () => {
  const cover = Buffer.from(jpeg('z'), 'base64');
  const { dir, media } = library(undefined, async lank => ({ title: `Título de ${lank}`, durationTicks: 1_234_000_000, thumb: cover }));
  await media.addVideo({ url: 'https://www.jw.org/finder?lank=pub-jwb-092_1_VIDEO', thumb: jpeg('a') });
  await media.addVideo({ url: 'lank=docid-502018518_2_VIDEO', label: 'Vídeo da parte', thumb: jpeg('a') });
  await media.addSong({ number: 151, thumb: jpeg('a') });
  expect(media.state().items.map(i => [i.kind, i.label])).toEqual([['video', 'Título de pub-jwb-092_1_VIDEO'], ['video', 'Vídeo da parte'], ['song', 'Cântico Título de pub-sjjm_151_VIDEO']]);
  expect(media.thumb(media.state().items[0]!.id)!.equals(cover)).toBe(true);
  const files = unzip(fs.readFileSync(media.build())), dbFile = path.join(dir, 'check.db'); fs.writeFileSync(dbFile, files.get('userData.db')!);
  const db = new DatabaseSync(dbFile);
  try {
    expect(db.prepare('SELECT l.DocumentId d, l.KeySymbol k, l.Track t, l.IssueTagNumber i, l.Type ty, m.BaseDurationTicks base, p.EndAction e FROM PlaylistItemLocationMap m JOIN Location l ON l.LocationId = m.LocationId JOIN PlaylistItem p ON p.PlaylistItemId = m.PlaylistItemId ORDER BY m.PlaylistItemId').all()).toEqual([
      { d: null, k: 'jwb-092', t: 1, i: 0, ty: 3, base: 1_234_000_000, e: 1 }, { d: 502018518, k: null, t: 2, i: 0, ty: 3, base: 1_234_000_000, e: 1 },
      // O cântico continua exatamente como foi validado no JW Library: sem duração.
      { d: null, k: 'sjjm', t: 151, i: 0, ty: 3, base: null, e: 1 }]);
  } finally { db.close(); }
});

it('the catalogue lookup survives a network failure and ignores what is not a JPEG', async () => {
  expect(await lookupJwMedia('pub-x_1_VIDEO', (async () => { throw new Error('offline'); }) as unknown as typeof fetch)).toEqual({ title: null, durationTicks: null, thumb: null });
  const fake = (async (url: string) => String(url).includes('mediator')
    ? new Response(JSON.stringify({ media: [{ title: 'Um vídeo', duration: 12.5, images: { wss: { sm: 'https://cdn.example/x.jpg' } } }] }))
    : new Response('<html>')) as unknown as typeof fetch;
  expect(await lookupJwMedia('pub-x_1_VIDEO', fake)).toEqual({ title: 'Um vídeo', durationTicks: 125_000_000, thumb: null });
});
