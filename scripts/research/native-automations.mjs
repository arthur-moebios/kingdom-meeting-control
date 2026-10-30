import { spawn } from 'node:child_process';
import path from 'node:path';

export function validateAutomationSettings(value) {
  if (!value || typeof value !== 'object' || typeof value.meetingId !== 'string' || !/^\d{9,11}$/.test(value.meetingId) ||
      typeof value.autoShare !== 'boolean' || typeof value.autoAdmit !== 'boolean')
    throw new Error('Informe a reunião e as duas opções de automação.');
  if (value.shareAudio !== undefined && typeof value.shareAudio !== 'boolean') throw new Error('shareAudio must be boolean');
  return { meetingId: value.meetingId, autoShare: value.autoShare, autoAdmit: value.autoAdmit,
    shareAudio: value.shareAudio ?? true, controlSession: value.controlSession === true };
}

export function createAutomations({ python, scriptDir, toolsDir, logPath, spawnWorker = spawn }) {
  let child = null;
  let sequence = 0, configurationQueue = Promise.resolve();
  const pending = new Map();
  let state = { phase: 'stopped', autoShare: false, autoAdmit: false, meetingId: '',
    message: 'Automações nativas desativadas', share: 'idle', waiting: null, lastEventAt: null, connected: false };
  const update = patch => { state = { ...state, ...patch }; };
  async function stop() {
    if (!child) { update({ phase: 'stopped' }); return; }
    update({ phase: 'stopping', message: 'Encerrando automações…' });
    const current = child;
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Aguardando encerramento do controlador nativo.')), 8000);
      current.once('close', () => { clearTimeout(timeout); resolve(); });
      current.stdin.end('stop\n');
    });
  }
  async function apply(input) {
    const settings = validateAutomationSettings(input);
    await stop();
    update({ ...settings, phase: 'stopped', share: 'idle', waiting: null, connected: false, lastError: null, message: 'Automações desativadas' });
    if (!settings.autoShare && !settings.autoAdmit && !settings.controlSession) return snapshot();
    const args = [path.join(scriptDir, 'zoom-native-media-watch.py'), '--meeting-id', settings.meetingId,
      '--duration', '600', '--managed', '--share-audio', String(settings.shareAudio), '--log', logPath,
      '--observer-script', path.join(scriptDir, 'win', 'watch-jw-media.ps1')];
    if (settings.autoAdmit) args.push('--auto-admit');
    if (!settings.autoShare) args.push('--no-share');
    update({ phase: 'starting', message: 'Conectando automações ao Zoom…' });
    child = spawnWorker(python, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, KMC_NATIVE_TOOLS: toolsDir, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
    const owned = child;
    let buffer = '', stderr = '';
    owned.stdin.on('error', () => {});
    owned.stdout.setEncoding('utf8');
    owned.stdout.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 2_000_000) { owned.stdin.end('stop\n'); update({ phase: 'error', message: 'Resposta excessiva do controlador' }); return; }
      for (let end; (end = buffer.indexOf('\n')) >= 0;) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const event = JSON.parse(line);
          update({ lastEventAt: new Date().toISOString() });
          if (event.event === 'command_result') {
            const request = pending.get(event.id);
            if (request) { pending.delete(event.id); clearTimeout(request.timeout); if (event.error) request.reject(new Error(event.error)); else request.resolve(event.result); }
          }
          if (event.event === 'watch_started') update({ phase: 'running', zoomPid: event.zoomPid, message: 'Automações ativas' });
          if (event.event === 'native_call' && event.command === 'query') update({
            connected: event.result.before.inMeetingRaw === 1 && event.result.before.conferenceReadyRaw === 1,
            actualMeetingId: event.result.before.meetingIdRaw, connectionObservedAt: new Date().toISOString() });
          if (event.event === 'media_intent') update({ share: event.hwnd ? 'starting' : 'idle' });
          if (event.event === 'native_call' && event.command === 'start') update(event.result?.returnRaw === 1
            ? { share: 'sent-locally', message: 'Envio solicitado ao Zoom; recepção ainda não confirmada' }
            : { share: 'blocked', message: 'O Zoom recusou o início do compartilhamento' });
          if (event.event === 'native_call' && event.command === 'stop') update({ share: 'idle' });
          if (event.event === 'admission_observation') update({ waiting: event.waiting });
          if (event.event === 'admission_confirmed') update({ message: 'Entrada de participante confirmada' });
          if (event.event === 'admission_requested') update({ message: event.result.acceptedLocally ? 'Admissão solicitada; aguardando confirmação' : 'Zoom não confirmou a admissão' });
          if (['reconcile_error', 'admission_error', 'observer_error'].includes(event.event)) update({ message: event.message, lastError: event.message });
          if (event.event === 'observer_recovered') update({ message: 'Automações ativas', lastError: null });
          if (event.event === 'foreign_share_present') update({ share: 'blocked', message: 'Já existe outro compartilhamento; aguardando liberação' });
        } catch { /* retain the last valid event */ }
      }
    });
    owned.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-3000); });
    owned.on('error', error => update({ phase: 'error', message: error.message }));
    owned.on('close', code => {
      if (child === owned) child = null;
      for (const request of pending.values()) { clearTimeout(request.timeout); request.reject(new Error('Controlador encerrado')); }
      pending.clear();
      update({ phase: code === 0 ? 'stopped' : 'error', connected: false,
        message: code === 0 ? 'Automações encerradas' : stderr.trim() || 'Controlador nativo encerrado com erro' });
    });
    return snapshot();
  }
  function configure(input) {
    validateAutomationSettings(input);
    const result = configurationQueue.catch(() => {}).then(() => apply(input));
    configurationQueue = result;
    return result;
  }
  function command(input) {
    if (!child || state.phase !== 'running') return Promise.reject(new Error('Ative as automações nativas primeiro'));
    const allowed = new Set(['join-audio','leave-audio','mute-self','unmute-self','mute-participant','ask-unmute-participant','mute-all','ask-unmute-all',
      'admit-participant','admit-all','set-allow-unmute','lower-hand','lower-all-hands','reclaim-host','lock-meeting','unlock-meeting',
      'microphone-status','allow-unmute-status','can-reclaim-host','share-start','share-stop','launch-poll','leave']);
    if (!allowed.has(input?.command)) return Promise.reject(new Error('Comando nativo desconhecido'));
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timeout = setTimeout(() => { pending.delete(id); reject(new Error('O Zoom não respondeu ao comando')); }, 12000);
      pending.set(id, { resolve, reject, timeout });
      child.stdin.write(JSON.stringify({ ...input, meetingId: state.meetingId, id }) + '\n');
    });
  }
  function snapshot() { return { ...state }; }
  return { snapshot, configure, command, stop };
}
