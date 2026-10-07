import { handleConnectReports } from '../_shared/connectReports.ts';

declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (req: Request) => Promise<Response>): void;
};

Deno.serve(req => handleConnectReports(req, { env: name => Deno.env.get(name), fetch }));
