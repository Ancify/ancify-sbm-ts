import { test, assert, describe } from "../runner";
import { makeHarness, noSsl } from "../helpers";

// Every export from src/index.ts should be importable and at least
// constructable / referenceable here. This is the catch-net for
// accidental rename/remove of a public symbol.
import * as Sbm from "../../src/index";

describe("public API surface", () => {
  test("every documented export from src/index.ts is defined", async () => {
    const expected = [
      "ClientSocket",
      "ServerSocket",
      "ConnectedClientSocket",
      "TcpTransport",
      "SbmSocket",
      "AuthStatus",
      "AuthContext",
      "Message",
      "ConnectionStatus",
      "ConnectionStatusEventArgs",
      "ConnectData",
      "Mutex",
      "MAX_FRAME_BYTES",
    ];
    for (const name of expected) {
      assert.ok((Sbm as any)[name] !== undefined, `missing export: ${name}`);
    }
  });

  test("Message constructor + helpers behave per the public contract", async () => {
    const m = new Sbm.Message("chan", { x: 1 }, "target-id");
    assert.equal(m.channel, "chan");
    assert.deepEqual(m.data, { x: 1 });
    assert.equal(m.targetId, "target-id");
    assert.equal(typeof m.messageId, "string");
    assert.ok(m.messageId.length > 0);
    assert.equal(m.senderId, "");

    const reply = Sbm.Message.fromReply(m, { ok: true });
    assert.equal(reply.channel, `chan_reply_${m.messageId}`);
    assert.equal(reply.replyTo, m.messageId);
    assert.equal(reply.targetId, m.senderId);

    const cast = m.as<{ x: number }>();
    assert.equal(cast.x, 1);
    const typeless = m.asTypeless();
    assert.equal(typeless["x"], 1);
  });

  test("AuthContext.success and .Failed factories produce the right shapes", async () => {
    const ok = Sbm.AuthContext.success("u", ["r"], "s", { k: 1 });
    assert.equal(ok.success, true);
    assert.equal(ok.isConnectionAllowed, true);
    assert.deepEqual(ok.roles, ["r"]);
    assert.equal(ok.scope, "s");
    assert.deepEqual(ok.sessionData, { k: 1 });

    const failed = Sbm.AuthContext.Failed;
    assert.equal(failed.success, false);
    assert.equal(failed.isConnectionAllowed, false);
  });

  test("ConnectData.fromObject parses a plain object", async () => {
    const cd = Sbm.ConnectData.fromObject({ host: "h", port: 7, meta: ["a"] });
    assert.equal(cd.host, "h");
    assert.equal(cd.port, 7);
    assert.deepEqual(cd.meta, ["a"]);

    const cd2 = Sbm.ConnectData.fromObject({ host: "h2", port: 8 });
    assert.deepEqual(cd2.meta, []);
  });

  test("ConnectionStatusEventArgs is constructible and carries the status", async () => {
    const args = new Sbm.ConnectionStatusEventArgs(Sbm.ConnectionStatus.Connected);
    assert.equal(args.status, Sbm.ConnectionStatus.Connected);
  });

  test("Mutex lock/unlock serializes work", async () => {
    const mtx = new Sbm.Mutex();
    const events: string[] = [];
    async function critical(tag: string) {
      const release = await mtx.lock();
      events.push(`enter ${tag}`);
      await new Promise((r) => setTimeout(r, 10));
      events.push(`exit ${tag}`);
      release();
    }
    await Promise.all([critical("a"), critical("b"), critical("c")]);
    // events must be strictly interleaved enter X / exit X / enter Y / ...
    for (let i = 0; i < events.length; i += 2) {
      assert.match(events[i], /^enter /, `events[${i}] should be enter, got ${events[i]}`);
      assert.match(events[i + 1], /^exit /, `events[${i + 1}] should be exit, got ${events[i + 1]}`);
      const tagEnter = events[i].split(" ")[1];
      const tagExit = events[i + 1].split(" ")[1];
      assert.equal(tagEnter, tagExit, `enter/exit tag mismatch at pair ${i / 2}`);
    }
  });

  test("end-to-end smoke exercise of every public class together", async () => {
    const h = await makeHarness({
      onServerClient: (client) => {
        client.onHandler("api-smoke", async (msg) => Sbm.Message.fromReply(msg, { echo: msg.data.echo }));
      },
    });
    try {
      const reply = await h.client.sendRequestAsync(new Sbm.Message("api-smoke", { echo: "hi" }), 2000);
      assert.equal(reply.data.echo, "hi");
      assert.ok(h.client instanceof Sbm.ClientSocket);
      assert.ok(h.server instanceof Sbm.ServerSocket);
      assert.ok(h.clientTransport instanceof Sbm.TcpTransport);
    } finally {
      await h.close();
    }
  });
});
