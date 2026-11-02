cp .env.example .env
# Fill RESEND_API_KEY and DISCORD_WEBHOOK_URL
docker compose up -d --build
docker compose logs -f camino-worker