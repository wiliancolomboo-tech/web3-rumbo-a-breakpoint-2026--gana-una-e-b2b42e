# Set your environment secrets
export RESEND_API_KEY="mock_development_token_00000000000000"
export DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/xxxx/yyyy"

# Build and start orchestrator
docker compose up -d --build

# Inspect operational logs
docker compose logs -f rumbo-orchestrator