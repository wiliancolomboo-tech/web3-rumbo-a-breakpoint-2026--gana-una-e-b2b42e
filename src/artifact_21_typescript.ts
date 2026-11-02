import http from 'http';

const port = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'UP',
      protocol: 'SolPath Escrow v1.0',
      network: process.env.SOLANA_RPC_URL || 'devnet',
      timestamp: new Date().toISOString()
    }));
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(port, () => {
  console.log(`[Healthcheck Telemetry] Listening on port ${port}`);
});