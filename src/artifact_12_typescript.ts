import * as http from "http";

const PORT = process.env.PORT || 8080;
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "healthy", timestamp: Date.now() }));
  } else {
    res.writeHead(404);
    res.end();
  }
});
server.listen(PORT, () => console.log(`Telemetry listening on :${PORT}`));