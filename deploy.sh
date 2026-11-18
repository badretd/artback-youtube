#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

BOLD='\033[1m'
DIM='\033[2m'
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

say() { printf "%b\n" "$*"; }
fail() { printf "%b\n" "${RED}$*${NC}" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || fail "Docker не установлен. Установите Docker Engine и повторите."
docker compose version >/dev/null 2>&1 || fail "Не найден docker compose (плагин v2)."

random_hex() {
  local bytes="$1"
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$bytes"
  else
    od -An -N "$bytes" -tx1 /dev/urandom | tr -d ' \n'
  fi
}

env_escape() {
  printf "%s" "$1" | sed "s/'/'\\\\''/g"
}

env_line() {
  printf "%s='%s'\n" "$1" "$(env_escape "$2")"
}

ask() {
  local prompt="$1"
  local default="${2:-}"
  local value=""
  if [ -n "$default" ]; then
    read -r -p "$prompt [$default]: " value || true
    value="${value:-$default}"
  else
    read -r -p "$prompt: " value || true
  fi
  printf "%s" "$value"
}

ask_secret() {
  local prompt="$1"
  local value=""
  read -r -s -p "$prompt: " value || true
  printf "\n" >&2
  printf "%s" "$value"
}

if [ -f .env ]; then
  say "${YELLOW}Файл .env уже существует — используем его без изменений.${NC}"
else
  say ""
  say "${BOLD}ARTBACK — первичная настройка${NC}"
  say "${DIM}Ответьте на несколько вопросов. Это займёт около минуты.${NC}"
  say ""

  DOMAIN="${ARTBACK_DOMAIN:-$(ask 'Домен сайта (например, artback.example.com, Enter — без домена)')}"
  DOMAIN="${DOMAIN#http://}"
  DOMAIN="${DOMAIN#https://}"
  DOMAIN="${DOMAIN%%/*}"

  if [ -n "$DOMAIN" ]; then
    SITE_ADDRESS="$DOMAIN"
    APP_URL="https://$DOMAIN"
    say "  → HTTPS будет выпущен автоматически для ${BOLD}$DOMAIN${NC}"
    say "  → Убедитесь, что A-запись домена указывает на этот сервер, а порты 80/443 открыты."
  else
    SITE_ADDRESS=":80"
    PUBLIC_IP="$(curl -4 -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
    APP_URL="http://${PUBLIC_IP:-localhost}"
    say "  ${YELLOW}Режим без домена: сайт будет доступен по адресу $APP_URL (HTTP, без TLS).${NC}"
  fi
  say ""

  YOUTUBE_API_KEY="${ARTBACK_YOUTUBE_API_KEY:-$(ask 'YouTube Data API key (Enter — пропустить)')}"

  say ""
  say "${BOLD}S3-хранилище${NC} (AWS S3, Cloudflare R2, MinIO или другой S3-совместимый сервис)"
  S3_ENDPOINT="${ARTBACK_S3_ENDPOINT:-$(ask 'S3 endpoint (Enter — AWS S3 по умолчанию)')}"
  S3_REGION="${ARTBACK_S3_REGION:-$(ask 'S3 region' 'auto')}"
  S3_BUCKET="${ARTBACK_S3_BUCKET:-$(ask 'S3 bucket')}"
  S3_ACCESS_KEY_ID="${ARTBACK_S3_ACCESS_KEY_ID:-$(ask 'S3 access key ID')}"
  if [ -n "${ARTBACK_S3_SECRET_ACCESS_KEY:-}" ]; then
    S3_SECRET_ACCESS_KEY="$ARTBACK_S3_SECRET_ACCESS_KEY"
  else
    S3_SECRET_ACCESS_KEY="$(ask_secret 'S3 secret access key')"
  fi
  S3_FORCE_PATH_STYLE="${ARTBACK_S3_FORCE_PATH_STYLE:-false}"

  say ""
  say "${BOLD}Google OAuth${NC} (необязательно; Enter — пропустить)"
  GOOGLE_CLIENT_ID="${ARTBACK_GOOGLE_CLIENT_ID:-$(ask 'Google client ID')}"
  if [ -n "${ARTBACK_GOOGLE_CLIENT_SECRET:-}" ]; then
    GOOGLE_CLIENT_SECRET="$ARTBACK_GOOGLE_CLIENT_SECRET"
  else
    GOOGLE_CLIENT_SECRET="$(ask_secret 'Google client secret')"
  fi

  POSTGRES_PASSWORD="$(random_hex 24)"
  SESSION_SECRET="$(random_hex 48)"

  : > .env
  {
    echo "# Сгенерировано deploy.sh $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    env_line DOMAIN "$DOMAIN"
    env_line SITE_ADDRESS "$SITE_ADDRESS"
    env_line APP_URL "$APP_URL"
    echo ""
    env_line POSTGRES_USER "artback"
    env_line POSTGRES_PASSWORD "$POSTGRES_PASSWORD"
    env_line POSTGRES_DB "artback"
    env_line SESSION_SECRET "$SESSION_SECRET"
    echo ""
    env_line YOUTUBE_API_KEY "$YOUTUBE_API_KEY"
    echo ""
    env_line GOOGLE_CLIENT_ID "$GOOGLE_CLIENT_ID"
    env_line GOOGLE_CLIENT_SECRET "$GOOGLE_CLIENT_SECRET"
    echo ""
    env_line S3_ENDPOINT "$S3_ENDPOINT"
    env_line S3_REGION "$S3_REGION"
    env_line S3_BUCKET "$S3_BUCKET"
    env_line S3_ACCESS_KEY_ID "$S3_ACCESS_KEY_ID"
    env_line S3_SECRET_ACCESS_KEY "$S3_SECRET_ACCESS_KEY"
    env_line S3_FORCE_PATH_STYLE "$S3_FORCE_PATH_STYLE"
    echo ""
    env_line MAX_MEMBERS "100"
    env_line MAX_IMAGE_MB "8"
    env_line MAX_VIDEO_MB "50"
    env_line MAX_AUDIO_MB "15"
    env_line MAX_FILE_MB "10"
    env_line SYNC_CRON "17 3 * * *"
  } >> .env
  chmod 600 .env

  say ""
  if [ -z "$YOUTUBE_API_KEY" ]; then
    say "${YELLOW}Внимание: YOUTUBE_API_KEY пуст — привязка каналов не будет работать.${NC}"
  fi
  if [ -z "$S3_BUCKET" ] || [ -z "$S3_ACCESS_KEY_ID" ] || [ -z "$S3_SECRET_ACCESS_KEY" ]; then
    say "${YELLOW}Внимание: S3 не заполнен — отправка медиа будет отключена.${NC}"
  fi
  if [ -n "$GOOGLE_CLIENT_ID" ] && [ -n "$GOOGLE_CLIENT_SECRET" ]; then
    say "Google OAuth redirect URI: ${BOLD}${APP_URL}/api/auth/google/callback${NC}"
    say "Добавьте его в Google Cloud Console → Credentials."
  fi
  say "${GREEN}Настройки сохранены в .env${NC}"
fi

say ""
say "${BOLD}Собираем и запускаем контейнеры…${NC}"
docker compose up -d --build

say ""
docker compose ps
say ""
say "${GREEN}${BOLD}Готово.${NC}"
APP_URL_SHOW="$(grep -E "^APP_URL=" .env | head -1 | cut -d= -f2- | tr -d "'")"
say "Сайт: ${BOLD}${APP_URL_SHOW:-http://localhost}${NC}"
say "${DIM}Первый подтвердивший канал участник автоматически станет администратором."
say "Логи: docker compose logs -f app${NC}"
