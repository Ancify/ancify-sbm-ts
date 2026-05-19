import { test, assert } from "./runner";
import { makeHarness, noSsl, waitFor } from "./helpers";
import { ClientSocket } from "../src/client/clientSocket";
import { ServerSocket } from "../src/server/serverSocket";
import { TcpTransport } from "../src/shared/transport/tcp/tcpTransport";
import { Message } from "../src/shared/model/networking/message";
import { ConnectedClientSocket } from "../src/server/connectedClientSocket";
import { ConnectionStatus } from "../src/shared/model/networking/connectionStatus";
import type { AddressInfo } from "node:net";

test("M1 regression: client reconnects after server restart and can send again", async () => {
  // Pick a port by starting+stopping a server, then re-use it so the
  // client's alwaysReconnect can find the new server bound to the same
  // port. (ServerSocket.startAsync auto-binds; we capture port 1 once
  // and reuse it across the restart.)
  const probe = new ServerSocket("127.0.0.1", 0, noSsl, false, async (id) =>
    (await import("../src/shared/model/authContext")).AuthContext.success(id, [], "client"),
  );
  await probe.startAsync();
  const port = ((probe as any).server.address() as AddressInfo).port;
  await probe.stopAsync();

  let server = await startEchoServer(port);

  const clientTransport = new TcpTransport("127.0.0.1", port, noSsl);
  clientTransport.alwaysReconnect = true;
  const client = new ClientSocket(clientTransport);

  const statuses: ConnectionStatus[] = [];
  client.on("connectionStatusChanged", (e: any) => statuses.push(e.status));

  try {
    await client.connectAsync();
    await client.authenticateAsync("id", "key", "client");

    const reply1 = await client.sendRequestAsync(new Message("echo", { v: 1 }), 2000);
    assert.equal(reply1.data.v, 1);

    // Kill the server. The client should detect the disconnect, then
    // automatically reconnect once we bring the server back up.
    await server.stopAsync();
    await waitFor(() => (clientTransport as any).isConnected === false, {
      label: "client noticed disconnect",
      timeoutMs: 3000,
    });

    server = await startEchoServer(port);

    await waitFor(() => (clientTransport as any).isConnected === true, {
      label: "client reconnected",
      timeoutMs: 3000,
    });

    // Reauth + try a request on the new connection.
    const reauth = await client.authenticateAsync("id", "key", "client");
    assert.equal(reauth, true, "reauth on reconnected socket must succeed");
    const reply2 = await client.sendRequestAsync(new Message("echo", { v: 2 }), 2000);
    assert.equal(reply2.data.v, 2);

    assert.ok(
      statuses.includes(ConnectionStatus.Disconnected),
      `expected to see Disconnected in status history; got ${statuses.join(",")}`,
    );
    assert.ok(
      statuses.includes(ConnectionStatus.Reconnected) || statuses.includes(ConnectionStatus.Connected),
      `expected to see Reconnected/Connected after restart; got ${statuses.join(",")}`,
    );
  } finally {
    client.dispose();
    await server.stopAsync();
  }
});

async function startEchoServer(port: number): Promise<ServerSocket> {
  const { AuthContext } = await import("../src/shared/model/authContext");
  const s = new ServerSocket("127.0.0.1", port, noSsl, false, async (id) =>
    AuthContext.success(id, [], "client"),
  );
  s.on("clientConnected", (client: ConnectedClientSocket) => {
    client.onHandler("echo", async (msg: Message) =>
      Message.fromReply(msg, { v: msg.data.v }),
    );
  });
  await s.startAsync();
  return s;
}
