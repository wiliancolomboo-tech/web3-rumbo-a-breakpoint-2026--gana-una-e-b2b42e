# Export runtime keys
cp .env.example .env
# Edit your .env with your RESEND_API_KEY and VERIFIER_PRIVATE_KEY

# Spin up daemon via Docker Compose
docker-compose up -d --build
docker-compose logs -f