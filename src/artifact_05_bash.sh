# 1. Install dependencies
yarn install

# 2. Build program binary with deterministic compiler
anchor build

# 3. Synchronize program ID across source code
anchor keys sync

# 4. Deploy to Solana Devnet (or Mainnet-Beta)
solana program deploy \
  --url https://api.devnet.solana.com \
  --program-id target/deploy/rumbo_passage-keypair.json \
  target/deploy/rumbo_passage.so