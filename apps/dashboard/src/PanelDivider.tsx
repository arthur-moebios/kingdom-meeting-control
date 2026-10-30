import { useRef } from 'react';

export function storedNumber(key: string, fallback: number, min: number, max: number): number {
  try { const raw = localStorage.getItem(key); const value = raw === null ? fallback : Number(raw); return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback; }
  catch { return fallback; }
}
export function remember(key: string, value: number): void { try { localStorage.setItem(key, String(value)); } catch {} }

export function PanelDivider({ value, onChange, horizontal = false, label }: {
  value: number; onChange: (value: number) => void; horizontal?: boolean; label: string;
}) {
  const dragging = useRef(false);
  const change = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    const bounds = event.currentTarget.parentElement!.getBoundingClientRect();
    const fraction = horizontal ? (event.clientY - bounds.top) / bounds.height : (event.clientX - bounds.left) / bounds.width;
    onChange(Math.max(30, Math.min(70, Math.round(fraction * 100))));
  };
  return <div className={`panel-divider ${horizontal ? 'horizontal' : 'vertical'}`} role="separator" tabIndex={0}
    aria-label={label} aria-orientation={horizontal ? 'horizontal' : 'vertical'} aria-valuemin={30} aria-valuemax={70} aria-valuenow={value}
    title={`${label} — arraste ou use as setas`}
    onPointerDown={event => { dragging.current = true; event.currentTarget.setPointerCapture(event.pointerId); }}
    onPointerMove={change} onPointerUp={event => { change(event); dragging.current = false; event.currentTarget.releasePointerCapture(event.pointerId); }}
    onPointerCancel={() => { dragging.current = false; }}
    onKeyDown={event => {
      if (['ArrowLeft','ArrowUp','ArrowRight','ArrowDown'].includes(event.key)) {
        event.preventDefault(); onChange(Math.max(30,Math.min(70,value + (['ArrowLeft','ArrowUp'].includes(event.key) ? -2 : 2))));
      }
    }} />;
}
