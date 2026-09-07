// Supabase Edge Function: delete-account
//
// Apple-linked account deletion. Revokes the Sign in with Apple authorization
// at Apple, then deletes the account - in that order, never the reverse. See
// ../_shared/deleteAccountHandler.ts, which holds the whole flow and is what
// tests/appleRevocation.test.js drives.
//
// Deployment, the four Apple secrets it needs, and the end-to-end device check
// are documented in ../README.md.

import { handleDeleteAccount } from '../_shared/deleteAccountHandler.ts';

// Declared locally rather than pulled from a URL type import: it is the only
// Deno surface this file touches, and declaring it keeps `tsc --noEmit` (which
// runs over the whole repo in `npm test`) able to check this file.
declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (req: Request) => Promise<Response>): void;
};

Deno.serve(req =>
  handleDeleteAccount(req, {
    env: name => Deno.env.get(name),
    fetch: (input, init) => fetch(input, init),
  }),
);
