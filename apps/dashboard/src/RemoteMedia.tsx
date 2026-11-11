import { useEffect, useRef, useState } from 'react';
import type { RemoteMediaState } from '@kmc/shared-types';
import { mediaApi } from './remoteApi.js';

const IMAGE_MAX = 1920, THUMB_MAX = 250, SONG_THUMB = 224;
const base64 = (canvas: HTMLCanvasElement, quality: number) => canvas.toDataURL('image/jpeg', quality).split(',')[1] ?? '';
function draw(source: CanvasImageSource, width: number, height: number, max: number): HTMLCanvasElement {
  const scale = Math.min(1, max / Math.max(width, height)), canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
  const g = canvas.getContext('2d')!;
  // JPEG não tem transparência: fundo preto, como a tela de mídia do salão.
  g.fillStyle = '#000'; g.fillRect(0, 0, canvas.width, canvas.height); g.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}
/** Converte qualquer imagem que o navegador abre (JPEG, PNG, HEIC no iPhone) em JPEG + miniatura. */
async function prepareImage(file: File): Promise<{ data: string; thumb: string }> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => { img.onload = () => resolve(); img.onerror = () => reject(new Error(`Não foi possível abrir “${file.name}”. Envie uma foto ou imagem.`)); img.src = url; });
    const full = draw(img, img.naturalWidth, img.naturalHeight, IMAGE_MAX);
    return { data: base64(full, 0.88), thumb: base64(draw(full, full.width, full.height, THUMB_MAX), 0.8) };
  } finally { URL.revokeObjectURL(url); }
}
function songThumb(number: number): string {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = SONG_THUMB;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#1f3a5f'; g.fillRect(0, 0, SONG_THUMB, SONG_THUMB);
  g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = '600 56px sans-serif'; g.fillText('♪', SONG_THUMB / 2, 70);
  g.font = '700 84px sans-serif'; g.fillText(String(number), SONG_THUMB / 2, 150);
  return base64(canvas, 0.85);
}
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Aba Mídias: fotos e cânticos enviados pelo celular viram uma playlist do JW Library no computador do salão. */
export function RemoteMedia({ connected, onError }: { connected: boolean; onError: (m: string | null) => void }) {
  const [data, setData] = useState<RemoteMediaState | null>(null), [busy, setBusy] = useState<string | null>(null);
  const [song, setSong] = useState(''), [name, setName] = useState(''), [sent, setSent] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const apply = (value: RemoteMediaState) => { setData(value); setName(value.name); };
  useEffect(() => { if (connected) mediaApi.state().then(apply).catch(e => onError(message(e))); }, [connected]);
  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label); onError(null); setSent(null);
    try { await fn(); } catch (e) { onError(message(e)); } finally { setBusy(null); }
  }
  const addImages = (files: File[]) => run('Enviando…', async () => {
    for (const [at, file] of files.entries()) {
      setBusy(`Enviando ${at + 1} de ${files.length}…`);
      apply(await mediaApi.image({ filename: file.name, ...(await prepareImage(file)) }));
    }
  });
  const addSong = () => {
    const number = Number(song);
    if (!Number.isInteger(number) || number < 1 || number > 200) { onError('Informe o número do cântico.'); return; }
    void run('Adicionando…', async () => { apply(await mediaApi.song({ number, thumb: songThumb(number) })); setSong(''); });
  };
  const change = (body: Parameters<typeof mediaApi.update>[0]) => run('Salvando…', async () => apply(await mediaApi.update(body)));
  function move(at: number, by: number) {
    if (!data) return;
    const order = data.items.map(i => i.id), to = at + by;
    if (to < 0 || to >= order.length) return;
    [order[at], order[to]] = [order[to]!, order[at]!];
    void change({ order });
  }
  function rename(id: string, current: string) {
    const label = window.prompt('Título do item na playlist', current)?.trim();
    if (label && label !== current) void change({ labels: { [id]: label } });
  }
  const send = () => run('Montando a playlist…', async () => {
    const result = await mediaApi.send();
    apply(result);
    setSent(result.opened ? 'Playlist aberta no JW Library do computador. Confirme a importação na tela do computador.' : 'Playlist montada, mas o computador não conseguiu abri-la no JW Library.');
  });
  if (!data) return <section className="rc-tab-section"><h2>Mídias</h2><p className="small muted">Carregando…</p></section>;
  const disabled = !connected || busy !== null;
  return <section className="rc-tab-section rc-media">
    <h2>Playlist para o JW Library</h2>
    <p className="small muted">Envie fotos e escolha cânticos. O computador do salão monta a playlist e abre no JW Library.</p>
    <label>Nome da playlist <input value={name} maxLength={80} disabled={disabled} onChange={e => setName(e.target.value)} onBlur={() => { if (name.trim() !== data.name) void change({ name: name.trim() }); }} /></label>
    <ul className="rc-list rc-media-list">{data.items.map((item, at) => <li key={item.id} className="rc-row rc-row-plain">
      <img src={`/remote-api/media/thumb/${item.id}`} alt="" loading="lazy" />
      <div className="rc-rowmain"><span className="rc-sec">{item.kind === 'song' ? 'Cântico' : 'Imagem'}</span><button type="button" className="rc-media-label" disabled={disabled} onClick={() => rename(item.id, item.label)}>{item.label}</button></div>
      <div className="rc-media-actions">
        <button type="button" className="secondary" aria-label="Subir" disabled={disabled || at === 0} onClick={() => move(at, -1)}>↑</button>
        <button type="button" className="secondary" aria-label="Descer" disabled={disabled || at === data.items.length - 1} onClick={() => move(at, 1)}>↓</button>
        <button type="button" className="secondary" aria-label="Remover" disabled={disabled} onClick={() => void change({ remove: [item.id] })}>✕</button>
      </div>
    </li>)}</ul>
    {!data.items.length && <p className="rc-empty">Nenhum item ainda.</p>}
    <input ref={picker} type="file" accept="image/*" multiple hidden onChange={e => { const files = [...(e.target.files ?? [])]; e.target.value = ''; if (files.length) void addImages(files); }} />
    <div className="rc-media-add">
      <button type="button" disabled={disabled} onClick={() => picker.current?.click()}>Adicionar fotos</button>
      <form onSubmit={e => { e.preventDefault(); addSong(); }}>
        <input type="number" inputMode="numeric" min={1} max={200} placeholder="Nº do cântico" aria-label="Número do cântico" value={song} disabled={disabled} onChange={e => setSong(e.target.value)} />
        <button className="secondary" disabled={disabled || !song}>Adicionar cântico</button>
      </form>
    </div>
    {busy && <p className="small" role="status">{busy}</p>}
    <button type="button" className="rc-media-send" disabled={disabled || !data.items.length} onClick={() => void send()}>Enviar ao JW Library</button>
    {sent && <p className="small" role="status">{sent}</p>}
    {data.items.length > 0 && <button type="button" className="secondary" disabled={disabled} onClick={() => { if (window.confirm('Remover todos os itens desta playlist?')) void run('Limpando…', async () => apply(await mediaApi.clear())); }}>Limpar tudo</button>}
    <p className="small muted">Toque no título para renomear. Vídeos enviados pelo celular ainda não são aceitos.</p>
  </section>;
}
