import { test, assert } from "./runner";
import { makeHarness } from "./helpers";
import { Message } from "../src/shared/model/networking/message";

test("C1 regression: server receive loop reads bytes after client connects (no isConnected poke)", async () => {
  // Before the C1 fix, the server-side TcpTransport never flipped
  // isConnected to true, so receiveAsync sat in a busy-loop and never
  // dispatched any frames to ConnectedClientSocket.
  let serverSawMessage = false;
  const h = await makeHarness({
    authenticate: false,
    onServerClient: (client) => {
      client.onHandler("ping", async (msg: Message) => {
        serverSawMessage = true;
        return Message.fromReply(msg, { pong: true });
      });
    },
  });
  try {
    const reply = await h.client.sendRequestAsync(new Message("ping"), 2000);
    assert.equal(serverSawMessage, true, "server-side handler must have been invoked");
    assert.equal(reply.data.pong, true);
  } finally {
    await h.close();
  }
});

test("connect+auth happy path", async () => {
  const h = await makeHarness();
  try {
    assert.equal(h.client.isAuthenticated(), true);
  } finally {
    await h.close();
  }
});
