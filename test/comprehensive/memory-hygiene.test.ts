import { test, assert, describe } from "../runner";
import { makeHarness, noSsl, sleep } from "../helpers";
import { ClientSocket } from "../../src/client/clientSocket";
import { ServerSocket } from "../../src/server/serverSocket";
import { TcpTransport } from "../../src/shared/transport/tcp/tcpTransport";
import { AuthContext } from "../../src/shared/model/authContext";
import { Message } from "../../src/shared/model/networking/message";
import type { AddressInfo } from "node:net";

function handlerCount(socket: any): number {
  const map: Map<string, unknown[]> = socket._handlers;
  let n = 0;
  for (const arr of map.values()) n += arr.length;
  return n;
}

// Categorize active handles by node:_getActiveResources/process.getActiveResourcesInfo.
// We care about TCPSocketWrap/TCPServerWrap counts, not Timer/Immediate (they churn).
function tcpHandleCount(): number {
  const info: string[] = (process as any).getActiveResourcesInfo?.() ?? [];
  return info.filter((k) => k.startsWith("TCP")).length;
}

describe("memory hygiene", () => {
  test("handler map returns to baseline after 50 successful requests", async () => {
    const h = await makeHarness({
      onServerClient: (client) => {
        client.onHandler("echo", async (msg) => Message.fromReply(msg, { v: msg.data.v }));
      },
    });
    try {
      const baseline = handlerCount(h.client);
      for (let i = 0; i < 50; i++) {
        await h.client.sendRequestAsync(new Message("echo", { v: i }), 2000);
      }
      assert.equal(handlerCount(h.client), baseline);
    } finally {
      await h.close();
    }
  });

  test("handler map returns to baseline after 20 timeouts on a dead channel", async () => {
    const h = await makeHarness();
    try {
      const baseline = handlerCount(h.client);
      for (let i = 0; i < 20; i++) {
        try {
          await h.client.sendRequestAsync(new Message("missing-channel"), 30);
        } catch {
          // expected
        }
      }
      assert.equal(handlerCount(h.client), baseline);
    } finally {
      await h.close();
    }
  });

  test("100 client connect+dispose cycles do not leak TCP handles", async () => {
    const server = new ServerSocket("127.0.0.1", 0, noSsl, false, async (id: string) =>
      AuthContext.success(id, [], "client"),
    );
    await server.startAsync();
    const port = ((server as any).server.address() as AddressInfo).port;

    try {
      // Pre-warm so the runtime resolves DNS caches, lazy modules, etc.
      // before we sample the baseline handle count.
      const warm = new ClientSocket(new TcpTransport("127.0.0.1", port, noSsl));
      await warm.connectAsync();
      await warm.authenticateAsync("warm", "k", "client");
      warm.dispose();
      await sleep(50);

      const baselineHandles = tcpHandleCount();
      for (let i = 0; i < 100; i++) {
        const c = new ClientSocket(new TcpTransport("127.0.0.1", port, noSsl));
        await c.connectAsync();
        await c.authenticateAsync("id", "key", "client");
        c.dispose();
      }
      // Let close/end events propagate through the kernel + libuv before
      // sampling; without this the count is dominated by sockets still in
      // FIN-WAIT teardown rather than by leaks.
      await sleep(250);

      const finalHandles = tcpHandleCount();
      // Slack of 4 covers the listening TCPServerWrap and a handful of
      // sockets still draining in libuv. The leak this guards against is
      // proportional (one per cycle), so any leak would show up as
      // ~100 extras here.
      assert.ok(
        finalHandles - baselineHandles <= 4,
        `TCP handle delta after 100 cycles: baseline=${baselineHandles} final=${finalHandles}`,
      );
      assert.equal((server as any).clients.size, 0);
    } finally {
      await server.stopAsync();
    }
  });

  test("dispose detaches data listeners from the underlying socket", async () => {
    const server = new ServerSocket("127.0.0.1", 0, noSsl, false, async (id: string) =>
      AuthContext.success(id, [], "client"),
    );
    await server.startAsync();
    const port = ((server as any).server.address() as AddressInfo).port;

    try {
      for (let i = 0; i < 20; i++) {
        const transport = new TcpTransport("127.0.0.1", port, noSsl);
        const c = new ClientSocket(transport);
        await c.connectAsync();
        const sock = (transport as any).socket;
        assert.ok(sock.listenerCount("data") <= 2);
        assert.ok(sock.listenerCount("error") <= 4);
        c.dispose();
        assert.equal(sock.listenerCount("data"), 0);
      }
    } finally {
      await server.stopAsync();
    }
  });

  test("stopAsync clears clients map and releases the listening server", async () => {
    const h = await makeHarness();
    assert.equal((h.server as any).clients.size, 1);
    await h.server.stopAsync();
    assert.equal((h.server as any).clients.size, 0);
    assert.equal((h.server as any).server, undefined);
    h.client.dispose();
  });
});
