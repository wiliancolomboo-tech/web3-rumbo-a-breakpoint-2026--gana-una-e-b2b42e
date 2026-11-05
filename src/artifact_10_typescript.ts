import express from "express";
const app = express();
const PORT = process.env.PORT || 8080;

app.get("/health", async (req, res) => {
  try {
    const slot = await client.connection.getSlot();
    res.status(200).json({
      status: "HEALTHY",
      service: "rumbo-breakpoint-daemon",
      current_slot: slot,
      program_id: PROGRAM_ID.toBase58(),
      uptime_seconds: process.uptime()
    });
  } catch (error: any) {
    res.status(503).json({ status: "UNHEALTHY", reason: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`[HealthCheck Service] Listening on port ${PORT}`);
});