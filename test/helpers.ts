import { ClientSocket } from "../src/client/clientSocket";
import { ServerSocket } from "../src/server/serverSocket";
import { SslConfig, TcpTransport } from "../src/shared/transport/tcp/tcpTransport";
import { AuthContext } from "../src/shared/model/authContext";
import type { AddressInfo } from "node:net";

export const noSsl: SslConfig = { sslEnabled: false, rejectUnauthorized: false };

export const acceptAllAuth = async (id: string): Promise<AuthContext> =>
  AuthContext.success(id, [], "client");

export interface Harness {
  server: ServerSocket;
  client: ClientSocket;
  clientTransport: TcpTransport;
  port: number;
  close: () => Promise<void>;
}

export async function makeHarness(opts: {
  port?: number;
  authHandler?: (id: string, key: string, scope?: string) => Promise<AuthContext>;
  disallowAnonymous?: boolean;
  healthCheckIntervalMs?: number;
  alwaysReconnect?: boolean;
  authenticate?: boolean; // default: true
  // Called for every client the server accepts, before the test's
  // client.connectAsync resolves. Use this to register message handlers
  // on the server-side ConnectedClientSocket without racing the
  // clientConnected event.
  onServerClient?: (client: import("../src/server/connectedClientSocket").ConnectedClientSocket) => void;
} = {}): Promise<Harness> {
  const authHandler = opts.authHandler ?? acceptAllAuth;
  const server = new ServerSocket("127.0.0.1", opts.port ?? 0, noSsl, false, authHandler);
  if (opts.disallowAnonymous) server.disallowAnonymous();
  if (opts.healthCheckIntervalMs !== undefined) server.healthCheckIntervalMs = opts.healthCheckIntervalMs;

  if (opts.onServerClient) {
    server.on("clientConnected", opts.onServerClient);
  }

  await server.startAsync();
  const addr = (server as any).server.address() as AddressInfo;
  const port = addr.port;

  const clientTransport = new TcpTransport("127.0.0.1", port, noSsl);
  if (opts.alwaysReconnect) clientTransport.alwaysReconnect = true;
  const client = new ClientSocket(clientTransport);
  await client.connectAsync();
  if (opts.authenticate !== false) {
    const ok = await client.authenticateAsync("test-id", "test-key", "client");
    if (!ok) throw new Error("Initial auth failed in test harness");
  }

  return {
    server,
    client,
    clientTransport,
    port,
    close: async () => {
      try { client.dispose(); } catch { /* ignore */ }
      try { await server.stopAsync(); } catch { /* ignore */ }
    },
  };
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Polls predicate until it returns true or the deadline elapses.
// Used in place of arbitrary sleep() when we need to await an
// asynchronous state transition driven by the SBM internals.
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 2000;
  const intervalMs = opts.intervalMs ?? 5;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(intervalMs);
  }
  throw new Error(`waitFor timed out${opts.label ? ` (${opts.label})` : ""}`);
}
