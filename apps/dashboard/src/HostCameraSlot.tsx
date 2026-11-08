import { useEffect, useRef, useState } from 'react';
import { remember, storedNumber } from './PanelDivider.js';
import { insideViewport, isObstructed, nextEvaluationDelay, slotProbe } from './cameraObstruction.js';
import { applyHostMessage, describeCamera, effectiveStatus, initialStatus, type CameraStatus } from './cameraState.js';

interface HostBridge {
  postMessage(message: string): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}
const hostBridge=():HostBridge|undefined=>(window as unknown as {chrome?:{webview?:HostBridge}}).chrome?.webview;

/**
 * The Windows host places its native video preview over this exact rectangle (a top-level window,
 * so the page can never paint above it) and reports back whether the preview is live.
 */
export function HostCameraSlot() {
  const slot=useRef<HTMLDivElement>(null);
  const drag=useRef<{y:number;height:number}|null>(null);
  const [height,setHeight]=useState(()=>storedNumber('kmc.operator.cameraHeight',160,80,300));
  const [status,setStatus]=useState<CameraStatus>(()=>initialStatus(Boolean(hostBridge())));
  const [now,setNow]=useState(()=>Date.now());
  useEffect(()=> {const id=window.setInterval(()=>setNow(Date.now()),1000);return()=>window.clearInterval(id);},[]);
  useEffect(()=> {
    const bridge=hostBridge(), el=slot.current;
    if(!bridge || !el)return;
    // Listen before announcing ourselves: the host answers the first slot message with the current state.
    const onHost=(event:{data:unknown})=>setStatus(prev=>applyHostMessage(prev,event.data,Date.now()));
    bridge.addEventListener('message',onHost);
    let last='',lastRun:number|null=null,timer:number|undefined;
    const evaluate=()=> {
      timer=undefined;lastRun=performance.now();
      const r=el.getBoundingClientRect();const box={left:r.left,top:r.top,right:r.right,bottom:r.bottom};
      // Visible only if nothing is painted over the slot: hit-test it instead of naming overlay classes.
      const visible=!document.hidden && insideViewport(box,innerWidth,innerHeight) && !isObstructed(box,slotProbe(el,(x,y)=>document.elementFromPoint(x,y)));
      const message=['kmc-camera-slot',r.x,r.y,r.width,r.height,devicePixelRatio,visible?1:0].join('|');
      if(message!==last) {last=message;bridge.postMessage(message);}
    };
    // Leading edge runs at once, bursts of mutations collapse into one hit-test pass.
    const schedule=()=> {if(timer===undefined)timer=window.setTimeout(evaluate,nextEvaluationDelay(lastRun,performance.now()));};
    const resize=new ResizeObserver(schedule);resize.observe(el);
    const changes=new MutationObserver(schedule);changes.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['style','class','hidden','open']});
    const poll=window.setInterval(schedule,500); // hover/CSS-only popovers raise no mutation
    const visibility=()=>{if(timer!==undefined){window.clearTimeout(timer);}evaluate();};
    window.addEventListener('resize',schedule);window.addEventListener('scroll',schedule,true);document.addEventListener('visibilitychange',visibility);evaluate();
    return()=> {
      resize.disconnect();changes.disconnect();window.clearInterval(poll);if(timer!==undefined)window.clearTimeout(timer);
      window.removeEventListener('resize',schedule);window.removeEventListener('scroll',schedule,true);document.removeEventListener('visibilitychange',visibility);
      bridge.removeEventListener('message',onHost);bridge.postMessage('kmc-camera-slot|0|0|0|0|1|0');
    };
  },[]);
  const view=describeCamera(effectiveStatus(status,now));
  const change=(value:number)=> {const next=Math.max(80,Math.min(300,Math.round(value)));setHeight(next);remember('kmc.operator.cameraHeight',next);};
  return <section className="card2 operator-camera" aria-label="Câmera do anfitrião">
    <div className="card2-head"><span className="card2-title">Câmera do anfitrião</span></div>
    <div ref={slot} className="native-camera-slot" data-state={view.kind} data-reason={view.reason} style={{height}}><span role="status">{view.text}</span></div>
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
