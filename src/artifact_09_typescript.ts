// Add into client/worker.ts:
import * as http from "http";

const server = http.createServer((req, res) => {
  if (req.url === "/health" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "healthy", timestamp: new Date().toISOString(), protocol: "FlightDeck v1.0.0" }));
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(process.env.PORT || 8080, () => {
  console.log(`[Telemetry Server] Healthcheck listening on port ${process.env.PORT || 8080}`);
});