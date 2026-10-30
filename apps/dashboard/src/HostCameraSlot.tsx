import { useEffect, useRef, useState } from 'react';
import { remember, storedNumber } from './PanelDivider.js';

/** The Windows host places its native video preview over this exact rectangle. */
export function HostCameraSlot() {
  const slot=useRef<HTMLDivElement>(null);
  const drag=useRef<{y:number;height:number}|null>(null);
  const [height,setHeight]=useState(()=>storedNumber('kmc.operator.cameraHeight',160,80,300));
  useEffect(()=> {
    const bridge=(window as unknown as {chrome?:{webview?:{postMessage:(message:string)=>void}}}).chrome?.webview;
    if(!bridge || !slot.current)return;
    let last='';
    const update=()=> {
      if(!slot.current)return;const r=slot.current.getBoundingClientRect();
      const visible=!document.hidden && !document.querySelector('.overlay') && r.width>0 && r.height>0 && r.left>=0 && r.top>=0 && r.right<=innerWidth+1 && r.bottom<=innerHeight+1;
      const message=['kmc-camera-slot',r.x,r.y,r.width,r.height,devicePixelRatio,visible?1:0].join('|');
      if(message!==last) {last=message;bridge.postMessage(message);}
    };
    const resize=new ResizeObserver(update);resize.observe(slot.current);
    const changes=new MutationObserver(update);changes.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['style','class','hidden','open']});
    window.addEventListener('resize',update);window.addEventListener('scroll',update,true);document.addEventListener('visibilitychange',update);update();
    return()=> {resize.disconnect();changes.disconnect();window.removeEventListener('resize',update);window.removeEventListener('scroll',update,true);document.removeEventListener('visibilitychange',update);bridge.postMessage('kmc-camera-slot|0|0|0|0|1|0');};
  },[]);
  const change=(value:number)=> {const next=Math.max(80,Math.min(300,Math.round(value)));setHeight(next);remember('kmc.operator.cameraHeight',next);};
  return <section className="card2 operator-camera" aria-label="Câmera do anfitrião">
    <div className="card2-head"><span className="card2-title">Câmera do anfitrião</span></div>
    <div ref={slot} className="native-camera-slot" style={{height}}><span>Ative a prévia no botão “Câmera do anfitrião” do app Windows.</span></div>
    <div className="camera-resizer" role="separator" aria-label="Altura da câmera" aria-orientation="horizontal" aria-valuemin={80} aria-valuemax={300} aria-valuenow={height} tabIndex={0}
      title="Arraste para ajustar a câmera; clique duplo para restaurar"
      onPointerDown={e=> {drag.current={y:e.clientY,height};e.currentTarget.setPointerCapture(e.pointerId);}}
      onPointerMove={e=> {if(drag.current)change(drag.current.height+e.clientY-drag.current.y);}}
      onPointerUp={e=> {drag.current=null;e.currentTarget.releasePointerCapture(e.pointerId);}}
      onPointerCancel={()=> {drag.current=null;}}
      onDoubleClick={()=>change(160)}
      onKeyDown={e=> {if(e.key==='ArrowUp'||e.key==='ArrowDown'){e.preventDefault();change(height+(e.key==='ArrowUp'?-8:8));}}} />
  </section>;
}
