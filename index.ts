import { ClientSocket } from "./src/client/clientSocket";
import { Message } from "./src/shared/model/networking/message";
import { SslConfig, TcpTransport } from "./src/shared/transport/tcp/tcpTransport";

const sslConfig: SslConfig = {
    sslEnabled: false,
    rejectUnauthorized: false,
    cert: ''
}

const transport = new TcpTransport("127.0.0.1", 12345, sslConfig);
transport.alwaysReconnect = true
const client = new ClientSocket(transport);

(async() => {
    client.on('connectionStatusChanged', args => {
        console.log(args)
    })

    await client.connectAsync()
    await client.authenticateAsync("t", "h")

    client.on('message_received', message => {
        console.log(`message_received: ${message}`)
    })

    try {
        const reply = await client.sendRequestAsync(new Message('test', 'request!'));
        console.log(`reply: ${reply.data}`)
    } catch (err) {
        console.log('failed to get reply', err);
    }
})()

console.log('done?')