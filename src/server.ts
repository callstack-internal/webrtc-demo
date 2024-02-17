import Koa from 'koa';
import route from 'koa-route';
import websockify from 'koa-websocket';

const PORT = 5172;

const app = websockify(new Koa());
const clients = new Set<WebSocket>();

app.ws.use(
  route.all('/socket', (ctx) => {
    clients.add(ctx.websocket);

    ctx.websocket.on('close', () => {
      clients.delete(ctx.websocket);
    });

    ctx.websocket.on('message', (message: Buffer) => {
      for (const client of clients) {
        if (client !== ctx.websocket) {
          client.send(message.toString());
        }
      }
    });
  })
);

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
