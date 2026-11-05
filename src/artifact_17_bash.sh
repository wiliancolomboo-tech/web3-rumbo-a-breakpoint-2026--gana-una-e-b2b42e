# 1. Build contract artifacts
anchor build

# 2. Verify Program ID
solana address -k target/deploy/rumbo_breakpoint-keypair.json

# 3. Synchronize program keys
anchor keys sync

# 4. Deploy to Solana Devnet
anchor deploy --provider.cluster devnet

# 5. Initialize the Global Configuration and Breakpoint Round 2026
npx ts-node scripts/init-round.ts \
  --round-id 2026 \
  --grant-amount 4000000000 \
  --min-reviews 3 \
  --pass-score 80 \
  --cluster devnet

# 6. Run Turnkey Docker Stack
docker compose up -d --build