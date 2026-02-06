#!/bin/bash
# VPS 资源监控脚本
# 检查 CPU/内存/Swap/磁盘，超阈值发 Telegram 告警

set -e

# 配置
TELEGRAM_CHAT_ID="5320562954"
ALERT_COOLDOWN_FILE="/tmp/.monitor_alert_cooldown"
COOLDOWN_SECONDS=1800  # 30分钟内不重复告警

# 阈值
MEM_WARN=75
MEM_CRIT=90
SWAP_WARN=50
SWAP_CRIT=80
DISK_WARN=80
DISK_CRIT=95
LOAD_WARN=3.0   # 4核机器，load 3 表示 75% 使用率
LOAD_CRIT=3.8   # 接近满载

# 获取当前资源使用情况
get_metrics() {
    # 内存使用率
    MEM_USED=$(free | awk '/Mem:/ {printf "%.0f", $3/$2 * 100}')
    MEM_AVAIL=$(free -h | awk '/Mem:/ {print $7}')

    # Swap 使用率
    SWAP_TOTAL=$(free | awk '/Swap:/ {print $2}')
    if [ "$SWAP_TOTAL" -gt 0 ]; then
        SWAP_USED=$(free | awk '/Swap:/ {printf "%.0f", $3/$2 * 100}')
    else
        SWAP_USED=0
    fi
    SWAP_AVAIL=$(free -h | awk '/Swap:/ {print $4}')

    # 磁盘使用率
    DISK_USED=$(df / | awk 'NR==2 {gsub(/%/,""); print $5}')
    DISK_AVAIL=$(df -h / | awk 'NR==2 {print $4}')

    # 系统负载 (1分钟平均)
    LOAD_1=$(uptime | awk -F'load average:' '{print $2}' | awk -F',' '{print $1}' | tr -d ' ')
}

# 发送 Telegram 告警
send_alert() {
    local level=$1
    local message=$2

    # 检查冷却时间
    if [ -f "$ALERT_COOLDOWN_FILE" ]; then
        local last_alert=$(cat "$ALERT_COOLDOWN_FILE")
        local now=$(date +%s)
        local diff=$((now - last_alert))
        if [ $diff -lt $COOLDOWN_SECONDS ]; then
            echo "告警冷却中，跳过 ($diff/$COOLDOWN_SECONDS 秒)"
            return
        fi
    fi

    # 发送告警
    local emoji="⚠️"
    [ "$level" = "critical" ] && emoji="🚨"

    local full_message="${emoji} VPS 资源告警 [$level]

${message}

---
时间: $(date '+%Y-%m-%d %H:%M:%S')
主机: $(hostname)"

    # 通过 OpenCLAW 发送（如果在运行）
    if pgrep -f "openclaw" > /dev/null; then
        curl -s -X POST "http://localhost:3000/api/notify" \
            -H "Content-Type: application/json" \
            -d "{\"chatId\": \"$TELEGRAM_CHAT_ID\", \"message\": \"$full_message\"}" \
            2>/dev/null || true
    fi

    # 记录冷却时间
    date +%s > "$ALERT_COOLDOWN_FILE"

    echo "$full_message"
}

# 检查并告警
check_and_alert() {
    local alerts=""
    local level="warning"

    # 检查内存
    if [ "$MEM_USED" -ge "$MEM_CRIT" ]; then
        alerts="${alerts}内存: ${MEM_USED}% (可用: ${MEM_AVAIL}) [严重]\n"
        level="critical"
    elif [ "$MEM_USED" -ge "$MEM_WARN" ]; then
        alerts="${alerts}内存: ${MEM_USED}% (可用: ${MEM_AVAIL}) [警告]\n"
    fi

    # 检查 Swap
    if [ "$SWAP_USED" -ge "$SWAP_CRIT" ]; then
        alerts="${alerts}Swap: ${SWAP_USED}% (可用: ${SWAP_AVAIL}) [严重]\n"
        level="critical"
    elif [ "$SWAP_USED" -ge "$SWAP_WARN" ]; then
        alerts="${alerts}Swap: ${SWAP_USED}% (可用: ${SWAP_AVAIL}) [警告]\n"
    fi

    # 检查磁盘
    if [ "$DISK_USED" -ge "$DISK_CRIT" ]; then
        alerts="${alerts}磁盘: ${DISK_USED}% (可用: ${DISK_AVAIL}) [严重]\n"
        level="critical"
    elif [ "$DISK_USED" -ge "$DISK_WARN" ]; then
        alerts="${alerts}磁盘: ${DISK_USED}% (可用: ${DISK_AVAIL}) [警告]\n"
    fi

    # 检查负载 (用 awk 代替 bc)
    if awk "BEGIN {exit !($LOAD_1 >= $LOAD_CRIT)}"; then
        alerts="${alerts}负载: ${LOAD_1} (阈值: ${LOAD_CRIT}) [严重]\n"
        level="critical"
    elif awk "BEGIN {exit !($LOAD_1 >= $LOAD_WARN)}"; then
        alerts="${alerts}负载: ${LOAD_1} (阈值: ${LOAD_WARN}) [警告]\n"
    fi

    # 发送告警
    if [ -n "$alerts" ]; then
        send_alert "$level" "$(echo -e "$alerts")"
        return 1
    fi

    return 0
}

# 主函数
main() {
    get_metrics

    echo "=== VPS 资源监控 ==="
    echo "内存: ${MEM_USED}% (可用: ${MEM_AVAIL})"
    echo "Swap: ${SWAP_USED}% (可用: ${SWAP_AVAIL})"
    echo "磁盘: ${DISK_USED}% (可用: ${DISK_AVAIL})"
    echo "负载: ${LOAD_1}"
    echo ""

    if check_and_alert; then
        echo "HEARTBEAT_OK - 资源正常"
    else
        echo "ALERT - 已发送告警"
    fi
}

main "$@"
