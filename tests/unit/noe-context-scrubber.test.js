import { describe, expect, it } from 'vitest';
import {
  StreamingContextScrubber,
  cleanVisibleModelText,
  redactSensitiveText,
  stripHiddenContextBlocks,
} from '../../src/runtime/NoeContextScrubber.js';

describe('NoeContextScrubber', () => {
  it('redacts common provider secrets without removing normal text', () => {
    const googleKey = 'AIza' + 'UnitTestRedactionKey000000000000';
    const text = redactSensitiveText(`XIAOMI_API_KEY=tp-unit-test-redaction-key-00000000000000000000 GEMINI_API_KEY=${googleKey} ok`);

    expect(text).toContain('XIAOMI_API_KEY=[redacted]');
    expect(text).toContain('GEMINI_API_KEY=[redacted]');
    expect(text).toContain('ok');
    expect(text).not.toContain('tp-unit-test-redaction-key');
    expect(text).not.toContain('AIzaUnitTest');
  });

  it('redacts third-party token shapes and generic assignments without touching URL query params', () => {
    const tg = redactSensitiveText('telegram 1234567890:AAExampleBotTokenAbcdefghijklmnopqrstuv ok');
    expect(tg).not.toContain('AAExampleBotTokenAbcdefghijklmnopqrstuv');
    expect(tg).toContain('[redacted-telegram-token]');

    const jwt = redactSensitiveText('jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36 end');
    expect(jwt).not.toContain('eyJzdWIiOiIxMjM0NTY3ODkw');
    expect(jwt).toContain('[redacted-jwt]');

    expect(redactSensitiveText('ghp_abcdefghijklmnopqrstuvwxyz0123456789 here')).toContain('[redacted-github-token]');
    expect(redactSensitiveText('AKIAIOSFODNN7EXAMPLE creds')).toContain('[redacted-aws-key]');

    const generic = redactSensitiveText('MY_CUSTOM_TOKEN=supersecretvalue123');
    expect(generic).toContain('MY_CUSTOM_TOKEN=[redacted]');
    expect(generic).not.toContain('supersecretvalue123');

    // 回归保护:URL query 的 token= 交还各模块自己的 URL 脱敏管线,通用赋值规则不得改写它
    expect(redactSensitiveText('https://x.test/p?token=abcdefghijklmnop')).toContain('?token=abcdefghijklmnop');
    // 正常文本零误伤(时间戳/版本号/手机号/中文)
    expect(redactSensitiveText('ts 1700000000000 ver 1.2.3 phone 13800138000 普通中文'))
      .toBe('ts 1700000000000 ver 1.2.3 phone 13800138000 普通中文');
  });

  it('strips hidden memory and context blocks', () => {
    const out = stripHiddenContextBlocks('hello <memory-context>private</memory-context> world');

    expect(out.text.trim()).toBe('hello  world');
    expect(out.stripped).toHaveLength(1);
    expect(out.stripped[0].kind).toBe('memory-context');
  });

  it('removes internal thought channels from visible model text', () => {
    const out = cleanVisibleModelText('<|channel>analysis\nprivate\n<|channel>final\nvisible');

    expect(out.text).toBe('visible');
    expect(out.stripped.some((item) => item.kind === 'channel:analysis')).toBe(true);
  });

  it('cleans stream chunks before exposing final text', () => {
    const scrubber = new StreamingContextScrubber();
    expect(scrubber.push('hello <memory-context>')).toBe('');
    expect(scrubber.push('private</memory-context> world')).toBe('');

    const out = scrubber.finish();
    expect(out.text).toBe('hello  world');
    expect(out.stripped[0].kind).toBe('memory-context');
  });
});

describe('tp- key 模式升级（吸收 ConsensusLedger 单源化）', () => {
  it('带连字符/下划线的 tp- key 也能整体抹除', () => {
    const text = redactSensitiveText('standalone tp-unit-test-redaction-key-11111111111111111111 end');
    expect(text).not.toContain('tp-unit-test-redaction-key');
    expect(text).toContain('end');
  });
});
