

const { WebSocketServer } = require('ws');

const dashboardClients = new Set();

function createWebSocketServer(httpServer) {
  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws) => {
    dashboardClients.add(ws);

    ws.on('close', () => {
      dashboardClients.delete(ws);
    });
    ws.on('error', (err) => {
        console.error('WebSocket client error:', err.message);
        dashboardClients.delete(ws);
        ws.terminate();
      });
  });


   
  return wss;
}

function broadcastReading(reading) {
  const message = JSON.stringify({ type: 'reading', ...reading });
  for (const client of dashboardClients) {
    if (client.readyState === client.OPEN) {
      client.send(message);
    }
  }
}

module.exports = {
  createWebSocketServer,
  broadcastReading,
};
