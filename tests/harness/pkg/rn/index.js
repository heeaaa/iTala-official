// react-native, stubbed for the pure-logic bundle.
//
// Almost everything here is "a function that returns undefined": the bundle
// imports components it never renders, so the shape only has to be callable.
//
// Two APIs are real, because one module under test is pure logic that reads
// them: src/lib/deviceClass.ts decides phone-vs-tablet from Platform.isPad on
// iOS and the shortest side of Dimensions.get('screen') on Android. That
// decision is what frees rotation, so the 600dp boundary and the screen-not-
// window choice are worth asserting, and they cannot be asserted against a
// stub that answers undefined.
//
// The defaults deliberately reproduce the old Proxy's observable answers
// (Platform.OS undefined, so `Platform.OS === 'ios'` stays false) - tests
// describe a device explicitly via __setDeviceEnv, and nothing else in the
// bundle silently changes branch.
const ZERO = { width: 0, height: 0, scale: 1, fontScale: 1 };
const env = { os: undefined, isPad: undefined, screen: { ...ZERO }, window: { ...ZERO } };
const listeners = new Set();

const Platform = {
  get OS() { return env.os; },
  get isPad() { return env.isPad; },
};

const Dimensions = {
  // Returns a copy: a caller that mutated the result must not be able to
  // rewrite the device the test set up.
  get(kind) { return { ...(kind === 'window' ? env.window : env.screen) }; },
  addEventListener(type, cb) {
    if (type === 'change') listeners.add(cb);
    return { remove() { listeners.delete(cb); } };
  },
};

/**
 * Describe the device for the next call. Partial: pass only what matters.
 * Emits the 'change' event, so a subscriber sees a rotation/fold the same way
 * it would on a device.
 */
function __setDeviceEnv(next = {}) {
  if ('os' in next) env.os = next.os;
  if ('isPad' in next) env.isPad = next.isPad;
  if (next.screen) env.screen = { ...ZERO, ...next.screen };
  if (next.window) env.window = { ...ZERO, ...next.window };
  for (const cb of listeners) cb({ screen: { ...env.screen }, window: { ...env.window } });
}

/** Back to the defaults above, so suites cannot leak a device into each other. */
function __resetDeviceEnv() {
  env.os = undefined;
  env.isPad = undefined;
  env.screen = { ...ZERO };
  env.window = { ...ZERO };
  listeners.clear();
}

const real = { Platform, Dimensions, __setDeviceEnv, __resetDeviceEnv };
module.exports = new Proxy(real, {
  get: (target, key) => (key in target ? target[key] : () => undefined),
});
