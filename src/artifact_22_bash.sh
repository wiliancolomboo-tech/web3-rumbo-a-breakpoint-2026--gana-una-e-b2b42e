# Set cluster to devnet
solana config set --url https://api.devnet.solana.com

# Build the Anchor program binary
anchor build

# Deploy to Solana Devnet
solana program deploy target/deploy/breakpoint_pass.so