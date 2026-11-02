# Initialize campaign with 1.5 SOL grants and 50 tickets
npx ts-node cli/admin-init.ts \
  --name "Rumbo a Breakpoint 2026" \
  --grant-sol 1.5 \
  --tickets 50 \
  --deadline 1798761600

# Deposit 25 SOL into Treasury Vault
solana transfer <VAULT_PDA_ADDRESS> 25 --allow-unfunded-recipient