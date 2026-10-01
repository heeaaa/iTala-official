import { handleConnectLinkState } from '../_shared/connectLinkState.ts';
declare const Deno: { env: { get(name: string): string | undefined }; serve(handler: (req: Request) => Promise<Response>): void };
Deno.serve(req => handleConnectLinkState(req, { env: name => Deno.env.get(name), fetch }));
