import { SbmSocket, AuthStatus } from "../shared/sbmSocket";
import { Transport } from "../interfaces/transport";
import { Message } from "../shared/model/networking/message";
import { ServerSocket } from "./serverSocket";
import { ConnectionStatus, ConnectionStatusEventArgs } from "../shared/model/networking/connectionStatus";
import { AuthContext } from "../shared/model/authContext";

export class ConnectedClientSocket extends SbmSocket {
  private server: ServerSocket;
  private authContext: AuthContext = new AuthContext();
  public disallowAnonymous: boolean = false;

  private faults = 0;
  private readonly maxFaults = 3;

  constructor(transport: Transport, server: ServerSocket) {
    super(transport);
    this.server = server;
    this.startReceiving();
    this.setupAuthHandlers();
  }

  private setupAuthHandlers(): void {
    this.onHandler("_auth_", async (message: Message) => {
      this.authStatus = AuthStatus.Authenticating;

      const data = message.asTypeless();
      const id: string = data["Id"];
      const key: string = data["Key"];
      const scope: string = data["Scope"];

      const authHandler = this.server.authHandler;
      if (authHandler) {
        const result = await authHandler(id, key, scope);
        this.authContext = result;

        if (!result.success) {
          this.authStatus = AuthStatus.Failed;

          if (!result.isConnectionAllowed) {
            this._transport?.close();
          }

          return Message.fromReply(message, { Success: false });
        }
      }

      this.authStatus = AuthStatus.Authenticated;
      this._transport?.onAuthenticated();
      return Message.fromReply(message, { Success: true });
    });
  }

  protected async isMessageAllowedAsync(message: Message): Promise<boolean> {
    return this.disallowAnonymous && !this.isAuthenticated()
      ? false
      : super.isMessageAllowedAsync(message);
  }

  protected override async handleMessageAsync(message: Message): Promise<void> {
    message.senderId = this.clientId;
    await super.handleMessageAsync(message);
  }

  public override dispose(): void {
    super.dispose();
    this.server.removeClient(this.clientId);
    this.server.emit("clientDisconnected", this);
  }

  protected override onConnectionStatusChanged(e: ConnectionStatusEventArgs): void {
    super.onConnectionStatusChanged(e);

    if (e.status === ConnectionStatus.Disconnected) {
      this.dispose();
    }
  }

  public authenticationGuard(role?: string, scope?: string): void {
    if (!this.isAuthenticated() || !this.authContext.success) {
      throw new Error("Not authenticated.");
    }

    if (role && !this.authContext.roles.includes(role)) {
      throw new Error("Client does not have the required role.");
    }

    if (scope && scope !== this.authContext.scope) {
      throw new Error("Client does not have the required scope.");
    }
  }

  public authenticationGuardAny(roles?: string[], scopes?: string[]): void {
    if (!this.isAuthenticated() || !this.authContext.success) {
      throw new Error("Not authenticated.");
    }

    const hasValidRole = !roles || roles.some((role) => this.authContext.roles.includes(role));
    const hasValidScope = !scopes || scopes.some((scope) => scope === this.authContext.scope);

    if (!hasValidRole && !hasValidScope) {
      throw new Error("Client does not have any of the required roles or scopes.");
    }
  }

  public authenticationGuardAll(roles?: string[], scopes?: string[]): void {
    if (!this.isAuthenticated() || !this.authContext.success) {
      throw new Error("Not authenticated.");
    }

    const hasAllRoles = !roles || roles.every((role) => this.authContext.roles.includes(role));
    const hasAllScopes = !scopes || scopes.every((scope) => scope === this.authContext.scope);

    if (!hasAllRoles || !hasAllScopes) {
      throw new Error("Client does not have all the required roles and scopes.");
    }
  }

  public async checkConnectionStatus(): Promise<void> {
    try {
      await this.sendRequestAsync(new Message("__$status"));
      this.faults = 0;
    } catch {
      this.faults++;

      if (this.faults >= this.maxFaults) {
        this.onConnectionStatusChanged(new ConnectionStatusEventArgs(ConnectionStatus.Disconnected));
      }
    }
  }
}
