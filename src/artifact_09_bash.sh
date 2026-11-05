# 1. Build Smart Contract
anchor build

# 2. Deploy Program to Solana Devnet / Mainnet-Beta
solana config set --url https://api.devnet.solana.com
anchor deploy --program-name rumbo_breakpoint

# 3. Initialize Cohort Pool via Anchor CLI or Script
anchor run initialize-cohort -- --cohort "BP2026-LATAM" --tickets 25 --stipend 2000000000

# 4. Start Turnkey Oracle & Enterprise Worker
docker compose up -d --build

# 5. Monitor Live Logs & Event Ingestion
docker logs -f rumbo-breakpoint-daemon