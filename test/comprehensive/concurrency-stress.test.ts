import { test, assert, describe } from "../runner";
import { makeHarness, noSsl, sleep, waitFor } from "../helpers";
import { ClientSocket } from "../../src/client/clientSocket";
import { ServerSocket } from "../../src/server/serverSocket";
import { TcpTransport } from "../../src/shared/transport/tcp/tcpTransport";
import { AuthContext } from "../../src/shared/model/authContext";
import { Message } from "../../src/shared/model/networking/message";
import type { AddressInfo } from "node:net";

describe("concurrency and stress", () => {
  test("many concurrent connections (16 clients, each round-trips)", async () => {
    const server = new ServerSocket("127.0.0.1", 0, noSsl, false, async (id: string) =>
      AuthContext.success(id, [], "client"),
    );
    server.on("clientConnected", (c: any) =>
      c.onHandler("ping", async (m: Message) => Message.fromReply(m, { from: m.data.from })),
    );
    await server.startAsync();
    const port = ((server as any).server.address() as AddressInfo).port;

    const clients: ClientSocket[] = [];
    try {
      const clientCount = 16;
      await Promise.all(
        Array.from({ length: clientCount }, async (_, i) => {
          const t = new TcpTransport("127.0.0.1", port, noSsl);
          const c = new ClientSocket(t);
          clients.push(c);
          await c.connectAsync();
          await c.authenticateAsync(`id-${i}`, "key", "client");
        }),
      );
      assert.equal((server as any).clients.size, clientCount);

      const replies = await Promise.all(
        clients.map((c, i) => c.sendRequestAsync(new Message("ping", { from: i }), 3000)),
      );
      replies.forEach((r, i) => assert.equal(r.data.from, i));
    } finally {
      for (const c of clients) {
        try { c.dispose(); } catch { /* ignore */ }
      }
      await server.stopAsync();
    }
  });

  test("request burst (200 concurrent in-flight) all resolve correctly", async () => {
    const h = await makeHarness({
      onServerClient: (client) => {
        client.onHandler("idx", async (msg) => Message.fromReply(msg, { i: msg.data.i }));
      },
    });
    try {
      const N = 200;
      const replies = await Promise.all(
        Array.from({ length: N }, (_, i) => h.client.sendRequestAsync(new Message("idx", { i }), 5000)),
      );
      const seen = new Set<number>();
      for (const r of replies) seen.add(r.data.i);
      assert.equal(seen.size, N, "every reply must be unique");
      for (let i = 0; i < N; i++) assert.ok(seen.has(i), `missing reply ${i}`);
    } finally {
      await h.close();
    }
  });

  test("mixed send + receive during a brief reconnect window", async () => {
    const probe = new ServerSocket("127.0.0.1", 0, noSsl, false, async (id: string) =>
      AuthContext.success(id, [], "client"),
    );
    await probe.startAsync();
    const port = ((probe as any).server.address() as AddressInfo).port;
    await probe.stopAsync();

    const startServer = async () => {
      const s = new ServerSocket("127.0.0.1", port, noSsl, false, async (id: string) =>
        AuthContext.success(id, [], "client"),
      );
      s.on("clientConnected", (c: any) =>
        c.onHandler("ping", async (m: Message) => Message.fromReply(m, { v: m.data.v })),
      );
      await s.startAsync();
      return s;
    };

    let server = await startServer();
    const transport = new TcpTransport("127.0.0.1", port, noSsl);
    transport.alwaysReconnect = true;
    const client = new ClientSocket(transport);
    try {
      await client.connectAsync();
      await client.authenticateAsync("a", "b", "client");
      // Successful round-trip before the bounce.
      const r0 = await client.sendRequestAsync(new Message("ping", { v: 0 }), 2000);
      assert.equal(r0.data.v, 0);

      await server.stopAsync();
      await waitFor(() => (transport as any).isConnected === false);
      server = await startServer();
      await waitFor(() => (transport as any).isConnected === true, { timeoutMs: 5000 });
      await client.authenticateAsync("a", "b", "client");

      // After reconnect+reauth, traffic flows again.
      const r1 = await client.sendRequestAsync(new Message("ping", { v: 1 }), 2000);
      assert.equal(r1.data.v, 1);
    } finally {
      client.dispose();
      try { await server.stopAsync(); } catch { /* ignore */ }
    }
  });

  test("backpressure: 64 x 256 KiB writes complete and all arrive", async () => {
    let received = 0;
    const expected = 64;
    const h = await makeHarness({
      onServerClient: (client) => {
        client.onHandler("chunk", async () => {
          received++;
          await sleep(2);
          return null;
        });
      },
    });
    try {
      const payload = "z".repeat(256 * 1024);
      const sends: Promise<void>[] = [];
      for (let i = 0; i < expected; i++) {
        sends.push(h.client.sendAsync(new Message("chunk", { payload })));
      }
      await Promise.all(sends);
      await waitFor(() => received === expected, { timeoutMs: 5000, label: "all chunks delivered" });
    } finally {
      await h.close();
    }
  });

  test("message ordering is preserved per-connection", async () => {
    const order: number[] = [];
    const h = await makeHarness({
      onServerClient: (client) => {
        client.onHandler("seq", async (msg) => {
          order.push(msg.data.i);
          return null;
        });
      },
    });
    try {
      const N = 100;
      for (let i = 0; i < N; i++) {
        await h.client.sendAsync(new Message("seq", { i }));
      }
      await waitFor(() => order.length === N, { timeoutMs: 3000 });
      for (let i = 0; i < N; i++) {
        assert.equal(order[i], i, `out-of-order at index ${i}: got ${order[i]}`);
      }
    } finally {
      await h.close();
    }
  });
});
