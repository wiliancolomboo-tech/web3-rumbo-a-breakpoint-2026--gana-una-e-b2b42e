# 1. Build & Verify Solana Anchor Smart Contract
anchor build

# 2. Deploy Program to Solana Devnet (or Mainnet-Beta)
anchor deploy --provider.cluster devnet

# 3. Configure Environment Variables
cat <<EOF > .env
SOLANA_RPC_URL=https://api.devnet.solana.com
PROGRAM_ID=Rumb026Breakpoint11111111111111111111111111
RESEND_API_KEY=re_your_api_key_here
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/your/webhook/url
ORACLE_SECRET_KEY=[1,2,3...255]
EOF

# 4. Launch Autonomous Worker & Telemetry Container
docker compose up -d --build

# 5. Verify Health Endpoint
curl http://localhost:8080/health