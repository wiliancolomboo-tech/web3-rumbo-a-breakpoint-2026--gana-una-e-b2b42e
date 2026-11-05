# 1. Clone repository & install dependencies
git clone https://github.com/solana-rumbo/rumbo-protocol.git
cd rumbo-protocol
yarn install

# 2. Build Anchor Program
anchor build

# 3. Synchronize program ID keypair
solana-keygen new -o target/deploy/rumbo_protocol-keypair.json --force --no-bip39-passphrase
PROGRAM_ID=$(solana address -k target/deploy/rumbo_protocol-keypair.json)
sed -i "s/Rumbo111111111111111111111111111111111111111/$PROGRAM_ID/g" programs/rumbo-protocol/src/lib.rs Anchor.toml

# 4. Rebuild & Deploy to Devnet / Mainnet-Beta
anchor build
anchor deploy --provider.cluster devnet

# 5. Execute Comprehensive Test Suite
anchor test

# 6. Launch Turnkey Agent Worker via Docker
docker-compose up -d --build
docker logs -f rumbo-automation-daemon