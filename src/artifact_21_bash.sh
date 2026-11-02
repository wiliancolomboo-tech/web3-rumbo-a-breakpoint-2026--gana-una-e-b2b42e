# 1. Clone repository and install dependencies
git clone https://github.com/solana-bounties/rumbo-breakpoint-2026.git
cd rumbo-breakpoint-2026
npm install

# 2. Build on-chain Anchor program
anchor build

# 3. Synchronize program keys
anchor keys sync

# 4. Deploy to Solana Devnet
solana config set --url https://api.devnet.solana.com
solana airdrop 2
anchor deploy --provider.cluster devnet

# 5. Initialize the Grant Pool for Breakpoint 2026
npx ts-node -e '
  import { Program } from "@coral-xyz/anchor";
  // run initialization script via anchor provider
'