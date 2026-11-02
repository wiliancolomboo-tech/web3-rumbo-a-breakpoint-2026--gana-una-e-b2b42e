# Set target cluster
solana config set --url https://api.devnet.solana.com

# Build Anchor zero-unsafe binary
anchor build

# Deploy to Solana Devnet
anchor deploy --program-name rumbo_breakpoint --program-keypair target/deploy/rumbo_breakpoint-keypair.json