import { test, assert, describe } from "../runner";
import { makeHarness, noSsl } from "../helpers";
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

describe("memory hygiene", () => {
  test("reply-channel handlers are cleaned up after a series of successful requests", async () => {
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
      const after = handlerCount(h.client);
      assert.equal(after, baseline, `expected handler count to return to baseline (${baseline}); got ${after}`);
    } finally {
      await h.close();
    }
  });

  test("reply-channel handlers are cleaned up across timeouts and rejected sends", async () => {
    const h = await makeHarness();
    try {
      const baseline = handlerCount(h.client);
      for (let i = 0; i < 20; i++) {
        try {
          await h.client.sendRequestAsync(new Message("missing-channel"), 30);
        } catch {
          // expected timeout
        }
      }
      const after = handlerCount(h.client);
      assert.equal(after, baseline, `timeouts must not accumulate handlers; before=${baseline} after=${after}`);
    } finally {
      await h.close();
    }
  });

  test("no listener leak across 50x connect+dispose cycles", async () => {
    // Stand up one server. Open and dispose 50 separate clients against
    // it. The server's listener count on its underlying net.Server must
    // stay bounded; each ConnectedClientSocket must be removed.
    const server = new ServerSocket("127.0.0.1", 0, noSsl, false, async (id: string) =>
      AuthContext.success(id, [], "client"),
    );
    await server.startAsync();
    const port = ((server as any).server.address() as AddressInfo).port;

    try {
      for (let i = 0; i < 50; i++) {
        const c = new ClientSocket(new TcpTransport("127.0.0.1", port, noSsl));
        await c.connectAsync();
        await c.authenticateAsync("id", "key", "client");
        c.dispose();
      }
      // After all 50 cycles, the server should eventually drop all its
      // ConnectedClientSocket entries. Disposing the client kicks the
      // disconnect propagation which removes from server.clients.
      await new Promise((r) => setTimeout(r, 100));
      assert.ok(
        (server as any).clients.size <= 1,
        `expected server.clients ~0 after 50 cycles; got ${(server as any).clients.size}`,
      );
    } finally {
      await server.stopAsync();
    }
  });

  test("dispose detaches transport listeners (no growth across 20 dispose cycles)", async () => {
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
        // Underlying net.Socket should have a bounded listener count
        // (data, close, end, error, plus a few from the auth pipeline).
        const sock = (transport as any).socket;
        const dataCount = sock.listenerCount("data");
        const errCount = sock.listenerCount("error");
        assert.ok(dataCount <= 2, `data listeners should be <=2 per active connection; got ${dataCount}`);
        assert.ok(errCount <= 4, `error listeners should be bounded; got ${errCount}`);
        c.dispose();
        // After dispose, our detach should have removed our listeners.
        assert.equal(sock.listenerCount("data"), 0, "data listener leak after dispose");
      }
    } finally {
      await server.stopAsync();
    }
  });

  test("server.stopAsync clears clients map and removes listening server", async () => {
    const h = await makeHarness();
    assert.equal((h.server as any).clients.size, 1);
    await h.server.stopAsync();
    assert.equal((h.server as any).clients.size, 0);
    assert.equal((h.server as any).server, undefined);
    h.client.dispose();
  });
});
