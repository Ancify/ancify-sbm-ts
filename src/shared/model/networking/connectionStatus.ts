export enum ConnectionStatus {
  Connecting = "Connecting",
  Connected = "Connected",
  Reconnecting = "Reconnecting",
  Reconnected = "Reconnected",
  Disconnected = "Disconnected",
  Authenticating = "Authenticating",
  Authenticated = "Authenticated",
  Failed = "Failed",
  Cancelled = "Cancelled"
}

export class ConnectionStatusEventArgs {
  status: ConnectionStatus;

  constructor(status: ConnectionStatus) {
    this.status = status;
  }
}
