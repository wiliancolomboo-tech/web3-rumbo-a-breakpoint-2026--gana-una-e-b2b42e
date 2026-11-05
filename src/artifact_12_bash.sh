# 1. Build & Deploy Smart Contract on Solana Devnet/Mainnet
anchor build
solana program deploy target/deploy/rumbo_breakpoint.so \
  --program-id Rumb0BrkP2o26Voyag3rProtoco1111111111111111 \
  --url https://api.devnet.solana.com

# 2. Run Comprehensive Test Suite
anchor test --skip-local-validator

# 3. Spin up the Enterprise Event Dispatcher with Docker Compose
cp .env.example .env
# Edit .env with your RESEND_API_KEY & DISCORD_WEBHOOK_URL
docker compose up -d --build

# 4. View Real-time Daemon Logs & Streamed Events
docker compose logs -f voyager-daemon