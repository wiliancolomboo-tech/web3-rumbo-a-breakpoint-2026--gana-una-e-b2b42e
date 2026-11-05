# Set network to devnet
solana config set --url https://api.devnet.solana.com

# Build Anchor project
anchor build

# Sync Program ID into lib.rs and Anchor.toml
anchor keys sync

# Deploy to Devnet
anchor deploy --program-name rumbo_escrow