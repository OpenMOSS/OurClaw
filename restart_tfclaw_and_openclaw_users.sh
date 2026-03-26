#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SCIHARNESS_ROOT="${SCRIPT_DIR}"
TFCLAW_ROOT="${TFCLAW_ROOT:-${SCIHARNESS_ROOT}/TFClaw}"
CONFIG_PATH="${TFCLAW_CONFIG_PATH:-${TFCLAW_ROOT}/config.json}"
MAP_PATH="${TFCLAW_OPENCLAW_MAP_PATH:-${TFCLAW_ROOT}/.runtime/openclaw_bridge/feishu-user-map.json}"
GATEWAY_SESSION="${TFCLAW_GATEWAY_SESSION:-tfclaw-gateway}"
RELAY_SESSION="${TFCLAW_RELAY_SESSION:-tfclaw-relay}"
TMUX_SESSION_PREFIX="${TFCLAW_OPENCLAW_TMUX_SESSION_PREFIX:-tfoc-}"
LOG_ROOT="${TFCLAW_LOG_ROOT:-${SCIHARNESS_ROOT}/.runtime/tfclaw_runtime_logs}"
GATEWAY_LOG_PATH="${TFCLAW_GATEWAY_LOG_PATH:-${LOG_ROOT}/tfclaw_gateway.log}"
RELAY_LOG_PATH="${TFCLAW_RELAY_LOG_PATH:-${LOG_ROOT}/tfclaw_relay.log}"
FORCED_COMPACTION_RESERVE_TOKENS_FLOOR=20000

resolve_from_tfclaw_root() {
  local raw="$1"
  if [[ "$raw" = /* ]]; then
    printf '%s\n' "$raw"
  else
    printf '%s\n' "${TFCLAW_ROOT}/${raw}"
  fi
}

harden_single_tfclaw_root_for_user_isolation() {
  local tfclaw_root="$1"
  local user_home_root="${2:-}"
  [[ -d "$tfclaw_root" ]] || return 0

  while IFS= read -r -d '' entry; do
    if [[ -n "$user_home_root" && "$entry" == "$user_home_root" ]]; then
      continue
    fi
    if [[ -d "$entry" ]]; then
      chmod 700 "$entry" 2>/dev/null || true
    else
      chmod 600 "$entry" 2>/dev/null || true
    fi
    chown root:root "$entry" 2>/dev/null || true
  done < <(find "$tfclaw_root" -mindepth 1 -maxdepth 1 -print0 2>/dev/null || true)

  # Keep parent traversal but hide listing for non-root users.
  chmod 711 "$tfclaw_root" 2>/dev/null || true
  if [[ -n "$user_home_root" && -d "$user_home_root" ]]; then
    chmod 711 "$user_home_root" 2>/dev/null || true
  fi
}

harden_tfclaw_root_for_user_isolation() {
  local tfclaw_root="$1"
  local user_home_root="$2"
  harden_single_tfclaw_root_for_user_isolation "$tfclaw_root" "$user_home_root"

  # Also harden sibling mount aliases (for example /inspire/hdd/... vs /inspire/qb-ilm/...).
  if [[ "$tfclaw_root" == /*/*/* ]]; then
    local root_no_lead="${tfclaw_root#/}"
    local first_seg="${root_no_lead%%/*}"
    local after_first="${root_no_lead#*/}"
    local second_seg="${after_first%%/*}"
    local tail_after_second="${after_first#*/}"
    local anchor_root="/${first_seg}"
    local primary_mount="${anchor_root}/${second_seg}"
    [[ -d "$anchor_root" ]] || return 0

    local relative_home=""
    if [[ "$user_home_root" == "$tfclaw_root/"* ]]; then
      relative_home="${user_home_root#"$tfclaw_root"/}"
    fi
    local mount_base candidate candidate_home
    for mount_base in "${anchor_root}"/*; do
      [[ -d "$mount_base" ]] || continue
      [[ "$mount_base" == "$primary_mount" ]] && continue
      candidate="${mount_base}/${tail_after_second}"
      [[ -d "$candidate" ]] || continue
      [[ "$candidate" == "$tfclaw_root" ]] && continue
      if [[ -n "$relative_home" && -d "$candidate/$relative_home" ]]; then
        candidate_home="$candidate/$relative_home"
      else
        candidate_home=""
      fi
      harden_single_tfclaw_root_for_user_isolation "$candidate" "$candidate_home"
    done
  fi
}

ensure_shared_skills_readable() {
  local shared_skills_dir="$1"
  [[ -n "$shared_skills_dir" ]] || return 0
  [[ -d "$shared_skills_dir" ]] || return 0

  # Shared skills must be readable by all mapped users, but writable only by root.
  # Keep ownership on root and clear group/other write bits recursively.
  chown -hR root:root "$shared_skills_dir" 2>/dev/null || true
  find "$shared_skills_dir" -xdev -type d -exec chmod u+rwx,go+rx,go-w {} + 2>/dev/null || true
  find "$shared_skills_dir" -xdev -type f -exec chmod u+rw,go+r,go-w {} + 2>/dev/null || true
}

migrate_user_home() {
  local user="$1"
  local current_home="$2"
  local target_home="$3"
  if [[ "$current_home" == "$target_home" ]]; then
    printf '%s\n' "$current_home"
    return 0
  fi

  mkdir -p "$(dirname -- "$target_home")"
  if ! usermod -d "$target_home" -m "$user" >/dev/null 2>&1; then
    echo "warn: usermod -m failed for $user ($current_home -> $target_home), trying copy fallback" >&2
    mkdir -p "$target_home"
    if [[ -d "$current_home" ]]; then
      cp -a "$current_home"/. "$target_home"/ 2>/dev/null || true
    fi
    chown -R "$user:$user" "$target_home" 2>/dev/null || true
    usermod -d "$target_home" "$user" >/dev/null 2>&1 || return 1
  fi

  local passwd_line new_home
  passwd_line="$(getent passwd "$user" || true)"
  new_home="$(awk -F: '{print $6}' <<<"$passwd_line")"
  [[ -n "$new_home" ]] || return 1
  printf '%s\n' "$new_home"
}

lock_legacy_home_dir() {
  local legacy_home="$1"
  [[ -n "$legacy_home" ]] || return 0
  [[ -d "$legacy_home" ]] || return 0
  chown -R root:root "$legacy_home" 2>/dev/null || true
  chmod -R u+rwX,go-rwx "$legacy_home" 2>/dev/null || true
  chmod 700 "$legacy_home" 2>/dev/null || true
}

rewrite_legacy_path_refs_in_user_home() {
  local old_prefix="$1"
  local new_prefix="$2"
  local user_home="$3"
  [[ -n "$old_prefix" && -n "$new_prefix" ]] || return 0
  [[ "$old_prefix" != "$new_prefix" ]] || return 0
  [[ -d "$user_home" ]] || return 0

  local scan_dirs=("$user_home/.openclaw" "$user_home/.tfclaw-openclaw")
  local dir file
  for dir in "${scan_dirs[@]}"; do
    [[ -d "$dir" ]] || continue
    while IFS= read -r file; do
      [[ -f "$file" ]] || continue
      OLD_PREFIX="$old_prefix" NEW_PREFIX="$new_prefix" \
        perl -0pi -e 's/\Q$ENV{OLD_PREFIX}\E/$ENV{NEW_PREFIX}/g' "$file" 2>/dev/null || true
    done < <(rg -l --fixed-strings "$old_prefix" "$dir" 2>/dev/null || true)
  done
}

cleanup_legacy_tmux_socket() {
  local user="$1"
  local legacy_home="$2"
  [[ -n "$user" && -n "$legacy_home" ]] || return 0
  local socket_path="${legacy_home}/.tfclaw-tmux.sock"
  if [[ -e "$socket_path" ]]; then
    env -u TMUX -u TMUX_PANE runuser -u "$user" -- tmux -S "$socket_path" kill-server >/dev/null 2>&1 || true
    rm -f "$socket_path" >/dev/null 2>&1 || true
  fi
  pkill -u "$user" -f "$socket_path" >/dev/null 2>&1 || true
}

parse_dotenv_file_to_json() {
  local env_file="$1"
  if [[ ! -f "$env_file" ]]; then
    printf '{}\n'
    return 0
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    printf '{}\n'
    return 0
  fi
  python3 - "$env_file" <<'PY'
import json
import re
import sys
from pathlib import Path

pattern = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
env_file = Path(sys.argv[1])
result = {}

try:
    text = env_file.read_text(encoding="utf-8", errors="ignore")
except Exception:
    print("{}")
    raise SystemExit(0)

for raw_line in text.splitlines():
    line = raw_line.strip()
    if not line or line.startswith("#"):
        continue
    if line.startswith("export "):
        line = line[len("export ") :].strip()
    if "=" not in line:
        continue
    key, value = line.split("=", 1)
    key = key.strip()
    if not pattern.fullmatch(key):
        continue
    value = value.strip()
    if len(value) >= 2 and ((value[0] == '"' and value[-1] == '"') or (value[0] == "'" and value[-1] == "'")):
        value = value[1:-1]
    if not value or len(value) > 16 * 1024:
        continue
    result[key] = value

print(json.dumps(result, separators=(",", ":")))
PY
}

sanitize_private_env_overrides_json() {
  local vars_json="$1"
  jq -cn --argjson vars "$vars_json" '
    def normalize_value($v):
      ($v | tostring | gsub("^\\s+|\\s+$"; "") | ascii_downcase);
    def is_sensitive_key($k):
      ($k | ascii_downcase | test("(api[_-]?key|access[_-]?key|secret|token|password|passwd)"));
    def is_placeholder_secret($v):
      (normalize_value($v)) as $s
      | (
          $s == "your_moss_api_key"
          or $s == "your_api_key"
          or $s == "api_key_here"
          or $s == "token_here"
          or $s == "secret_here"
          or $s == "changeme"
          or $s == "replace_me"
          or $s == "replace-with-real-value"
          or $s == "placeholder"
          or $s == "none"
          or $s == "null"
          or $s == "undefined"
          or $s == "xxx"
          or ($s | startswith("your_"))
          or ($s | startswith("your-"))
          or ($s | startswith("<"))
          or ($s | startswith("${"))
          or ($s | startswith("sk-your"))
          or ($s | contains("your_moss_api_key"))
          or ($s | contains("your_api_key"))
          or ($s | contains("api_key_here"))
          or ($s | contains("token_here"))
          or ($s | contains("secret_here"))
          or ($s | contains("replace_me"))
          or ($s | contains("changeme"))
        );
    ($vars // {})
    | with_entries(
      if (is_sensitive_key(.key) and (.value | type == "string") and is_placeholder_secret(.value)) then
        empty
      else
        .
      end
    )
  ' 2>/dev/null || printf '%s\n' "$vars_json"
}

normalize_user_bridge_runtime_permissions() {
  local user="$1"
  local home_dir="$2"
  [[ -n "$user" && -n "$home_dir" ]] || return 0

  local workspace_dir="${home_dir}/.tfclaw-openclaw/workspace"
  local workspace_skills_dir="${workspace_dir}/skills"
  local home_skills_dir="${home_dir}/skills"
  local uid gid tmp_media_root base tts_skill_dir
  uid="$(id -u "$user" 2>/dev/null || true)"
  gid="$(id -g "$user" 2>/dev/null || true)"
  [[ -n "$uid" && -n "$gid" ]] || return 0

  mkdir -p "$workspace_dir" "$workspace_skills_dir" "$workspace_dir/outbound" "$workspace_dir/inbound"
  chown "$user:$user" "$workspace_dir" "$workspace_skills_dir" "$workspace_dir/outbound" "$workspace_dir/inbound" 2>/dev/null || true
  chmod 700 "$workspace_dir" "$workspace_skills_dir" "$workspace_dir/outbound" "$workspace_dir/inbound" 2>/dev/null || true

  for base in "$workspace_skills_dir" "$home_skills_dir"; do
    tts_skill_dir="${base}/feishu-voice-tts"
    # Only touch local writable skill directories; skip symlinked shared skills.
    if [[ -d "$tts_skill_dir" && ! -L "$tts_skill_dir" ]]; then
      mkdir -p "${tts_skill_dir}/outbound"
      chown -R "$user:$user" "${tts_skill_dir}/outbound" 2>/dev/null || true
      chmod 700 "${tts_skill_dir}/outbound" 2>/dev/null || true
    fi
  done

  # Repair historical root-owned artifacts that break voice/file bridge writes.
  chown -R "$user:$user" "$workspace_dir/outbound" "$workspace_dir/inbound" 2>/dev/null || true
  find "$workspace_dir/outbound" -type d -exec chmod 700 {} + 2>/dev/null || true
  find "$workspace_dir/outbound" -type f -exec chmod 600 {} + 2>/dev/null || true
  find "$workspace_dir/inbound" -type d -exec chmod 700 {} + 2>/dev/null || true
  find "$workspace_dir/inbound" -type f -exec chmod 600 {} + 2>/dev/null || true

  tmp_media_root="/tmp/openclaw-${uid}"
  if [[ -d "$tmp_media_root" ]]; then
    chown -R "$user:$user" "$tmp_media_root" 2>/dev/null || true
    find "$tmp_media_root" -type d -exec chmod 700 {} + 2>/dev/null || true
    find "$tmp_media_root" -type f -exec chmod 600 {} + 2>/dev/null || true
  fi
}

path_to_project_whitelist_entry() {
  local raw_path="$1"
  local resolved_path resolved_project_root
  resolved_path="$(readlink -f "$raw_path" 2>/dev/null || echo "$raw_path")"
  resolved_project_root="$(readlink -f "$SCIHARNESS_ROOT" 2>/dev/null || echo "$SCIHARNESS_ROOT")"
  if [[ "$resolved_path" == "$resolved_project_root" ]]; then
    printf '.\n'
    return 0
  fi
  if [[ "$resolved_path" == "$resolved_project_root/"* ]]; then
    printf '%s\n' "${resolved_path#"$resolved_project_root"/}"
    return 0
  fi
  printf '%s\n' "$resolved_path"
}

verify_user_path_whitelist_guard() {
  local user="$1"
  local shell_wrapper_path="$2"
  local workspace_dir="$3"
  local home_dir="$4"
  local read_whitelist="$5"
  local write_whitelist="$6"
  local shared_skills_dir="$7"
  local shared_env_path="$8"
  local denied_read_path="$9"

  local env_prefix=(
    "TFCLAW_EXEC_PROJECT_ROOT=$SCIHARNESS_ROOT"
    "TFCLAW_EXEC_READ_WHITELIST=$read_whitelist"
    "TFCLAW_EXEC_WRITE_WHITELIST=$write_whitelist"
    "TFCLAW_EXEC_WORKSPACE=$workspace_dir"
    "TFCLAW_EXEC_HOME=$home_dir"
    "TFCLAW_EXEC_REAL_SHELL=/bin/bash"
    "TFCLAW_EXEC_NODE_BIN_DIR=$NODE_BIN_DIR"
  )

  local writable_probe="${workspace_dir}/.perm-write-probe"
  local shared_env_probe="${shared_env_path}.perm-write-probe"
  local shared_skills_probe="${shared_skills_dir}/.perm-write-probe"

  runuser -u "$user" -- env "${env_prefix[@]}" "$shell_wrapper_path" -c "test -r '$home_dir/.tfclaw-openclaw/openclaw.json'" >/dev/null 2>&1 \
    || { echo "permission guard check failed: cannot read user home for $user" >&2; return 1; }
  runuser -u "$user" -- env "${env_prefix[@]}" "$shell_wrapper_path" -c "test -d '$shared_skills_dir' && ls '$shared_skills_dir' >/dev/null" >/dev/null 2>&1 \
    || { echo "permission guard check failed: cannot read shared skills for $user" >&2; return 1; }
  runuser -u "$user" -- env "${env_prefix[@]}" "$shell_wrapper_path" -c "test -r '$shared_env_path'" >/dev/null 2>&1 \
    || { echo "permission guard check failed: cannot read shared env for $user" >&2; return 1; }
  runuser -u "$user" -- env "${env_prefix[@]}" "$shell_wrapper_path" -c "printf 'ok' > '$writable_probe'" >/dev/null 2>&1 \
    || { echo "permission guard check failed: cannot write own workspace for $user" >&2; return 1; }
  runuser -u "$user" -- env "${env_prefix[@]}" "$shell_wrapper_path" -c "rm -f '$writable_probe'" >/dev/null 2>&1 || true

  if runuser -u "$user" -- env "${env_prefix[@]}" "$shell_wrapper_path" -c "test -r '$denied_read_path'" >/dev/null 2>&1; then
    echo "permission guard check failed: unexpectedly readable outside whitelist for $user -> $denied_read_path" >&2
    return 1
  fi
  if runuser -u "$user" -- env "${env_prefix[@]}" "$shell_wrapper_path" -c "printf 'deny' > '$shared_env_probe'" >/dev/null 2>&1; then
    runuser -u "$user" -- env "${env_prefix[@]}" "$shell_wrapper_path" -c "rm -f '$shared_env_probe'" >/dev/null 2>&1 || true
    echo "permission guard check failed: unexpectedly writable shared env for $user -> $shared_env_path" >&2
    return 1
  fi
  if runuser -u "$user" -- env "${env_prefix[@]}" "$shell_wrapper_path" -c "printf 'deny' > '$shared_skills_probe'" >/dev/null 2>&1; then
    runuser -u "$user" -- env "${env_prefix[@]}" "$shell_wrapper_path" -c "rm -f '$shared_skills_probe'" >/dev/null 2>&1 || true
    echo "permission guard check failed: unexpectedly writable shared skills for $user -> $shared_skills_dir" >&2
    return 1
  fi
  if runuser -u "$user" -- env "${env_prefix[@]}" "$shell_wrapper_path" -c "printf 'deny' > '$denied_read_path'" >/dev/null 2>&1; then
    runuser -u "$user" -- env "${env_prefix[@]}" "$shell_wrapper_path" -c "rm -f '$denied_read_path'" >/dev/null 2>&1 || true
    echo "permission guard check failed: unexpectedly writable outside whitelist for $user -> $denied_read_path" >&2
    return 1
  fi
  return 0
}

restart_relay_tmux_session() {
  pkill -f "node .*apps/server/src/index.ts" >/dev/null 2>&1 || true
  if tmux has-session -t "$RELAY_SESSION" 2>/dev/null; then
    tmux kill-session -t "$RELAY_SESSION"
  fi
  TMUX= TMUX_PANE= tmux new-session -d -s "$RELAY_SESSION" \
    "bash -lc 'cd \"$TFCLAW_ROOT\" && RELAY_HOST=\"$RELAY_BIND_HOST\" RELAY_PORT=\"$RELAY_PORT\" RELAY_WS_PATH=\"$RELAY_WS_PATH\" npm exec tsx watch apps/server/src/index.ts'"
  TMUX= TMUX_PANE= tmux pipe-pane -o -t "${RELAY_SESSION}:0.0" "cat >> \"$RELAY_LOG_PATH\"" >/dev/null 2>&1 || true
  TMUX= TMUX_PANE= tmux capture-pane -p -S -200 -t "${RELAY_SESSION}:0.0" >> "$RELAY_LOG_PATH" 2>/dev/null || true
}

wait_for_port_closed() {
  local host="$1"
  local port="$2"
  local timeout_seconds="${3:-10}"
  python3 - "$host" "$port" "$timeout_seconds" <<'PY'
import socket
import sys
import time

host = sys.argv[1]
port = int(sys.argv[2])
timeout_seconds = float(sys.argv[3])
deadline = time.time() + max(timeout_seconds, 1.0)

while time.time() < deadline:
    sock = socket.socket()
    sock.settimeout(0.5)
    try:
        sock.connect((host, port))
    except OSError:
        sys.exit(0)
    finally:
        sock.close()
    time.sleep(0.2)

sys.exit(1)
PY
}

need_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "missing required command: $cmd" >&2
    exit 1
  fi
}

need_cmd jq
need_cmd tmux
need_cmd runuser
need_cmd node
need_cmd usermod

if [[ "$(id -u)" -ne 0 ]]; then
  echo "please run as root (required to switch linux users)." >&2
  exit 1
fi

if [[ ! -f "$CONFIG_PATH" ]]; then
  echo "config not found: $CONFIG_PATH" >&2
  exit 1
fi

RELAY_URL="$(jq -r '.relay.url // empty' "$CONFIG_PATH")"
if [[ -z "$RELAY_URL" ]]; then
  echo "relay url not found in config: $CONFIG_PATH (.relay.url)" >&2
  exit 1
fi

mapfile -t RELAY_PARTS < <(node -e '
const raw = process.argv[1] || "";
try {
  const u = new URL(raw);
  const host = (u.hostname || "").trim();
  const defaultPort = (u.protocol === "wss:" || u.protocol === "https:") ? "443" : "80";
  const port = (u.port || defaultPort).trim();
  const path = (u.pathname && u.pathname.trim()) ? u.pathname.trim() : "/";
  console.log(host);
  console.log(port);
  console.log(path);
} catch {
  process.exit(1);
}
' "$RELAY_URL" 2>/dev/null || true)

if [[ "${#RELAY_PARTS[@]}" -lt 3 ]]; then
  echo "failed to parse relay url: $RELAY_URL" >&2
  exit 1
fi

RELAY_HOST_RAW="${RELAY_PARTS[0]}"
RELAY_PORT="${RELAY_PARTS[1]}"
RELAY_WS_PATH="${RELAY_PARTS[2]}"

if [[ ! "$RELAY_PORT" =~ ^[0-9]+$ ]] || (( RELAY_PORT < 1 || RELAY_PORT > 65535 )); then
  echo "invalid relay port from url ($RELAY_URL): $RELAY_PORT" >&2
  exit 1
fi

RELAY_BIND_HOST="$RELAY_HOST_RAW"
case "$RELAY_BIND_HOST" in
  ""|"localhost") RELAY_BIND_HOST="127.0.0.1" ;;
  "0.0.0.0"|"127.0.0.1"|"::"|"::1") ;;
  *)
    # Non-local hostnames in relay.url are for clients; local relay should bind all interfaces.
    RELAY_BIND_HOST="0.0.0.0"
    ;;
esac

RELAY_HEALTH_HOST="$RELAY_BIND_HOST"
if [[ "$RELAY_HEALTH_HOST" == "0.0.0.0" || "$RELAY_HEALTH_HOST" == "::" ]]; then
  RELAY_HEALTH_HOST="127.0.0.1"
fi

OPENCLAW_ROOT_RAW="$(jq -r '.openclawBridge.openclawRoot // empty' "$CONFIG_PATH")"
if [[ -z "$OPENCLAW_ROOT_RAW" ]]; then
  OPENCLAW_ROOT_RAW="../openclaw"
fi
OPENCLAW_RUNTIME_BACKEND="$(jq -r '.openclawBridge.runtimeBackend // "local"' "$CONFIG_PATH" | tr '[:upper:]' '[:lower:]')"
if [[ "$OPENCLAW_RUNTIME_BACKEND" != "inspire-cpu" ]]; then
  OPENCLAW_RUNTIME_BACKEND="local"
fi
OPENCLAW_ROOT="$(resolve_from_tfclaw_root "$OPENCLAW_ROOT_RAW")"
OPENCLAW_ROOT="$(readlink -f "$OPENCLAW_ROOT" 2>/dev/null || echo "$OPENCLAW_ROOT")"
if [[ ! -d "$OPENCLAW_ROOT" ]]; then
  echo "openclaw root not found: $OPENCLAW_ROOT" >&2
  exit 1
fi

SHARED_SKILLS_DIR_RAW="$(jq -r '.openclawBridge.sharedSkillsDir // empty' "$CONFIG_PATH")"
if [[ -z "$SHARED_SKILLS_DIR_RAW" ]]; then
  SHARED_SKILLS_DIR_RAW="${OPENCLAW_ROOT}/skills"
fi
SHARED_SKILLS_DIR="$(resolve_from_tfclaw_root "$SHARED_SKILLS_DIR_RAW")"
SHARED_SKILLS_DIR="$(readlink -f "$SHARED_SKILLS_DIR" 2>/dev/null || echo "$SHARED_SKILLS_DIR")"
ensure_shared_skills_readable "$SHARED_SKILLS_DIR"
EXTENSION_FEISHU_SKILLS_DIR="${OPENCLAW_ROOT}/extensions/feishu/skills"
EXTENSION_FEISHU_SKILLS_DIR="$(readlink -f "$EXTENSION_FEISHU_SKILLS_DIR" 2>/dev/null || echo "$EXTENSION_FEISHU_SKILLS_DIR")"
OPENCLAW_EXTENSIONS_DIR="${OPENCLAW_ROOT}/extensions"
OPENCLAW_EXTENSIONS_DIR="$(readlink -f "$OPENCLAW_EXTENSIONS_DIR" 2>/dev/null || echo "$OPENCLAW_EXTENSIONS_DIR")"

SHARED_ENV_PATH_RAW="$(jq -r '.openclawBridge.sharedEnvPath // empty' "$CONFIG_PATH")"
if [[ -z "$SHARED_ENV_PATH_RAW" ]]; then
  SHARED_ENV_PATH_RAW=".runtime/openclaw_bridge/.env"
fi
SHARED_ENV_PATH="$(resolve_from_tfclaw_root "$SHARED_ENV_PATH_RAW")"
SHARED_ENV_PATH="$(readlink -f "$SHARED_ENV_PATH" 2>/dev/null || echo "$SHARED_ENV_PATH")"
SHARED_ENV_DIR="$(dirname -- "$SHARED_ENV_PATH")"
SHARED_ENV_PARENT_DIR="$(dirname -- "$SHARED_ENV_DIR")"
mkdir -p "$SHARED_ENV_DIR"
# Allow mapped linux users to traverse and read the shared env file only.
chmod 711 "$SHARED_ENV_PARENT_DIR" 2>/dev/null || true
chmod 711 "$SHARED_ENV_DIR" 2>/dev/null || true
if [[ ! -f "$SHARED_ENV_PATH" ]]; then
  printf '# Shared env for all TFClaw OpenClaw users.\n' > "$SHARED_ENV_PATH"
fi
chmod 644 "$SHARED_ENV_PATH" || true

SHARED_SKILLS_WHITELIST_ENTRY="$(path_to_project_whitelist_entry "$SHARED_SKILLS_DIR")"
EXTENSION_FEISHU_SKILLS_WHITELIST_ENTRY="$(path_to_project_whitelist_entry "$EXTENSION_FEISHU_SKILLS_DIR")"
OPENCLAW_EXTENSIONS_WHITELIST_ENTRY="$(path_to_project_whitelist_entry "$OPENCLAW_EXTENSIONS_DIR")"
SHARED_ENV_WHITELIST_ENTRY="$(path_to_project_whitelist_entry "$SHARED_ENV_PATH")"
DENIED_READ_SAMPLE_PATH="${TFCLAW_ROOT}/config.json"

USER_HOME_ROOT_RAW="$(jq -r '.openclawBridge.userHomeRoot // empty' "$CONFIG_PATH")"
if [[ -z "$USER_HOME_ROOT_RAW" ]]; then
  USER_HOME_ROOT_RAW=".home"
fi
USER_HOME_ROOT="$(resolve_from_tfclaw_root "$USER_HOME_ROOT_RAW")"
mkdir -p "$USER_HOME_ROOT"
USER_HOME_ROOT="$(readlink -f "$USER_HOME_ROOT" 2>/dev/null || echo "$USER_HOME_ROOT")"
chmod 711 "$USER_HOME_ROOT" || true
harden_tfclaw_root_for_user_isolation "$TFCLAW_ROOT" "$USER_HOME_ROOT"
# harden_* will tighten TFClaw subdirs; re-apply explicit shared read-only paths.
ensure_shared_skills_readable "$SHARED_SKILLS_DIR"
chmod 711 "$SHARED_ENV_PARENT_DIR" 2>/dev/null || true
chmod 711 "$SHARED_ENV_DIR" 2>/dev/null || true
chmod 644 "$SHARED_ENV_PATH" 2>/dev/null || true

LEGACY_USER_HOME_ROOT_RAW="${TFCLAW_LEGACY_USER_HOME_ROOT:-$(dirname -- "$SCIHARNESS_ROOT")/.home}"
LEGACY_USER_HOME_ROOT="$(readlink -f "$LEGACY_USER_HOME_ROOT_RAW" 2>/dev/null || echo "$LEGACY_USER_HOME_ROOT_RAW")"

LEGACY_GROUP_WORKSPACE_ROOT="${TFCLAW_ROOT}/.runtime/openclaw_bridge/group_workspaces"
GROUP_WORKSPACE_ROOT="${USER_HOME_ROOT}/_groups"
mkdir -p "$GROUP_WORKSPACE_ROOT"
chmod 711 "$GROUP_WORKSPACE_ROOT" || true
if [[ -d "$LEGACY_GROUP_WORKSPACE_ROOT" ]]; then
  cp -a "$LEGACY_GROUP_WORKSPACE_ROOT"/. "$GROUP_WORKSPACE_ROOT"/ 2>/dev/null || true
fi
chmod 711 "$GROUP_WORKSPACE_ROOT" || true

ACCESS_STATE_PATH="${TFCLAW_ROOT}/.runtime/openclaw_bridge/access-control.json"
if [[ -f "$ACCESS_STATE_PATH" ]]; then
  tmp_access_state="$(mktemp)"
  if jq \
    --arg legacy "$LEGACY_GROUP_WORKSPACE_ROOT" \
    --arg next "$GROUP_WORKSPACE_ROOT" \
    '
      .groups = ((.groups // {}) | with_entries(
        .value.workspaceDir = (
          (.value.workspaceDir // "") as $ws
          | if ($ws | type) != "string" then $ws
            elif ($legacy | length) == 0 then $ws
            elif ($ws | startswith($legacy)) then ($next + ($ws | ltrimstr($legacy)))
            else $ws
          end
        )
      ))
    ' "$ACCESS_STATE_PATH" > "$tmp_access_state"; then
    mv "$tmp_access_state" "$ACCESS_STATE_PATH"
    chmod 600 "$ACCESS_STATE_PATH" || true
  else
    rm -f "$tmp_access_state"
  fi
fi

NODE_PATH="$(jq -r '.openclawBridge.nodePath // empty' "$CONFIG_PATH")"
if [[ "$NODE_PATH" == "~/"* ]]; then
  NODE_PATH="${HOME}/${NODE_PATH#\~/}"
elif [[ "$NODE_PATH" == "~" ]]; then
  NODE_PATH="$HOME"
fi
if [[ -n "$NODE_PATH" && "$NODE_PATH" != /* ]]; then
  CONFIG_DIR="$(cd -- "$(dirname -- "$CONFIG_PATH")" && pwd -P)"
  NODE_PATH="${CONFIG_DIR}/${NODE_PATH}"
fi
if [[ -n "$NODE_PATH" ]]; then
  NODE_PATH="$(readlink -f -- "$NODE_PATH" 2>/dev/null || realpath "$NODE_PATH" 2>/dev/null || printf '%s' "$NODE_PATH")"
fi
if [[ -z "$NODE_PATH" ]]; then
  NODE_PATH="$(command -v node)"
fi
if [[ ! -x "$NODE_PATH" ]]; then
  NODE_PATH_FALLBACK="$(command -v node 2>/dev/null || true)"
  if [[ -n "$NODE_PATH_FALLBACK" && -x "$NODE_PATH_FALLBACK" ]]; then
    echo "[warn] configured nodePath not executable, fallback to: $NODE_PATH_FALLBACK" >&2
    NODE_PATH="$NODE_PATH_FALLBACK"
  else
    echo "node executable not found: $NODE_PATH" >&2
    exit 1
  fi
fi
NODE_BIN_DIR="$(dirname -- "$NODE_PATH")"

OPENCLAW_FEISHU_APP_ID="$(jq -r '.openclawBridge.feishuAppId // .channels.feishu.appId // empty' "$CONFIG_PATH")"
OPENCLAW_FEISHU_APP_SECRET="$(jq -r '.openclawBridge.feishuAppSecret // .channels.feishu.appSecret // empty' "$CONFIG_PATH")"
OPENCLAW_FEISHU_VERIFICATION_TOKEN_BASE="$(jq -r '.openclawBridge.feishuVerificationToken // .channels.feishu.verificationToken // empty' "$CONFIG_PATH")"
OPENCLAW_FEISHU_ENCRYPT_KEY="$(jq -r '.openclawBridge.feishuEncryptKey // .channels.feishu.encryptKey // empty' "$CONFIG_PATH")"
if [[ -z "$OPENCLAW_FEISHU_ENCRYPT_KEY" ]]; then
  OPENCLAW_FEISHU_ENCRYPT_KEY="${TFCLAW_OPENCLAW_FEISHU_ENCRYPT_KEY:-${FEISHU_ENCRYPT_KEY:-}}"
fi
OPENCLAW_FEISHU_WEBHOOK_PORT_OFFSET_RAW="$(jq -r '.openclawBridge.feishuWebhookPortOffset // empty' "$CONFIG_PATH")"
if [[ "$OPENCLAW_FEISHU_WEBHOOK_PORT_OFFSET_RAW" =~ ^[0-9]+$ ]]; then
  OPENCLAW_FEISHU_WEBHOOK_PORT_OFFSET="$OPENCLAW_FEISHU_WEBHOOK_PORT_OFFSET_RAW"
else
  OPENCLAW_FEISHU_WEBHOOK_PORT_OFFSET=20000
fi
if [[ "$OPENCLAW_FEISHU_WEBHOOK_PORT_OFFSET" -lt 100 ]]; then
  OPENCLAW_FEISHU_WEBHOOK_PORT_OFFSET=100
fi
if [[ "$OPENCLAW_FEISHU_WEBHOOK_PORT_OFFSET" -gt 50000 ]]; then
  OPENCLAW_FEISHU_WEBHOOK_PORT_OFFSET=50000
fi

OPENCLAW_ENTRY="${OPENCLAW_ROOT}/openclaw.mjs"
if [[ ! -f "$OPENCLAW_ENTRY" ]]; then
  echo "openclaw entry not found: $OPENCLAW_ENTRY" >&2
  exit 1
fi

OPENCLAW_CONFIG_TEMPLATE_PATH_RAW="$(jq -r '.openclawBridge.configTemplatePath // "~/.openclaw/openclaw.json"' "$CONFIG_PATH")"
if [[ "$OPENCLAW_CONFIG_TEMPLATE_PATH_RAW" == "~/"* ]]; then
  OPENCLAW_CONFIG_TEMPLATE_PATH="${HOME}/${OPENCLAW_CONFIG_TEMPLATE_PATH_RAW#\~/}"
elif [[ "$OPENCLAW_CONFIG_TEMPLATE_PATH_RAW" == "~" ]]; then
  OPENCLAW_CONFIG_TEMPLATE_PATH="$HOME"
elif [[ "$OPENCLAW_CONFIG_TEMPLATE_PATH_RAW" == /* ]]; then
  OPENCLAW_CONFIG_TEMPLATE_PATH="$OPENCLAW_CONFIG_TEMPLATE_PATH_RAW"
else
  OPENCLAW_CONFIG_TEMPLATE_PATH="$(resolve_from_tfclaw_root "$OPENCLAW_CONFIG_TEMPLATE_PATH_RAW")"
fi
OPENCLAW_CONFIG_TEMPLATE_PATH="$(readlink -f "$OPENCLAW_CONFIG_TEMPLATE_PATH" 2>/dev/null || echo "$OPENCLAW_CONFIG_TEMPLATE_PATH")"
TEMPLATE_CONFIG_JSON='{}'
if [[ -f "$OPENCLAW_CONFIG_TEMPLATE_PATH" ]]; then
  if ! jq -e . "$OPENCLAW_CONFIG_TEMPLATE_PATH" >/dev/null 2>&1; then
    echo "failed to parse openclaw config template: $OPENCLAW_CONFIG_TEMPLATE_PATH" >&2
    exit 1
  fi
  TEMPLATE_CONFIG_JSON="$(jq -c 'if type == "object" then . else {} end' "$OPENCLAW_CONFIG_TEMPLATE_PATH")"
else
  echo "[warn] openclaw config template not found, fallback to empty template: $OPENCLAW_CONFIG_TEMPLATE_PATH" >&2
fi

OPENCLAW_COMMON_WORKSPACE_DIR="${TFCLAW_COMMON_WORKSPACE_DIR:-$(dirname -- "$OPENCLAW_ROOT")/commonworkspace}"
OPENCLAW_COMMON_WORKSPACE_DIR="$(readlink -f "$OPENCLAW_COMMON_WORKSPACE_DIR" 2>/dev/null || echo "$OPENCLAW_COMMON_WORKSPACE_DIR")"
OPENCLAW_COMMON_CONFIG_PATH="${OPENCLAW_COMMON_WORKSPACE_DIR}/openclaw.json"
COMMON_CONFIG_JSON='{}'
if [[ -f "$OPENCLAW_COMMON_CONFIG_PATH" ]]; then
  if ! jq -e . "$OPENCLAW_COMMON_CONFIG_PATH" >/dev/null 2>&1; then
    echo "failed to parse common workspace openclaw config: $OPENCLAW_COMMON_CONFIG_PATH" >&2
    exit 1
  fi
  COMMON_CONFIG_JSON="$(jq -c 'if type == "object" then . else {} end' "$OPENCLAW_COMMON_CONFIG_PATH")"
fi

mkdir -p "$(dirname -- "$MAP_PATH")"
if [[ ! -f "$MAP_PATH" ]]; then
  printf '{\n  "version": 1,\n  "users": {}\n}\n' > "$MAP_PATH"
  chmod 600 "$MAP_PATH"
fi

mkdir -p "$LOG_ROOT"
touch "$RELAY_LOG_PATH"
touch "$GATEWAY_LOG_PATH"

echo "[1/4] restarting tfclaw relay session: $RELAY_SESSION"
restart_relay_tmux_session

mapfile -t USERS < <(jq -r '.users // {} | to_entries[]? | [.value.linuxUser, (.value.gatewayPort|tostring), .value.gatewayToken] | @tsv' "$MAP_PATH")

echo "[2/4] restarting mapped openclaw users"
if [[ "$OPENCLAW_RUNTIME_BACKEND" == "inspire-cpu" ]]; then
  echo "skip local mapped-user restart: runtimeBackend=inspire-cpu"
elif [[ "${#USERS[@]}" -eq 0 ]]; then
  echo "no mapped users found in $MAP_PATH"
else
  for row in "${USERS[@]}"; do
    IFS=$'\t' read -r user port token <<<"$row"
    [[ -n "$user" && -n "$port" && -n "$token" ]] || continue
    session_name="${TMUX_SESSION_PREFIX}${user}"

    passwd_line="$(getent passwd "$user" || true)"
    if [[ -z "$passwd_line" ]]; then
      echo "skip $user: linux user not found"
      continue
    fi
    home_dir="$(awk -F: '{print $6}' <<<"$passwd_line")"
    if [[ -z "$home_dir" ]]; then
      echo "skip $user: home dir missing"
      continue
    fi

    env -u TMUX -u TMUX_PANE runuser -u "$user" -- tmux has-session -t "$session_name" 2>/dev/null \
      && env -u TMUX -u TMUX_PANE runuser -u "$user" -- tmux kill-session -t "$session_name" \
      || true
    pkill -u "$user" -f "openclaw.mjs gateway" >/dev/null 2>&1 || true
    pkill -u "$user" -f "^openclaw-gateway( |$)" >/dev/null 2>&1 || true
    pkill -u "$user" -x "openclaw-gatewa" >/dev/null 2>&1 || true
    wait_for_port_closed "127.0.0.1" "$port" 10 >/dev/null 2>&1 || true

    expected_home_dir="${USER_HOME_ROOT}/${user}"
    if [[ "$home_dir" != "$expected_home_dir" ]]; then
      old_home_dir="$home_dir"
      migrated_home="$(migrate_user_home "$user" "$home_dir" "$expected_home_dir" || true)"
      if [[ -z "$migrated_home" ]]; then
        echo "skip $user: failed to migrate home ($home_dir -> $expected_home_dir)"
        continue
      fi
      home_dir="$migrated_home"
      if [[ -n "${old_home_dir:-}" && "$old_home_dir" != "$home_dir" ]]; then
        lock_legacy_home_dir "$old_home_dir"
      fi
    fi
    rewrite_legacy_path_refs_in_user_home "${LEGACY_USER_HOME_ROOT}/${user}" "$home_dir" "$home_dir"
    if [[ "$LEGACY_USER_HOME_ROOT" != "$USER_HOME_ROOT" ]]; then
      cleanup_legacy_tmux_socket "$user" "${LEGACY_USER_HOME_ROOT}/${user}"
      lock_legacy_home_dir "${LEGACY_USER_HOME_ROOT}/${user}"
    fi

    # Permission self-heal for migrated homes.
    mkdir -p "$home_dir/.tfclaw-openclaw/workspace" "$home_dir/.tfclaw-openclaw/workspace/skills" "$home_dir/.openclaw" "$home_dir/skills"
    chown -R "$user:$user" "$home_dir"
    chmod 711 "$USER_HOME_ROOT" || true
    chmod 700 "$home_dir" || true
    chmod 700 "$home_dir/.openclaw" "$home_dir/.tfclaw-openclaw" "$home_dir/.tfclaw-openclaw/workspace" "$home_dir/.tfclaw-openclaw/workspace/skills" "$home_dir/skills" || true

    shell_wrapper_dir="${home_dir}/.tfclaw-openclaw/bin"
    shell_wrapper_path="${shell_wrapper_dir}/tfclaw-jail-shell.sh"
    mkdir -p "$shell_wrapper_dir"
cat > "$shell_wrapper_path" <<'TFCLAW_JAIL_SHELL'
#!/usr/bin/env bash
set -euo pipefail

REAL_SHELL="${TFCLAW_EXEC_REAL_SHELL:-/bin/bash}"
WORKSPACE="${TFCLAW_EXEC_WORKSPACE:-${PWD}}"
USER_HOME="${TFCLAW_EXEC_HOME:-${HOME:-$WORKSPACE}}"
USER_NAME="${USER:-$(id -un 2>/dev/null || echo user)}"
NODE_BIN_DIR="${TFCLAW_EXEC_NODE_BIN_DIR:-}"
NODE_BIN=""
PATH_DEFAULT="${PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}"
if [[ -n "$NODE_BIN_DIR" && -d "$NODE_BIN_DIR" ]]; then
  PATH_DEFAULT="$NODE_BIN_DIR:$PATH_DEFAULT"
  if [[ -x "$NODE_BIN_DIR/node" ]]; then
    NODE_BIN="$NODE_BIN_DIR/node"
  fi
fi

if [[ "${1:-}" != "-c" || $# -lt 2 ]]; then
  exec "$REAL_SHELL" "$@"
fi

CMD="$2"
WORKSPACE="$(readlink -f "$WORKSPACE" 2>/dev/null || realpath "$WORKSPACE" 2>/dev/null || echo "$WORKSPACE")"
USER_HOME="$(readlink -f "$USER_HOME" 2>/dev/null || realpath "$USER_HOME" 2>/dev/null || echo "$USER_HOME")"
if [[ ! -d "$WORKSPACE" ]]; then
  exec "$REAL_SHELL" -c "$CMD"
fi
if [[ ! -d "$USER_HOME" ]]; then
  USER_HOME="$WORKSPACE"
fi
NPM_CACHE_DIR="${WORKSPACE}/.npm-cache"
NPM_PREFIX_DIR="${WORKSPACE}/.npm-global"
NPM_USERCONFIG="${WORKSPACE}/.npmrc"
mkdir -p "$NPM_CACHE_DIR" "$NPM_PREFIX_DIR/bin"

cd "$WORKSPACE"
export PATH="$NPM_PREFIX_DIR/bin:$PATH_DEFAULT"
export HOME="$USER_HOME"
export USER="$USER_NAME"
export LOGNAME="$USER_NAME"
export SHELL="$REAL_SHELL"
export TERM="${TERM:-xterm-256color}"
export LANG="${LANG:-C.UTF-8}"
export NPM_CONFIG_CACHE="$NPM_CACHE_DIR"
export npm_config_cache="$NPM_CACHE_DIR"
export NPM_CONFIG_PREFIX="$NPM_PREFIX_DIR"
export npm_config_prefix="$NPM_PREFIX_DIR"
export NPM_CONFIG_USERCONFIG="$NPM_USERCONFIG"
export npm_config_userconfig="$NPM_USERCONFIG"
export NPM_CONFIG_UPDATE_NOTIFIER=false
export npm_config_update_notifier=false
if [[ -n "$NODE_BIN" ]]; then
  export TFCLAW_EXEC_NODE_PATH="$NODE_BIN"
fi

# Guardrail: rewrite common bad node invocations that bypass configured nodePath.
if [[ -n "$NODE_BIN" ]]; then
  CMD="${CMD//\/usr\/bin\/node/node}"
  CMD="${CMD//\/usr\/local\/bin\/node/node}"
  CMD="${CMD//env -i \/bin\/bash -lc/env -i bash -lc}"
  CMD="${CMD//env -i \/usr\/bin\/bash -lc/env -i bash -lc}"
  if [[ "$CMD" == *"env -i "* && "$CMD" != *"env -i PATH="* ]]; then
    CMD="${CMD//env -i /env -i PATH=\"$PATH\" }"
  fi
fi
PROJECT_ROOT="${TFCLAW_EXEC_PROJECT_ROOT:-$WORKSPACE}"
READ_WHITELIST="${TFCLAW_EXEC_READ_WHITELIST:-}"
WRITE_WHITELIST="${TFCLAW_EXEC_WRITE_WHITELIST:-}"
tfclaw_guard_command_paths() {
  local cmd_text="$1"
  if command -v python3 >/dev/null 2>&1; then
    TFCLAW_GUARD_CMD="$cmd_text" \
    TFCLAW_GUARD_WORKSPACE="$WORKSPACE" \
    TFCLAW_GUARD_HOME="$USER_HOME" \
    TFCLAW_GUARD_PROJECT_ROOT="$PROJECT_ROOT" \
    TFCLAW_GUARD_READ_WHITELIST="$READ_WHITELIST" \
    TFCLAW_GUARD_WRITE_WHITELIST="$WRITE_WHITELIST" \
    python3 <<'PY'
import os
import re
import shlex
import sys
from pathlib import Path

cmd = os.environ.get("TFCLAW_GUARD_CMD", "")
workspace = os.path.realpath(os.environ.get("TFCLAW_GUARD_WORKSPACE", ""))
user_home = os.path.realpath(os.environ.get("TFCLAW_GUARD_HOME", ""))
project_root = os.path.realpath(os.environ.get("TFCLAW_GUARD_PROJECT_ROOT", workspace or "."))
read_whitelist_raw = os.environ.get("TFCLAW_GUARD_READ_WHITELIST", "")
write_whitelist_raw = os.environ.get("TFCLAW_GUARD_WRITE_WHITELIST", "")
allowed_special = {"/dev/null", "/dev/stdin", "/dev/stdout", "/dev/stderr"}

if re.search(r"(^|[^A-Za-z0-9_])\.\.($|[^A-Za-z0-9_])", cmd):
    print("TFClaw sandbox: parent traversal '..' is not allowed.", file=sys.stderr)
    sys.exit(2)

def split_whitelist(raw: str) -> list[str]:
    return [item.strip() for item in raw.split(":") if item.strip()]

def resolve_whitelist_entry(entry: str) -> str:
    expanded = os.path.expanduser(entry)
    if os.path.isabs(expanded):
        return os.path.realpath(expanded)
    return os.path.realpath(os.path.join(project_root, expanded))

def dedupe(values: list[str]) -> list[str]:
    seen = set()
    out: list[str] = []
    for value in values:
        if not value or value in seen:
            continue
        seen.add(value)
        out.append(value)
    return out

def build_roots(raw: str, fallback: list[str]) -> list[str]:
    values = [resolve_whitelist_entry(item) for item in split_whitelist(raw)]
    if not values:
        values = [os.path.realpath(item) for item in fallback if item]
    return dedupe(values)

read_roots = build_roots(read_whitelist_raw, [workspace, user_home])
write_roots = build_roots(write_whitelist_raw, [user_home])

def within_roots(path: str, roots: list[str]) -> bool:
    if path in allowed_special:
        return True
    for root in roots:
        if path == root or path.startswith(root + os.sep):
            return True
    return False

def first_segment_exists(path: str) -> bool:
    if not path.startswith("/"):
        return False
    rest = path[1:]
    if not rest:
        return True
    first = "/" + rest.split("/", 1)[0]
    return os.path.exists(first)

def normalize_candidate(raw: str) -> str:
    expanded = os.path.expanduser(raw)
    if os.path.isabs(expanded):
        return os.path.realpath(expanded)
    return ""

def add_candidate(raw: str, sink: set[str]) -> None:
    candidate = normalize_candidate(raw)
    if candidate:
        sink.add(candidate)

def is_url(token: str) -> bool:
    return re.match(r"^[A-Za-z][A-Za-z0-9+.-]*://", token or "") is not None

try:
    tokens = shlex.split(cmd, posix=True)
except Exception:
    tokens = cmd.split()

candidates: set[str] = set()
write_candidates: set[str] = set()

write_redir_ops = {">", ">>", "1>", "2>", "1>>", "2>>", ">|", "1>|", "2>|", "&>", "&>>", "<>"}
read_redir_ops = {"<", "0<"}
write_redir_prefixes = tuple(sorted(write_redir_ops, key=len, reverse=True))
read_redir_prefixes = tuple(sorted(read_redir_ops, key=len, reverse=True))

for idx, token in enumerate(tokens):
    if is_url(token):
        continue
    if token in write_redir_ops | read_redir_ops:
        if idx + 1 < len(tokens):
            next_token = tokens[idx + 1]
            if not is_url(next_token):
                add_candidate(next_token, candidates)
                if token in write_redir_ops:
                    add_candidate(next_token, write_candidates)
        continue
    if token.startswith("/") or token == "~" or token.startswith("~/"):
        add_candidate(token, candidates)
    if "=" in token and not token.startswith("="):
        rhs = token.split("=", 1)[1]
        if rhs.startswith("/") or rhs == "~" or rhs.startswith("~/"):
            add_candidate(rhs, candidates)
    for prefix in write_redir_prefixes:
        if token.startswith(prefix) and len(token) > len(prefix):
            rhs = token[len(prefix):]
            add_candidate(rhs, candidates)
            add_candidate(rhs, write_candidates)
            break
    for prefix in read_redir_prefixes:
        if token.startswith(prefix) and len(token) > len(prefix):
            rhs = token[len(prefix):]
            add_candidate(rhs, candidates)
            break

sanitized = re.sub(r"[A-Za-z][A-Za-z0-9+.-]*://\S+", " ", cmd)
for match in re.finditer(r"(?<![A-Za-z0-9_])(/[^ \t\r\n'\"`|&;<>]+)", sanitized):
    add_candidate(match.group(1), candidates)

cmd_name = ""
if tokens:
    cmd_name = Path(tokens[0]).name.lower()

mutating_all = {
    "rm", "mkdir", "rmdir", "touch", "truncate", "chmod", "chown",
    "ln", "unlink", "install", "dd", "mktemp", "find", "tar", "zip",
    "unzip", "cpio", "tee", "mv", "cp", "rsync", "scp",
}
mutating_dest_last = {"cp", "mv", "install", "rsync", "scp"}

positional_paths: list[str] = []
after_double_dash = False
for token in tokens[1:]:
    if is_url(token):
        continue
    if token == "--":
        after_double_dash = True
        continue
    if not after_double_dash and token.startswith("-"):
        continue
    if token.startswith("/") or token == "~" or token.startswith("~/"):
        normalized = normalize_candidate(token)
        if normalized:
            positional_paths.append(normalized)

if cmd_name in mutating_all:
    if cmd_name in mutating_dest_last:
        if positional_paths:
            write_candidates.add(positional_paths[-1])
    elif cmd_name == "tee":
        for candidate in positional_paths:
            write_candidates.add(candidate)
    else:
        for candidate in positional_paths:
            write_candidates.add(candidate)

if cmd_name in {"sed", "perl"} and any(
    tok == "-i" or tok.startswith("-i") for tok in tokens[1:]
):
    for candidate in positional_paths:
        write_candidates.add(candidate)

for normalized in sorted(candidates):
    if not first_segment_exists(normalized):
        continue
    if not within_roots(normalized, read_roots):
        print(f"TFClaw sandbox: read path not allowed: {normalized}", file=sys.stderr)
        sys.exit(2)

for normalized in sorted(write_candidates):
    if not first_segment_exists(normalized):
        continue
    if not within_roots(normalized, write_roots):
        print(f"TFClaw sandbox: write path not allowed: {normalized}", file=sys.stderr)
        sys.exit(2)
PY
    return $?
  fi
  if [[ "$cmd_text" == *"../"* || "$cmd_text" =~ (^|[[:space:];|&<>=()])/[^[:space:]]+ ]]; then
    echo "TFClaw sandbox: disallowed path detected in command." >&2
    return 1
  fi
  return 0
}
if ! tfclaw_guard_command_paths "$CMD"; then
  exit 126
fi
exec "$REAL_SHELL" -lc "$CMD"
TFCLAW_JAIL_SHELL
    chown "$user:$user" "$shell_wrapper_path"
    chmod 700 "$shell_wrapper_path"

    skills_dir="${home_dir}/skills"
    workspace_dir="${home_dir}/.tfclaw-openclaw/workspace"
    workspace_skills_dir="${workspace_dir}/skills"
    user_home_whitelist_entry="$(path_to_project_whitelist_entry "$home_dir")"
    read_whitelist_entries="${user_home_whitelist_entry}:${SHARED_SKILLS_WHITELIST_ENTRY}:${EXTENSION_FEISHU_SKILLS_WHITELIST_ENTRY}:${OPENCLAW_EXTENSIONS_WHITELIST_ENTRY}:${SHARED_ENV_WHITELIST_ENTRY}"
    write_whitelist_entries="${user_home_whitelist_entry}"
    normalize_user_bridge_runtime_permissions "$user" "$home_dir"
    shared_env_vars_json="$(parse_dotenv_file_to_json "$SHARED_ENV_PATH")"
    workspace_env_path="${workspace_dir}/.env"
    user_env_path="${home_dir}/.tfclaw-openclaw/user.env.json"
    legacy_user_env_path="${LEGACY_USER_HOME_ROOT}/${user}/.tfclaw-openclaw/user.env.json"
    workspace_env_vars_json="$(parse_dotenv_file_to_json "$workspace_env_path")"
    user_env_vars_json="$(jq -c '.vars // . // {}' "$user_env_path" 2>/dev/null || echo '{}')"
    if [[ "$legacy_user_env_path" != "$user_env_path" && -f "$legacy_user_env_path" ]]; then
      legacy_user_env_vars_json="$(jq -c '.vars // . // {}' "$legacy_user_env_path" 2>/dev/null || echo '{}')"
      user_env_vars_json="$(jq -cn --argjson legacy "$legacy_user_env_vars_json" --argjson current "$user_env_vars_json" '$legacy + $current')"
    fi
    # Migrate old user.env.json into the single private source: workspace/.env (workspace overrides legacy json).
    user_env_vars_json="$(jq -cn --argjson legacy "$user_env_vars_json" --argjson workspace "$workspace_env_vars_json" '$legacy + $workspace')"
    user_env_vars_json="$(sanitize_private_env_overrides_json "$user_env_vars_json")"
    # Sync shared env into workspace/.env. This is now the only private env file.
    synced_workspace_env_vars_json="$(jq -cn --argjson shared "$shared_env_vars_json" --argjson current "$user_env_vars_json" '$shared + $current')"
    synced_workspace_env_vars_json="$(jq -cn --argjson shared "$shared_env_vars_json" --argjson current "$synced_workspace_env_vars_json" '
      (($shared.MOSS_API_KEY // $shared.moss_api_key // "") | tostring) as $shared_moss
      | if ($shared_moss | length) > 0 then
          $current + {MOSS_API_KEY: $shared_moss, moss_api_key: $shared_moss}
        else
          (($current.MOSS_API_KEY // $current.moss_api_key // "") | tostring) as $resolved_moss
          | if ($resolved_moss | length) > 0 then
              $current + {MOSS_API_KEY: $resolved_moss, moss_api_key: $resolved_moss}
            else
              $current
            end
        end
    ')"
    tmp_workspace_env="${workspace_env_path}.tmp.$$"
    jq -r '
      to_entries
      | map(select((.key | type) == "string" and ((.value | type) == "string") and (.value | length) > 0))
      | sort_by(.key)
      | .[]
      | "\(.key)=\(.value | @json)"
    ' <<<"$synced_workspace_env_vars_json" > "$tmp_workspace_env"
    mv "$tmp_workspace_env" "$workspace_env_path"
    chown "$user:$user" "$workspace_env_path"
    chmod 600 "$workspace_env_path"
    rm -f "$user_env_path" >/dev/null 2>&1 || true
    if [[ "$legacy_user_env_path" != "$user_env_path" ]]; then
      rm -f "$legacy_user_env_path" >/dev/null 2>&1 || true
    fi
    runtime_env_vars_json="$(jq -c --arg clawhub_workdir "$workspace_dir" '.CLAWHUB_WORKDIR = $clawhub_workdir' <<<"$synced_workspace_env_vars_json")"
    config_path="${home_dir}/.tfclaw-openclaw/openclaw.json"
    if [[ ! -f "$config_path" ]]; then
      printf '{}\n' > "$config_path"
      chown "$user:$user" "$config_path"
      chmod 600 "$config_path"
      echo "bootstrap $user: created default config at $config_path"
    fi
    feishu_webhook_port=$((port + OPENCLAW_FEISHU_WEBHOOK_PORT_OFFSET))
    if [[ "$feishu_webhook_port" -lt 1024 ]]; then
      feishu_webhook_port=1024
    fi
    if [[ "$feishu_webhook_port" -gt 65535 ]]; then
      feishu_webhook_port=65535
    fi
    feishu_verification_token="$OPENCLAW_FEISHU_VERIFICATION_TOKEN_BASE"
    if [[ -z "$feishu_verification_token" ]]; then
      feishu_verification_token="tfclaw-${user}"
    fi

    # Ensure per-user skills directory is always included and exec policy is usable per user.
    tmp_cfg="${config_path}.tmp.$$"
    jq \
      --arg shared_skills_dir "$SHARED_SKILLS_DIR" \
      --arg extension_feishu_skills_dir "$EXTENSION_FEISHU_SKILLS_DIR" \
      --arg openclaw_extensions_dir "$OPENCLAW_EXTENSIONS_DIR" \
      --arg skills_dir "$skills_dir" \
      --arg workspace_skills_dir "$workspace_skills_dir" \
      --argjson runtime_env_vars "$runtime_env_vars_json" \
      --argjson template_config "$TEMPLATE_CONFIG_JSON" \
      --argjson common_config "$COMMON_CONFIG_JSON" \
      --arg feishu_app_id "$OPENCLAW_FEISHU_APP_ID" \
      --arg feishu_app_secret "$OPENCLAW_FEISHU_APP_SECRET" \
      --arg feishu_verification_token "$feishu_verification_token" \
      --arg feishu_encrypt_key "$OPENCLAW_FEISHU_ENCRYPT_KEY" \
      --argjson feishu_webhook_port "$feishu_webhook_port" \
      --argjson compaction_reserve_tokens_floor "$FORCED_COMPACTION_RESERVE_TOKENS_FLOOR" \
      '
      def deepmerge(a; b):
        if (a | type) == "object" and (b | type) == "object" then
          reduce (((a | keys_unsorted) + (b | keys_unsorted) | unique[]) ) as $k
            ({}; .[$k] = deepmerge(a[$k]; b[$k]))
        elif b == null then
          a
        else
          b
        end;
      (if type == "object" then . else {} end) as $current |
      (deepmerge($template_config; $common_config)) as $base |
      deepmerge($current; $base) |
      # Always re-apply models from the template config for every restart,
      # even when the per-user config already exists.
      if (($template_config.models // null) | type) != "null" then
        .models = $template_config.models
      else
        .
      end |
      .skills = (.skills // {}) |
      .skills.load = (.skills.load // {}) |
      .skills.load.extraDirs = [ $shared_skills_dir, $skills_dir, $workspace_skills_dir ] |
      .env = (.env // {}) |
      .env.vars = ((.env.vars // {}) + $runtime_env_vars) |
      .agents = (.agents // {}) |
      .agents.defaults = (.agents.defaults // {}) |
      .agents.defaults.compaction = ((.agents.defaults.compaction // {}) + {
        mode: "safeguard",
        reserveTokensFloor: $compaction_reserve_tokens_floor
      }) |
      if ((.agents.list // null) | type) == "array" then
        .agents.list |= map(
          if ((.subagents.allowAgents // null) | type) == "array" then
            .subagents.allowAgents = (
              (.subagents.allowAgents
                | map(tostring)
                | map(gsub("^\\s+|\\s+$"; ""))
                | map(select(length > 0 and . != "*"))
                | unique)
            ) |
            if (.subagents.allowAgents | length) == 0 then
              .subagents.allowAgents = ["main"]
            else
              .
            end
          else
            .
          end
        )
      else
        .
      end |
      .tools = (.tools // {}) |
      .tools.exec = (.tools.exec // {}) |
      .tools.exec.host = "gateway" |
      .tools.exec.security = "full" |
      .tools.exec.ask = "off" |
      .tools.exec.applyPatch = (.tools.exec.applyPatch // {}) |
      .tools.exec.applyPatch.workspaceOnly = true |
      .tools.fs = (.tools.fs // {}) |
      .tools.fs.workspaceOnly = true |
      .tools.fs.readOnlyRoots = (((.tools.fs.readOnlyRoots // []) + [ $shared_skills_dir, $extension_feishu_skills_dir, $openclaw_extensions_dir ]) | map(tostring) | map(select(length > 0)) | unique) |
      .tools.deny = ((.tools.deny // []) | map(tostring) | map(select((. | ascii_downcase) != "message"))) |
      .tools.alsoAllow = (((.tools.alsoAllow // []) + [
        "feishu_doc",
        "feishu_create_doc",
        "feishu_fetch_doc",
        "feishu_update_doc",
        "feishu_app_scopes",
        "feishu_drive_file",
        "feishu_doc_comments",
        "feishu_doc_media"
      ]) | map(tostring) | map(select(length > 0)) | unique) |
      .channels = (.channels // {}) |
      .channels.feishu = (.channels.feishu // {}) |
      .channels.feishu.enabled = true |
      .channels.feishu.appId = $feishu_app_id |
      .channels.feishu.appSecret = $feishu_app_secret |
      .channels.feishu.connectionMode = "webhook" |
      .channels.feishu.webhookHost = "127.0.0.1" |
      .channels.feishu.webhookPort = $feishu_webhook_port |
      .channels.feishu.webhookPath = "/feishu/events" |
      .channels.feishu.verificationToken = $feishu_verification_token |
      if (($feishu_encrypt_key | tostring | length) > 0) then
        .channels.feishu.encryptKey = $feishu_encrypt_key
      else
        .
      end |
      .channels.feishu.tools = ((.channels.feishu.tools // {}) + {
        doc: true,
        wiki: true,
        drive: true,
        scopes: true,
        chat: true,
        perm: true
      }) |
      del(
        .channels.feishu.accounts,
        .channels.feishu.defaultAccount
      )
    ' "$config_path" > "$tmp_cfg"
    mv "$tmp_cfg" "$config_path"
    chown "$user:$user" "$config_path"
    chmod 600 "$config_path"

    approvals_path="${home_dir}/.openclaw/exec-approvals.json"
    approvals_token="$(jq -r '.socket.token // empty' "$approvals_path" 2>/dev/null || true)"
    if [[ -z "$approvals_token" ]]; then
      approvals_token="$(tr -d '-' </proc/sys/kernel/random/uuid)"
    fi
    tmp_approvals="${approvals_path}.tmp.$$"
    if [[ -f "$approvals_path" ]]; then
      if ! jq \
        --arg socket_path "${home_dir}/.openclaw/exec-approvals.sock" \
        --arg token "$approvals_token" \
        '
          .version = 1 |
          .socket = { path: $socket_path, token: $token } |
          .defaults = ((.defaults // {}) + { security: "full", ask: "off", askFallback: "full" }) |
          .agents = (.agents // {}) |
          .agents.main = ((.agents.main // {}) + { security: "full", ask: "off", askFallback: "full" })
        ' "$approvals_path" > "$tmp_approvals"; then
        jq \
          --arg socket_path "${home_dir}/.openclaw/exec-approvals.sock" \
          --arg token "$approvals_token" \
          '
            .version = 1 |
            .socket = { path: $socket_path, token: $token } |
            .defaults = { security: "full", ask: "off", askFallback: "full" } |
            .agents = { main: { security: "full", ask: "off", askFallback: "full" } }
          ' <<< '{}' > "$tmp_approvals"
      fi
    else
      jq \
        --arg socket_path "${home_dir}/.openclaw/exec-approvals.sock" \
        --arg token "$approvals_token" \
        '
          .version = 1 |
          .socket = { path: $socket_path, token: $token } |
          .defaults = { security: "full", ask: "off", askFallback: "full" } |
          .agents = { main: { security: "full", ask: "off", askFallback: "full" } }
        ' <<< '{}' > "$tmp_approvals"
    fi
    mv "$tmp_approvals" "$approvals_path"
    chown "$user:$user" "$approvals_path"
    chmod 600 "$approvals_path"

    start_cmd="unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy NO_PROXY no_proxy npm_config_proxy npm_config_https_proxy npm_config_http_proxy npm_config_noproxy TMUX TMUX_PANE && umask 077 && cd '$OPENCLAW_ROOT' && HOME='$home_dir' USER='$user' LOGNAME='$user' SHELL='$shell_wrapper_path' TFCLAW_EXEC_PROJECT_ROOT='$SCIHARNESS_ROOT' TFCLAW_EXEC_READ_WHITELIST='$read_whitelist_entries' TFCLAW_EXEC_WRITE_WHITELIST='$write_whitelist_entries' TFCLAW_EXEC_WORKSPACE='$workspace_dir' TFCLAW_EXEC_HOME='$home_dir' TFCLAW_EXEC_REAL_SHELL='/bin/bash' TFCLAW_EXEC_NODE_BIN_DIR='$NODE_BIN_DIR' NODE_DISABLE_COMPILE_CACHE=1 OPENCLAW_HOME='$home_dir' CLAWHUB_WORKDIR='$workspace_dir' OPENCLAW_CONFIG_PATH='$config_path' OPENCLAW_GATEWAY_TOKEN='$token' exec '$NODE_PATH' '$OPENCLAW_ENTRY' gateway --allow-unconfigured --port $port --bind loopback --auth token --token '$token'"

    verify_user_path_whitelist_guard \
      "$user" \
      "$shell_wrapper_path" \
      "$workspace_dir" \
      "$home_dir" \
      "$read_whitelist_entries" \
      "$write_whitelist_entries" \
      "$SHARED_SKILLS_DIR" \
      "$SHARED_ENV_PATH" \
      "$DENIED_READ_SAMPLE_PATH"

    env -u TMUX -u TMUX_PANE runuser -u "$user" -- tmux has-session -t "$session_name" 2>/dev/null \
      && env -u TMUX -u TMUX_PANE runuser -u "$user" -- tmux kill-session -t "$session_name" \
      || true

    env -u TMUX -u TMUX_PANE runuser -u "$user" -- tmux new-session -d -s "$session_name" bash -lc "$start_cmd"
    user_log_dir="${home_dir}/.tfclaw-openclaw/logs"
    user_log_path="${user_log_dir}/openclaw_gateway.log"
    mkdir -p "$user_log_dir"
    touch "$user_log_path"
    chown "$user:$user" "$user_log_dir" "$user_log_path"
    chmod 700 "$user_log_dir"
    chmod 600 "$user_log_path"
    env -u TMUX -u TMUX_PANE runuser -u "$user" -- tmux pipe-pane -o -t "${session_name}:0.0" "cat >> '$user_log_path'" >/dev/null 2>&1 || true
    env -u TMUX -u TMUX_PANE runuser -u "$user" -- tmux capture-pane -p -S -200 -t "${session_name}:0.0" >> "$user_log_path" 2>/dev/null || true
    echo "restarted $session_name (port $port)"
  done
fi

echo "[3/4] restarting tfclaw gateway session: $GATEWAY_SESSION"
pkill -f "node .*apps/feishu-gateway/src/index.ts" >/dev/null 2>&1 || true
if tmux has-session -t "$GATEWAY_SESSION" 2>/dev/null; then
  tmux kill-session -t "$GATEWAY_SESSION"
fi
TMUX= TMUX_PANE= tmux new-session -d -s "$GATEWAY_SESSION" \
  "bash -lc 'cd \"$TFCLAW_ROOT\" && npm exec tsx watch apps/feishu-gateway/src/index.ts'"
TMUX= TMUX_PANE= tmux pipe-pane -o -t "${GATEWAY_SESSION}:0.0" "cat >> \"$GATEWAY_LOG_PATH\"" >/dev/null 2>&1 || true
TMUX= TMUX_PANE= tmux capture-pane -p -S -200 -t "${GATEWAY_SESSION}:0.0" >> "$GATEWAY_LOG_PATH" 2>/dev/null || true

echo "[4/4] health check"
sleep 3
if ! tmux has-session -t "$RELAY_SESSION" 2>/dev/null; then
  echo "warn: relay session missing before health check; restarting once"
  restart_relay_tmux_session
  sleep 1
fi
if tmux has-session -t "$RELAY_SESSION" 2>/dev/null; then
  TMUX= TMUX_PANE= tmux capture-pane -p -t "$RELAY_SESSION":0.0 | tail -n 25
else
  echo "warn: relay session still missing after restart attempt"
fi
if tmux has-session -t "$GATEWAY_SESSION" 2>/dev/null; then
  TMUX= TMUX_PANE= tmux capture-pane -p -t "$GATEWAY_SESSION":0.0 | tail -n 25
else
  echo "warn: gateway session missing before health check"
fi

if command -v python3 >/dev/null 2>&1; then
python3 - <<PY
import json, socket, time
path = "${MAP_PATH}"
relay_host = "${RELAY_HEALTH_HOST}"
relay_port = int("${RELAY_PORT}")

relay_ok = False
relay_deadline = time.time() + 20.0
while time.time() < relay_deadline:
    s = socket.socket()
    s.settimeout(1.0)
    try:
        s.connect((relay_host, relay_port))
        relay_ok = True
        break
    except Exception:
        time.sleep(0.4)
    finally:
        s.close()
print(f"relay: {relay_host}:{relay_port} {'open' if relay_ok else 'closed'}")

try:
    data = json.load(open(path, "r", encoding="utf-8"))
except Exception as exc:
    print(f"map parse failed: {exc}")
    raise SystemExit(0)
for _, item in (data.get("users") or {}).items():
    user = str(item.get("linuxUser", "")).strip()
    port = int(item.get("gatewayPort", 0) or 0)
    if not user or port <= 0:
        continue
    ok = False
    deadline = time.time() + 60.0
    while time.time() < deadline:
        s = socket.socket()
        s.settimeout(1.0)
        try:
            s.connect(("127.0.0.1", port))
            ok = True
            break
        except Exception:
            time.sleep(0.6)
        finally:
            s.close()
    print(f"{user}: {port} {'open' if ok else 'closed'}")
PY
fi

echo
echo "log files:"
echo "- relay: $RELAY_LOG_PATH"
echo "- gateway: $GATEWAY_LOG_PATH"
echo "- openclaw users: <user_home>/.tfclaw-openclaw/logs/openclaw_gateway.log"

echo "done"
