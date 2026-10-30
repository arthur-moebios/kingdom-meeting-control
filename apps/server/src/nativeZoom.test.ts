import { afterEach, expect, it, vi } from 'vitest';
import { SettingsSchema } from '@kmc/shared-types';
import { NativeZoomService } from './nativeZoom.js';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
function setup(connected: boolean, actualMeetingId = '1234567890', connectionAge = 0) {
  const settings = SettingsSchema.parse({ meeting: { meetingId: '1234567890' }, reconnect: { enabled: false } });
  const automation = { phase: 'running', connected, zoomPid: 1234, actualMeetingId, share: 'idle', connectionObservedAt: new Date(Date.now() - connectionAge).toISOString() };
  const snapshot = { pid: 1234, observedAt: new Date().toISOString(), sessionToken: 'test-session', participants: [],
    waitingRoom: [], raisedHands: { order: [], orderSource: 'detection-time', partial: false } };
  const fetch = vi.fn(async (url: string | URL | Request) => new Response(JSON.stringify(
    String(url).endsWith('/snapshot') ? snapshot : String(url).endsWith('/command') ? { role: { hostRaw: 1 } } : automation), { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  const service = new NativeZoomService({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    profileDir: '', headless: false, zoomWebUrl: 'https://app.zoom.us', getSettings: () => settings,
    isPresentationActive: () => false, emit: vi.fn() });
  return { service, fetch };
}

it('cached native participant memory cannot impersonate an active meeting', async () => {
  const { service } = setup(false);
  await (service as any).refresh();
  expect(service.getStatus().state).not.toBe('IN_MEETING');
  expect(service.getStatus().participantCount).toBe(0);
});

it('native snapshots from another room do not populate the configured room', async () => {
  const { service } = setup(true, '1111111111');
  await (service as any).refresh();
  expect(service.getStatus().state).not.toBe('IN_MEETING');
});

it('a stale connection observation cannot authorize a fresh passive roster', async () => {
  const { service } = setup(true, '1234567890', 10000);
  await (service as any).refresh();
  expect(service.getStatus().state).not.toBe('IN_MEETING');
});

it('native connection and local role are observed without a Chromium session', async () => {
  const { service } = setup(true);
  await (service as any).refresh();
  expect(service.getStatus()).toMatchObject({ backend: 'native', state: 'IN_MEETING', role: 'host', browserRunning: false });
});

it('duplicate names cannot select an arbitrary native participant', async () => {
  const { service, fetch } = setup(true);
  (service as any).snapshot = { participants: [{ id: '1', displayName: 'Duplicado' }, { id: '2', displayName: 'Duplicado' }] };
  await expect(service.unmuteParticipant('Duplicado')).rejects.toThrow('nome duplicado');
  expect(fetch).not.toHaveBeenCalled();
});
