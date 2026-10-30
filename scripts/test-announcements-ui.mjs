// Read one local snapshot, then test an isolated UI with every write intercepted.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { WebSocket } from 'ws';
import { chromium } from 'playwright';

const source = process.env.KMC_TEST_BASE_URL || 'http://127.0.0.1:4319';
const frame = await new Promise((resolve, reject) => {
  const socket = new WebSocket(source.replace(/^http/, 'ws') + '/ws');
  const timeout = setTimeout(() => { socket.close(); reject(new Error('Snapshot timeout')); }, 5000);
  socket.on('error', reject);
  socket.on('message', data => {
    const value = JSON.parse(String(data));
    if (value.kind === 'snapshot') { clearTimeout(timeout); socket.close(); resolve(value); }
  });
});
frame.snapshot.settings.tablet.announcements = 'Texto anterior';
frame.snapshot.settings.meeting.passcode = '';
const root = path.resolve('apps/dashboard/dist');
const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const file = path.join(root, pathname === '/' ? 'index.html' : pathname);
    if (!file.startsWith(root + path.sep)) throw new Error('Invalid path');
    res.setHeader('Content-Type', { '.html':'text/html', '.js':'text/javascript', '.css':'text/css' }[path.extname(file)] || 'application/octet-stream');
    res.end(await fs.readFile(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 790 }, colorScheme: 'dark' });
  await page.addInitScript(()=> {
    window.__cameraMessages=[];window.chrome=window.chrome || {};
    window.chrome.webview={postMessage:message=>window.__cameraMessages.push(message)};
  });
  let stream;
  await page.routeWebSocket('**/ws', socket => {stream=socket;socket.send(JSON.stringify(frame));});
  let finishSave, saveObserved;
  await page.route('**/api/v1/**', async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() === 'PUT' && pathname === '/api/v1/settings') {
      const submitted = request.postDataJSON().tablet.announcements;
      const outcome = await new Promise(resolve => { finishSave = resolve; saveObserved?.(); });
      return route.fulfill({ status: outcome, json: outcome === 200
        ? { ...frame.snapshot.settings, tablet: { ...frame.snapshot.settings.tablet, announcements: submitted } }
        : { error: 'simulated failure' } });
    }
    assert.equal(request.method(), 'GET', 'Unexpected write in isolated test');
    const data = pathname.endsWith('/meeting') ? frame.snapshot.meeting
      : pathname.endsWith('/zoom/status') ? frame.snapshot.status
      : pathname.endsWith('/net') ? { addresses: [], panelUrls: [], tabletUrls: [] }
      : pathname.endsWith('/polls/history') ? { results: [{ date: new Date().toLocaleDateString('en-CA'), pollName: 'Contagem de Assistência', question: 'Quantas pessoas estão assistindo de sua casa?', totalVoted: 15, totalParticipants: null, options: [1,2,3,4,5,6].map(n=>({label:String(n),votes:n===1?12:n===4?3:0,percent:null})),capturedAt:new Date().toISOString() }] }
      : { results: [], logs: [] };
    return route.fulfill({ json: data });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.locator('.operator-layout').waitFor();
  await page.locator('.pollres-opts').waitFor();
  const geometry = await page.evaluate(() => ({
    scrollHeight: document.documentElement.scrollHeight, height: innerHeight,
    scrollWidth: document.documentElement.scrollWidth, width: innerWidth,
    partsHeight: document.querySelector('.m-list').clientHeight,
    partsContent: document.querySelector('.m-list').scrollHeight,
    pollHeight: document.querySelector('.operator-lower').clientHeight,
    pollContent: document.querySelector('.operator-lower').scrollHeight,
    quickTools: document.querySelector('.operator-quicktools').getBoundingClientRect().toJSON(),
  }));
  assert.ok(geometry.scrollHeight <= geometry.height, 'Page requires vertical scrolling');
  assert.ok(geometry.scrollWidth <= geometry.width, 'Page requires horizontal scrolling');
  assert.ok(geometry.partsHeight > 80, 'Timer list has no usable internal area');
  assert.ok(geometry.pollContent <= geometry.pollHeight, 'Six-option attendance poll needs scrolling');
  assert.equal(await page.locator('.pollres-attend-num').innerText(), '24');
  await fs.mkdir('runtime/data/zoom-native-research', { recursive: true });
  await page.screenshot({ path: 'runtime/data/zoom-native-research/operator-half-screen.png' });
  console.log('PASS: half-screen workspace geometry', JSON.stringify(geometry));
  const fixed=await page.evaluate(()=>({camera:document.querySelector('.operator-camera').getBoundingClientRect().toJSON(),attendance:document.querySelector('.operator-attendance').getBoundingClientRect().toJSON(),timer:document.querySelector('.operator-timer').getBoundingClientRect().toJSON()}));
  assert.ok(fixed.camera.x>fixed.timer.right,'Camera is not in the right column');
  assert.ok(fixed.attendance.y>=fixed.timer.bottom,'Attendance is not below the timer');
  const originalParts=frame.snapshot.meeting.parts;
  frame.snapshot.meeting.parts=originalParts.slice(0,2);
  frame.snapshot.meetingNames={
    [frame.snapshot.meeting.parts[0].id]:{name:'ORADOR TESTE',secondName:''},
    [frame.snapshot.meeting.parts[1].id]:{name:'DIRIGENTE TESTE',secondName:'LEITOR TESTE'},
  };
  stream.send(JSON.stringify(frame));await page.waitForFunction(()=>document.querySelectorAll('.m-row').length===2);
  await page.locator('.m-assignment').filter({hasText:'ORADOR TESTE'}).waitFor();
  await page.locator('.m-assignment').filter({hasText:'DIRIGENTE TESTE / LEITOR TESTE'}).waitFor();
  const weekend=await page.evaluate(()=>({camera:document.querySelector('.operator-camera').getBoundingClientRect().toJSON(),attendance:document.querySelector('.operator-attendance').getBoundingClientRect().toJSON()}));
  assert.equal(weekend.camera.y,fixed.camera.y);assert.equal(weekend.attendance.y,fixed.attendance.y);
  frame.snapshot.meeting.parts=originalParts;stream.send(JSON.stringify(frame));
  console.log('PASS: Windows dashboard shows weekend names and keeps camera and attendance fixed');
  await page.waitForFunction(()=>window.__cameraMessages.some(message=>message.endsWith('|1')));
  await page.evaluate(()=>{const overlay=document.createElement('div');overlay.className='overlay';overlay.id='camera-test-overlay';document.body.append(overlay);});
  await page.waitForFunction(()=>window.__cameraMessages.at(-1).endsWith('|0'));
  await page.evaluate(()=>document.querySelector('#camera-test-overlay').remove());
  await page.waitForFunction(()=>window.__cameraMessages.at(-1).endsWith('|1'));
  console.log('PASS: native camera bridge hides the preview when a modal covers it');
  await page.getByRole('separator', { name: 'Largura do cronômetro', exact: true }).focus();
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.evaluate(() => localStorage.getItem('kmc.operator.timerWidth')), '48');
  await page.reload();
  await page.locator('.operator-layout').waitFor();
  assert.equal(await page.getByRole('separator', { name: 'Largura do cronômetro', exact: true }).getAttribute('aria-valuenow'), '48');
  console.log('PASS: panel proportions persist after reload');
  const divider = page.getByRole('separator', { name: 'Largura do cronômetro', exact: true });
  const handle = await divider.boundingBox();
  const grid = await page.locator('.operator-layout > .grid').boundingBox();
  await page.mouse.move(handle.x+handle.width/2,handle.y+handle.height/2);
  await page.mouse.down();
  await page.mouse.move(grid.x+grid.width*0.6,handle.y+handle.height/2);
  await page.mouse.up();
  assert.equal(await divider.getAttribute('aria-valuenow'),'60');
  console.log('PASS: pointer drag resizes the timer column');
  await page.getByRole('button', { name: 'Anúncios', exact: true }).click();
  const field = page.locator('textarea.annedit');
  const save = page.getByRole('button', { name: 'Salvar e enviar', exact: true });
  async function submit(text) {
    await field.fill(text);
    const observed = new Promise(resolve => { saveObserved = resolve; });
    await save.click();
    await observed;
  }
  await submit('Anúncio novo');
  assert.equal(await field.inputValue(), 'Anúncio novo', 'Pending save erased the draft');
  finishSave(200);
  await save.waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('.annedit').closest('section').textContent.includes('não salvo'));
  assert.equal(await field.inputValue(), 'Anúncio novo', 'Old snapshot erased saved text');
  console.log('PASS: text remains during save and after acknowledgement');

  await submit('Primeira edição');
  await field.fill('Segunda edição durante o envio');
  finishSave(200);
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].find(b => b.textContent.includes('Salvar e enviar')).disabled);
  assert.equal(await field.inputValue(), 'Segunda edição durante o envio');
  assert.match(await field.locator('..').textContent(), /não salvo/);
  console.log('PASS: edits made during save are preserved as unsaved');

  await submit('Rascunho com falha de rede');
  finishSave(500);
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].find(b => b.textContent.includes('Salvar e enviar')).disabled);
  assert.equal(await field.inputValue(), 'Rascunho com falha de rede');
  assert.match(await field.locator('..').textContent(), /não salvo/);
  console.log('PASS: failed save preserves the draft');
  await page.locator('.layout-options > summary').click();
  await page.getByRole('button', { name: 'Visão completa', exact: true }).click();
  assert.equal(await field.inputValue(), 'Rascunho com falha de rede');
  await page.getByRole('button', { name: 'Visão compacta', exact: true }).click();
  assert.equal(await field.inputValue(), 'Rascunho com falha de rede');
  console.log('PASS: changing workspace modes preserves announcement drafts');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
