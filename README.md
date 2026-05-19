# Ancify Simple Bidirectional Messaging System

## About

This was made as a simple bidirectional messaging system following a server<->clients architecture.
Protocol and serialization formats can be (somewhat) freely chosen. Default uses TCP + MessagePack serialization.

## Server Usage

You preferrably don't, use the c# version instead since this one hasn't really been tested yet.

## Client Usage

Here's a basic example of how to program a client


```ts
const sslConfig: SslConfig = {
    sslEnabled: false,
    rejectUnauthorized: false,
    cert: ''
}

const transport = new TcpTransport("127.0.0.1", 9931, sslConfig);
transport.alwaysReconnect = true;
client = new ClientSocket(transport);

await client.connectAsync();
await client.authenticateAsync('abcd', '1234', 'client');

const response = client.sendRequestAsync(new Message('test::message'));
console.log(response.data)
```