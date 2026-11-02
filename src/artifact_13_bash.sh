# Configure Solana CLI to targeted cluster
solana config set --url https://api.devnet.solana.com

# Build optimized BPF bytecode
anchor build

# Sync keys
anchor keys sync

# Deploy Anchor Program
anchor deploy --program-name rumbo_breakpoint --program-keypair target/deploy/rumbo_breakpoint-keypair.json