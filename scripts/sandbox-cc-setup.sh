#!/usr/bin/env bash
# 沙箱镜像构建脚本
# 支持分阶段构建和代理配置
#
# Usage:
#   ./scripts/sandbox-cc-setup.sh              # 完整构建
#   ./scripts/sandbox-cc-setup.sh --stage cli  # 从 cli 阶段开始
#   ./scripts/sandbox-cc-setup.sh --proxy-test # 仅测试代理
#   ./scripts/sandbox-cc-setup.sh --run        # 运行容器

set -euo pipefail

# 颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 配置
IMAGE_PREFIX="openclaw-sandbox-cc"
DOCKERFILE="Dockerfile.sandbox-cc"
PROXY_HOST="${PROXY_HOST:-host.docker.internal}"
PROXY_PORT="${PROXY_PORT:-7890}"
CONTAINER_NAME="${CONTAINER_NAME:-sandbox-cc}"

# 阶段定义
STAGES=("base" "devtools" "cli")

# 脚本目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

log() {
  echo -e "${BLUE}[sandbox-cc]${NC} $*"
}

success() {
  echo -e "${GREEN}[✓]${NC} $*"
}

warn() {
  echo -e "${YELLOW}[!]${NC} $*"
}

error() {
  echo -e "${RED}[✗]${NC} $*" >&2
}

# 检查 Docker
check_docker() {
  if ! command -v docker &>/dev/null; then
    error "Docker 未安装"
    exit 1
  fi
  if ! docker info &>/dev/null; then
    error "Docker daemon 未运行"
    exit 1
  fi
  success "Docker 可用"
}

# 测试代理连通性
test_proxy() {
  log "测试代理连通性..."
  local proxy_url="http://${PROXY_HOST}:${PROXY_PORT}"

  # 在临时容器中测试
  if docker run --rm \
    --add-host=host.docker.internal:host-gateway \
    -e "HTTP_PROXY=${proxy_url}" \
    -e "HTTPS_PROXY=${proxy_url}" \
    debian:bookworm-slim \
    bash -c "apt-get update -qq && apt-get install -y -qq curl >/dev/null 2>&1 && curl -sf --max-time 10 https://api.anthropic.com/v1/messages -o /dev/null && echo 'OK'" 2>/dev/null; then
    success "代理连通: ${proxy_url} → api.anthropic.com"
    return 0
  else
    warn "代理测试失败: ${proxy_url}"
    warn "容器内可能无法访问 Anthropic API"
    return 1
  fi
}

# 检查镜像是否存在
image_exists() {
  local tag="$1"
  docker image inspect "${IMAGE_PREFIX}:${tag}" &>/dev/null
}

# 构建指定阶段
build_stage() {
  local stage="$1"
  local tag="${IMAGE_PREFIX}:${stage}"

  log "构建阶段: ${stage} → ${tag}"

  docker build \
    --target "${stage}" \
    --tag "${tag}" \
    --file "${PROJECT_ROOT}/${DOCKERFILE}" \
    "${PROJECT_ROOT}"

  success "阶段 ${stage} 构建完成"
}

# 完整构建
build_all() {
  local start_stage="${1:-base}"
  local started=false

  for stage in "${STAGES[@]}"; do
    if [[ "$stage" == "$start_stage" ]]; then
      started=true
    fi

    if [[ "$started" == "true" ]]; then
      build_stage "$stage"
    else
      if image_exists "$stage"; then
        log "跳过阶段 ${stage} (镜像已存在)"
      else
        warn "阶段 ${stage} 镜像不存在，开始构建"
        started=true
        build_stage "$stage"
      fi
    fi
  done

  # 创建 latest 标签
  docker tag "${IMAGE_PREFIX}:cli" "${IMAGE_PREFIX}:latest"
  success "创建标签: ${IMAGE_PREFIX}:latest"
}

# 运行容器
run_container() {
  local proxy_url="http://${PROXY_HOST}:${PROXY_PORT}"
  local claude_dir="${HOME}/.claude"

  log "启动容器: ${CONTAINER_NAME}"

  # 停止已有容器
  if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    log "停止已有容器..."
    docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
  fi

  # 创建 .claude 目录（如果不存在）
  mkdir -p "${claude_dir}"

  # 运行容器
  docker run -d \
    --name "${CONTAINER_NAME}" \
    --add-host=host.docker.internal:host-gateway \
    -e "HTTP_PROXY=${proxy_url}" \
    -e "HTTPS_PROXY=${proxy_url}" \
    -e "http_proxy=${proxy_url}" \
    -e "https_proxy=${proxy_url}" \
    -v "${claude_dir}:/home/dev/.claude" \
    -v "${PROJECT_ROOT}:/workspace" \
    "${IMAGE_PREFIX}:latest"

  success "容器已启动: ${CONTAINER_NAME}"
  log "进入容器: docker exec -it ${CONTAINER_NAME} bash"
}

# 进入容器进行 OAuth
oauth_auth() {
  log "OAuth 认证流程..."
  log "需要在容器内运行 'claude' 命令完成认证"

  if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    error "容器未运行，先执行: $0 --run"
    exit 1
  fi

  echo ""
  echo "=========================================="
  echo "请在另一个终端执行以下命令："
  echo ""
  echo "  docker exec -it ${CONTAINER_NAME} bash"
  echo "  source ~/.bashrc"
  echo "  claude"
  echo ""
  echo "然后按照提示完成 OAuth 认证"
  echo "=========================================="
  echo ""

  read -rp "认证完成后按回车继续..."

  # 验证认证
  if docker exec "${CONTAINER_NAME}" bash -c 'source ~/.bashrc && claude --version' &>/dev/null; then
    success "Claude CLI 可用"
  else
    warn "无法验证 Claude CLI 状态"
  fi
}

# 清理镜像
clean() {
  log "清理镜像..."

  for stage in "${STAGES[@]}"; do
    if image_exists "$stage"; then
      docker rmi "${IMAGE_PREFIX}:${stage}" || true
    fi
  done

  if image_exists "latest"; then
    docker rmi "${IMAGE_PREFIX}:latest" || true
  fi

  success "清理完成"
}

# 显示状态
status() {
  echo ""
  echo "镜像状态:"
  echo "=========================================="
  for stage in "${STAGES[@]}"; do
    if image_exists "$stage"; then
      local size
      size=$(docker image inspect "${IMAGE_PREFIX}:${stage}" --format '{{.Size}}' | awk '{printf "%.0fMB", $1/1024/1024}')
      echo -e "  ${GREEN}✓${NC} ${IMAGE_PREFIX}:${stage} (${size})"
    else
      echo -e "  ${RED}✗${NC} ${IMAGE_PREFIX}:${stage}"
    fi
  done
  echo ""

  echo "容器状态:"
  echo "=========================================="
  if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    echo -e "  ${GREEN}✓${NC} ${CONTAINER_NAME} (运行中)"
  elif docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    echo -e "  ${YELLOW}!${NC} ${CONTAINER_NAME} (已停止)"
  else
    echo -e "  ${RED}✗${NC} ${CONTAINER_NAME} (不存在)"
  fi
  echo ""
}

# 帮助信息
usage() {
  cat <<EOF
沙箱镜像构建脚本

Usage: $0 [OPTIONS]

Options:
  --build              完整构建所有阶段
  --stage <stage>      从指定阶段开始构建 (base|devtools|cli)
  --proxy-test         测试代理连通性
  --run                运行容器
  --auth               OAuth 认证流程
  --status             显示镜像和容器状态
  --clean              清理所有镜像
  --help               显示此帮助

Environment:
  PROXY_HOST           代理主机 (默认: host.docker.internal)
  PROXY_PORT           代理端口 (默认: 7890)
  CONTAINER_NAME       容器名称 (默认: sandbox-cc)

Examples:
  $0 --build                    # 完整构建
  $0 --stage cli                # 从 cli 阶段开始
  $0 --proxy-test               # 测试代理
  $0 --run                      # 运行容器
  $0 --run && $0 --auth         # 运行并认证

EOF
}

# 主流程
main() {
  cd "${PROJECT_ROOT}"

  case "${1:-}" in
    --build)
      check_docker
      build_all
      ;;
    --stage)
      check_docker
      build_all "${2:-base}"
      ;;
    --proxy-test)
      check_docker
      test_proxy
      ;;
    --run)
      check_docker
      run_container
      ;;
    --auth)
      oauth_auth
      ;;
    --status)
      status
      ;;
    --clean)
      clean
      ;;
    --help|-h)
      usage
      ;;
    "")
      # 默认：显示状态
      status
      usage
      ;;
    *)
      error "未知选项: $1"
      usage
      exit 1
      ;;
  esac
}

main "$@"
