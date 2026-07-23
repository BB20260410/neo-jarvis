// @ts-check
// NoeLoraVersionRegistry（P5-3 权重版本化与回滚）——权重比代码难回滚，必须版本化可逆。
// 每个 LoRA 版本入册：版本号 + 训练数据指纹 + 评测分 + base 模型 + adapter 路径；一键 revert 到任意历史版本
// （revert 只移动 active 指针，历史版本不删 = 真可逆，评测分可追溯）。
//
// 全注入式（read/write/now）：默认读写一个 registry JSON；测试注入内存读写。纯状态管理，不碰真权重文件
// （只记元数据 + adapter 路径；加载/热更由训练/部署侧据 active 指针做）。
//
// @deprecated 2026-06-22（P7 换路线）：LoRA 路线经 owner 2026-06-21 复盘判死——当前 SFT 约半是项目
//   复盘，训透即人格退化（persona 该挂 system prompt 见 NoeSelfModel.buildPersonaPin，weights 进化改
//   GEPA + memory-RAG）。本模块 server.js 引用=0（已 unwired）。**代码保留不删**：备未来用干净数据重启
//   LoRA 时此版本化/回滚地基仍可复用，删了要重写。新增权重进化逻辑请走 GEPA/RAG，勿再接线此模块。

function clean(v, max = 200) { return String(v ?? '').slice(0, max); }

/**
 * @deprecated LoRA 路线已判死（见文件头 2026-06-22 注），仅留作未来干净数据重启时复用；勿新接线。
 * @param {{ read?: ()=>object|null, write?: (obj)=>void, now?: ()=>number }} deps
 */
export function createLoraVersionRegistry({ read = null, write = null, now = () => Date.now() } = {}) {
  // 内存兜底（未注入持久化时）：进程内 registry。
  let mem = { versions: [], active: null, schemaVersion: 1 };
  const load = () => {
    if (typeof read === 'function') { const r = read(); return r && typeof r === 'object' ? { versions: [], active: null, schemaVersion: 1, ...r } : { versions: [], active: null, schemaVersion: 1 }; }
    return mem;
  };
  const persist = (obj) => { if (typeof write === 'function') write(obj); else mem = obj; };

  // 登记一个新版本（version 唯一；重复 version 拒，防覆盖历史=不可逆）。
  function register({ version, dataFingerprint = '', evalScore = null, baseModel = '', adapterPath = '', notes = '' } = {}) {
    const v = clean(version, 80);
    if (!v) return { ok: false, reason: 'version_required' };
    const reg = load();
    if (reg.versions.some((x) => x.version === v)) return { ok: false, reason: 'version_exists' };
    const entry = {
      version: v,
      dataFingerprint: clean(dataFingerprint, 200),
      evalScore: (evalScore === null || evalScore === undefined) ? null : Number(evalScore),
      baseModel: clean(baseModel, 120),
      adapterPath: clean(adapterPath, 500),
      notes: clean(notes, 500),
      registeredAt: Number(typeof now === 'function' ? now() : now) || 0,
    };
    reg.versions = [...reg.versions, entry];
    persist(reg);
    return { ok: true, entry };
  }

  function list() { return load().versions.slice().sort((a, b) => b.registeredAt - a.registeredAt); }
  function get(version) { return load().versions.find((x) => x.version === clean(version, 80)) || null; }
  function current() { const reg = load(); return reg.active ? (reg.versions.find((x) => x.version === reg.active) || null) : null; }

  // 提升某版本为 active（热更生产指针）。版本须已登记。
  function setActive(version) {
    const v = clean(version, 80);
    const reg = load();
    if (!reg.versions.some((x) => x.version === v)) return { ok: false, reason: 'unknown_version' };
    reg.active = v;
    persist(reg);
    return { ok: true, active: v };
  }

  // 回滚到任意历史版本（= setActive 历史版本；不删任何版本，纯指针移动，真可逆）。
  function revertTo(version) {
    const v = clean(version, 80);
    const target = get(v);
    if (!target) return { ok: false, reason: 'unknown_version' };
    const reg = load();
    const from = reg.active;
    reg.active = v;
    persist(reg);
    return { ok: true, revertedFrom: from || null, revertedTo: v, adapterPath: target.adapterPath, evalScore: target.evalScore };
  }

  return { register, list, get, current, setActive, revertTo };
}
