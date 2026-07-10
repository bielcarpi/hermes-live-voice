#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$DIR/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: .env not found at $ENV_FILE" >&2
  echo "Copy .env.example to .env and fill in the missing keys." >&2
  exit 1
fi

# Load .env into the environment
set -a
source "$ENV_FILE"
set +a

# Require at minimum the Hermes API key and a provider
if [ -z "${HERMES_AGENT_API_SERVER_KEY:-}" ]; then
  echo "ERROR: HERMES_AGENT_API_SERVER_KEY is not set in .env" >&2
  exit 1
fi

PROVIDER="${HERMES_LIVE_PROVIDER:-}"
case "$PROVIDER" in
  openai)
    if [ -z "${OPENAI_API_KEY:-}" ]; then
      echo "ERROR: HERMES_LIVE_PROVIDER=openai but OPENAI_API_KEY is not set in .env" >&2
      exit 1
    fi
    ;;
  gemini)
    if [ -z "${GEMINI_API_KEY:-}" ]; then
      echo "ERROR: HERMES_LIVE_PROVIDER=gemini but GEMINI_API_KEY is not set in .env" >&2
      exit 1
    fi
    ;;
  local)
    if [ -z "${LLM_API_KEY:-}" ]; then
      echo "ERROR: HERMES_LIVE_PROVIDER=local but LLM_API_KEY is not set in .env" >&2
      exit 1
    fi
    BACKEND_VENV="$DIR/backend/.venv"
    if [ ! -d "$BACKEND_VENV" ]; then
      echo "ERROR: backend venv not found at $BACKEND_VENV" >&2
      echo "       Run: cd backend && uv sync --python 3.13" >&2
      exit 1
    fi
    ;;
  mock) ;;
  "")
    echo "ERROR: HERMES_LIVE_PROVIDER is not set in .env" >&2
    exit 1
    ;;
esac

# ── Process tracking (used only for local provider) ───────────────────────────
BACKEND_PID=""
GATEWAY_PID=""

cleanup() {
  echo ""
  echo "[shutdown] Stopping..."
  [ -n "$BACKEND_PID" ] && kill "$BACKEND_PID" 2>/dev/null || true
  [ -n "$GATEWAY_PID" ] && kill "$GATEWAY_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  echo "[shutdown] Done."
}

# ── Local provider: start speech-to-speech backend first ─────────────────────
if [ "$PROVIDER" = "local" ]; then
  trap cleanup EXIT INT TERM

  BACKEND_PORT="${HERMES_LOCAL_REALTIME_PORT:-8765}"
  LLM_MODEL="${LLM_MODEL:-deepseek/deepseek-v4-flash}"
  LLM_BASE_URL="${LLM_BASE_URL:-https://openrouter.ai/api/v1}"

  # Fix macOS SSL certs for NLTK
  SSL_CERT_FILE="$("$DIR/backend/.venv/bin/python3" -c 'import certifi; print(certifi.where())' 2>/dev/null || echo '')"
  export SSL_CERT_FILE REQUESTS_CA_BUNDLE="$SSL_CERT_FILE"

  echo "[backend] Starting speech-to-speech on ws://127.0.0.1:$BACKEND_PORT/v1/realtime ..."
  "$DIR/backend/.venv/bin/speech-to-speech" \
    --mode realtime \
    --ws_port "$BACKEND_PORT" \
    --llm_backend responses-api \
    --model_name "$LLM_MODEL" \
    --responses_api_base_url "$LLM_BASE_URL" \
    --responses_api_api_key "$LLM_API_KEY" \
    --responses_api_stream \
    --enable_live_transcription &
  BACKEND_PID=$!

  # Wire the gateway to the backend we just started
  export HERMES_LOCAL_REALTIME_BASE_URL="ws://127.0.0.1:$BACKEND_PORT/v1/realtime"

  # Give the backend a moment to bind its port before the gateway tries to connect
  sleep 2

  echo "[gateway] Starting hermes-live gateway ..."
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo " hermes-live-voice  v0.1.0"
  echo " provider:  local (hf-realtime-voice)"
  echo " backend:   ws://127.0.0.1:$BACKEND_PORT/v1/realtime"
  echo " hermes:    ${HERMES_BASE_URL:-http://127.0.0.1:8642}"
  echo " gateway:   http://${HERMES_LIVE_HOST:-127.0.0.1}:${HERMES_LIVE_PORT:-8788}"
  echo " llm:       $LLM_MODEL"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""

  node "$DIR/dist/cli.js" serve &
  GATEWAY_PID=$!

  wait
else
  # ── Cloud providers: just start the gateway ─────────────────────────────────
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo " hermes-live-voice  v0.1.0"
  echo " provider:  ${PROVIDER}"
  echo " hermes:    ${HERMES_BASE_URL:-http://127.0.0.1:8642}"
  echo " gateway:   http://${HERMES_LIVE_HOST:-127.0.0.1}:${HERMES_LIVE_PORT:-8788}"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""

  exec node "$DIR/dist/cli.js" serve
fi
