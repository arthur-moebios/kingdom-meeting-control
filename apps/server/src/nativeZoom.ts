import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type { Capabilities, RaisedHands, ZoomParticipant, ZoomState, ZoomStatus } from '@kmc/shared-types';
import type { ZoomAutomationDeps } from '@kmc/zoom-automation';
import { repoRoot } from '@kmc/config';

const origin = 'http://127.0.0.1:4318';
type Person = ZoomParticipant;
interface NativeSnapshot {
  pid: number; observedAt: string; stale?: boolean; sessionToken: string; participants: Person[];
  waitingRoom: Person[]; raisedHands: RaisedHands;
  polls?: { normalizedResults?: { pollName: string; question: string; totalVoted: number;
    totalParticipants: number | null; options: { label: string; votes: number; total: number; percent: number | null }[] }[] };
}

/** Reuses the production server, timers, tablet and persistence with native Zoom. */
export class NativeZoomService {
  private child: ChildProcess | null = null;
  private timer: NodeJS.Timeout | null = null;
  private snapshot: NativeSnapshot | null = null;
  private automation: Record<string, any> = {};
  private current: ZoomState = 'STOPPED';
  private error: string | null = null;
  private applying: Promise<unknown> = Promise.resolve();
  private configuration = '';
  private refreshRunning = false;
  private joinedAt: string | null = null;
  private digest = '';
  private lastRestart = 0;
  private role: 'host' | 'participant' | null = null;
  private seenToken: string | null = null;
  private nextRole = 0;
  private sessionConfigured = '';
  private intentionalLeave = false;
  private everConnected = false;
  private reconnectAttempts = 0;
  private nextReconnect = 0;
  private joining: Promise<void> | null = null;
  constructor(private readonly deps: ZoomAutomationDeps) {}
  get state(): ZoomState { return this.current; }
  private async request(route: string, body?: unknown): Promise<any> {
    const response = await fetch(origin + '/api/v1/native/' + route, { signal: AbortSignal.timeout(15000),
      method: body === undefined ? 'GET' : 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const value: any = await response.json();
    if (!response.ok) throw new Error(value.error || `Native HTTP ${response.status}`);
    return value;
  }
  async initialize(): Promise<void> {
    this.current = 'INITIALIZING';
    try {
      try { await this.request('automations'); }
      catch {
        const script = path.join(repoRoot, 'native-server.mjs');
        if (!fs.existsSync(script)) throw new Error('Pacote nativo incompleto: native-server.mjs ausente');
        this.child = spawn(process.execPath, [script], { cwd: repoRoot, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'],
          env: { ...process.env, KMC_NATIVE_PORT: '4318', KMC_PARENT_PROCESS_MANAGED: '1' } });
        this.child.on('error', err => { this.error = err.message; });
        for (let i = 0; i < 40; i++) {
          try { await this.request('automations'); break; } catch { await new Promise(r => setTimeout(r, 200)); }
        }
      }
      await this.refresh();
      this.timer = setInterval(() => void this.refresh(), 750);
      this.timer.unref();
      await this.applySettings();
    } catch (error) { this.error = String(error); this.current = 'ERROR'; }
  }
  private async refresh(): Promise<void> {
    if (this.refreshRunning) return;
    this.refreshRunning = true;
    try {
      this.automation = await this.request('automations');
      const state = await this.request('snapshot').catch(() => null) as NativeSnapshot | null;
      const fresh = !!state && !state.stale && Date.now() - Date.parse(state.observedAt) < 5000;
      if (fresh && !this.intentionalLeave && ['error','stopped'].includes(this.automation.phase) && Date.now() - this.lastRestart > 5000) {
        this.configuration = ''; this.lastRestart = Date.now();
      }
      const connectionFresh = Date.now() - Date.parse(this.automation.connectionObservedAt || '') < 5000;
      if (fresh && connectionFresh && Number.isInteger(state.pid) && state.pid === this.automation.zoomPid && !this.intentionalLeave && this.automation.connected === true && this.automation.phase === 'running' && this.automation.actualMeetingId === this.deps.getSettings().meeting.meetingId.replace(/\D/g, '')) {
        const changed = this.seenToken !== state.sessionToken;
        this.seenToken = state.sessionToken;
        this.snapshot = state;
        this.everConnected = true; this.reconnectAttempts = 0;
        if (changed) { this.role = null; this.nextRole = 0; this.joinedAt = new Date().toISOString(); this.deps.emit('zoom.connected', { backend: 'native' }); }
        this.current = this.automation.share === 'sent-locally' ? 'SHARING' : 'IN_MEETING';
        this.error = this.automation.lastError || null;
      } else {
        this.snapshot = null;
        if (this.current !== 'JOINING') this.current = 'AUTHENTICATED';
        const reconnect = this.deps.getSettings().reconnect;
        if (this.everConnected && !this.intentionalLeave && !this.joining && reconnect.enabled && Date.now() >= this.nextReconnect) {
          if (this.reconnectAttempts < reconnect.maxAttempts) {
            const delay = Math.min(reconnect.maxDelayMs, reconnect.baseDelayMs * 2 ** this.reconnectAttempts++);
            this.nextReconnect = Date.now() + delay;
            this.current = 'RECONNECTING';
            setTimeout(() => void this.join().catch(error => { this.error = String(error); }), 0).unref();
          } else { this.current = 'ERROR'; this.error = 'Limite de tentativas de reconexão atingido'; }
        }
      }
      if (fresh && this.automation.phase === 'error') { this.current = 'ERROR'; this.error = String(this.automation.message || 'Controle nativo indisponível').trim().split('\n').at(-1) || null; }
      const digest = JSON.stringify([this.current, this.role, this.error, this.snapshot?.participants, this.automation.share]);
      if (digest !== this.digest) { this.digest = digest; this.deps.emit('zoom.state.changed', { backend: 'native', state: this.current }); }
      await this.applySettings();
      await this.refreshRole();
    } catch (error) { this.error = String(error); this.current = 'ERROR'; }
    finally { this.refreshRunning = false; }
  }
  private async refreshRole(): Promise<void> {
    if (!this.snapshot || this.automation.phase !== 'running' || Date.now() < this.nextRole) return;
    this.nextRole = Date.now() + 5000;
    const status = await this.command('microphone-status');
    this.role = status.role?.hostRaw === 1 ? 'host' : status.role?.hostRaw === 0 ? 'participant' : null;
    const settings = this.deps.getSettings().automations;
    if (this.sessionConfigured !== this.snapshot.sessionToken) {
      if (settings.lockUnmute) await this.setLockUnmute(true);
      if (settings.autoLaunchPoll) await this.launchPoll();
      this.sessionConfigured = this.snapshot.sessionToken;
    }
    if (settings.autoReclaimHost && this.role === 'participant') {
      const eligible = await this.command('can-reclaim-host');
      if (eligible.returnRaw === 1) await this.reclaimHost();
    }
  }
  async applySettings(): Promise<void> {
    const settings = this.deps.getSettings();
    const config = { meetingId: settings.meeting.meetingId.replace(/\D/g, ''),
      autoShare: settings.share.mode === 'automatic', autoAdmit: settings.automations.autoAdmit,
      shareAudio: settings.share.shareAudio, controlSession: true };
    const key = JSON.stringify(config);
    if (key === this.configuration || !/^\d{9,11}$/.test(config.meetingId)) return;
    this.configuration = key;
    this.applying = this.applying.catch(() => {}).then(async () => {
      try { this.automation = await this.request('automations', config); }
      catch (error) { this.configuration = ''; throw error; }
    });
    await this.applying;
  }
  async join(): Promise<void> {
    this.intentionalLeave = false;
    if (this.joining) return this.joining;
    this.joining = this.joinOnce().finally(() => { this.joining = null; });
    return this.joining;
  }
  private async joinOnce(): Promise<void> {
    // Give discovery a chance to attach to an existing room before launching
    // another URI or applying microphone-on-join to a meeting already in use.
    await this.refresh();
    for (let attempt = 0; !this.snapshot && this.automation.phase === 'starting' && attempt < 10; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      await this.refresh();
    }
    if (this.snapshot) { await this.applySettings(); return; }
    const settings = this.deps.getSettings().meeting;
    const room = settings.meetingId.replace(/\D/g, '');
    if (!/^\d{9,11}$/.test(room)) throw new Error('Configure o ID da reunião');
    const executable = path.join(process.env.APPDATA || '', 'Zoom', 'bin', 'Zoom.exe');
    if (!fs.existsSync(executable)) throw new Error('Zoom desktop não encontrado');
    const query = new URLSearchParams({ confno: room, uname: settings.displayName });
    if (settings.passcode) query.set('pwd', settings.passcode);
    // The signed-in owner starts their own room through the native join route.
    // The /start URI did not start the room in our live test; join did (host=1).
    const scheme = 'join';
    this.current = 'JOINING';
    const launch = spawn(executable, ['--url=zoommtg://zoom.us/' + scheme + '?' + query.toString()], { windowsHide: true, stdio: 'ignore' });
    await new Promise<void>((resolve, reject) => { launch.once('spawn', resolve); launch.once('error', reject); });
    await this.applySettings();
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      await this.refresh();
      if (this.snapshot) {
        try {
          await this.command('join-audio');
          // The native audio connection completes asynchronously. Respect the
          // client's command throttle before applying the microphone policy.
          await new Promise(resolve => setTimeout(resolve, 500));
          await this.command(settings.micOnJoin ? 'unmute-self' : 'mute-self');
        }
        catch (error) { this.deps.log.warn({ err: String(error) }, 'Native microphone-on-join not confirmed'); }
        return;
      }
      await new Promise(r => setTimeout(r, 500));
    }
    this.current = 'ERROR';
    throw new Error('O Zoom não confirmou entrada na reunião. Verifique login ou senha no cliente.');
  }
  private async command(command: string, extra: Record<string, unknown> = {}): Promise<any> {
    const result = await this.request('command', { command, ...extra });
    if (result.acceptedLocally === false || result.acceptedLocally === 0) throw new Error('O Zoom recusou o comando');
    return result;
  }
  async leave(): Promise<void> {
    this.intentionalLeave = true; this.snapshot = null;
    await this.command('leave');
    for (let attempt = 0; attempt < 30; attempt++) {
      const controller = await this.request('automations');
      if (controller.phase === 'stopped' || controller.phase === 'error') break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    this.current = 'AUTHENTICATED';
  }
  async recover(): Promise<void> { await this.join(); }
  async shutdown(): Promise<void> {
    this.intentionalLeave = true; this.everConnected = false;
    if (this.timer) clearInterval(this.timer);
    const child = this.child;
    await this.request('shutdown', {}).catch(() => { child?.kill(); }); this.child = null;
    this.current = 'STOPPED';
  }
  async waitForLogin(): Promise<boolean> { return this.refreshAuth(); }
  async refreshAuth(): Promise<boolean> { await this.refresh(); return !!this.snapshot; }
  getStatus(): ZoomStatus {
    const hosts = this.role === 'host' ? this.listParticipants().filter(person => person.isHost) : [];
    const micOn = hosts.length === 1 && typeof hosts[0]!.isMuted === 'boolean' ? !hosts[0]!.isMuted : null;
    return { backend: 'native', state: this.current, authenticated: !!this.snapshot || this.current === 'AUTHENTICATED',
      browserRunning: false, meetingId: this.snapshot ? this.deps.getSettings().meeting.meetingId : null,
      role: this.snapshot ? this.role : null, joinedAt: this.joinedAt, micOn, cameraOn: null,
      sharing: this.current === 'SHARING', participantCount: this.listParticipants().length,
      lastError: this.error, updatedAt: new Date().toISOString() };
  }
  listParticipants(): ZoomParticipant[] { return this.snapshot?.participants || []; }
  getRaisedHands(): RaisedHands { return this.snapshot?.raisedHands || { order: [], orderSource: 'detection-time', partial: true }; }
  getCapabilities(): Capabilities { return { native: 'experimental', participants: 'experimental', autoAdmit: 'experimental',
    autoShareMonitor: 'experimental', pollResults: 'experimental', launchPoll: 'experimental', mute: 'experimental',
    cameraSelection: 'unsupported' }; }
  async admitAll(): Promise<number> { const count = this.snapshot?.waitingRoom.length || 0; await this.command('admit-all'); return count; }
  async setLockUnmute(lock: boolean): Promise<boolean> {
    await this.command('set-allow-unmute', { allowUnmute: !lock });
    for (let attempt = 0; attempt < 25; attempt++) {
      const status = await this.command('allow-unmute-status');
      if (status.returnRaw === Number(!lock)) return true;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('O Zoom ainda não confirmou a permissão de microfone');
  }
  async unmuteParticipant(name: string): Promise<boolean> {
    const matches = this.listParticipants().filter(person => person.displayName === name);
    if (matches.length !== 1) throw new Error('Participante ausente ou nome duplicado');
    await this.command('ask-unmute-participant', { participantId: Number(matches[0]!.id) }); return true;
  }
  async reclaimHost(): Promise<boolean> { if (this.role !== 'host') await this.command('reclaim-host'); return true; }
  async launchPoll(): Promise<boolean> { await this.command('launch-poll', { pollName: this.deps.getSettings().automations.pollName }); return true; }
  async setBrowserHidden(hidden: boolean): Promise<void> { await this.request('desktop', { hidden }); }
  async startMonitorShare(): Promise<boolean> { await this.command('share-start'); return true; }
  async stopMonitorShare(): Promise<void> { await this.command('share-stop'); }
  async openSharePicker(): Promise<boolean> { return this.startMonitorShare(); }
  async onPresentationChange(_active: boolean): Promise<void> { /* the validated native controller owns media transitions */ }
  async diagnose(): Promise<unknown> { return { automations: this.automation, snapshot: this.snapshot }; }
  async dumpParticipants(): Promise<unknown> { return this.snapshot; }
  async scrapePollResults(_open = true): Promise<any> {
    const wanted = this.deps.getSettings().automations.pollName;
    return this.snapshot?.polls?.normalizedResults?.find(poll => !wanted || poll.pollName === wanted) || null;
  }
}
