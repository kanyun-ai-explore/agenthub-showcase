#!/bin/bash
# Shell 日志工具库
# 提供带时间戳的日志函数，格式与 Node.js 日志一致

# 服务名称（可通过环境变量覆盖）
SERVICE_NAME="${SERVICE_NAME:-Showcase}"

# 获取当前时间戳（格式：YYYY-MM-DD HH:mm:ss.mmm）
get_timestamp() {
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')

    # 获取毫秒（macOS 和 Linux 兼容）
    local ms
    if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS：使用 Python 获取毫秒
        ms=$(python3 -c "import datetime; print(datetime.datetime.now().strftime('%f')[:3])" 2>/dev/null || echo "000")
    else
        # Linux：使用 date 的 %N 参数
        ms=$(date '+%3N' 2>/dev/null || echo "000")
    fi

    echo "${timestamp}.${ms}"
}

# 构建日志前缀
build_log_prefix() {
    local timestamp=$(get_timestamp)
    if [[ -n "$SERVICE_NAME" ]]; then
        echo "${timestamp} [${SERVICE_NAME}]"
    else
        echo "${timestamp}"
    fi
}

# INFO 级别日志
log_info() {
    local prefix=$(build_log_prefix)
    echo "${prefix} $*"
}

# WARN 级别日志
log_warn() {
    local prefix=$(build_log_prefix)
    echo "${prefix} [WARN] $*" >&2
}

# ERROR 级别日志
log_error() {
    local prefix=$(build_log_prefix)
    echo "${prefix} [ERROR] $*" >&2
}

# DEBUG 级别日志（仅在 DEBUG=1 时输出）
log_debug() {
    if [[ "${DEBUG}" == "1" ]]; then
        local prefix=$(build_log_prefix)
        echo "${prefix} [DEBUG] $*"
    fi
}

# 默认日志函数（别名到 log_info）
log() {
    log_info "$@"
}

# 导出函数（使其可在子 shell 中使用）
export -f get_timestamp
export -f build_log_prefix
export -f log_info
export -f log_warn
export -f log_error
export -f log_debug
export -f log
