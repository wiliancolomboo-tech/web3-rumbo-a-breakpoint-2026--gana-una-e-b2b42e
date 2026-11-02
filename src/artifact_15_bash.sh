cp .env.example .env
# Edit .env with real Resend API key and RPC URL
docker-compose up -d --build
docker-compose logs -f