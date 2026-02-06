#!/bin/bash
# OpenCLAW 健康检查脚本
# 由 systemd timer 定期调用，检查重启后的服务状态
# 如果检测到重启失败，自动执行回滚

STATE_DIR="/home/openclaw/.openclaw/restart-state"
OPENCLAW_DIR="/home/openclaw/openclaw"
TG_CHAT_ID="${OPENCLAW_RESTART_NOTIFY_CHAT:-5320562954}"
GATEWAY_URL="http://127.0.0.1:18789"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[HEALTH]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[HEALTH]${NC} $1"; }
log_error() { echo -e "${RED}[HEALTH]${NC} $1"; }

# 发送 TG 通知
send_tg_notify() {
    local message="$1"
    if [ -n "$TG_CHAT_ID" ] && [ -n "$OPENCLAW_GATEWAY_TOKEN" ]; then
        curl -s -X POST "$GATEWAY_URL/api/send" \
            -H "Content-Type: application/json" \
            -H "Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN" \
            -d "{\"channel\":\"telegram\",\"chatId\":\"$TG_CHAT_ID\",\"text\":\"$message\"}" \
            2>/dev/null || true
    fi
    log_info "$message"
}

# 检查是否需要健康检查
check_if_needed() {
    if [ ! -f "$STATE_DIR/restart-status" ]; then
        # 没有进行中的重启
        exit 0
    fi

    local status=$(cat "$STATE_DIR/restart-status")
    if [ "$status" != "pending" ]; then
        # 已经处理过了
        exit 0
    fi
}

# 检查 gateway 是否健康
check_gateway_health() {
    # 检查进程是否存在
    if ! pgrep -f "openclaw-gateway" > /dev/null; then
        log_error "openclaw-gateway 进程不存在"
        return 1
    fi

    # 检查端口是否监听
    if ! ss -tlnp | grep -q ":18789"; then
        log_error "Gateway 端口 18789 未监听"
        return 1
    fi

    # 检查 HTTP 响应 (访问根路径)
    local response=$(curl -s -o /dev/null -w "%{http_code}" "$GATEWAY_URL/" --max-time 5 2>/dev/null || echo "000")
    if [ "$response" = "000" ]; then
        log_error "Gateway HTTP 无响应"
        return 1
    fi

    log_info "Gateway 健康检查通过 (HTTP $response)"
    return 0
}

# 检查是否超时
check_timeout() {
    if [ ! -f "$STATE_DIR/health-check-deadline" ]; then
        return 1
    fi

    local deadline=$(cat "$STATE_DIR/health-check-deadline")
    local now=$(date +%s)

    if [ "$now" -gt "$deadline" ]; then
        log_error "健康检查超时"
        return 0  # 超时了
    fi

    return 1  # 还没超时
}

# 执行回滚
do_rollback() {
    log_warn "执行自动回滚..."

    cd "$OPENCLAW_DIR"

    if [ ! -f "$STATE_DIR/previous-commit" ]; then
        log_error "没有找到之前的 commit，无法回滚"
        echo "failed" > "$STATE_DIR/restart-status"
        return 1
    fi

    local prev_commit=$(cat "$STATE_DIR/previous-commit")
    log_info "回滚到 commit: $prev_commit"

    # 回滚代码
    git checkout "$prev_commit" -- .

    # 恢复 stash (如果有)
    if [ -f "$STATE_DIR/has-stash" ] && [ "$(cat $STATE_DIR/has-stash)" = "true" ]; then
        log_info "恢复工作区更改..."
        git stash pop 2>/dev/null || log_warn "stash pop 有冲突，保留在 stash 中"
    fi

    # 重新构建
    log_info "重新构建..."
    pnpm install --frozen-lockfile 2>/dev/null || pnpm install
    if ! pnpm build; then
        log_error "回滚后构建失败，需要人工介入"
        echo "failed" > "$STATE_DIR/restart-status"
        return 1
    fi

    # 重启服务
    log_info "重启服务..."
    sudo systemctl restart openclaw

    echo "rolled_back" > "$STATE_DIR/restart-status"

    # 等待几秒让服务启动
    sleep 15

    # 再次检查
    if check_gateway_health; then
        send_tg_notify "⚠️ OpenCLAW 重启失败，已自动回滚到之前版本。工作区更改已保留，请检查问题。"
        return 0
    else
        log_error "回滚后服务仍然不健康，需要人工介入"
        send_tg_notify "🚨 OpenCLAW 重启失败且回滚后仍有问题，需要人工介入!"
        return 1
    fi
}

# 标记成功
mark_success() {
    echo "success" > "$STATE_DIR/restart-status"

    # 计算重启耗时
    local start_ts=$(cat "$STATE_DIR/restart-timestamp" 2>/dev/null || echo "0")
    local now=$(date +%s)
    local duration=$((now - start_ts))

    send_tg_notify "✅ OpenCLAW 重启成功! 耗时 ${duration} 秒。"

    # 清理状态文件
    rm -f "$STATE_DIR/health-check-deadline"
    rm -f "$STATE_DIR/previous-commit"
    rm -f "$STATE_DIR/has-stash"
    rm -f "$STATE_DIR/restart-timestamp"

    log_info "状态文件已清理"
}

# 主流程
main() {
    log_info "========== 健康检查开始 =========="

    # 检查是否需要执行
    check_if_needed

    # 给服务一点启动时间
    sleep 5

    # 检查健康状态
    if check_gateway_health; then
        mark_success
        exit 0
    fi

    # 检查是否超时
    if check_timeout; then
        log_error "服务不健康且已超时，执行回滚"
        do_rollback
        exit 1
    fi

    log_info "服务暂时不健康，等待下一次检查..."
    exit 0
}

main "$@"
