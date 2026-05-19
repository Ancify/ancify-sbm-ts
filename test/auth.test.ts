import { test, assert } from "./runner";
import { makeHarness, noSsl } from "./helpers";
import { ClientSocket } from "../src/client/clientSocket";
import { ServerSocket } from "../src/server/serverSocket";
import { TcpTransport } from "../src/shared/transport/tcp/tcpTransport";
import { AuthContext } from "../src/shared/model/authContext";
import type { AddressInfo } from "node:net";

test("M12 regression: server with disallowAnonymous accepts _auth_ and allows traffic after", async () => {
  // Before the fix, isMessageAllowedAsync rejected every inbound message
  // — including the _auth_ message itself — when disallowAnonymous was
  // set, so no client could ever authenticate.
  const server = new ServerSocket(
    "127.0.0.1",
    0,
    noSsl,
    false,
    async (id) => AuthContext.success(id, [], "client"),
  );
  server.disallowAnonymous();
  await server.startAsync();
  const port = ((server as any).server.address() as AddressInfo).port;

  const client = new ClientSocket(new TcpTransport("127.0.0.1", port, noSsl));
  try {
    await client.connectAsync();
    const ok = await client.authenticateAsync("a", "b", "client");
    assert.equal(ok, true, "auth must succeed with disallowAnonymous on");
    assert.equal(client.isAuthenticated(), true);
  } finally {
    client.dispose();
    await server.stopAsync();
  }
});

test("M10 regression: auth without scope leaves scope as undefined on the server side", async () => {
  let observedScope: unknown = "sentinel";
  const server = new ServerSocket("127.0.0.1", 0, noSsl, false, async (id, _key, scope) => {
    observedScope = scope;
    return AuthContext.success(id, []);
  });
  await server.startAsync();
  const port = ((server as any).server.address() as AddressInfo).port;
  const client = new ClientSocket(new TcpTransport("127.0.0.1", port, noSsl));
  try {
    await client.connectAsync();
    const ok = await client.authenticateAsync("a", "b"); // no scope
    assert.equal(ok, true);
    assert.equal(observedScope, undefined, `expected undefined scope, got ${observedScope}`);
  } finally {
    client.dispose();
    await server.stopAsync();
  }
});

test("auth failure: client sees Success=false when handler rejects, connection stays open", async () => {
  // We use a failure context that keeps the connection alive
  // (isConnectionAllowed=true) so the reply can travel back to the
  // client cleanly. The close-and-reply ordering when
  // isConnectionAllowed=false is a separate, pre-existing issue (the
  // server closes the socket inside the handler and then attempts to
  // write the reply on it) and is out of scope for this audit.
  const failHandler = async (): Promise<AuthContext> =>
    new AuthContext(undefined, [], undefined, undefined, /* success */ false, /* isConnectionAllowed */ true);

  const server = new ServerSocket("127.0.0.1", 0, noSsl, false, failHandler);
  await server.startAsync();
  const port = ((server as any).server.address() as AddressInfo).port;
  const client = new ClientSocket(new TcpTransport("127.0.0.1", port, noSsl));
  try {
    await client.connectAsync();
    const ok = await client.authenticateAsync("a", "b", "client");
    assert.equal(ok, false, "auth must report failure");
    assert.equal(client.isAuthenticated(), false);
  } finally {
    client.dispose();
    await server.stopAsync();
  }
});
