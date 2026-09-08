import { DeviceEventEmitter, Platform } from 'react-native';
import { devLog, isDevBuild } from '../lib/log';

let sequence = 0;

// Never emit raw error messages: native descriptions may contain URLs, and
// PostgREST errors may contain roster values. Classify known phrases only.
export function networkCategory(value: unknown): string {
  const message = typeof value === 'string' ? value : '';
  if (/network connection was lost/i.test(message)) return 'connection-lost';
  if (/not connected to the internet|internet connection appears to be offline/i.test(message)) return 'offline';
  if (/could not connect to the server|cannot connect to host/i.test(message)) return 'cannot-connect';
  if (/server with the specified hostname could not be found|cannot find host/i.test(message)) return 'host-not-found';
  if (/secure connection|certificate|ssl/i.test(message)) return 'tls';
  if (/timed out|timeout/i.test(message)) return 'timeout';
  if (/cancelled|canceled|aborted/i.test(message)) return 'cancelled';
  if (/network request failed|fetch failed|failed to fetch/i.test(message)) return 'generic-network';
  return 'other';
}

export function createRosterTrace() {
  const enabled = isDevBuild();
  const attempt = ++sequence, started = Date.now();
  let stage = 'START';
  const mark = (phase: string, fields: Record<string, string | number | boolean | null> = {}) => {
    stage = phase;
    if (!enabled) return;
    try { devLog('[roster-diag]', JSON.stringify({ attempt, phase, at: new Date().toISOString(), elapsedMs: Date.now() - started, ...fields })); }
    catch { /* Diagnostics cannot change the import outcome. */ }
  };
  const watchNative = (): (() => void) => {
    if (!enabled || Platform.OS !== 'ios') return () => {};
    try {
      // Passive observation of the event emitted by this installed RN version's
      // RCTNetworking.mm. No monkey-patching, extra requests, headers or payloads.
      const subscription = DeviceEventEmitter.addListener('didCompleteNetworkResponse', (event: unknown) => {
        if (!Array.isArray(event) || !event[1]) return;
        const during = stage;
        mark('NATIVE_FAILURE_UNCORRELATED', {
          during, requestId: typeof event[0] === 'number' ? event[0] : null,
          category: networkCategory(event[1]), nativeTimedOut: event[2] === true,
        });
        stage = during;
      });
      return () => { try { subscription.remove(); } catch { /* best effort */ } };
    } catch { mark('NATIVE_LISTENER_UNAVAILABLE'); return () => {}; }
  };
  return { mark, watchNative };
}
