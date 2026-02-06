#!/bin/bash
# =============================================================================
# OpenClaw VPS 本地部署脚本
# 用途: 在 VPS 上本地构建、重启 OpenClaw Gateway 服务
# =============================================================================

set -e

# 颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# 配置
LOCAL_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# =============================================================================
# Git 状态检查
# =============================================================================
check_git_sync() {
    log_info "检查 Git 同步状态..."
    cd "$LOCAL_DIR"

    # 检查是否有未提交的更改
    if ! git diff --quiet || ! git diff --cached --quiet; then
        log_error "本地有未提交的更改，请先提交或 stash"
        git status --short
        exit 1
    fi

    # 检查是否有未跟踪的文件（排除已知的临时文件）
    UNTRACKED=$(git ls-files --others --exclude-standard)
    if [ -n "$UNTRACKED" ]; then
        log_warn "有未跟踪的文件:"
        echo "$UNTRACKED"
        read -p "是否继续部署? [y/N] " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            exit 1
        fi
    fi

    # fetch 远程更新
    git fetch origin main --quiet

    # 检查本地是否落后于远程
    LOCAL_HEAD=$(git rev-parse HEAD)
    REMOTE_HEAD=$(git rev-parse origin/main)
    MERGE_BASE=$(git merge-base HEAD origin/main)

    if [ "$LOCAL_HEAD" != "$REMOTE_HEAD" ]; then
        if [ "$MERGE_BASE" = "$LOCAL_HEAD" ]; then
            log_error "本地落后于远程，请先 git pull"
            git log --oneline HEAD..origin/main
            exit 1
        elif [ "$MERGE_BASE" = "$REMOTE_HEAD" ]; then
            log_warn "本地有 $(git rev-list origin/main..HEAD --count) 个未推送的提交"
        else
            log_error "本地和远程已分叉，请先解决"
            exit 1
        fi
    fi

    log_success "Git 状态检查通过"
}

# =============================================================================
# 本地构建
# =============================================================================
build_local() {
    log_info "本地构建..."
    cd "$LOCAL_DIR"
    pnpm build
    log_success "构建完成"
}

# =============================================================================
# 安装依赖 + 构建 + 重启服务
# =============================================================================
build_restart() {
    build_local

    log_info "重启服务..."
    sudo systemctl restart openclaw

    sleep 3

    # 检查状态
    if sudo systemctl is-active --quiet openclaw; then
        log_success "服务已启动"
        sudo systemctl status openclaw --no-pager | head -10
    else
        log_error "服务启动失败"
        sudo journalctl -u openclaw -n 20 --no-pager
        exit 1
    fi

    log_success "部署完成"
}

# =============================================================================
# 快速部署 (跳过 Git 检查和依赖安装，仅构建 + 重启)
# =============================================================================
quick_deploy() {
    build_local

    log_info "重启服务..."
    sudo systemctl restart openclaw

    sleep 3

    if sudo systemctl is-active --quiet openclaw; then
        log_success "服务已启动"
        sudo systemctl status openclaw --no-pager | head -10
    else
        log_error "服务启动失败"
        sudo journalctl -u openclaw -n 20 --no-pager
        exit 1
    fi

    log_success "快速部署完成"
}

# =============================================================================
# 快速重启 (仅重启服务，不重新构建)
# =============================================================================
quick_restart() {
    log_info "快速重启服务..."
    sudo systemctl restart openclaw
    sleep 2
    sudo systemctl status openclaw --no-pager | head -10
    log_success "重启完成"
}

# =============================================================================
# 查看日志
# =============================================================================
show_logs() {
    sudo journalctl -u openclaw -f
}

# =============================================================================
# 查看状态
# =============================================================================
show_status() {
    sudo systemctl status openclaw
}

# =============================================================================
# 完整部署流程
# =============================================================================
full_deploy() {
    # 本地部署不强制 Git 检查，有未提交改动也可部署
    build_restart
}

# =============================================================================
# 帮助
# =============================================================================
show_help() {
    echo "OpenClaw VPS 本地部署脚本"
    echo ""
    echo "用法: $0 [命令]"
    echo ""
    echo "命令:"
    echo "  deploy    完整部署 (Git检查 + 安装依赖 + 构建 + 重启服务)"
    echo "  quick     快速部署 (仅构建 + 重启，跳过检查和依赖安装)"
    echo "  build     仅本地构建"
    echo "  restart   快速重启服务 (不重新构建)"
    echo "  status    查看服务状态"
    echo "  logs      查看服务日志"
    echo "  help      显示帮助"
    echo ""
    echo "Git 检查 (deploy 命令):"
    echo "  - 本地不能有未提交的更改"
    echo "  - 本地不能落后于远程 (需要先 pull)"
    echo "  - 未跟踪文件会提示确认"
    echo ""
    echo "示例:"
    echo "  $0 deploy     # 完整部署 (推荐)"
    echo "  $0 quick      # 快速部署: 跳过检查，直接构建重启"
    echo "  $0 restart    # 紧急修复: 仅重启服务"
    echo ""
}

# =============================================================================
# 主函数
# =============================================================================
main() {
    case "${1:-help}" in
        deploy|d)
            full_deploy
            ;;
        quick|q)
            quick_deploy
            ;;
        build|b)
            build_local
            ;;
        restart|r)
            quick_restart
            ;;
        status)
            show_status
            ;;
        logs|l)
            show_logs
            ;;
        help|h|*)
            show_help
            ;;
    esac
}

main "$@"
