# 1. Clone repository & install dependencies
git clone https://github.com/solana-rumbo/rumbo-breakpoint-protocol.git
cd rumbo-breakpoint-protocol
npm install

# 2. Build Anchor Smart Contracts
anchor build

# 3. Synchronize program keys
solana address -k target/deploy/rumbo_protocol-keypair.json
anchor keys sync

# 4. Run full deterministic test suite with local validator
anchor test

# 5. Deploy to Devnet
anchor deploy --provider.cluster devnet