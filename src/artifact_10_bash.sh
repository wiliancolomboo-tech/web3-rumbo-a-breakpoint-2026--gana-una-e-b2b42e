# 1. Clone & Enter repository
git clone https://github.com/solana-latam/rumbo-breakpoint-escrow.git
cd rumbo-breakpoint-escrow

# 2. Build on-chain program
anchor build

# 3. Deploy to Solana Devnet
solana config set --url https://api.devnet.solana.com
anchor deploy --provider.cluster devnet

# 4. Install dependencies and run tests
npm install
anchor test