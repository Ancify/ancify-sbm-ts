import { test, assert, describe } from "../runner";
import { makeHarness, noSsl } from "../helpers";
import { ClientSocket } from "../../src/client/clientSocket";
import { ServerSocket } from "../../src/server/serverSocket";
import { TcpTransport } from "../../src/shared/transport/tcp/tcpTransport";
import { AuthContext } from "../../src/shared/model/authContext";
import { AuthStatus } from "../../src/shared/sbmSocket";
import { Message } from "../../src/shared/model/networking/message";
import type { AddressInfo } from "node:net";

describe("auth scenarios", () => {
  test("auth with various scopes ('client', 'admin', empty string, undefined)", async () => {
    const observed: (string | undefined)[] = [];
    const server = new ServerSocket("127.0.0.1", 0, noSsl, false, async (_id, _key, scope) => {
      observed.push(scope);
      return AuthContext.success("u", [], scope);
    });
    await server.startAsync();
    const port = ((server as any).server.address() as AddressInfo).port;

    const cases: (string | undefined)[] = ["client", "admin", "", undefined];
    try {
      for (const scope of cases) {
        const c = new ClientSocket(new TcpTransport("127.0.0.1", port, noSsl));
        await c.connectAsync();
        const ok = await c.authenticateAsync("a", "b", scope);
        assert.equal(ok, true, `scope=${scope} should authenticate`);
        c.dispose();
      }
      assert.deepEqual(observed, ["client", "admin", "", undefined]);
    } finally {
      await server.stopAsync();
    }
  });

  test("anonymous (no auth) traffic flows when disallowAnonymous is NOT set", async () => {
    const h = await makeHarness({
      authenticate: false,
      onServerClient: (client) => {
        client.onHandler("hi", async (msg) => Message.fromReply(msg, { ok: true }));
      },
    });
    try {
      const reply = await h.client.sendRequestAsync(new Message("hi"), 2000);
      assert.equal(reply.data.ok, true);
    } finally {
      await h.close();
    }
  });

  test("anonymous traffic blocked when disallowAnonymous is set", async () => {
    let dispatched = false;
    const h = await makeHarness({
      authenticate: false,
      disallowAnonymous: true,
      onServerClient: (client) => {
        client.onHandler("hi", async (msg) => {
          dispatched = true;
          return Message.fromReply(msg, { ok: true });
        });
      },
    });
    try {
      let timedOut = false;
      try {
        await h.client.sendRequestAsync(new Message("hi"), 200);
      } catch {
        timedOut = true;
      }
      assert.equal(timedOut, true);
      assert.equal(dispatched, false, "handler must not run for anonymous client");
    } finally {
      await h.close();
    }
  });

  test("after successful auth under disallowAnonymous, subsequent traffic flows", async () => {
    let dispatched = false;
    const h = await makeHarness({
      disallowAnonymous: true,
      onServerClient: (client) => {
        client.onHandler("hi", async (msg) => {
          dispatched = true;
          return Message.fromReply(msg, { ok: true });
        });
      },
    });
    try {
      const reply = await h.client.sendRequestAsync(new Message("hi"), 2000);
      assert.equal(reply.data.ok, true);
      assert.equal(dispatched, true);
    } finally {
      await h.close();
    }
  });

  test("authStatus transitions None -> Authenticating -> Authenticated on success", async () => {
    const probe = new ServerSocket("127.0.0.1", 0, noSsl, false, async (id: string) =>
      AuthContext.success(id, []),
    );
    await probe.startAsync();
    const port = ((probe as any).server.address() as AddressInfo).port;
    await probe.stopAsync();
    const server = new ServerSocket("127.0.0.1", port, noSsl, false, async (id: string) =>
      AuthContext.success(id, []),
    );
    await server.startAsync();
    const transport = new TcpTransport("127.0.0.1", port, noSsl);
    const client = new ClientSocket(transport);
    try {
      await client.connectAsync();
      assert.equal(client.authStatus, AuthStatus.None);
      const authPromise = client.authenticateAsync("a", "b", "client");
      // briefly observe Authenticating before the round-trip resolves
      assert.equal(client.authStatus, AuthStatus.Authenticating);
      await authPromise;
      assert.equal(client.authStatus, AuthStatus.Authenticated);
    } finally {
      client.dispose();
      await server.stopAsync();
    }
  });

  test("authStatus transitions None -> Authenticating -> Failed on rejected auth", async () => {
    const server = new ServerSocket("127.0.0.1", 0, noSsl, false, async () =>
      new AuthContext(undefined, [], undefined, undefined, false, true),
    );
    await server.startAsync();
    const port = ((server as any).server.address() as AddressInfo).port;
    const transport = new TcpTransport("127.0.0.1", port, noSsl);
    const client = new ClientSocket(transport);
    try {
      await client.connectAsync();
      const ok = await client.authenticateAsync("a", "b", "client");
      assert.equal(ok, false);
      assert.equal(client.authStatus, AuthStatus.Failed);
    } finally {
      client.dispose();
      await server.stopAsync();
    }
  });

  test("auth-retry after a failed attempt can succeed on the same connection", async () => {
    let allow = false;
    const server = new ServerSocket("127.0.0.1", 0, noSsl, false, async (id) =>
      allow
        ? AuthContext.success(id, [])
        : new AuthContext(undefined, [], undefined, undefined, false, true),
    );
    await server.startAsync();
    const port = ((server as any).server.address() as AddressInfo).port;
    const transport = new TcpTransport("127.0.0.1", port, noSsl);
    const client = new ClientSocket(transport);
    try {
      await client.connectAsync();
      assert.equal(await client.authenticateAsync("a", "b"), false);
      allow = true;
      assert.equal(await client.authenticateAsync("a", "b"), true);
      assert.equal(client.authStatus, AuthStatus.Authenticated);
    } finally {
      client.dispose();
      await server.stopAsync();
    }
  });

  test("auth handler with custom roles surfaces them via Context on the server", async () => {
    const roles = ["admin", "ops"];
    let observedRoles: string[] | undefined;
    const server = new ServerSocket("127.0.0.1", 0, noSsl, false, async (id) =>
      AuthContext.success(id, roles, "admin"),
    );
    server.on("clientConnected", (c: any) => {
      c.onHandler("whoami", async (msg: Message) => {
        observedRoles = c.authContext?.roles ?? (c as any).authContext.roles;
        return Message.fromReply(msg, { roles: observedRoles });
      });
    });
    await server.startAsync();
    const port = ((server as any).server.address() as AddressInfo).port;
    const client = new ClientSocket(new TcpTransport("127.0.0.1", port, noSsl));
    try {
      await client.connectAsync();
      assert.equal(await client.authenticateAsync("a", "b", "admin"), true);
      const reply = await client.sendRequestAsync(new Message("whoami"), 2000);
      assert.deepEqual(reply.data.roles, roles);
    } finally {
      client.dispose();
      await server.stopAsync();
    }
  });
});
