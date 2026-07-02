import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SALIENCE_THRESHOLD,
  NOE_MEMORY_MD_MIRROR_ENV,
  buildMirrorDocuments,
  factToLine,
  isMirrorEnabled,
  knowledgeEntityToMirrorDoc,
  memoriesToMirrorDoc,
  relationToLine,
  slugifyFilename,
  toMarkdown,
} from '../../src/memory/NoeMemoryMarkdownMirror.js';

// 确定性脱敏 mock：把任何含 sk- 的片段替换掉，断言脱敏被真正调用（默认参数路径不依赖此 mock）。
const fakeRedact = (s) => String(s).replace(/sk-[A-Za-z0-9]+/g, '[redacted]');

describe('isMirrorEnabled（env 门控，默认 OFF）', () => {
  it('默认（空 env）= OFF', () => {
    expect(isMirrorEnabled()).toBe(false);
    expect(isMirrorEnabled({})).toBe(false);
  });

  it('只有显式 1 / true / on 才算开，大小写不敏感', () => {
    expect(isMirrorEnabled({ [NOE_MEMORY_MD_MIRROR_ENV]: '1' })).toBe(true);
    expect(isMirrorEnabled({ [NOE_MEMORY_MD_MIRROR_ENV]: 'true' })).toBe(true);
    expect(isMirrorEnabled({ [NOE_MEMORY_MD_MIRROR_ENV]: 'ON' })).toBe(true);
    expect(isMirrorEnabled({ [NOE_MEMORY_MD_MIRROR_ENV]: ' True ' })).toBe(true);
  });

  it('其他值（0/false/空/yes/随意）= OFF', () => {
    for (const v of ['0', 'false', '', 'yes', 'enabled', 'off', '2']) {
      expect(isMirrorEnabled({ [NOE_MEMORY_MD_MIRROR_ENV]: v })).toBe(false);
    }
  });

  it('环境变量名常量正确', () => {
    expect(NOE_MEMORY_MD_MIRROR_ENV).toBe('NOE_MEMORY_MD_MIRROR');
  });
});

describe('factToLine（Basic Memory observation 行）', () => {
  it('渲染 - [category] 事实 #tag', () => {
    expect(factToLine({ category: 'preference', text: 'owner 默认用简体中文', tags: ['lang', 'owner'] }))
      .toBe('- [preference] owner 默认用简体中文 #lang #owner');
  });

  it('缺省 category 为 fact，无 tag 不带尾部空格', () => {
    expect(factToLine({ text: '一个事实' })).toBe('- [fact] 一个事实');
  });

  it('接受 body 作为 text 的别名（兼容 MemoryCore 字段）', () => {
    expect(factToLine({ body: 'via body 字段' })).toBe('- [fact] via body 字段');
  });

  it('tag 规整：去前导 #、空白转连字符、空 tag 丢弃', () => {
    expect(factToLine({ text: 'x', tags: ['#hot', 'two words', '   ', '#'] }))
      .toBe('- [fact] x #hot #two-words');
  });

  it('空事实返回空串（由调用方过滤）', () => {
    expect(factToLine({ text: '   ' })).toBe('');
    expect(factToLine({})).toBe('');
  });

  it('折叠换行/多空白为单空格（保证单行）', () => {
    expect(factToLine({ text: '多行\n   事实\t内容' })).toBe('- [fact] 多行 事实 内容');
  });

  it('注入脱敏函数会作用到事实文本', () => {
    expect(factToLine({ text: 'key=sk-ABCDEF123' }, fakeRedact)).toBe('- [fact] key=[redacted]');
  });
});

describe('relationToLine（Basic Memory relation 行）', () => {
  it('渲染 - rel_type [[实体]]', () => {
    expect(relationToLine({ relType: 'contains', target: 'server.js' })).toBe('- contains [[server.js]]');
  });

  it('接受 rel_type / dst 别名（兼容 KG 字段）', () => {
    expect(relationToLine({ rel_type: 'has_type', dst: 'other' })).toBe('- has_type [[other]]');
  });

  it('缺省 relType 为 related_to，含空格的关系名转下划线', () => {
    expect(relationToLine({ target: 'X' })).toBe('- related_to [[X]]');
    expect(relationToLine({ relType: 'depends on', target: 'X' })).toBe('- depends_on [[X]]');
  });

  it('空目标返回空串', () => {
    expect(relationToLine({ relType: 'r' })).toBe('');
    expect(relationToLine({})).toBe('');
  });
});

describe('toMarkdown（核心纯函数 / NOTE-FORMAT）', () => {
  it('完整文档：frontmatter + Observations + Relations，结构与顺序稳定', () => {
    const md = toMarkdown({
      frontmatter: { title: '我的项目', type: 'project', tags: ['noe', 'local'] },
      facts: [
        { category: 'fact', text: '端口 51835', tags: ['port'] },
        { category: 'preference', text: 'owner 要全自动' },
      ],
      relations: [
        { relType: 'contains', target: 'server.js' },
        { relType: 'has_type', target: 'backend' },
      ],
    });
    expect(md).toBe(
      [
        '---',
        'tags: [noe, local]',
        'title: 我的项目',
        'type: project',
        '---',
        '',
        '# 我的项目',
        '',
        '## Observations',
        '- [fact] 端口 51835 #port',
        '- [preference] owner 要全自动',
        '',
        '## Relations',
        '- contains [[server.js]]',
        '- has_type [[backend]]',
        '',
      ].join('\n'),
    );
  });

  it('确定性：键按字母序，同输入两次产出逐字节相同', () => {
    const input = { frontmatter: { zeta: 1, alpha: 'a', mid: true }, facts: [{ text: 'x' }] };
    expect(toMarkdown(input)).toBe(toMarkdown(input));
    const lines = toMarkdown(input).split('\n');
    // alpha < mid < zeta
    expect(lines.slice(1, 4)).toEqual(['alpha: a', 'mid: true', 'zeta: 1']);
  });

  it('YAML 标量按需加引号：日期/数字样/布尔字面量/含冒号 → 引号；普通中英文 → 裸写', () => {
    const md = toMarkdown({
      frontmatter: {
        created: '2026-06-14',
        version: '123',
        flag: 'true',
        note: 'has: colon',
        plain: 'ok-plain',
        cn: '中文值',
        num: 7,
        real_bool: false,
      },
      facts: [{ text: 'x' }],
    });
    expect(md).toContain('created: "2026-06-14"');
    expect(md).toContain('version: "123"');
    expect(md).toContain('flag: "true"');
    expect(md).toContain('note: "has: colon"');
    expect(md).toContain('plain: ok-plain');
    expect(md).toContain('cn: 中文值');
    expect(md).toContain('num: 7'); // 真数字不加引号
    expect(md).toContain('real_bool: false'); // 真布尔不加引号
  });

  it('空数组渲染为 []，空 frontmatter 折叠为 ---\\n---', () => {
    expect(toMarkdown({ frontmatter: { tags: [] }, facts: [{ text: 'x' }] })).toContain('tags: []');
    const empty = toMarkdown({ frontmatter: {}, facts: [], relations: [] });
    expect(empty.startsWith('---\n---\n')).toBe(true);
    expect(empty).toContain('# 记忆'); // 缺省标题
  });

  it('无 facts 时不出现 Observations 段；无 relations 时不出现 Relations 段', () => {
    const onlyRel = toMarkdown({ frontmatter: { title: 't' }, relations: [{ relType: 'r', target: 'X' }] });
    expect(onlyRel).not.toContain('## Observations');
    expect(onlyRel).toContain('## Relations');
    const onlyFact = toMarkdown({ frontmatter: { title: 't' }, facts: [{ text: 'x' }] });
    expect(onlyFact).toContain('## Observations');
    expect(onlyFact).not.toContain('## Relations');
  });

  it('title 优先用入参，其次 frontmatter.title，最后缺省「记忆」', () => {
    expect(toMarkdown({ frontmatter: { title: 'FM' }, title: 'ARG', facts: [{ text: 'x' }] })).toContain('# ARG');
    expect(toMarkdown({ frontmatter: { title: 'FM' }, facts: [{ text: 'x' }] })).toContain('# FM');
    expect(toMarkdown({ frontmatter: {}, facts: [{ text: 'x' }] })).toContain('# 记忆');
  });

  it('frontmatter 字符串值与字符串数组元素都过脱敏（防 secret 入 YAML 头）', () => {
    const md = toMarkdown(
      { frontmatter: { secret: 'token sk-XYZ999', arr: ['sk-AAA111', 'safe'] }, facts: [{ text: 'k=sk-BBB222' }] },
      { redact: fakeRedact },
    );
    // 脱敏 token 含 []，YAML 序列化加引号防破坏结构（实现的安全正确行为）
    expect(md).toContain('secret: "token [redacted]"');
    expect(md).toContain('arr: ["[redacted]", safe]');
    expect(md).toContain('- [fact] k=[redacted]');
    expect(md).not.toContain('sk-');
  });

  it('文档以单个换行结尾（POSIX 文本文件惯例）', () => {
    const md = toMarkdown({ frontmatter: { title: 't' }, facts: [{ text: 'x' }] });
    expect(md.endsWith('\n')).toBe(true);
    expect(md.endsWith('\n\n')).toBe(false);
  });

  it('无入参不抛错', () => {
    expect(() => toMarkdown()).not.toThrow();
    expect(toMarkdown()).toContain('# 记忆');
  });
});

describe('slugifyFilename', () => {
  it('折叠空白为连字符、去非法字符', () => {
    expect(slugifyFilename('My Project / v2:beta')).toBe('My-Project-v2-beta');
  });
  it('保留中文', () => {
    expect(slugifyFilename('佣兵小镇')).toBe('佣兵小镇');
  });
  it('空/纯非法 → untitled', () => {
    expect(slugifyFilename('')).toBe('untitled');
    expect(slugifyFilename('///')).toBe('untitled');
    expect(slugifyFilename(null)).toBe('untitled');
  });
});

describe('knowledgeEntityToMirrorDoc（KG 实体 → 镜像文档，单向只读）', () => {
  it('把 oneHop 结果映射成 frontmatter + 一条概要观察 + 关系行', () => {
    const hop = {
      entity: { name: 'server.js', type: 'file', description: 'backend 入口', refs: ['/abs/server.js'] },
      edges: [
        { rel_type: 'has_type', name: 'backend' },
        { rel_type: 'mentions', name: 'WebSocket' },
      ],
    };
    const mapped = knowledgeEntityToMirrorDoc(hop, { projectId: 'noe' });
    expect(mapped.filename).toBe('server.js.md');
    expect(mapped.doc.frontmatter).toMatchObject({ title: 'server.js', type: 'file', source: 'knowledge_graph', project: 'noe' });
    expect(mapped.doc.facts[0]).toEqual({ category: 'file', text: 'backend 入口', tags: ['file'] });
    expect(mapped.doc.relations).toEqual([
      { relType: 'has_type', target: 'backend' },
      { relType: 'mentions', target: 'WebSocket' },
    ]);
    // 端到端渲染含 wikilink 关系
    const md = toMarkdown(mapped.doc);
    expect(md).toContain('- has_type [[backend]]');
    expect(md).toContain('- mentions [[WebSocket]]');
  });

  it('无实体或无名实体返回 null', () => {
    expect(knowledgeEntityToMirrorDoc({})).toBeNull();
    expect(knowledgeEntityToMirrorDoc({ entity: { name: '' } })).toBeNull();
  });

  it('无 description 时不产生空观察', () => {
    const mapped = knowledgeEntityToMirrorDoc({ entity: { name: 'x', type: 'term' }, edges: [] });
    expect(mapped.doc.facts).toEqual([]);
  });
});

describe('memoriesToMirrorDoc（高显著度过滤）', () => {
  const memories = [
    { body: '高显著度A', scope: 'fact', salience: 5, tags: ['a'] },
    { body: '低显著度B', scope: 'fact', salience: 2 },
    { body: '敏感C', scope: 'fact', salience: 5, sensitive: true },
    { body: '无标注D', scope: 'insight' }, // salience 缺失 → 保守保留
  ];

  it('默认阈值=DEFAULT_SALIENCE_THRESHOLD，过滤低显著度', () => {
    expect(DEFAULT_SALIENCE_THRESHOLD).toBe(4);
    const doc = memoriesToMirrorDoc(memories);
    const texts = doc.facts.map((f) => f.text);
    expect(texts).toContain('高显著度A');
    expect(texts).toContain('无标注D'); // 缺失 salience 保守保留
    expect(texts).not.toContain('低显著度B'); // 低于阈值剔除
    expect(texts).not.toContain('敏感C'); // sensitive 整条剔除
    expect(doc.frontmatter.count).toBe(2);
    expect(doc.frontmatter.salience_min).toBe(4);
  });

  it('可调阈值', () => {
    const doc = memoriesToMirrorDoc(memories, { salienceThreshold: 1 });
    // 阈值=1 时 B（salience 2）入选，敏感仍剔除
    expect(doc.facts.map((f) => f.text)).toContain('低显著度B');
    expect(doc.facts.map((f) => f.text)).not.toContain('敏感C');
  });

  it('scope 映射为 category', () => {
    const doc = memoriesToMirrorDoc([{ body: 'x', scope: 'project', salience: 5 }]);
    expect(doc.facts[0].category).toBe('project');
  });

  it('空输入返回 count=0 文档', () => {
    expect(memoriesToMirrorDoc([]).frontmatter.count).toBe(0);
    expect(memoriesToMirrorDoc().frontmatter.count).toBe(0);
  });
});

describe('buildMirrorDocuments（顶层编排 + env 门控落点，仍不写盘）', () => {
  const memories = [{ body: '高显著度记忆', scope: 'fact', salience: 5 }];
  const entityHops = [{ entity: { name: '佣兵小镇', type: 'project', description: 'Godot 游戏' }, edges: [] }];

  it('门控关闭（默认 env）：enabled=false 且 files 为空', () => {
    const out = buildMirrorDocuments({ memories, entityHops }, { env: {} });
    expect(out.enabled).toBe(false);
    expect(out.files).toEqual([]);
  });

  it('门控开启：产出 memory/long-term.md + entities/<slug>.md，content 是有效 Markdown', () => {
    const out = buildMirrorDocuments(
      { memories, entityHops },
      { env: { [NOE_MEMORY_MD_MIRROR_ENV]: '1' } },
    );
    expect(out.enabled).toBe(true);
    const paths = out.files.map((f) => f.relPath);
    expect(paths).toContain('memory/long-term.md');
    expect(paths).toContain('entities/佣兵小镇.md');
    const memFile = out.files.find((f) => f.relPath === 'memory/long-term.md');
    expect(memFile.content).toContain('- [fact] 高显著度记忆');
    expect(memFile.content).toContain('source: memory_core');
    const entFile = out.files.find((f) => f.relPath === 'entities/佣兵小镇.md');
    expect(entFile.content).toContain('# 佣兵小镇');
    expect(entFile.content).toContain('- [project] Godot 游戏');
  });

  it('门控开启但无高显著度记忆时，不产 long-term.md（避免空文件）', () => {
    const out = buildMirrorDocuments(
      { memories: [{ body: 'low', salience: 1 }], entityHops: [] },
      { env: { [NOE_MEMORY_MD_MIRROR_ENV]: '1' } },
    );
    expect(out.enabled).toBe(true);
    expect(out.files.map((f) => f.relPath)).not.toContain('memory/long-term.md');
  });

  it('注入脱敏函数贯穿到产出文件内容（不泄漏 secret）', () => {
    const out = buildMirrorDocuments(
      { memories: [{ body: 'apikey=sk-LEAK0001', salience: 5 }], entityHops: [] },
      { env: { [NOE_MEMORY_MD_MIRROR_ENV]: 'true' }, redact: fakeRedact },
    );
    const content = out.files.map((f) => f.content).join('\n');
    expect(content).toContain('[redacted]');
    expect(content).not.toContain('sk-LEAK0001');
  });

  it('本模块不触碰 fs / 不返回任何写盘副作用，只返回 {relPath, content}', () => {
    const out = buildMirrorDocuments({ memories, entityHops: [] }, { env: { [NOE_MEMORY_MD_MIRROR_ENV]: '1' } });
    for (const f of out.files) {
      expect(Object.keys(f).sort()).toEqual(['content', 'relPath']);
      expect(typeof f.content).toBe('string');
      expect(typeof f.relPath).toBe('string');
    }
  });
});