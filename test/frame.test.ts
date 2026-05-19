import { test, assert } from "./runner";
import { makeHarness, sleep, waitFor } from "./helpers";
import { Message } from "../src/shared/model/networking/message";
import { MAX_FRAME_BYTES } from "../src/shared/transport/tcp/tcpTransport";
import { createConnection } from "node:net";

test("C5 regression: oversize frame from peer aborts the read loop", async () => {
  // We start the server directly here (no client.connectAsync) so the
  // only client in server.clients is the raw socket we control.
  const { ServerSocket } = await import("../src/server/serverSocket");
  const { AuthContext } = await import("../src/shared/model/authContext");
  const { noSsl: ssl } = await import("./helpers");
  const server = new ServerSocket("127.0.0.1", 0, ssl, false, async (id) =>
    AuthContext.success(id, [], "client"),
  );
  await server.startAsync();
  const addr = (server as any).server.address();
  const port = addr.port as number;
  try {
    const raw = createConnection({ host: "127.0.0.1", port });
    await new Promise<void>((resolve, reject) => {
      raw.once("connect", () => resolve());
      raw.once("error", reject);
    });

    // Wait for the server to register the connection (acceptTcpClient
    // runs setupServerStream first, then creates the ConnectedClientSocket).
    await waitFor(() => (server as any).clients.size === 1, {
      label: "raw client registered server-side",
      timeoutMs: 2000,
    });

    const length = MAX_FRAME_BYTES + 1;
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32LE(length, 0);
    raw.write(lenBuf);

    // The server reading the bad length should destroy the socket; the
    // raw client observes that as a close.
    const closed = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 2000);
      raw.once("close", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    raw.destroy();
    assert.equal(closed, true, "server must close the connection on oversize frame");
  } finally {
    await server.stopAsync();
  }
});

test("C5 regression: outgoing oversize frame is refused by sendAsync", async () => {
  const h = await makeHarness();
  try {
    // Craft a payload that, once msgpacked, exceeds the cap.
    const huge = "x".repeat(MAX_FRAME_BYTES + 16);
    let threw = false;
    let errorMsg = "";
    // Wrap with a manual listener for the unhandled rejection path.
    const originalLog = console.log;
    const captured: string[] = [];
    console.log = (...args: any[]) => { captured.push(args.map(String).join(" ")); };
    try {
      // sendAsync currently catches all exceptions and logs via console.log
      // (existing behavior preserved from upstream). The fix throws first
      // before the catch handler so it lands in the captured logs.
      await h.client.sendAsync(new Message("big", { huge }));
    } finally {
      console.log = originalLog;
    }
    threw = captured.some((line) => line.includes("MAX_FRAME_BYTES"));
    errorMsg = captured.join("\n");
    assert.equal(threw, true, `expected MAX_FRAME_BYTES error; captured logs: ${errorMsg}`);
  } finally {
    await h.close();
  }
});

test("malformed frame: truncated payload causes clean disconnect", async () => {
  const { ServerSocket } = await import("../src/server/serverSocket");
  const { AuthContext } = await import("../src/shared/model/authContext");
  const { noSsl: ssl } = await import("./helpers");
  const server = new ServerSocket("127.0.0.1", 0, ssl, false, async (id) =>
    AuthContext.success(id, [], "client"),
  );
  await server.startAsync();
  const port = ((server as any).server.address()).port as number;
  try {
    const raw = createConnection({ host: "127.0.0.1", port });
    await new Promise<void>((resolve, reject) => {
      raw.once("connect", () => resolve());
      raw.once("error", reject);
    });
    await waitFor(() => (server as any).clients.size === 1, {
      label: "raw client registered server-side",
      timeoutMs: 2000,
    });
    // Claim a 100-byte frame, send only 5 bytes, then close.
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32LE(100, 0);
    raw.write(lenBuf);
    raw.write(Buffer.from([1, 2, 3, 4, 5]));
    raw.end();

    await waitFor(() => (server as any).clients.size === 0, {
      label: "server dropped truncated client",
      timeoutMs: 3000,
    });
    raw.destroy();
  } finally {
    await server.stopAsync();
  }
});

test("backpressure: writes complete without OOM even when receiver is slow", async () => {
  let received = 0;
  const h = await makeHarness({
    onServerClient: (client) => {
      client.onHandler("chunk", async (_msg: Message) => {
        received++;
        // Mimic a slow consumer: a few microtasks of delay per message.
        await sleep(1);
        return null;
      });
    },
  });
  try {
    // 64 KiB payload * 32 = 2 MiB total. Easily fits in MAX_FRAME_BYTES
    // and well below Node's default highWaterMark sum.
    const payload = "y".repeat(64 * 1024);
    const sends: Promise<void>[] = [];
    for (let i = 0; i < 32; i++) {
      sends.push(h.client.sendAsync(new Message("chunk", { i, payload })));
    }
    await Promise.all(sends);

    await waitFor(() => received === 32, { label: "all chunks received", timeoutMs: 3000 });
  } finally {
    await h.close();
  }
});
