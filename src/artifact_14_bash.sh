# 1. Build and verify the Anchor program
anchor build

# 2. Deploy program to Solana Devnet / Mainnet
solana program deploy \
  --program-id target/deploy/breakpoint_quest-keypair.json \
  target/deploy/breakpoint_quest.so \
  --url devnet

# 3. Launch the automated off-chain verification agent
docker-compose up -d --build

# 4. View real-time evaluation logs
docker-compose logs -f breakpoint-verification-agent