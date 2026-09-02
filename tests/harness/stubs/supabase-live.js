// @supabase/supabase-js for the provider suite.
//
// tests/harness/stubs/supabase.js returns null from createClient, which puts the
// app in local-only mode - useful for the bundle that only imports pure
// functions, and useless for a suite whose whole subject is the boot pull, the
// push and the drain.
//
// This returns a forwarding handle instead of the client itself, so
// `getSupabase()`'s memoisation cannot pin one test's server into the next
// test's app: every property access is resolved against whatever client the
// running test has installed.

'use strict';

const handle = new Proxy({}, {
  get(_t, key) {
    const client = globalThis.__ITALA_CLIENT;
    if (!client) throw new Error('supabase-live: no fake client installed on globalThis.__ITALA_CLIENT');
    const value = client[key];
    return typeof value === 'function' ? value.bind(client) : value;
  },
});

module.exports = { createClient: () => handle, SupabaseClient: class {} };
