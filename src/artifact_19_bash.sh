# Set production secrets in environment
export RESEND_API_KEY="re_123456789abcdef"
export DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/your_webhook_here"

# Build and start containerized daemon
docker-compose up -d --build

# Inspect live telemetry logs
docker-compose logs -f rumbo-oracle-daemon