import type { ReactNode } from 'react';

export type RemoteTab = 'painel' | 'cronometro' | 'programacao' | 'assistencia' | 'mais';

// Ícones inline 24x24 (stroke="currentColor"), sem biblioteca. Mesmo padrão visual do app Mapas JW.
const icons: Record<RemoteTab, ReactNode> = {
  painel: <><rect x="3" y="3" width="7" height="9" /><rect x="14" y="3" width="7" height="5" /><rect x="14" y="12" width="7" height="9" /><rect x="3" y="16" width="7" height="5" /></>,
  cronometro: <><circle cx="12" cy="13" r="8" /><path d="M12 9v4l2 2" /><path d="M9 2h6" /></>,
  programacao: <><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4" /><path d="M8 2v4" /><path d="M3 10h18" /></>,
  assistencia: <><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></>,
  mais: <><circle cx="5" cy="12" r="1.2" /><circle cx="12" cy="12" r="1.2" /><circle cx="19" cy="12" r="1.2" /></>,
};
// Nomenclatura alinhada ao app da tribuna (Painel · Cronômetro · ... · Mais).
export const TAB_LABELS: Record<RemoteTab, string> = { painel: 'Painel', cronometro: 'Cronômetro', programacao: 'Programação', assistencia: 'Assistência', mais: 'Mais' };

/** Barra inferior do PWA. A aba Painel só entra quando o servidor liberou o papel para este aparelho. */
export function RemoteBottomNav({ withPainel, active, onSelect }: { withPainel: boolean; active: RemoteTab; onSelect: (tab: RemoteTab) => void }) {
  const tabs = (['painel', 'cronometro', 'programacao', 'assistencia', 'mais'] as const).filter(t => t !== 'painel' || withPainel);
  return <nav className="rc-bnav" aria-label="Menu inferior">
    {tabs.map(tab => <button key={tab} type="button" className={`rc-bnav-item${active === tab ? ' active' : ''}`} aria-current={active === tab ? 'page' : undefined} onClick={() => onSelect(tab)}>
      <svg viewBox="0 0 24 24" aria-hidden="true" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{icons[tab]}</svg>
      <span>{TAB_LABELS[tab]}</span>
    </button>)}
  </nav>;
}
