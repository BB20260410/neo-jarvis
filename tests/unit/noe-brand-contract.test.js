// @ts-check
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

function read(relPath) {
  return readFileSync(join(ROOT, relPath), 'utf8');
}

describe('Neo 贾维斯 external brand contract', () => {
  it('uses Neo 贾维斯 on the primary product, cognitive, pricing, and onboarding surfaces', () => {
    const index = read('public/index.html');
    const cognitive = read('public/cognitive.html');
    const pricing = read('public/pricing.html');
    const website = read('website/index.html');
    const onboarding = read('public/src/web/onboarding.js');
    const license = read('public/src/web/license-ui.js');

    expect(index).toContain('<title>Neo 贾维斯</title>');
    expect(index).toContain('<h2>欢迎使用 Neo 贾维斯</h2>');
    expect(index).toContain('Neo 贾维斯 <span id="aboutVersion">');
    expect(cognitive).toContain('<title>Neo 贾维斯 · 认知界面</title>');
    expect(cognitive).toContain('placeholder="对 Neo 贾维斯说点什么…"');
    expect(pricing).toContain('<h1>Neo 贾维斯</h1>');
    expect(pricing).toContain('© 2026 Neo 贾维斯 · 本地多 AI 工作台');
    expect(website).toContain('<h1>Neo 贾维斯</h1>');
    expect(onboarding).toContain('👋 欢迎使用 Neo 贾维斯');
    expect(license).toContain('激活 Neo 贾维斯 Pro');
  });

  it('qualifies every visible Noe Brain surface as the internal Noe Runtime', () => {
    const index = read('public/index.html');
    const cognitive = read('public/cognitive.html');

    expect(index).toContain('Neo 贾维斯 · Noe Runtime：查看');
    expect(index).toContain('<div class="noe-brain-title">Neo 贾维斯 · Noe Runtime</div>');
    expect(cognitive).toContain('Neo 贾维斯 · Noe Runtime 仪表盘');
    expect(index).not.toMatch(/(?:title|aria-label)="[^"]*Noe Brain/);
    expect(index).not.toContain('>Noe Brain<');
    expect(cognitive).not.toContain('Noe Brain 仪表盘');
  });

  it('uses the external brand for visible assistant labels and help text', () => {
    const files = [
      'public/src/web/cognitive-command-surface.js',
      'public/src/web/cognitive-research.js',
      'public/src/web/cognitive-taskflow.js',
      'public/src/web/cognitive-local-council.js',
      'public/src/web/cognitive-acui-lite.js',
    ];

    for (const file of files) {
      const source = read(file);
      expect(source, file).toContain("role === 'user' ? '用户' : 'Neo 贾维斯'");
      expect(source, file).not.toContain("role === 'user' ? '用户' : 'Noe'");
    }

    expect(read('public/src/web/cognitive-command-surface.js')).toContain(
      '查看 Neo 贾维斯工具命令的 help/schema/dry-run',
    );
    expect(read('public/src/web/cognitive-acui-lite.js')).toContain(
      '查看 Neo 贾维斯当前状态卡片',
    );
  });

  it('translates the external brand while preserving legacy translation aliases', () => {
    const i18n = read('public/i18n.js');
    const extra = JSON.parse(read('public/i18n-dict.json'));

    expect(i18n).toContain("'Neo 贾维斯': 'Neo JARVIS'");
    expect(i18n).toContain("'欢迎使用 Noe': 'Welcome to Neo JARVIS'");
    expect(i18n).toContain("'欢迎使用 Neo 贾维斯': 'Welcome to Neo JARVIS'");
    expect(i18n).toContain("'Noe Brain 仪表盘': 'Neo JARVIS · Noe Runtime Dashboard'");
    expect(i18n).toContain("'Neo 贾维斯 · Noe Runtime 仪表盘': 'Neo JARVIS · Noe Runtime Dashboard'");
    expect(i18n).not.toContain("'Welcome to Noe'");
    expect(i18n).not.toContain("'Say something to Noe");
    expect(i18n).not.toContain("'Noe Brain Dashboard'");

    expect(extra['Noe Brain：查看 loop、记忆、焦点栈、工具和健康状态']).toBe(
      'Neo JARVIS · Noe Runtime: View loop, memory, focus stack, tools, and health',
    );
    expect(extra['Neo 贾维斯 · Noe Runtime：查看 loop、记忆、焦点栈、工具和健康状态']).toBe(
      extra['Noe Brain：查看 loop、记忆、焦点栈、工具和健康状态'],
    );
    expect(extra['写入一条 Noe 记忆']).toBe('Write a Neo JARVIS memory entry');
    expect(extra['写入一条 Neo 贾维斯记忆']).toBe(extra['写入一条 Noe 记忆']);
    expect(extra['打开 Noe Brain']).toBe('Open Neo JARVIS · Noe Runtime');
    expect(extra['打开 Neo 贾维斯 · Noe Runtime']).toBe(extra['打开 Noe Brain']);
    expect(extra['让 Noe 看一眼你的屏幕']).toBe('Let Neo JARVIS take a look at your screen');
    expect(extra['让 Neo 贾维斯看一眼你的屏幕']).toBe(extra['让 Noe 看一眼你的屏幕']);
    expect(extra['— Noe 认知界面 · 直接打字或点「实时对话」说话 —']).toContain(
      'Neo JARVIS Cognitive Surface',
    );
    expect(extra['— Neo 贾维斯认知界面 · 直接打字或点「实时对话」说话 —']).toBe(
      extra['— Noe 认知界面 · 直接打字或点「实时对话」说话 —'],
    );
    expect(Object.values(extra)).not.toContain('Open Noe Brain');
    expect(Object.values(extra)).not.toContain('Write a Noe Memory entry');
    expect(Object.values(extra)).not.toContain('Let Noe Take a Look at Your Screen');
  });

  it('uses Neo 贾维斯 for visible voice log labels', () => {
    const voice = read('public/src/web/noe-voice.js');

    expect(voice).toContain("logVoice('Neo 贾维斯', data.reply || '')");
    expect(voice).toContain("logVoice('Neo 贾维斯 · 主动陪伴', data.text || '')");
    expect(voice).toContain('主动陪伴已开启（Neo 贾维斯会偶尔看一眼屏幕，只在值得时开口）');
    expect(voice).not.toContain("logVoice('Noe',");
    expect(voice).not.toContain("logVoice('Noe 主动',");
  });

  it('rejects the known stale external-brand literals', () => {
    const surfaces = [
      'public/index.html',
      'public/cognitive.html',
      'public/pricing.html',
      'website/index.html',
      'public/src/web/onboarding.js',
      'public/src/web/license-ui.js',
    ].map(read).join('\n');

    for (const stale of [
      '欢迎使用 Noe',
      '<h1>Noe</h1>',
      '© 2026 Noe ·',
      '激活 Noe Pro',
      '对 Noe 说点什么',
      'Noe · 感知 L1',
      '— Noe 认知界面',
    ]) {
      expect(surfaces).not.toContain(stale);
    }
  });

  it('preserves internal runtime and compatibility identifiers', () => {
    const pkg = JSON.parse(read('package.json'));
    const index = read('public/index.html');
    const cognitive = read('public/cognitive.html');
    const wakeword = read('public/src/web/noe-voice.js');
    const electronSmoke = read('scripts/electron-smoke.mjs');

    expect(pkg.name).toBe('noe');
    expect(pkg.productName).toBe('Neo 贾维斯');
    expect(pkg.build?.appId).toBe('com.hxx.noe');
    expect(pkg.build?.linux?.executableName).toBe('noe');
    expect(index).toContain('id="btnNoeBrain"');
    expect(index).toContain('id="noeBrainArea"');
    expect(index).toContain('~/.noe-panel/');
    expect(cognitive).toContain("addMsg('noe'");
    expect(cognitive).toContain('/api/noe/');
    expect(wakeword).toContain('嘿Noe');
    expect(wakeword).toContain('noe-wakeword-mode');
    expect(electronSmoke).toContain("`${PRODUCT_NAME}.app`");
    expect(electronSmoke).toContain('NOE_ELECTRON_SMOKE_USE_EXISTING');
    expect(electronSmoke).toContain('NOE_ELECTRON_SMOKE_OUTPUT_DIR');
    expect(electronSmoke).toContain("runtime: 'packaged_electron'");
    expect(electronSmoke).toContain('packagedRuntimeVerified');
    expect(electronSmoke).toContain('panelPageVerified');
    expect(electronSmoke).toContain('packaged_app_does_not_match_build_receipt');
    expect(electronSmoke).toContain('delete childEnv.NOE_PACKAGED_EXTERNAL_NODE');
    expect(electronSmoke).toContain("status: typeof code === 'number' ? code : 128");
    expect(electronSmoke).toContain('exit.signal == null');
    expect(electronSmoke).toContain("'server_node_selected'");
    expect(electronSmoke).toContain("'smoke_quit_requested'");
    expect(electronSmoke).not.toContain('packaged Noe.app not found');
  });
});
