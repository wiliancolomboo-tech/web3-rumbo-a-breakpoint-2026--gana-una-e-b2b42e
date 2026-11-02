# 1. Clone repository and install dependencies
git clone https://github.com/solana-rumbo/rumbo-breakpoint-2026.git
cd rumbo-breakpoint-2026
yarn install

# 2. Build Anchor smart contract
anchor build

# 3. Synchronize program ID across source code and Anchor.toml
solana address -k target/deploy/rumbo_protocol-keypair.json
# Ensure ID matches declare_id!("...") in src/lib.rs

# 4. Deploy to Solana Devnet
solana config set --url https://api.devnet.solana.com
solana airdrop 3
anchor deploy --provider.cluster Devnet

# 5. Run full integration test suite with 100% assertions passing
anchor test