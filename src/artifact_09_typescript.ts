import http from "http";

export function startHealthServer(port: number = 8080) {
  const server = http.createServer((req, res) => {
    if (req.url === "/healthz" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "healthy",
          uptime: process.uptime(),
          timestamp: new Date().toISOString(),
          version: "1.0.0",
        })
      );
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.listen(port, () => {
    console.log(`[HEALTH] Healthcheck endpoint live on :${port}/healthz`);
  });
}