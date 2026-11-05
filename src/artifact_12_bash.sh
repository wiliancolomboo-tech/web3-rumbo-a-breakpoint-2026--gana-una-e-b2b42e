# -------------------------------------------------------------
# STEP 1: Build & Deploy Anchor Smart Contract to Solana Devnet
# -------------------------------------------------------------
# Install Anchor CLI v0.30.1 and Solana CLI 1.18+
anchor build

# Generate deterministic keypair or grab program ID
solana address -k target/deploy/camino_escrow-keypair.json

# Deploy to Devnet
anchor deploy --provider.cluster devnet

# -------------------------------------------------------------
# STEP 2: Configure Environment Variables
# -------------------------------------------------------------
cat <<EOF > .env
SOLANA_RPC_URL=https://api.devnet.solana.com
PROGRAM_ID=$(solana address -k target/deploy/camino_escrow-keypair.json)
RESEND_API_KEY=re_test_000000000000000000000000
DISCORD_SLACK_WEBHOOK_URL=https://discord.com/api/webhooks/...
EOF

# -------------------------------------------------------------
# STEP 3: Initialize Campaign via CLI
# -------------------------------------------------------------
# Initialize 2,500 USDC Stipend per builder, 10 recipients maximum
npm run cli -- init-campaign \
  -k ~/.config/solana/id.json \
  -i 2026 \
  -t "Rumbo a Breakpoint 2026" \
  -s 2500000000 \
  -m 10 \
  -mint 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU # Devnet USDC

# -------------------------------------------------------------
# STEP 4: Launch Real-Time Monitoring Worker Daemon
# -------------------------------------------------------------
docker-compose up -d --build
docker-compose logs -f camino-worker