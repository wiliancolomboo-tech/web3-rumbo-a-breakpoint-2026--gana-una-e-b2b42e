# 1. Build contract artifacts and generate binary
anchor build

# 2. Synchronize Program ID keys
solana address -k target/deploy/rumbo_protocol-keypair.json
# Ensure declare_id matches this key in programs/rumbo_protocol/src/lib.rs

# 3. Deploy to Solana Devnet / Mainnet-Beta
solana program deploy \
  --url https://api.devnet.solana.com \
  --program-id target/deploy/rumbo_protocol-keypair.json \
  target/deploy/rumbo_protocol.so

# 4. Initialize Campaign & Escrow Seeding via CLI
npm run agent:init-campaign -- \
  --campaign-id "breakpoint-2026-latam" \
  --ticket-quota 50 \
  --grant-sol 15.0 \
  --deadline "2026-09-01T00:00:00Z"