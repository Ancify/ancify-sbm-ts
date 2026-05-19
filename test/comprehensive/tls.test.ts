import { test, assert, describe } from "../runner";
import { mintSelfSignedCert } from "../helpers-tls";
import { ClientSocket } from "../../src/client/clientSocket";
import { ServerSocket } from "../../src/server/serverSocket";
import { SslConfig, TcpTransport } from "../../src/shared/transport/tcp/tcpTransport";
import { AuthContext } from "../../src/shared/model/authContext";
import { Message } from "../../src/shared/model/networking/message";
import type { ConnectedClientSocket } from "../../src/server/connectedClientSocket";
import type { AddressInfo } from "node:net";

describe("TLS round-trip (M6 regression)", () => {
  test("server with sslEnabled and a self-signed cert exchanges a frame with a TLS client", async () => {
    const { key, cert } = mintSelfSignedCert("localhost");
    const serverSsl: SslConfig = { sslEnabled: true, rejectUnauthorized: false, key, cert };
    const clientSsl: SslConfig = { sslEnabled: true, rejectUnauthorized: false };

    const server = new ServerSocket("127.0.0.1", 0, serverSsl, false, async (id: string) =>
      AuthContext.success(id, [], "client"),
    );
    server.on("clientConnected", (c: ConnectedClientSocket) => {
      c.onHandler("tls-ping", async (msg: Message) =>
        Message.fromReply(msg, { pong: msg.data.pong }),
      );
    });
    await server.startAsync();
    const port = ((server as any).server.address() as AddressInfo).port;

    const transport = new TcpTransport("127.0.0.1", port, clientSsl);
    const client = new ClientSocket(transport);
    try {
      await client.connectAsync();
      assert.equal(await client.authenticateAsync("a", "b", "client"), true);
      const reply = await client.sendRequestAsync(new Message("tls-ping", { pong: 42 }), 3000);
      assert.equal(reply.data.pong, 42);
    } finally {
      client.dispose();
      await server.stopAsync();
    }
  });
});
