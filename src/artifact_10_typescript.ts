import http from "http";

export function startHealthServer(port = 8080) {
  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "healthy", timestamp: Date.now() }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  server.listen(port);
}