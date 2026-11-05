# 1. Clone repository & install dependencies
git clone https://github.com/superteam-latam/rumbo-breakpoint.git
cd rumbo-breakpoint
yarn install

# 2. Build on-chain program
anchor build

# 3. Synchronize program keys
anchor keys sync

# 4. Deploy to Solana Devnet
anchor deploy --provider.cluster devnet

# 5. Run test suite against local validator
anchor test