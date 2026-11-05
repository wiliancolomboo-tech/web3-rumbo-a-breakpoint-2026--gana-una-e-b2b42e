# 1. Clone repository and install dependencies
git clone https://github.com/solana-pathfinder/rumbo-breakpoint.git
cd rumbo-breakpoint
yarn install

# 2. Build on-chain Anchor program
anchor build

# 3. Synchronize program keys
anchor keys sync

# 4. Deploy to Solana Devnet (or Mainnet-Beta)
solana config set --url https://api.devnet.solana.com
anchor deploy --provider.cluster devnet

# 5. Run complete test suite with 100% assertions
anchor test --skip-local-validator