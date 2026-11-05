# Configure local CLI to Solana Devnet
solana config set --url https://api.devnet.solana.com

# Verify deployer keypair balance (ensure >= 5 SOL)
solana airdrop 5 $(solana address)