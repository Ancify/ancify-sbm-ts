import { createServer, Server, Socket } from "net";
import { ConnectionStatus, ConnectionStatusEventArgs } from "../shared/model/networking/connectionStatus";
import { ConnectedClientSocket } from "./connectedClientSocket";
import { TcpTransport } from "../shared/transport/tcp/tcpTransport";
//import { WebsocketTransport } from "../shared/transport/ws/websocketTransport";
import { Message } from "../shared/model/networking/message";
import { EventEmitter } from "events";
import { AuthContext } from "../shared/model/authContext";

export type AuthHandler = (id: string, key: string, scope?: string) => Promise<AuthContext>;

export class ServerSocket extends EventEmitter {
  private server?: Server;
  private httpServer?: any; // Placeholder for WebSocket server
  private clients: Map<string, ConnectedClientSocket> = new Map();
  public authHandler?: AuthHandler;
  private host: string;
  private port: number;
  private sslConfig: any; // Adjust type if needed
  private useWebSocket: boolean;
  private anonymousDisallowed: boolean = false;
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private stopped: boolean = false;
  // Server-driven liveness probe interval. Override before startAsync()
  // for tests (small value) or noisy environments.
  public healthCheckIntervalMs: number = 5000;

  constructor(host: string, port: number, sslConfig: any, useWebSocket: boolean = false, authHandler?: AuthHandler) {
    super();
    this.host = host;
    this.port = port;
    this.sslConfig = sslConfig;
    this.useWebSocket = useWebSocket;
    if (authHandler) {
      this.authHandler = authHandler;
    }
  }

  public async startAsync(): Promise<void> {
    if (this.useWebSocket) {
      await this.startWebSocketServer();
    } else {
      await this.startTcpServer();
    }
    this.scheduleNextHealthCheck();
  }

  public async stopAsync(): Promise<void> {
    this.stopped = true;
    if (this.healthCheckTimer) {
      clearTimeout(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = undefined;
    }
    for (const client of this.clients.values()) {
      try { client.dispose(); } catch { /* ignore */ }
    }
    this.clients.clear();
  }

  private scheduleNextHealthCheck(): void {
    if (this.stopped) return;
    this.healthCheckTimer = setTimeout(() => {
      this.runHealthCheck().catch((err) => console.error("Health check loop error:", err));
    }, this.healthCheckIntervalMs);
    // Don't keep the event loop alive on this timer alone; tests
    // shouldn't have to call stopAsync just to exit.
    if (typeof (this.healthCheckTimer as any).unref === "function") {
      (this.healthCheckTimer as any).unref();
    }
  }

  private async runHealthCheck(): Promise<void> {
    for (const client of this.clients.values()) {
      try {
        await client.checkConnectionStatus();
      } catch {
        // Per-client errors are logged inside checkConnectionStatus.
      }
    }
    this.scheduleNextHealthCheck();
  }

  private startTcpServer(): Promise<void> {
    this.server = createServer((socket: Socket) => {
      const transport = new TcpTransport(socket, this.sslConfig);
      // C# parity: ServerSocket.StartAsync awaits SetupServerStream before
      // constructing ConnectedClientSocket so the receive loop sees a
      // ready (and, if configured, TLS-handshaken) stream. We do the
      // same here. Errors during setup are logged and the half-open
      // transport is closed; the client is not registered.
      this.acceptTcpClient(transport).catch((err) => {
        console.error("Failed to accept new client:", err);
        try { transport.close(); } catch { /* ignore */ }
      });
    });

    this.server.on("error", (err) => {
      console.error("Server error:", err);
    });

    return new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        this.server?.removeListener("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        this.server?.removeListener("error", onError);
        console.log(`TCP Server listening on ${this.host}:${this.port}`);
        resolve();
      };
      this.server!.once("error", onError);
      this.server!.once("listening", onListening);
      this.server!.listen(this.port, this.host);
    });
  }

  private async acceptTcpClient(transport: TcpTransport): Promise<void> {
    await transport.setupServerStream();
    this.handleNewClient(transport);
  }

  private async startWebSocketServer(): Promise<void> {
    /*
    const { WebSocketServer } = await import("ws");
    this.httpServer = new WebSocketServer({ port: this.port });

    this.httpServer.on("connection", (ws: any) => {
      const transport = new WebsocketTransport(ws);
      this.handleNewClient(transport);
    });

    console.log(`WebSocket Server listening on ws://${this.host}:${this.port}`);
    */
  }

  private handleNewClient(transport: TcpTransport /* | WebsocketTransport */): void {
    const clientSocket = new ConnectedClientSocket(transport, this);
    clientSocket.clientId = crypto.randomUUID();
    clientSocket.disallowAnonymous = this.anonymousDisallowed;

    this.clients.set(clientSocket.clientId, clientSocket);
    this.emit("clientConnected", clientSocket);
  }

  public async broadcastAsync(message: Message): Promise<void> {
    await Promise.all([...this.clients.values()].map((client) => client.sendAsync(message)));
  }

  public async sendToClientAsync(clientId: string, message: Message): Promise<void> {
    const clientSocket = this.clients.get(clientId);
    if (!clientSocket) {
      throw new Error("Client not connected");
    }
    await clientSocket.sendAsync(message);
  }

  public removeClient(clientId: string): void {
    this.clients.delete(clientId);
  }

  public disallowAnonymous(): void {
    this.anonymousDisallowed = true;
  }

}
