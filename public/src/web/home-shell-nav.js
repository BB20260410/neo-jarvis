// @ts-check
/** Browser copy of NoeHomeShell navigation IA (keep in sync with src/runtime/NoeHomeShell.js). */
export function buildHomeShellNavigation() {
  const main = [
    { id: 'chat', title: '对话', description: '打字或说话，一句话办事', action: 'focus_composer' },
    { id: 'memory', title: '记忆', description: '可视化记忆时间线', action: 'show_memory' },
    { id: 'status', title: '状态', description: '运行模式与语音就绪', action: 'show_status' },
  ];
  const settings = [
    { id: 'models', title: '模型（最少配置）', description: 'Base URL + 模型 ID · 不必手改 .env', action: 'focus_product_settings' },
    { id: 'voice', title: '语音', description: '主界面开关 + Whisper/TTS', action: 'focus_product_settings' },
    { id: 'runtime_mode', title: '运行模式', description: '白龙马式 / Neo 默认', action: 'toggle_runtime_mode_help' },
    { id: 'evolution', title: '进化 dry-run', description: '只读观测 · 真改默认 OFF', href: '/evolution.html' },
    { id: 'permissions', title: '权限与安全', description: 'owner token、执行策略', href: '/index.html#settings-security' },
  ];
  const expertReachable = [
    { id: 'cognitive', title: '沉浸驾驶舱', description: '语音+视频+图', href: '/cognitive.html', expert: true },
    { id: 'mind', title: 'Mind 专家视图', description: '意识/心跳细节', href: '/mind.html', expert: true },
    { id: 'governance', title: '治理/审批', description: '危险操作确认', href: '/index.html#governance', expert: true },
    { id: 'rooms', title: '多模型房间', description: '辩论与协作', href: '/index.html#rooms', expert: true },
    { id: 'terminal', title: '终端', description: 'PTY 真终端', href: '/index.html#terminal', expert: true },
    { id: 'full_models', title: '完整模型/密钥', description: 'BYOK / adapter 池', href: '/index.html#settings-models', expert: true },
  ];
  return { main, settings, expertReachable };
}
