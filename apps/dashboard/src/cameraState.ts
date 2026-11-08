/**
 * Preview state reported by the Windows host to the page ("kmc-camera-state|<kind>|<reason>"
 * via WebView2 PostWebMessageAsString). The reason codes are shared with
 * scripts/win/OperatorDesktop.cs (class CameraReason); a contract test compares both lists.
 * DOM-free and clock-free: callers pass `now`.
 */

export type CameraKind = 'active' | 'paused' | 'unavailable';

export interface ReasonInfo { kind: CameraKind; text: string; /** only produced by the page, never by the host */ local?: true }

export const CAMERA_REASONS: Record<string, ReasonInfo> = {
  ok: { kind: 'active', text: 'Prévia ao vivo' },
  desligada: { kind: 'paused', text: 'Prévia desligada. Ative no botão “Câmera do anfitrião” do app Windows.' },
  'painel-minimizado': { kind: 'paused', text: 'Prévia pausada: a janela do painel está minimizada.' },
  'oculta-pela-pagina': { kind: 'paused', text: 'Prévia oculta: há um menu ou janela sobre a câmera.' },
  'varredura-antiga': { kind: 'paused', text: 'Prévia pausada: aguardando nova leitura do Zoom.' },
  'zoom-minimizado': { kind: 'paused', text: 'Prévia pausada: o Zoom está minimizado.' },
  'zoom-invisivel': { kind: 'paused', text: 'Prévia pausada: a janela do Zoom está oculta.' },
  'zoom-outra-area': { kind: 'paused', text: 'Prévia pausada: o Zoom está em outra área de trabalho.' },
  'zoom-sem-area': { kind: 'paused', text: 'Prévia pausada: a janela do Zoom está sem área.' },
  'zoom-fora-do-desktop': { kind: 'paused', text: 'Prévia pausada: o Zoom está fora da área de trabalho.' },
  procurando: { kind: 'unavailable', text: 'Procurando a câmera do anfitrião…' },
  'zoom-ausente': { kind: 'unavailable', text: 'Prévia indisponível: Zoom nativo não encontrado.' },
  'camera-nao-encontrada': { kind: 'unavailable', text: 'Prévia indisponível: câmera do anfitrião não encontrada no Zoom (vídeo desligado, reunião fechada ou fora da área visível).' },
  'camera-ambigua': { kind: 'unavailable', text: 'Prévia indisponível: câmera do anfitrião ambígua.' },
  'varredura-falhou': { kind: 'unavailable', text: 'Prévia indisponível: falha ao ler o Zoom.' },
  'dwm-recusou': { kind: 'unavailable', text: 'Prévia indisponível: o Windows recusou a miniatura. Use Mostrar Zoom.' },
  // Local to the page:
  'aguardando-host': { kind: 'unavailable', text: 'Aguardando o app Windows informar o estado da prévia…', local: true },
  'sem-app-windows': { kind: 'unavailable', text: 'A prévia da câmera só existe no app Windows.', local: true },
  'host-sem-resposta': { kind: 'unavailable', text: 'Prévia indisponível: o app Windows não responde.', local: true },
};

/** Silence from the host longer than this means the state is no longer trustworthy. */
export const HOST_SILENCE_MS = 6000;

export interface CameraStatus { kind: CameraKind; reason: string; receivedAt: number | null }

export function initialStatus(hasHost: boolean): CameraStatus {
  return { kind: 'unavailable', reason: hasHost ? 'aguardando-host' : 'sem-app-windows', receivedAt: null };
}

const KINDS: readonly string[] = ['active', 'paused', 'unavailable'];

/** Strict parser for the host message; anything else is ignored. */
export function parseCameraState(data: unknown): { kind: CameraKind; reason: string } | null {
  if (typeof data !== 'string') return null;
  const parts = data.split('|');
  if (parts.length !== 3 || parts[0] !== 'kmc-camera-state') return null;
  const kind = parts[1] ?? '', reason = parts[2] ?? '';
  if (!KINDS.includes(kind) || !/^[a-z-]{1,40}$/.test(reason)) return null;
  const known = CAMERA_REASONS[reason];
  // An unknown reason keeps the host's kind (generic text); a known one must agree with it, else fail safe.
  if (known && known.kind !== kind) return { kind: 'unavailable', reason: 'host-sem-resposta' };
  return { kind: kind as CameraKind, reason };
}

/** Folds a host message into the status. Invalid input leaves the status untouched. */
export function applyHostMessage(prev: CameraStatus, data: unknown, now: number): CameraStatus {
  const parsed = parseCameraState(data);
  return parsed ? { ...parsed, receivedAt: now } : prev;
}

/** The status to show at `now`: a host that went quiet is "not answering", never a stale "active". */
export function effectiveStatus(status: CameraStatus, now: number): CameraStatus {
  if (status.receivedAt !== null && now - status.receivedAt > HOST_SILENCE_MS)
    return { kind: 'unavailable', reason: 'host-sem-resposta', receivedAt: status.receivedAt };
  return status;
}

export interface CameraView { kind: CameraKind; reason: string; text: string }

export function describeCamera(status: CameraStatus): CameraView {
  const info = CAMERA_REASONS[status.reason];
  const generic = status.kind === 'active' ? 'Prévia ao vivo' : status.kind === 'paused' ? 'Prévia pausada.' : 'Prévia indisponível.';
  return { kind: status.kind, reason: status.reason, text: info?.text ?? generic };
}
