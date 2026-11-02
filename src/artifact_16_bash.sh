# 1. Install prerequisites (Solana 1.18.26 + Anchor 0.30.1)
sh -c "$(curl -sSfL https://release.solana.com/v1.18.26/install)"
cargo install --git https://github.com/coral-xyz/anchor avm --locked --force
avm install 0.30.1
avm use 0.30.1

# 2. Synchronize Program Keys and Compile
solana-keygen new --no-bip39-passphrase -o target/deploy/rumbo_protocol-keypair.json --force
anchor keys sync
anchor build

# 3. Deploy to Solana Devnet / Mainnet-Beta
solana config set --url https://api.devnet.solana.com
solana airdrop 2
anchor deploy --provider.cluster devnet

# 4. Verify Program IDL on-chain
anchor idl init --filepath target/idl/rumbo_protocol.json RumboxQx6Zt3K6m1pB4uTfV2YvN8WpZ9cDeFgHjK1Mn