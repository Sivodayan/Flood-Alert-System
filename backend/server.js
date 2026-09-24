//ignore authentication,rate limiting,cors,database for phonenumbers

const express = require('express');
const http = require('http');
const cors = require('cors');

const { createWebSocketServer } = require('./websocket');
const routes = require('./routes');

const PORT = 3000;
//use port 8001 for ml
const app = express();
app.use(cors());
app.use(express.json());
app.use(routes);

const server = http.createServer(app);
createWebSocketServer(server);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on port ${PORT}`);
});
