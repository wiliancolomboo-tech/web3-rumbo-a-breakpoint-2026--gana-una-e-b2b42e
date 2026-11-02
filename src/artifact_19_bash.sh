# Set production secrets in environment
export RESEND_API_KEY="re_123456789abcdef"
export DISCORD_WEBHOOK_URL="https://api.example.com/webhooks/alerts/placeholder"

# Build and start containerized daemon
docker-compose up -d --build

# Inspect live telemetry logs
docker-compose logs -f rumbo-oracle-daemon