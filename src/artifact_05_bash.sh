# 1. Clone repository & install dependencies
git clone https://github.com/solana-latam/rumbo-breakpoint-2026.git
cd rumbo-breakpoint-2026
npm install

# 2. Build Solana Anchor Program
anchor build

# 3. Synchronize Program ID (if redeploying)
solana address -k target/deploy/rumbo_protocol-keypair.json
# Ensure declare_id! matches target keypair

# 4. Deploy to Solana Devnet / Mainnet
solana config set --url https://api.devnet.solana.com
solana airdrop 2
anchor deploy --provider.cluster devnet

# 5. Run automated test suite
anchor test