import { SbmSocket, AuthStatus } from "../shared/sbmSocket";
import { Transport } from "../interfaces/transport";
import { Message } from "../shared/model/networking/message";
import { ServerSocket } from "./serverSocket";
import { ConnectionStatus, ConnectionStatusEventArgs } from "../shared/model/networking/connectionStatus";

export class ConnectedClientSocket extends SbmSocket {
  private server: ServerSocket;

  constructor(transport: Transport, server: ServerSocket) {
    super();
    this._transport = transport;
    this.server = server;
    // Propagate transport connection events
    transport.on("connectionStatusChanged", (e: ConnectionStatusEventArgs) => {
      this.onConnectionStatusChanged(e);
    });
    this.startReceiving();
    this.setupAuthHandlers();
  }

  private setupAuthHandlers() {
    this.onHandler("_auth_", async (message: Message) => {
      this.authStatus = AuthStatus.Authenticating;
      const data = message.asTypeless();
      const id: string = data["Id"];
      const key: string = data["Key"];
      if (this.server.authHandler) {
        const authResult = await this.server.authHandler(id, key);
        if (!authResult) {
          this.authStatus = AuthStatus.Failed;
          return Message.fromReply(message, { Success: false });
        }
      }
      this.authStatus = AuthStatus.Authenticated;
      this._transport?.onAuthenticated();
      return Message.fromReply(message, { Success: true });
    });
  }

  protected override async handleMessageAsync(message: Message) {
    // Ensure the message’s sender is set to this client’s id
    message.senderId = this.clientId;
    await super.handleMessageAsync(message);
  }

  public dispose() {
    super.dispose();
    this.server.removeClient(this.clientId);
    this.server.emit("clientDisconnected", this);
  }

  protected override onConnectionStatusChanged(e: ConnectionStatusEventArgs) {
    super.onConnectionStatusChanged(e);
    if (e.status === ConnectionStatus.Disconnected) {
      this.dispose();
    }
  }
}
