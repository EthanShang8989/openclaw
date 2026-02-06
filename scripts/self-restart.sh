#!/bin/bash
# OpenCLAW 安全自我重启脚本 (带回滚能力)
# 用法: ./scripts/self-restart.sh [--pull] [--notify]

set -e

# 配置
OPENCLAW_DIR="/home/openclaw/openclaw"
STATE_DIR="/home/openclaw/.openclaw/restart-state"
HEALTH_CHECK_TIMEOUT=90  # 秒
TG_CHAT_ID="${OPENCLAW_RESTART_NOTIFY_CHAT:-5320562954}"  # 默认通知的 TG chat

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# 解析参数
DO_PULL=false
DO_NOTIFY=false
for arg in "$@"; do
    case $arg in
        --pull) DO_PULL=true ;;
        --notify) DO_NOTIFY=true ;;
    esac
done

# 创建状态目录
mkdir -p "$STATE_DIR"

# 发送 TG 通知 (通过 gateway API)
send_tg_notify() {
    local message="$1"
    if [ "$DO_NOTIFY" = true ] && [ -n "$TG_CHAT_ID" ]; then
        # 使用 openclaw gateway 的 API 发送消息
        curl -s -X POST "http://127.0.0.1:18789/api/send" \
            -H "Content-Type: application/json" \
            -H "Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN" \
            -d "{\"channel\":\"telegram\",\"chatId\":\"$TG_CHAT_ID\",\"text\":\"$message\"}" \
            2>/dev/null || true
    fi
    log_info "$message"
}

# 步骤 1: 保存当前状态
save_state() {
    log_info "保存当前状态..."

    cd "$OPENCLAW_DIR"

    # 保存当前 commit
    git rev-parse HEAD > "$STATE_DIR/previous-commit"

    # 保存工作区更改 (如果有)
    if ! git diff --quiet || ! git diff --cached --quiet; then
        log_info "检测到未提交更改，保存到 stash..."
        git stash push -m "self-restart-$(date +%Y%m%d-%H%M%S)" --include-untracked
        echo "true" > "$STATE_DIR/has-stash"
    else
        echo "false" > "$STATE_DIR/has-stash"
    fi

    # 记录重启时间
    date +%s > "$STATE_DIR/restart-timestamp"

    log_info "状态已保存"
}

# 步骤 2: 拉取更新 (可选)
pull_updates() {
    if [ "$DO_PULL" = true ]; then
        log_info "拉取最新代码..."
        cd "$OPENCLAW_DIR"
        git pull origin main || {
            log_error "git pull 失败，尝试恢复..."
            restore_stash
            exit 1
        }
    fi
}

# 步骤 3: 恢复 stash
restore_stash() {
    if [ -f "$STATE_DIR/has-stash" ] && [ "$(cat $STATE_DIR/has-stash)" = "true" ]; then
        log_info "恢复工作区更改..."
        cd "$OPENCLAW_DIR"
        git stash pop || {
            log_warn "stash pop 有冲突，保留在 stash 中，请手动处理"
        }
    fi
}

# 步骤 4: 构建
build_project() {
    log_info "开始构建..."
    cd "$OPENCLAW_DIR"

    # 安装依赖
    pnpm install --frozen-lockfile 2>/dev/null || pnpm install

    # 构建
    if ! pnpm build; then
        log_error "构建失败!"
        return 1
    fi

    log_info "构建成功"
    return 0
}

# 步骤 5: 回滚
rollback() {
    log_warn "执行回滚..."
    cd "$OPENCLAW_DIR"

    if [ -f "$STATE_DIR/previous-commit" ]; then
        local prev_commit=$(cat "$STATE_DIR/previous-commit")
        log_info "回滚到 commit: $prev_commit"

        git checkout "$prev_commit" -- .

        # 恢复 stash
        restore_stash

        # 重新构建旧版本
        if build_project; then
            log_info "回滚构建成功"
            return 0
        else
            log_error "回滚构建也失败了，需要人工介入!"
            return 1
        fi
    else
        log_error "没有找到之前的 commit 记录，无法回滚"
        return 1
    fi
}

# 步骤 6: 重启服务
restart_service() {
    log_info "重启 openclaw 服务..."

    # 标记期望的健康检查时间
    echo $(($(date +%s) + HEALTH_CHECK_TIMEOUT)) > "$STATE_DIR/health-check-deadline"
    echo "pending" > "$STATE_DIR/restart-status"

    # 重启
    sudo systemctl restart openclaw

    log_info "服务重启命令已发送"
}

# 主流程
main() {
    log_info "========== OpenCLAW 安全重启开始 =========="

    send_tg_notify "🔄 OpenCLAW 即将重启更新，预计 30-60 秒..."

    # 保存状态
    save_state

    # 拉取更新
    pull_updates

    # 恢复工作区
    restore_stash

    # 构建
    if ! build_project; then
        log_error "构建失败，执行回滚..."
        send_tg_notify "❌ 构建失败，正在回滚..."
        if rollback; then
            send_tg_notify "✅ 已回滚到之前版本，服务未重启"
        else
            send_tg_notify "🚨 回滚也失败了，需要人工介入!"
        fi
        exit 1
    fi

    # 重启
    restart_service

    log_info "========== 重启流程完成，等待健康检查 =========="
}

main "$@"
