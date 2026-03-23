#!/bin/bash
set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${GREEN}╔════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║          LLM Proxy Deployment Script               ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════════╝${NC}"
echo

if [ ! -f "config.yaml" ]; then
    echo -e "${RED}❌ Error: config.yaml not found${NC}"
    echo "Run: cp config.example.yaml config.yaml && nano config.yaml"
    exit 1
fi

if grep -q "password: change_me_to_secure_password" config.yaml; then
    echo -e "${YELLOW}⚠️  Warning: Admin password is still default${NC}"
    read -p "Continue anyway? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

echo "Deployment mode:"
echo "  1) Production (docker-compose.prod.yml)"
echo "  2) Development (docker-compose.yml)"
echo
read -p "Choose mode [1-2]: " -n 1 -r
echo

if [[ $REPLY =~ ^1$ ]]; then
    MODE="production"
    COMPOSE_FILE="docker-compose.prod.yml"
elif [[ $REPLY =~ ^2$ ]]; then
    MODE="development"
    COMPOSE_FILE="docker-compose.yml"
else
    echo -e "${RED}Invalid choice${NC}"
    exit 1
fi

echo -e "${GREEN}Building Docker image...${NC}"
docker compose -f "$COMPOSE_FILE" build

echo -e "${GREEN}Starting LLM Proxy...${NC}"
docker compose -f "$COMPOSE_FILE" up -d

sleep 5

for i in {1..30}; do
    if curl -s http://localhost:4000/admin/health > /dev/null 2>&1; then
        echo -e "${GREEN}✅ Service is healthy!${NC}"
        break
    fi
    if [ $i -eq 30 ]; then
        echo -e "${RED}❌ Service failed to start${NC}"
        docker compose -f "$COMPOSE_FILE" logs
        exit 1
    fi
    echo -n "."
    sleep 2
done

echo
echo -e "${GREEN}╔════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║              Deployment Complete!                  ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════════╝${NC}"
echo
echo -e "${GREEN}Access:${NC}"
echo "  Dashboard: http://localhost:4000/admin"
echo "  API:       http://localhost:4000/v1/chat/completions"
echo
echo -e "${YELLOW}Commands:${NC}"
echo "  Logs:  docker compose -f $COMPOSE_FILE logs -f"
echo "  Stop:  docker compose -f $COMPOSE_FILE down"
