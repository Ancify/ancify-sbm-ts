import { SbmSocket } from "../shared/sbmSocket";
import { Transport } from "../interfaces/transport";
import { Message } from "../shared/model/networking/message";
import { ConnectionStatus, ConnectionStatusEventArgs } from "../shared/model/networking/connectionStatus";

export class ClientSocket extends SbmSocket {
  constructor(transport: Transport) {
    super();
    this._transport = transport;
    // Forward transport connection events to SbmSocket
    transport.on("connectionStatusChanged", (e: ConnectionStatusEventArgs) => {
      this.onConnectionStatusChanged(e);
    });
    this.startReceiving();
  }

  public async connectAsync(): Promise<void> {
    this.onConnectionStatusChanged(new ConnectionStatusEventArgs(ConnectionStatus.Connecting));
    await this._transport!.connectAsync();
    this.onConnectionStatusChanged(new ConnectionStatusEventArgs(ConnectionStatus.Connected));
  }

  public async authenticateAsync(id: string, key: string): Promise<boolean> {
    const message = new Message("_auth_", { Id: id, Key: key });
    const response = await this.sendRequestAsync(message);
    const data = response.asTypeless();
    const success = Boolean(data["Success"]);
    if (success) {
      this._transport?.onAuthenticated();
    }
    return success;
  }

  // Override to ensure the senderId is set
  public override async sendAsync(message: Message): Promise<void> {
    message.senderId = this.clientId;
    await super.sendAsync(message);
  }

  public override async sendRequestAsync(request: Message, timeout?: number): Promise<Message> {
    request.senderId = this.clientId;
    return super.sendRequestAsync(request, timeout);
  }
}
