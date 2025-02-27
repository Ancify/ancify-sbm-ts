import { Message } from "../shared/model/networking/message";
import { ConnectionStatusEventArgs } from "../shared/model/networking/connectionStatus";
import { EventEmitter } from "events";

/**
 * The Transport interface abstracts a TCP/TLS transport.
 */
export interface Transport extends EventEmitter {
  connectAsync(maxRetries?: number, delayMilliseconds?: number): Promise<void>;
  sendAsync(message: Message): Promise<void>;
  receiveAsync(abortSignal?: AbortSignal): AsyncIterable<Message>;
  onAuthenticated(): void;
  // Transport implementations should emit a "connectionStatusChanged" event with a ConnectionStatusEventArgs instance.
}
