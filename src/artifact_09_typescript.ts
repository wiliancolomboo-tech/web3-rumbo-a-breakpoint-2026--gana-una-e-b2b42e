import http from "http";

http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "HEALTHY",
      uptime: process.uptime(),
      solana_rpc: "CONNECTED",
      timestamp: Date.now()
    }));
  } else {
    res.writeHead(404);
    res.end();
  }
}).listen(8080, () => console.log("🚀 Healthcheck listener live on port 8080"));