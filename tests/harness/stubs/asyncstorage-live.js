// AsyncStorage for the provider suite: the same in-memory map as
// stubs/asyncstorage.js, exposed so a test can inspect what actually reached
// "disk" and clear it between cases. The map deliberately SURVIVES a simulated
// relaunch, because that is the whole point of the suite.
//
// `__esModule: true` IS LOAD-BEARING, and its absence made this stub a
// silent no-op. `src/store/storage.ts` does `import AsyncStorage from '...'`,
// which esbuild compiles to `import_async_storage.default.setItem(...)` via
// `__toESM`. `__toESM` treats a CommonJS module WITHOUT the marker as
// interop-needed and sets `default` to the whole `module.exports` - so
// `.default.setItem` resolved to `undefined`, the resulting TypeError was
// swallowed by `saveState`'s best-effort catch, and every read and write in the
// suite did nothing at all while still reporting success. The marker makes
// `__toESM` pass the object through, so `.default` is this shim.
//
// tests/provider.test.js re-checks the round trip at startup rather than
// trusting this comment: a harness whose storage quietly does nothing can
// report any result it likes.
'use strict';

const mem = {};
globalThis.__ITALA_DISK = mem;

const AsyncStorage = {
  getItem: async k => (k in mem ? mem[k] : null),
  setItem: async (k, v) => { mem[k] = v; },
  removeItem: async k => { delete mem[k]; },
  clear: async () => { for (const k of Object.keys(mem)) delete mem[k]; },
  getAllKeys: async () => Object.keys(mem),
};

module.exports = { __esModule: true, default: AsyncStorage, AsyncStorage };
