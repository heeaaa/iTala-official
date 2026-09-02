// react-native for the provider suite.
//
// tests/harness/pkg/rn answers every property with a no-op function, which is
// enough for modules that only import types or components they never render.
// StoreProvider CALLS two of them - Alert.alert, and AppState.addEventListener
// whose return value it stores and calls .remove() on - so the no-op proxy
// throws the moment the provider mounts. Only those two are modelled; anything
// else keeps the permissive proxy behaviour.

'use strict';

const alerts = [];
const appStateListeners = new Set();

const real = {
  Alert: {
    alert(title, message, buttons) { alerts.push({ title, message, buttons }); },
  },
  AppState: {
    currentState: 'active',
    addEventListener(type, handler) {
      const entry = { type, handler };
      appStateListeners.add(entry);
      return { remove() { appStateListeners.delete(entry); } };
    },
  },
  Platform: { OS: 'ios', select: (o) => o.ios ?? o.default },
  // Test-only handles, namespaced so they cannot collide with a real export.
  __alerts: alerts,
  __emitAppState(next) {
    real.AppState.currentState = next;
    for (const { type, handler } of [...appStateListeners]) {
      if (type === 'change') handler(next);
    }
  },
  __appStateListenerCount() { return appStateListeners.size; },
};

// Published for the same reason react-live is: the provider bundle INLINES this
// module, so a test that required the copy on disk would be emitting app-state
// changes into a different listener set than the one the component subscribed
// to - and the reconnect path would look broken (or, worse, look fine) for a
// reason that has nothing to do with the app.
const mod = new Proxy(real, {
  get(target, key) {
    if (key in target) return target[key];
    return () => undefined;
  },
  has() { return true; },
});

globalThis.__ITALA_RN = mod;
module.exports = mod;
