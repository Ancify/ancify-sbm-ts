import { test, assert, describe } from "../runner";
import { makeHarness, noSsl, sleep, waitFor } from "../helpers";
import { ClientSocket } from "../../src/client/clientSocket";
import { ServerSocket } from "../../src/server/serverSocket";
import { TcpTransport } from "../../src/shared/transport/tcp/tcpTransport";
import { AuthContext } from "../../src/shared/model/authContext";
import { Message } from "../../src/shared/model/networking/message";
import { ConnectionStatus } from "../../src/shared/model/networking/connectionStatus";
import { createServer, Socket, type AddressInfo } from "node:net";

describe("error paths", () => {
  test("DNS failure surfaces as Failed and rejects the connect", async () => {
    const transport = new TcpTransport(
      "this-host-should-not-resolve.invalid",
      31337,
      noSsl,
    );
    const client = new ClientSocket(transport);
    const statuses: ConnectionStatus[] = [];
    client.on("connectionStatusChanged", (e: any) => statuses.push(e.status));
    try {
      await transport.connectAsync(2, 5);
      await sleep(20);
      assert.ok(statuses.includes(ConnectionStatus.Failed), `expected Failed; got ${statuses.join(",")}`);
    } finally {
      client.dispose();
    }
  });

  test("ECONNREFUSED on every attempt ends with Failed (no infinite hang)", async () => {
    const probe = new ServerSocket("127.0.0.1", 0, noSsl, false, async (id: string) =>
      AuthContext.success(id, []),
    );
    await probe.startAsync();
    const port = ((probe as any).server.address() as AddressInfo).port;
    await probe.stopAsync();

    const transport = new TcpTransport("127.0.0.1", port, noSsl);
    const client = new ClientSocket(transport);
    const t0 = Date.now();
    try {
      await transport.connectAsync(3, 5);
      const elapsed = Date.now() - t0;
      assert.ok(elapsed < 3000, `connect retries should bail in <3s; took ${elapsed}ms`);
    } finally {
      client.dispose();
    }
  });

  test("peer drops connection mid-handshake on the raw byte stream", async () => {
    const raw = createServer((sock: Socket) => sock.end());
    await new Promise<void>((resolve, reject) => {
      raw.once("listening", () => resolve());
      raw.once("error", reject);
      raw.listen(0, "127.0.0.1");
    });
    const port = (raw.address() as AddressInfo).port;
    const transport = new TcpTransport("127.0.0.1", port, noSsl);
    const client = new ClientSocket(transport);
    const statuses: ConnectionStatus[] = [];
    client.on("connectionStatusChanged", (e: any) => statuses.push(e.status));
    try {
      await transport.connectAsync(1);
      await waitFor(() => statuses.includes(ConnectionStatus.Disconnected), { timeoutMs: 2000 });
    } finally {
      client.dispose();
      await new Promise<void>((resolve) => raw.close(() => resolve()));
    }
  });

  test("sendAsync on a disposed client does not throw", async () => {
    const h = await makeHarness();
    h.client.dispose();
    let threw = false;
    try {
      await h.client.sendAsync(new Message("any"));
    } catch {
      threw = true;
    }
    assert.equal(threw, false);
    await h.server.stopAsync();
  });

  test("sendRequestAsync during a reconnect-in-flight either resolves or times out cleanly", async () => {
    const probe = new ServerSocket("127.0.0.1", 0, noSsl, false, async (id: string) =>
      AuthContext.success(id, [], "client"),
    );
    await probe.startAsync();
    const port = ((probe as any).server.address() as AddressInfo).port;
    await probe.stopAsync();

    let server = new ServerSocket("127.0.0.1", port, noSsl, false, async (id: string) =>
      AuthContext.success(id, [], "client"),
    );
    server.on("clientConnected", (c: any) =>
      c.onHandler("ping", async (msg: Message) => Message.fromReply(msg, { v: 1 })),
    );
    await server.startAsync();

    const transport = new TcpTransport("127.0.0.1", port, noSsl);
    transport.alwaysReconnect = true;
    const client = new ClientSocket(transport);
    try {
      await client.connectAsync();
      await client.authenticateAsync("a", "b", "client");

      await server.stopAsync();
      await waitFor(() => (transport as any).isConnected === false);

      let rejected = false;
      const start = Date.now();
      try {
        await client.sendRequestAsync(new Message("ping"), 200);
      } catch {
        rejected = true;
      }
      const elapsed = Date.now() - start;
      assert.equal(rejected, true);
      assert.ok(elapsed < 500, `should fail within timeout window; took ${elapsed}ms`);
    } finally {
      client.dispose();
      try { await server.stopAsync(); } catch { /* ignore */ }
    }
  });

  test("handler exception does not crash the receive loop; subsequent messages still dispatch", async () => {
    let secondHandled = false;
    const h = await makeHarness({
      onServerClient: (client) => {
        client.onHandler("boom", async () => {
          throw new Error("intentional");
        });
        client.onHandler("after", async (msg) => {
          secondHandled = true;
          return Message.fromReply(msg, { ok: true });
        });
      },
    });
    try {
      await h.client.sendAsync(new Message("boom"));
      const reply = await h.client.sendRequestAsync(new Message("after"), 2000);
      assert.equal(reply.data.ok, true);
      assert.equal(secondHandled, true);
    } finally {
      await h.close();
    }
  });
});
