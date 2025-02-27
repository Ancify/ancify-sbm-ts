import { ClientSocket } from "./src/client/clientSocket";
import { Message } from "./src/shared/model/networking/message";
import { SslConfig, TcpTransport } from "./src/shared/transport/tcp/tcpTransport";

const sslConfig: SslConfig = {
    sslEnabled: false,
    rejectUnauthorized: false,
    cert: ''
}

const transport = new TcpTransport("127.0.0.1", 12345, sslConfig);
const client = new ClientSocket(transport);

(async() => {
    await client.connectAsync()
    await client.authenticateAsync("t", "h")

    client.on('message_received', message => {
        console.log(`message_received: ${message}`)
    })

    const reply = await client.sendRequestAsync(new Message('test', 'request!'));
    console.log(`reply: ${reply.data}`)
})()

console.log('done?')