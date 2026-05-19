import { test, assert } from "./runner";
import { makeHarness } from "./helpers";
import { Message } from "../src/shared/model/networking/message";
import type { ConnectedClientSocket } from "../src/server/connectedClientSocket";

test("request/response correlation under concurrent load", async () => {
  const h = await makeHarness({
    onServerClient: (client) => {
      client.onHandler("echo", async (msg: Message) =>
        Message.fromReply(msg, { value: msg.data.value }),
      );
    },
  });
  try {
    const count = 50;
    const requests: Promise<Message>[] = [];
    for (let i = 0; i < count; i++) {
      requests.push(h.client.sendRequestAsync(new Message("echo", { value: i }), 4000));
    }

    const replies = await Promise.all(requests);
    for (let i = 0; i < count; i++) {
      assert.equal(replies[i].data.value, i, `reply ${i} must carry matching value`);
    }
  } finally {
    await h.close();
  }
});

test("C3 regression: sendRequestAsync timeout unregisters reply handler", async () => {
  const h = await makeHarness();
  try {
    // No server-side handler registered for this channel; the request
    // can never receive a reply.
    const handlersBefore = handlerCount(h.client);
    let timedOut = false;
    try {
      await h.client.sendRequestAsync(new Message("noreply"), 100);
    } catch (err) {
      timedOut = true;
      assert.match(String(err), /timed out/);
    }
    assert.equal(timedOut, true, "expected timeout");

    // After timeout, the reply-channel handler must be gone. Internal
    // _handlers map is the source of truth (we check by total count to
    // avoid coupling tests to channel naming).
    const handlersAfter = handlerCount(h.client);
    assert.equal(
      handlersAfter,
      handlersBefore,
      `handlers should be cleaned up after timeout (before=${handlersBefore}, after=${handlersAfter})`,
    );
  } finally {
    await h.close();
  }
});

test("C2 regression: senderId is preserved on the wire (server stamps clientId)", async () => {
  // After the C2 fix, TcpTransport.sendAsync no longer overwrites
  // senderId with Guid.Empty. The server-side ConnectedClientSocket
  // intentionally re-stamps the incoming senderId with the connection's
  // authoritative clientId (M5, parity with C#). The end state observed
  // by a server handler is therefore: senderId == that connection's
  // clientId, which is a real GUID, NOT "00000000-..." .
  let observed: string | undefined;
  let serverSideClient: ConnectedClientSocket | undefined;
  const h = await makeHarness({
    onServerClient: (client) => {
      serverSideClient = client;
      client.onHandler("inspect", async (msg: Message) => {
        observed = msg.senderId;
        return Message.fromReply(msg, { ok: true });
      });
    },
  });
  try {
    await h.client.sendRequestAsync(new Message("inspect"));
    assert.notEqual(observed, undefined);
    assert.notEqual(observed, "00000000-0000-0000-0000-000000000000", "senderId must not be zero GUID");
    assert.notEqual(observed, "", "senderId must not be empty string");
    assert.equal(observed, serverSideClient!.clientId);
  } finally {
    await h.close();
  }
});

function handlerCount(socket: any): number {
  const map: Map<string, unknown[]> = socket._handlers;
  let n = 0;
  for (const arr of map.values()) n += arr.length;
  return n;
}
