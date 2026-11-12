import { useEffect, useState } from 'react';
import type { AttendanceSummary, RemoteTimerState, TimerRoom, TimerDetails, ImportedProgramme, ProgrammePart, RemoteMediaState, RemoteDeviceInfo, DeviceAccess } from '@kmc/shared-types';
export class PairingRequired extends Error {}
async function request<T>(path: string, body?: unknown, timeout=8000): Promise<T> {
  const response=await fetch('/remote-api/'+path,{method:body===undefined?'GET':'POST',cache:'no-store',credentials:'same-origin',
    headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(timeout)});
  if(response.status===401 && path!=='pair')throw new PairingRequired();
  if(!response.ok) {const value=await response.json().catch(()=>({error:'Não foi possível enviar o comando.'}));throw new Error(value.error);}
  return response.json() as Promise<T>;
}
export const remoteApi={
  pair:(name:string)=>request('pair',{name}),state:()=>request<RemoteTimerState>('state'),
  active:(partId:string)=>request<RemoteTimerState>('active',{partId}),
  start:(id:string)=>request<RemoteTimerState>('part/'+encodeURIComponent(id)+'/start',{}),
  pause:(id:string)=>request<RemoteTimerState>('part/'+encodeURIComponent(id)+'/pause',{}),
  pauseNext:(id:string)=>request<RemoteTimerState>('part/'+encodeURIComponent(id)+'/pause-next',{}),
  reset:(id:string)=>request<RemoteTimerState>('part/'+encodeURIComponent(id)+'/reset',{}),
};
/** Mídias → playlist do JW Library (só para aparelhos com o papel Painel). */
export const mediaApi={
  state:()=>request<RemoteMediaState>('media'),
  image:(body:{filename:string;data:string;thumb:string})=>request<RemoteMediaState>('media/image',body,90000),
  song:(body:{number:number;thumb:string})=>request<RemoteMediaState>('media/song',body,20000),
  video:(body:{url:string;thumb:string})=>request<RemoteMediaState>('media/video',body,20000),
  update:(body:{name?:string;order?:string[];labels?:Record<string,string>;remove?:string[]})=>request<RemoteMediaState>('media/update',body),
  clear:()=>request<RemoteMediaState>('media/clear',{}),
  send:()=>request<RemoteMediaState&{opened:boolean}>('media/send',{},30000),
};
/** Administração dos aparelhos por quem tem o papel Painel. */
export const devicesApi={
  list:()=>request<RemoteDeviceInfo[]>('devices'),
  update:(body:{id:string;painel?:boolean;access?:DeviceAccess})=>request<RemoteDeviceInfo[]>('devices/update',body),
};
export const roomApi=(room:TimerRoom)=> {
  const query='?room='+room;
  return {
    state:()=>request<RemoteTimerState>('state'+query),
    active:(partId:string)=>request<RemoteTimerState>('active'+query,{partId}),
    start:(id:string)=>request<RemoteTimerState>('part/'+encodeURIComponent(id)+'/start'+query,{}),
    pause:(id:string)=>request<RemoteTimerState>('part/'+encodeURIComponent(id)+'/pause'+query,{}),
    pauseNext:(id:string)=>request<RemoteTimerState>('part/'+encodeURIComponent(id)+'/pause-next'+query,{}),
    reset:(id:string)=>request<RemoteTimerState>('part/'+encodeURIComponent(id)+'/reset'+query,{}),
    attendance:()=>request<AttendanceSummary>('attendance'),
    setAttendance:(presencial:number)=>request<AttendanceSummary>('attendance',{presencial}),
    list:()=>request<ImportedProgramme[]>('programmes'),
    sync:()=>request<{programmes:number;weeks:number;lastAt:string|null}>('programmes/sync'+query,{},30000),
    load:(programmeId:string,includeNames:boolean,edits:ProgrammePart[])=>request<RemoteTimerState>('programmes/load'+query,{programmeId,includeNames,edits}),
    prepareB:()=>request<RemoteTimerState>('room-b/prepare',{}),
    details:(details:TimerDetails,partIds:string[])=>request<RemoteTimerState>('details'+query,{...details,partIds}),
    finishB:()=>request<RemoteTimerState>('room-b/finish',{}),
  };
};
export function useRemoteTimers(revision: number,room:TimerRoom='main') {
  const [state,setState]=useState<RemoteTimerState|null>(null),[connected,setConnected]=useState(false),[pairing,setPairing]=useState(false),[offset,setOffset]=useState(0);
  const [unavailable,setUnavailable]=useState(false);
  useEffect(()=> {
    setState(null);setConnected(false);
    let stopped=false,socket:WebSocket|null=null,reconnect:ReturnType<typeof setTimeout>|undefined,lastMessage=Date.now();
    const update=(value:RemoteTimerState)=> {if(stopped)return;lastMessage=Date.now();setState(value);setOffset(Date.parse(value.serverNow)-Date.now());setConnected(true);setPairing(false);setUnavailable(false);};
    const connect=async()=> {
      try {
        update(await roomApi(room).state());if(stopped)return;
        socket=new WebSocket(`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}/remote-api/ws?room=${room}`);
        socket.onmessage=event=> {try {update(JSON.parse(String(event.data)));}catch{}};
        socket.onclose=()=> {if(stopped)return;setConnected(false);reconnect=setTimeout(()=>void connect(),2000);};
        socket.onerror=()=>socket?.close();
      } catch(error) {if(stopped)return;setConnected(false);if(error instanceof PairingRequired)setPairing(true);else {setUnavailable(true);reconnect=setTimeout(()=>void connect(),2000);}}
    };
    const offline=()=> {setConnected(false);setUnavailable(true);socket?.close();};
    const watchdog=setInterval(()=>{if(socket?.readyState===WebSocket.OPEN && Date.now()-lastMessage>4500)offline();},1000);
    window.addEventListener('offline',offline);void connect();
    return ()=> {stopped=true;clearTimeout(reconnect);clearInterval(watchdog);window.removeEventListener('offline',offline);socket?.close();};
  },[revision,room]);
  return {state,connected,pairing,offset,unavailable};
}
