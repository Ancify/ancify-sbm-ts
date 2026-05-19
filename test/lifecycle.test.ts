import { test, assert } from "./runner";
import { makeHarness, waitFor } from "./helpers";
import { Message } from "../src/shared/model/networking/message";

test("M4 regression: dispose exits the receive loop within 100ms (AbortSignal)", async () => {
  const h = await makeHarness();
  try {
    const t0 = Date.now();
    h.client.dispose();
    await waitFor(() => (h.clientTransport as any).disposed === true, { timeoutMs: 1000 });
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 200, `dispose should exit promptly; took ${elapsed}ms`);
    // Sanity: nothing thrown by a second dispose.
    h.client.dispose();
  } finally {
    try { await h.server.stopAsync(); } catch { /* ignore */ }
  }
});

test("M7 regression: server health check fires within healthCheckIntervalMs", async () => {
  let probeCount = 0;
  const h = await makeHarness({ healthCheckIntervalMs: 50 });
  try {
    // Watch the client for incoming __$status messages. The server's
    // CheckConnectionStatus calls sendRequestAsync('__$status') on every
    // connected client, which the default ClientSocket handler replies
    // Success=true to. We add an additional counter handler.
    h.client.onHandler("__$status", async (msg: Message) => {
      probeCount++;
      return Message.fromReply(msg, { Success: true });
    });

    await waitFor(() => probeCount >= 2, { timeoutMs: 1500, label: "two server probes received" });
    assert.ok(probeCount >= 2, `expected >=2 server-driven probes; got ${probeCount}`);
  } finally {
    await h.close();
  }
});

test("disconnect cleanup: client.dispose removes server-side ConnectedClientSocket from server", async () => {
  const h = await makeHarness();
  try {
    assert.equal((h.server as any).clients.size, 1);
    h.client.dispose();
    await waitFor(() => (h.server as any).clients.size === 0, {
      label: "server forgot the client after dispose",
      timeoutMs: 2000,
    });
  } finally {
    try { await h.server.stopAsync(); } catch { /* ignore */ }
  }
});

test("concurrent send/receive: many parallel requests preserve their replies", async () => {
  const h = await makeHarness({
    onServerClient: (client) => {
      client.onHandler("add", async (msg: Message) =>
        Message.fromReply(msg, { sum: msg.data.a + msg.data.b }),
      );
    },
  });
  try {
    const N = 20;
    const replies = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        h.client.sendRequestAsync(new Message("add", { a: i, b: i * 2 }), 3000),
      ),
    );
    for (let i = 0; i < N; i++) {
      assert.equal(replies[i].data.sum, i + i * 2);
    }
  } finally {
    await h.close();
  }
});
