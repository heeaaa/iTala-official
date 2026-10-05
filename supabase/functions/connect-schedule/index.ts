import { handleConnectSchedule } from '../_shared/connectSchedule.ts';

declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (req: Request) => Promise<Response>): void;
};

Deno.serve(req => handleConnectSchedule(req, { env: name => Deno.env.get(name), fetch }));
