#!/usr/bin/env bash
#
# Полная очистка тестового сервера ARTBACK.
#
# Что делает скрипт:
#   1. останавливает контейнеры приложения (app и caddy);
#   2. удаляет все объекты из S3-бакета, указанного в .env
#      (включая версии, delete-маркеры и незавершённые multipart-загрузки);
#   3. удаляет контейнеры, сеть и Docker-тома проекта (PostgreSQL, Caddy);
#   4. если в этом каталоге запущен локальный Supabase CLI-стек —
#      останавливает и удаляет его контейнеры, тома (БД + Storage) и сеть;
#   5. по флагам может удалить .env и собранный образ приложения.
#
# Использование:
#   ./purge.sh                 # спросит подтверждение
#   ./purge.sh --yes           # без подтверждения (для автоматизации)
#   ./purge.sh --skip-s3       # не трогать S3
#   ./purge.sh --delete-bucket # удалить и сам S3-бакет, а не только объекты
#   ./purge.sh --keep-supabase # не трогать локальный Supabase-стек
#   ./purge.sh --remove-env    # удалить .env после очистки
#   ./purge.sh --remove-images # удалить собранный образ приложения
#
set -Eeuo pipefail

cd "$(dirname "$0")"

BOLD='\033[1m'
DIM='\033[2m'
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

say() { printf "%b\n" "$*"; }
warn() { printf "%b\n" "${YELLOW}$*${NC}"; }
step() { printf "\n%b\n" "${BOLD}==> $*${NC}"; }
fail() { printf "%b\n" "${RED}$*${NC}" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

usage() {
  sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'
}

ASSUME_YES=0
PURGE_S3=1
DELETE_S3_BUCKET=0
PURGE_SUPABASE=1
REMOVE_ENV=0
REMOVE_IMAGES=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    -y | --yes) ASSUME_YES=1 ;;
    --skip-s3) PURGE_S3=0 ;;
    --delete-bucket) DELETE_S3_BUCKET=1 ;;
    --keep-supabase) PURGE_SUPABASE=0 ;;
    --remove-env) REMOVE_ENV=1 ;;
    --remove-images) REMOVE_IMAGES=1 ;;
    -h | --help) usage; exit 0 ;;
    *) fail "Неизвестный аргумент: $1. См. ./purge.sh --help" ;;
  esac
  shift
done

have docker || fail "Docker не установлен."
docker compose version >/dev/null 2>&1 || fail "Не найден docker compose (плагин v2)."
[ -f .env ] || fail "Не найден .env. Скрипт должен лежать в каталоге проекта рядом с docker-compose.yml и .env."
docker compose config >/dev/null 2>&1 || fail "docker compose config завершился с ошибкой. Проверьте .env."

# Чтение значений из .env для показа и для передачи S3-переменных в docker run.
env_value() {
  local key="$1" line value
  line="$(grep -E "^${key}=" .env | tail -n1 || true)"
  [ -n "$line" ] || return 0
  value="${line#*=}"
  value="${value%$'\r'}"
  if [[ "$value" == \'*\' && ${#value} -ge 2 ]]; then
    value="${value:1:${#value}-2}"
  elif [[ "$value" == \"*\" && ${#value} -ge 2 ]]; then
    value="${value:1:${#value}-2}"
  fi
  printf '%s' "$value"
}

# Имя Compose-проекта (по умолчанию — имя каталога).
PROJECT="${COMPOSE_PROJECT_NAME:-}"
if [ -z "$PROJECT" ]; then
  if have jq; then
    PROJECT="$(docker compose config --format json 2>/dev/null | jq -r '.name // empty' 2>/dev/null || true)"
  fi
  if [ -z "$PROJECT" ]; then
    PROJECT="$(docker compose config --format json 2>/dev/null \
      | awk -F'"' '/^  "name": / && !found { print $4; found=1 }' || true)"
  fi
fi
PROJECT="${PROJECT:-$(basename "$PWD")}"
APP_IMAGE="$(docker compose config --images app 2>/dev/null | sed -n '1p' || true)"
APP_IMAGE="${APP_IMAGE:-${PROJECT}-app}"
APP_NETWORK="${PROJECT}_internal"

S3_BUCKET_VALUE="$(env_value S3_BUCKET)"
S3_ENDPOINT_VALUE="$(env_value S3_ENDPOINT)"
S3_REGION_VALUE="$(env_value S3_REGION)"
S3_KEY_VALUE="$(env_value S3_ACCESS_KEY_ID)"
S3_SECRET_VALUE="$(env_value S3_SECRET_ACCESS_KEY)"
S3_FORCE_PATH_STYLE_VALUE="$(env_value S3_FORCE_PATH_STYLE)"
S3_CONFIGURED=0
if [ -n "$S3_BUCKET_VALUE" ] && [ -n "$S3_KEY_VALUE" ] && [ -n "$S3_SECRET_VALUE" ]; then
  S3_CONFIGURED=1
fi

# Локальный Supabase CLI-стек этого каталога (если запускался `supabase start`).
SUPABASE_PROJECT="${SUPABASE_PROJECT:-$(basename "$PWD")}"
mapfile -t SUPABASE_IDS < <(
  docker ps -aq --filter "label=com.supabase.cli.workdir=$PWD" 2>/dev/null || true
)
if [ "${#SUPABASE_IDS[@]}" -eq 0 ]; then
  mapfile -t SUPABASE_IDS < <(
    docker ps -aq --filter "label=com.supabase.cli.project=$SUPABASE_PROJECT" 2>/dev/null || true
  )
fi
if [ "${#SUPABASE_IDS[@]}" -gt 0 ]; then
  detected_project="$(docker inspect "${SUPABASE_IDS[0]}" \
    --format '{{index .Config.Labels "com.supabase.cli.project"}}' 2>/dev/null || true)"
  if [ -n "$detected_project" ]; then
    SUPABASE_PROJECT="$detected_project"
  fi
fi
mapfile -t SUPABASE_VOLUMES < <(
  docker volume ls -q --filter "label=com.supabase.cli.project=$SUPABASE_PROJECT" 2>/dev/null || true
)
SUPABASE_PRESENT=0
if [ "${#SUPABASE_IDS[@]}" -gt 0 ] || [ "${#SUPABASE_VOLUMES[@]}" -gt 0 ]; then
  SUPABASE_PRESENT=1
fi

if [ "$PURGE_S3" -eq 1 ] && [ "$S3_CONFIGURED" -eq 1 ]; then
  if [ -z "$APP_IMAGE" ] || ! docker image inspect "$APP_IMAGE" >/dev/null 2>&1; then
    fail "Образ приложения (${APP_IMAGE:-не найден}) отсутствует, поэтому очистить S3 через него нельзя.
Соберите его: docker compose build app
Либо запустите очистку без S3: ./purge.sh --skip-s3"
  fi
fi

step "Будут безвозвратно удалены данные"
say "  • контейнеры, сеть и тома Compose-проекта ${BOLD}${PROJECT}${NC}"
say "    (PostgreSQL, сертификаты и состояние Caddy)"
if [ "$PURGE_S3" -eq 1 ]; then
  if [ "$S3_CONFIGURED" -eq 1 ]; then
    if [ "$DELETE_S3_BUCKET" -eq 1 ]; then
      say "  • S3-бакет ${BOLD}${S3_BUCKET_VALUE}${NC} целиком (все объекты и сам бакет)"
    else
      say "  • все объекты в S3-бакете ${BOLD}${S3_BUCKET_VALUE}${NC} (бакет останется пустым)"
    fi
  else
    warn "  • S3 не настроен в .env — очистка S3 будет пропущена"
  fi
else
  say "  • S3 не трогаем (--skip-s3)"
fi
if [ "$PURGE_SUPABASE" -eq 1 ] && [ "$SUPABASE_PRESENT" -eq 1 ]; then
  say "  • локальный Supabase-стек ${BOLD}${SUPABASE_PROJECT}${NC}: контейнеры,"
  say "    тома PostgreSQL и Storage (файлы, загруженные в Supabase)"
else
  say "  • локальный Supabase-стек не обнаружен или исключён (--keep-supabase)"
fi
if [ "$REMOVE_ENV" -eq 1 ]; then
  say "  • файл ${BOLD}.env${NC} с секретами"
fi
if [ "$REMOVE_IMAGES" -eq 1 ]; then
  say "  • собранный образ приложения ${BOLD}${APP_IMAGE:-app}${NC}"
fi
say ""
warn "Это необратимая операция. Все данные на тестовом сервере будут потеряны."

if [ "$ASSUME_YES" -ne 1 ]; then
  printf "\nДля продолжения введите %bDELETE%b: " "$BOLD" "$NC"
  read -r answer || true
  [ "$answer" = "DELETE" ] || fail "Отменено."
fi

# 1. Останавливаем приложение. Базу и Supabase пока оставляем — они могут быть S3-хранилищем.
step "Останавливаем контейнеры приложения"
docker compose stop app caddy >/dev/null 2>&1 || true
say "Контейнеры остановлены."

# 2. Очищаем S3, пока доступен образ приложения и его node_modules.
if [ "$PURGE_S3" -eq 1 ] && [ "$S3_CONFIGURED" -eq 1 ]; then
  step "Очищаем S3-бакет ${S3_BUCKET_VALUE}"
  # Если S3 — локальный Supabase/MinIO на 127.0.0.1, контейнеру нужен host network.
  s3_args=(run --rm)
  case "$S3_ENDPOINT_VALUE" in
    *127.0.0.1* | *localhost* | *0.0.0.0*) s3_args+=(--network host) ;;
  esac
  s3_args+=(
    -e "S3_BUCKET=$S3_BUCKET_VALUE"
    -e "S3_ENDPOINT=$S3_ENDPOINT_VALUE"
    -e "S3_REGION=$S3_REGION_VALUE"
    -e "S3_ACCESS_KEY_ID=$S3_KEY_VALUE"
    -e "S3_SECRET_ACCESS_KEY=$S3_SECRET_VALUE"
    -e "S3_FORCE_PATH_STYLE=$S3_FORCE_PATH_STYLE_VALUE"
  )
  if [ "$DELETE_S3_BUCKET" -eq 1 ]; then
    s3_args+=(-e PURGE_DELETE_BUCKET=1)
  fi
  s3_args+=(--entrypoint node "$APP_IMAGE" --input-type=module -)

  docker "${s3_args[@]}" <<'NODE'
import {
  S3Client,
  HeadBucketCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  DeleteObjectsCommand,
  ListMultipartUploadsCommand,
  AbortMultipartUploadCommand,
  DeleteBucketCommand,
} from '@aws-sdk/client-s3';

const env = process.env;
const bucket = (env.S3_BUCKET || '').trim();
const endpoint = (env.S3_ENDPOINT || '').trim();
const region = (env.S3_REGION || (endpoint ? 'auto' : 'us-east-1')).trim();
const accessKeyId = (env.S3_ACCESS_KEY_ID || '').trim();
const secretAccessKey = (env.S3_SECRET_ACCESS_KEY || '').trim();
const forcePathStyle =
  ['1', 'true', 'yes', 'on'].includes(String(env.S3_FORCE_PATH_STYLE || '').toLowerCase()) ||
  (String(env.S3_FORCE_PATH_STYLE || '') === '' && Boolean(endpoint));
const deleteBucket = env.PURGE_DELETE_BUCKET === '1';

const log = (message) => console.log(`[s3] ${message}`);

if (!bucket || !accessKeyId || !secretAccessKey) {
  log('S3 не настроен — пропускаем.');
  process.exit(0);
}

const s3 = new S3Client({
  region,
  endpoint: endpoint || undefined,
  forcePathStyle,
  credentials: { accessKeyId, secretAccessKey },
});

async function bucketExists() {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    return true;
  } catch (error) {
    const status = error?.$metadata?.httpStatusCode;
    if (status === 404 || ['NotFound', 'NoSuchBucket'].includes(error?.name)) {
      return false;
    }
    throw error;
  }
}

async function deleteEntries(entries) {
  let deleted = 0;
  for (let index = 0; index < entries.length; index += 1000) {
    const chunk = entries.slice(index, index + 1000);
    if (chunk.length === 0) continue;

    const result = await s3.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: chunk, Quiet: true },
      }),
    );

    const errors = result.Errors || [];
    if (errors.length > 0) {
      throw new Error(
        `не удалось удалить ${errors.length} объектов (${errors[0].Code}: ${errors[0].Message})`,
      );
    }
    deleted += chunk.length;
  }
  return deleted;
}

async function deleteAllVersions() {
  let total = 0;
  let keyMarker;
  let versionIdMarker;

  do {
    const result = await s3.send(
      new ListObjectVersionsCommand({
        Bucket: bucket,
        KeyMarker: keyMarker,
        VersionIdMarker: versionIdMarker,
      }),
    );

    const entries = [
      ...(result.Versions || []).map((item) => ({ Key: item.Key, VersionId: item.VersionId })),
      ...(result.DeleteMarkers || []).map((item) => ({ Key: item.Key, VersionId: item.VersionId })),
    ].filter((item) => item.Key && item.VersionId);

    total += await deleteEntries(entries);

    const truncated = Boolean(result.IsTruncated);
    keyMarker = truncated ? result.NextKeyMarker : undefined;
    versionIdMarker = truncated ? result.NextVersionIdMarker : undefined;
    if (truncated && !keyMarker) break;
  } while (keyMarker);

  return total;
}

async function deleteCurrentObjects() {
  let total = 0;
  let token;

  do {
    const result = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }),
    );

    const entries = (result.Contents || [])
      .map((item) => ({ Key: item.Key }))
      .filter((item) => item.Key);

    total += await deleteEntries(entries);

    token = result.IsTruncated ? result.NextContinuationToken : undefined;
    if (result.IsTruncated && !token) break;
  } while (token);

  return total;
}

async function abortMultipartUploads() {
  let total = 0;
  let keyMarker;
  let uploadIdMarker;

  do {
    const result = await s3.send(
      new ListMultipartUploadsCommand({
        Bucket: bucket,
        KeyMarker: keyMarker,
        UploadIdMarker: uploadIdMarker,
      }),
    );

    for (const upload of result.Uploads || []) {
      await s3.send(
        new AbortMultipartUploadCommand({
          Bucket: bucket,
          Key: upload.Key,
          UploadId: upload.UploadId,
        }),
      );
      total += 1;
    }

    const truncated = Boolean(result.IsTruncated);
    keyMarker = truncated ? result.NextKeyMarker : undefined;
    uploadIdMarker = truncated ? result.NextUploadIdMarker : undefined;
    if (truncated && !keyMarker) break;
  } while (keyMarker);

  return total;
}

async function main() {
  log(`бакет: ${bucket}${endpoint ? `, endpoint: ${endpoint}` : ''}`);

  if (!(await bucketExists())) {
    log('бакет не существует — очищать нечего.');
    return;
  }

  const versions = await deleteAllVersions();
  if (versions > 0) log(`удалено версий и delete-маркеров: ${versions}.`);

  const objects = await deleteCurrentObjects();
  if (objects > 0) log(`удалено объектов: ${objects}.`);

  const uploads = await abortMultipartUploads();
  if (uploads > 0) log(`прервано незавершённых multipart-загрузок: ${uploads}.`);

  if (deleteBucket) {
    await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
    log(`бакет "${bucket}" удалён.`);
  } else {
    log('S3 очищен, бакет оставлен пустым.');
  }
}

main().catch((error) => {
  console.error(`[s3] Ошибка очистки: ${error?.message || error}`);
  process.exit(1);
});
NODE
fi

# 3. Удаляем контейнеры, тома и сеть приложения.
step "Удаляем контейнеры и данные PostgreSQL/Caddy"
docker compose stop db >/dev/null 2>&1 || true
docker compose rm -f -v app caddy db >/dev/null 2>&1 || true

for volume in db_data caddy_data caddy_config; do
  mapfile -t volume_ids < <(
    docker volume ls -q \
      --filter "label=com.docker.compose.project=$PROJECT" \
      --filter "label=com.docker.compose.volume=$volume" 2>/dev/null || true
  )
  if [ "${#volume_ids[@]}" -gt 0 ]; then
    docker volume rm "${volume_ids[@]}" >/dev/null
    say "Том ${volume} удалён."
  fi
done

mapfile -t app_network_ids < <(
  docker network ls -q \
    --filter "label=com.docker.compose.project=$PROJECT" \
    --filter "label=com.docker.compose.network=internal" 2>/dev/null || true
)
if [ "${#app_network_ids[@]}" -eq 0 ] && docker network inspect "$APP_NETWORK" >/dev/null 2>&1; then
  app_network_ids=("$APP_NETWORK")
fi
for network_id in "${app_network_ids[@]}"; do
  network_name="$(docker network inspect "$network_id" --format '{{.Name}}' 2>/dev/null || true)"
  docker network rm "$network_id" >/dev/null
  say "Сеть ${network_name:-$network_id} удалена."
done

# 4. Удаляем локальный Supabase-стек, если он относится к этому каталогу.
if [ "$PURGE_SUPABASE" -eq 1 ]; then
  mapfile -t SUPABASE_IDS < <(
    docker ps -aq --filter "label=com.supabase.cli.workdir=$PWD" 2>/dev/null || true
  )
  if [ "${#SUPABASE_IDS[@]}" -eq 0 ]; then
    mapfile -t SUPABASE_IDS < <(
      docker ps -aq --filter "label=com.supabase.cli.project=$SUPABASE_PROJECT" 2>/dev/null || true
    )
  fi
  mapfile -t SUPABASE_VOLUMES < <(
    docker volume ls -q --filter "label=com.supabase.cli.project=$SUPABASE_PROJECT" 2>/dev/null || true
  )

  if [ "${#SUPABASE_IDS[@]}" -gt 0 ] || [ "${#SUPABASE_VOLUMES[@]}" -gt 0 ]; then
    step "Удаляем локальный Supabase-стек ${SUPABASE_PROJECT}"

    if [ "${#SUPABASE_IDS[@]}" -gt 0 ]; then
      docker stop "${SUPABASE_IDS[@]}" >/dev/null 2>&1 || true
      docker rm -f -v "${SUPABASE_IDS[@]}" >/dev/null
      say "Контейнеры Supabase удалены."
    fi

    if [ "${#SUPABASE_VOLUMES[@]}" -gt 0 ]; then
      docker volume rm "${SUPABASE_VOLUMES[@]}" >/dev/null
      say "Тома Supabase (PostgreSQL + Storage) удалены."
    fi

    mapfile -t supabase_networks < <(
      docker network ls -q \
        --filter "label=com.docker.compose.project=$SUPABASE_PROJECT" 2>/dev/null || true
    )
    for network_id in "${supabase_networks[@]}"; do
      network_name="$(docker network inspect "$network_id" --format '{{.Name}}' 2>/dev/null || true)"
      case "$network_name" in
        supabase_network_*)
          docker network rm "$network_id" >/dev/null 2>&1 || true
          say "Сеть ${network_name} удалена."
          ;;
      esac
    done
  fi
fi

# 5. Необязательные шаги.
if [ "$REMOVE_IMAGES" -eq 1 ] && [ -n "$APP_IMAGE" ]; then
  if docker image inspect "$APP_IMAGE" >/dev/null 2>&1; then
    step "Удаляем образ приложения"
    docker image rm "$APP_IMAGE" >/dev/null 2>&1 || warn "Не удалось удалить образ ${APP_IMAGE}."
  fi
fi

if [ "$REMOVE_ENV" -eq 1 ]; then
  step "Удаляем .env"
  rm -f .env
fi

say ""
say "${GREEN}${BOLD}Готово. Тестовый сервер очищен.${NC}"
say "${DIM}Для повторного запуска: ./deploy.sh${NC}"
