import http from "http";

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "HEALTHY",
      uptime: process.uptime(),
      service: "Rumbo-Breakpoint-Worker",
      timestamp: Date.now()
    }));
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(8080, () => console.log("[Telemetry] Healthcheck available at :8080/health"));