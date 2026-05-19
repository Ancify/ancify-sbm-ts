import { test, assert, describe } from "../runner";
import { makeHarness, noSsl, sleep, waitFor } from "../helpers";
import { ClientSocket } from "../../src/client/clientSocket";
import { ServerSocket } from "../../src/server/serverSocket";
import { TcpTransport } from "../../src/shared/transport/tcp/tcpTransport";
import { AuthContext } from "../../src/shared/model/authContext";
import { ConnectionStatus } from "../../src/shared/model/networking/connectionStatus";
import type { AddressInfo } from "node:net";

describe("ConnectionStatus lifecycle", () => {
  test("connecting -> connected -> authenticated on a clean connection", async () => {
    const statuses: ConnectionStatus[] = [];
    const server = new ServerSocket("127.0.0.1", 0, noSsl, false, async (id: string) =>
      AuthContext.success(id, [], "client"),
    );
    await server.startAsync();
    const port = ((server as any).server.address() as AddressInfo).port;
    const transport = new TcpTransport("127.0.0.1", port, noSsl);
    const client = new ClientSocket(transport);
    client.on("connectionStatusChanged", (e: any) => statuses.push(e.status));
    try {
      await client.connectAsync();
      await client.authenticateAsync("a", "b", "client");
      await sleep(20);
      assert.ok(statuses.includes(ConnectionStatus.Connecting));
      assert.ok(statuses.includes(ConnectionStatus.Connected));
      assert.ok(statuses.includes(ConnectionStatus.Authenticated));
    } finally {
      client.dispose();
      await server.stopAsync();
    }
  });

  test("disconnected fires when peer closes the socket", async () => {
    const h = await makeHarness();
    const statuses: ConnectionStatus[] = [];
    h.client.on("connectionStatusChanged", (e: any) => statuses.push(e.status));
    try {
      await h.server.stopAsync();
      await waitFor(() => statuses.includes(ConnectionStatus.Disconnected), {
        label: "disconnected after server stop",
      });
    } finally {
      h.client.dispose();
    }
  });

  test("reconnecting -> reconnected after server restart", async () => {
    const probe = new ServerSocket("127.0.0.1", 0, noSsl, false, async (id: string) =>
      AuthContext.success(id, [], "client"),
    );
    await probe.startAsync();
    const port = ((probe as any).server.address() as AddressInfo).port;
    await probe.stopAsync();

    let server = await startServer(port);
    const transport = new TcpTransport("127.0.0.1", port, noSsl);
    transport.alwaysReconnect = true;
    const client = new ClientSocket(transport);
    const statuses: ConnectionStatus[] = [];
    client.on("connectionStatusChanged", (e: any) => statuses.push(e.status));
    try {
      await client.connectAsync();
      await client.authenticateAsync("a", "b", "client");
      await server.stopAsync();
      await waitFor(() => (transport as any).isConnected === false);
      server = await startServer(port);
      await waitFor(() => (transport as any).isConnected === true, { timeoutMs: 5000 });
      await sleep(50);
      assert.ok(statuses.includes(ConnectionStatus.Reconnecting), `got ${statuses.join(",")}`);
      assert.ok(statuses.includes(ConnectionStatus.Reconnected), `got ${statuses.join(",")}`);
    } finally {
      client.dispose();
      await server.stopAsync();
    }
  });

  test("failed status when connect cannot reach host", async () => {
    // Bind a server briefly to claim a port, then release it so the
    // client's connectAsync to that port fails reliably with ECONNREFUSED.
    const probe = new ServerSocket("127.0.0.1", 0, noSsl, false, async (id: string) =>
      AuthContext.success(id, []),
    );
    await probe.startAsync();
    const port = ((probe as any).server.address() as AddressInfo).port;
    await probe.stopAsync();

    const transport = new TcpTransport("127.0.0.1", port, noSsl);
    const client = new ClientSocket(transport);
    const statuses: ConnectionStatus[] = [];
    client.on("connectionStatusChanged", (e: any) => statuses.push(e.status));
    try {
      await transport.connectAsync(2, 10);
      await sleep(20);
      assert.ok(statuses.includes(ConnectionStatus.Failed), `expected Failed; got ${statuses.join(",")}`);
    } finally {
      client.dispose();
    }
  });

  test("status events emit on a non-reconnecting transport when peer closes", async () => {
    const h = await makeHarness({ alwaysReconnect: false });
    const statuses: ConnectionStatus[] = [];
    h.client.on("connectionStatusChanged", (e: any) => statuses.push(e.status));
    try {
      await h.server.stopAsync();
      await waitFor(() => statuses.includes(ConnectionStatus.Disconnected));
      await sleep(50);
      assert.ok(!statuses.includes(ConnectionStatus.Reconnecting), "no reconnect attempt when alwaysReconnect=false");
    } finally {
      h.client.dispose();
    }
  });
});

async function startServer(port: number): Promise<ServerSocket> {
  const s = new ServerSocket("127.0.0.1", port, noSsl, false, async (id: string) =>
    AuthContext.success(id, [], "client"),
  );
  await s.startAsync();
  return s;
}
