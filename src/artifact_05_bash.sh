# 1. Install dependencies & Anchor CLI
npm install -g @coral-xyz/anchor-cli
yarn install

# 2. Build smart contract binary
anchor build

# 3. Synchronize program keys
anchor keys sync

# 4. Deploy to Solana Devnet / Mainnet
solana config set --url https://api.devnet.solana.com
solana airdrop 2
anchor deploy --provider.cluster devnet

# 5. Run end-to-end automated verification suite
anchor test