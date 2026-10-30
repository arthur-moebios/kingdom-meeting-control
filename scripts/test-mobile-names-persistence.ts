// Real SQLite, isolated file: does not touch the installed app or meeting.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Db } from '../apps/server/src/db.ts';
import { MobileProgrammes } from '../apps/server/src/mobileProgrammes.ts';
import { MeetingService } from '../packages/meeting/src/MeetingService.ts';
import { SettingsSchema } from '../packages/shared-types/src/index.ts';
import { parseProgrammePages } from '../apps/server/src/programmeImport.ts';
import type { AppContext } from '../apps/server/src/context.ts';

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kmc-names-')),filename=path.join(dir,'test.sqlite');
let db=new Db(filename);
function context() {
  const ctx={db,logger:{info(){},warn(){},error(){}},getSettings:()=>SettingsSchema.parse({})} as unknown as AppContext;
  Object.assign(ctx,{meeting:new MeetingService({log:ctx.logger,getSettings:()=>ctx.getSettings(),emit(){},loadState:()=>db.getKv('main'),saveState:value=>db.setKv('main',value)})});
  Object.assign(ctx,{programmes:new MobileProgrammes(ctx)});return ctx;
}
try {
  const ctx=context();
  const [programme]=parseProgrammePages([`Reunião do meio de semana
14 de outubro de 2026 | LEITURA
Dirigente (Sala B) DIRIGENTE B
FAÇA SEU MELHOR NO MINISTÉRIO
4. Iniciando conversas (3 min) Salão Principal NOME A
Sala B NOME B / AJUDANTE B
5. Cultivando interesse (4 min) Salão Principal OUTRO A
Sala B OUTRO B`],'fixture.pdf');
  ctx.programmes.store([programme!]);
  const loaded=ctx.programmes.load({programmeId:programme!.id,room:'b',includeNames:true}),id=loaded.meeting.parts[0]!.id;
  ctx.programmes.saveDetails('b',{...loaded.details,conductor:'DIRIGENTE EDITADO',helper:'AJUDANTE EDITADO',partIds:loaded.meeting.parts.map(p=>p.id),assignments:{[id]:{name:'NOME EDITADO',secondName:'SEGUNDO EDITADO'}}});
  db.close();db=new Db(filename);
  const restarted=context(),recovered=restarted.programmes.state('b');
  assert.equal(recovered.details!.assignments[id]!.name,'NOME EDITADO');assert.equal(recovered.details!.helper,'AJUDANTE EDITADO');
  const reloaded=restarted.programmes.load({programmeId:programme!.id,room:'b',includeNames:true}),newId=reloaded.meeting.parts[0]!.id;
  assert.notEqual(newId,id);assert.equal(reloaded.details!.assignments[newId]!.name,'NOME EDITADO');
  assert.equal(reloaded.details!.helper,'AJUDANTE EDITADO');assert.equal(reloaded.details!.conductor,'DIRIGENTE EDITADO');
  assert.equal(reloaded.details!.assignments[reloaded.meeting.parts[1]!.id]!.name,'OUTRO B');
  // Reopening once more proves names did not survive merely in service memory.
  db.close();db=new Db(filename);
  assert.equal(context().programmes.state('b').details!.assignments[newId]!.secondName,'SEGUNDO EDITADO');
  console.log('PASS: real SQLite survives two backend restarts; edited names, team and original numbering survive regenerated IDs');
}finally{
  db.close();
  // Remove only the exact temporary directory created above.
  assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('kmc-names-'));
  fs.rmSync(dir,{recursive:true,force:true});
}
