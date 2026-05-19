import { test, assert, describe } from "../runner";
import { makeHarness, sleep, waitFor } from "../helpers";
import { MAX_FRAME_BYTES } from "../../src/shared/transport/tcp/tcpTransport";
import { Message } from "../../src/shared/model/networking/message";

describe("protocol edge cases", () => {
  test("empty-string channel round-trip", async () => {
    let observed: string | undefined;
    const h = await makeHarness({
      onServerClient: (client) => {
        client.onHandler("", async (msg) => {
          observed = msg.channel;
          return Message.fromReply(msg, { ok: true });
        });
      },
    });
    try {
      const reply = await h.client.sendRequestAsync(new Message(""), 2000);
      assert.equal(observed, "");
      assert.equal(reply.data.ok, true);
    } finally {
      await h.close();
    }
  });

  test("unicode payload round-trip preserves bytes exactly", async () => {
    const payload = "héllo 🌍 ✨ 漢字 𓂀";
    const h = await makeHarness({
      onServerClient: (client) => {
        client.onHandler("unicode", async (msg) => Message.fromReply(msg, { echo: msg.data.payload }));
      },
    });
    try {
      const reply = await h.client.sendRequestAsync(new Message("unicode", { payload }), 2000);
      assert.equal(reply.data.echo, payload);
    } finally {
      await h.close();
    }
  });

  test("zero-byte data payload round-trip", async () => {
    const h = await makeHarness({
      onServerClient: (client) => {
        client.onHandler("nodata", async (msg) => Message.fromReply(msg, null));
      },
    });
    try {
      const reply = await h.client.sendRequestAsync(new Message("nodata"), 2000);
      assert.equal(reply.data, null);
    } finally {
      await h.close();
    }
  });

  test("near-MAX_FRAME_BYTES payload (~15 MiB) sends and receives intact", async () => {
    // Use a buffer of bytes to bypass JS string-cost — msgpack-lite
    // encodes Buffer as msgpack bin type (1 byte overhead per chunk).
    // Sized so encoded frame stays under 16 MiB.
    const size = 15 * 1024 * 1024;
    const buf = Buffer.alloc(size, 0xab);
    let receivedLen = -1;
    const h = await makeHarness({
      onServerClient: (client) => {
        client.onHandler("big", async (msg) => {
          receivedLen = (msg.data as Buffer).length;
          return Message.fromReply(msg, { len: receivedLen });
        });
      },
    });
    try {
      const reply = await h.client.sendRequestAsync(new Message("big", buf), 5000);
      assert.equal(receivedLen, size);
      assert.equal(reply.data.len, size);
    } finally {
      await h.close();
    }
  });

  test("very long channel name round-trip", async () => {
    const channel = "x".repeat(8192);
    let observed: string | undefined;
    const h = await makeHarness({
      onServerClient: (client) => {
        client.onHandler(channel, async (msg) => {
          observed = msg.channel;
          return Message.fromReply(msg, { ok: true });
        });
      },
    });
    try {
      const reply = await h.client.sendRequestAsync(new Message(channel), 2000);
      assert.equal(observed?.length, 8192);
      assert.equal(reply.data.ok, true);
    } finally {
      await h.close();
    }
  });

  test("nested object payload round-trip", async () => {
    const payload = {
      a: 1,
      b: "two",
      c: [1, 2, 3],
      d: { nested: { deeper: [{ x: 1 }, { y: 2 }] } },
      e: true,
      f: null,
    };
    let observed: any = null;
    const h = await makeHarness({
      onServerClient: (client) => {
        client.onHandler("nested", async (msg) => {
          observed = msg.data;
          return Message.fromReply(msg, msg.data);
        });
      },
    });
    try {
      const reply = await h.client.sendRequestAsync(new Message("nested", payload), 2000);
      assert.deepEqual(observed, payload);
      assert.deepEqual(reply.data, payload);
    } finally {
      await h.close();
    }
  });

  test("MAX_FRAME_BYTES exported constant equals 16 * 1024 * 1024", async () => {
    assert.equal(MAX_FRAME_BYTES, 16 * 1024 * 1024);
  });
});
