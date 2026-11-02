#!/usr/bin/env bash
set -euo pipefail

echo "=========================================================="
echo "   RUMBO A BREAKPOINT 2026: PROGRAM DEPLOYMENT SCRIPT     "
echo "=========================================================="

export SOLANA_NETWORK="${1:-devnet}"
echo "[*] Target Network: ${SOLANA_NETWORK}"

# 1. Build Anchor Binaries
echo "[*] Building Anchor smart contract..."
anchor build

# 2. Get Program Address
PROGRAM_ID=$(solana address -k target/deploy/rumbo_protocol-keypair.json)
echo "[*] Program ID: ${PROGRAM_ID}"

# 3. Deploy to Solana Cluster
echo "[*] Deploying contract to ${SOLANA_NETWORK}..."
solana program deploy \
  --url "${SOLANA_NETWORK}" \
  --program-id target/deploy/rumbo_protocol-keypair.json \
  target/deploy/rumbo_protocol.so

echo "[✔] Smart Contract Successfully Deployed!"
echo "[*] Initializing Docker Worker Daemon..."
docker compose up -d --build
docker compose logs -f