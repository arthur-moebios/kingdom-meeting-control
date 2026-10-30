// Isolated gateway + fake meeting: no Cloudflare account or live meeting changes.
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import { MeetingScheduleSchema, SettingsSchema } from '../packages/shared-types/src/index.ts';
import { MobileTimers, buildRemoteGateway } from '../apps/server/src/mobileTimers.ts';
import type { AppContext } from '../apps/server/src/context.ts';
import { MobileProgrammes } from '../apps/server/src/mobileProgrammes.ts';
import { parseProgrammePages } from '../apps/server/src/programmeImport.ts';

let port=0,commands=0;
const listeners=new Set<(event:{type:string})=>void>();
const meeting=MeetingScheduleSchema.parse({weekLabel:'Reunião de teste',activePartId:'test',parts:[{id:'test',order:0,title:'Parte de teste',section:'INÍCIO',allottedSec:60}]});
const notify=()=>{for(const listener of listeners)listener({type:'meeting.updated'});};
const kv=new Map<string,string>();
// The primary test meeting represents an explicit selection for today.
const today=new Date();kv.set('mobile.auto.main',`${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`);
const ctx={cfg:{publicDir:path.resolve('apps/dashboard/dist')},cloudflare:{get gatewayPort(){return port;},publicOrigin:'',instanceId:'test-instance'},
  db:{getKv:(key:string)=>kv.get(key) ?? null,setKv:(key:string,value:string)=>kv.set(key,value)},getSettings:()=>SettingsSchema.parse({}),
  logger:{info:()=>{},warn:()=>{},error:()=>{}},
  bus:{subscribe:(listener:(event:{type:string})=>void)=>{listeners.add(listener);return()=>listeners.delete(listener);}},
  meeting:{getState:()=>meeting,setActive:(id:string)=>{meeting.activePartId=id;notify();},
    start:()=>{commands++;meeting.parts[0]!.running=true;meeting.parts[0]!.startedAt=new Date().toISOString();notify();},
    pause:()=>{commands++;meeting.parts[0]!.running=false;notify();},pauseAndAdvance:()=>{commands++;meeting.parts[0]!.running=false;notify();},
    reset:()=>{commands++;meeting.parts[0]!.running=false;meeting.parts[0]!.baseElapsedSec=0;meeting.parts[0]!.startedAt=null;notify();}},
} as unknown as AppContext;
(ctx as {programmes:MobileProgrammes}).programmes=new MobileProgrammes(ctx);
ctx.programmes.store(parseProgrammePages([`Reunião do meio de semana
28 de outubro de 2026 | LEITURA
Dirigente (Sala B) DIRIGENTE TESTE
TESOUROS DA PALAVRA DE DEUS
3. Leitura da Bíblia (4 min) Salão Principal LEITOR
Sala B LEITOR B
FAÇA SEU MELHOR NO MINISTÉRIO
4. Iniciando conversas (3 min) Salão Principal PARTICIPANTE PRINCIPAL
Sala B PARTICIPANTE B / AJUDANTE B
5. Cultivando interesse (4 min) Salão Principal OUTRO
Sala B OUTRO B`],'programacao-teste.pdf'));
(ctx as {mobile:MobileTimers}).mobile=new MobileTimers(ctx);
const gateway=await buildRemoteGateway(ctx);
await gateway.listen({host:'127.0.0.1',port:0});
port=(gateway.server.address() as {port:number}).port;
const browser=await chromium.launch({headless:true});
try {
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,colorScheme:'dark'});
  const page=await context.newPage();const origin=`http://127.0.0.1:${port}`;
  await page.goto(origin+'/remote.html');
  await page.getByRole('heading',{name:'Conectar este aparelho'}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Conectar este aparelho',exact:true}).isDisabled(),true);
  await page.getByLabel('Nome do aparelho').fill('   ');
  assert.equal(await page.getByRole('button',{name:'Conectar este aparelho',exact:true}).isDisabled(),true);
  await page.getByLabel('Nome do aparelho').fill('Celular de teste');
  await page.getByRole('button',{name:'Conectar este aparelho',exact:true}).click();
  await page.locator('.rc-list').waitFor();
  await page.getByRole('button',{name:'▶ Iniciar',exact:true}).click();
  await page.getByRole('button',{name:'❚❚ Pausar e próxima',exact:true}).waitFor();
  assert.equal(commands,1);assert.equal(meeting.parts[0]!.running,true);
  await page.waitForFunction(()=>!!navigator.serviceWorker.controller,undefined,{timeout:15000});
  const manifest=await (await context.newCDPSession(page)).send('Page.getAppManifest');
  assert.equal(manifest.errors.length,0);assert.equal(JSON.parse(manifest.data).display,'standalone');
  const cookie=(await context.cookies()).find(cookie=>cookie.name==='kmc_remote');assert.ok(cookie?.httpOnly);
  await fs.mkdir('runtime/data/zoom-native-research',{recursive:true});
  await page.screenshot({path:'runtime/data/zoom-native-research/mobile-pwa-online.png',fullPage:true});
  console.log('PASS: pairing, HTTP-only persistent session, timer command, live update, manifest and service worker');
  await page.getByRole('button',{name:'Sala B',exact:true}).click();
  await page.locator('.rc-list li').nth(1).waitFor();
  await page.getByRole('button',{name:'Programação e nomes',exact:true}).click();
  await page.getByText('1 data preparada automaticamente',{exact:true}).waitFor();
  assert.equal(await page.getByRole('combobox').count(),0);
  await page.getByRole('button',{name:'Fechar',exact:true}).click();

  await page.locator('.rc-list li').nth(1).waitFor();
  assert.equal(await page.locator('.rc-list li').count(),2);
  assert.equal(await page.locator('.rc-list').getByText('Leitura da Bíblia').count(),0);
  await page.getByText('PARTICIPANTE B / AJUDANTE B',{exact:true}).waitFor();
  await page.getByRole('button',{name:'▶ Iniciar',exact:true}).click();
  assert.equal(meeting.parts[0]!.running,true);assert.equal(commands,1);
  await page.waitForTimeout(1200);
  const downloadPromise=page.waitForEvent('download');await page.getByRole('button',{name:'Compartilhar imagem',exact:true}).click();
  const download=await downloadPromise;assert.match(download.suggestedFilename(),/sala-b.*\.png$/);
  await download.saveAs('runtime/data/zoom-native-research/sala-b-report.png');
  assert.equal(await page.getByRole('dialog').count(),0);
  assert.equal(ctx.programmes.state('b').meeting.parts[0]!.running,true);
  assert.equal(meeting.parts[0]!.running,true);
  await page.evaluate(`(()=> {
    Object.defineProperty(navigator,'canShare',{configurable:true,value:()=>true});
    Object.defineProperty(navigator,'share',{configurable:true,value:(data)=> {
      window.__shared={count:data.files?.length,type:data.files?.[0]?.type,active:navigator.userActivation.isActive,text:data.text};return Promise.resolve();
    }});
  })()`);
  await page.getByRole('button',{name:'Compartilhar imagem',exact:true}).click();
  const shared=await page.evaluate(()=>(window as any).__shared);
  assert.equal(shared.count,1);assert.equal(shared.type,'image/png');assert.equal(shared.active,true);assert.equal(shared.text,undefined);
  await page.screenshot({path:'runtime/data/zoom-native-research/sala-b-timers-mobile.png',fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.getByRole('button',{name:'Salão principal',exact:true}).click();
  await page.getByText('Parte de teste',{exact:true}).first().waitFor();
  assert.equal(await page.locator('.rc-list li').count(),1);
  console.log('PASS: same pairing for both rooms; B only ministry, private names, independent timers, automatic scheduling, direct native image sharing and PNG fallback');
  await context.setOffline(true);
  await page.getByRole('status').filter({hasText:'Sem conexão'}).waitFor();
  assert.equal(await page.locator('.rc-list button:not(:disabled)').count(),0);
  const sent=commands;await page.reload();
  await page.getByText('Sem conexão. Conecte-se à internet para controlar os cronômetros.').waitFor();
  assert.equal(commands,sent);
  console.log('PASS: app shell opens offline; controls are disabled and commands are not queued');
  await context.setOffline(false);await page.reload();await page.locator('.rc-list').waitFor();
  assert.equal(await page.getByRole('heading',{name:'Conectar este aparelho'}).count(),0);
  // Reproduce delayed metadata with the same part IDs; no writes reach the app.
  const regression=await context.newPage();
  await regression.addInitScript(()=>localStorage.setItem('kmc.timer-room','b'));
  const full=structuredClone(ctx.programmes.state('b'));
  let frame=structuredClone(full);frame.details!.assignments={};
  let stream:any,saved:any;
  await regression.route('**/remote-api/state?room=*',route=>route.fulfill({json:frame}));
  await regression.routeWebSocket('**/remote-api/ws?room=*',socket=>{stream=socket;socket.send(JSON.stringify(frame));});
  await regression.route('**/remote-api/details?room=b',async route=> {
    saved=route.request().postDataJSON();frame={...full,details:saved};
    await route.fulfill({json:frame});stream.send(JSON.stringify(frame));
  });
  await regression.goto(origin+'/remote.html');
  await regression.getByRole('button',{name:'Programação e nomes',exact:true}).click();
  await regression.getByText('Ajustar nomes da programação atual',{exact:true}).click();
  const participant=regression.getByLabel('Participante',{exact:true}).first();
  assert.equal(await participant.inputValue(),'');
  frame=structuredClone(full);stream.send(JSON.stringify(frame));
  await regression.waitForFunction("document.querySelector('.rc-name-editor fieldset input').value === 'PARTICIPANTE B'");
  await participant.fill('NOME EDITADO NO CELULAR');
  stream.send(JSON.stringify({...full,details:{...full.details,assignments:{}}}));
  await regression.waitForTimeout(150);
  assert.equal(await participant.inputValue(),'NOME EDITADO NO CELULAR');
  await regression.getByRole('button',{name:'Salvar nomes',exact:true}).click();
  await regression.getByRole('status').getByText('Nomes salvos no computador para esta sala e data.',{exact:true}).waitFor();
  assert.equal(saved.assignments[full.meeting.parts[0]!.id].name,'NOME EDITADO NO CELULAR');
  assert.deepEqual(saved.partIds,full.meeting.parts.map(p=>p.id));
  await regression.reload();await regression.getByRole('button',{name:'Programação e nomes',exact:true}).click();
  await regression.getByText('Ajustar nomes da programação atual',{exact:true}).click();
  assert.equal(await regression.getByLabel('Participante',{exact:true}).first().inputValue(),'NOME EDITADO NO CELULAR');
  await regression.getByRole('button',{name:'Fechar',exact:true}).click();
  frame={...full,room:'main',meeting:{...full.meeting,kind:'weekend',parts:full.meeting.parts.map((p,i)=>({...p,section:'Fim de semana',title:i===0?'Discurso público':'A Sentinela: Tema do estudo',running:false,startedAt:null}))},
    details:{assignments:{[full.meeting.parts[0]!.id]:{name:'ORADOR TESTE',secondName:''},[full.meeting.parts[1]!.id]:{name:'DIRIGENTE TESTE',secondName:'LEITOR TESTE'}},date:'2026-10-31',conductor:'',helper:''},
    period:{weekLabel:'Semana de 26 de outubro a 1 de novembro de 2026',dateLabel:'31 de outubro de 2026',matchesMainWeek:true}};
  await regression.getByRole('button',{name:'Salão principal',exact:true}).click();
  await regression.getByText('Fim de semana · 31 de outubro de 2026',{exact:true}).waitFor();
  await regression.getByText('ORADOR TESTE',{exact:true}).waitFor();
  await regression.getByText('DIRIGENTE TESTE / LEITOR TESTE',{exact:true}).waitFor();
  assert.equal(await regression.locator('.rc-list li').count(),2);
  await regression.close();
  console.log('PASS: late names populate the editor, edits survive reload, and PWA shows both weekend parts with names');
  assert.equal(ctx.mobile.status().deviceList[0]!.label,'Celular de teste');
  ctx.mobile.revoke(ctx.mobile.status().deviceList[0]!.id);await page.getByRole('heading',{name:'Conectar este aparelho'}).waitFor({timeout:10000});
  console.log('PASS: reconnect retains session; individual revocation disconnects the live PWA and requires explicit reconnection');
} finally {await browser.close();await gateway.close();}
