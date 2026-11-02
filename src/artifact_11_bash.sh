# Export runtime secrets
cp .env.example .env
echo "RESEND_API_KEY=re_your_enterprise_api_key" >> .env
echo "DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/your_webhook_id" >> .env

# Launch via Docker Compose
docker compose up -d --build

# Verify container telemetry
docker compose logs -f rumbo-orchestrator