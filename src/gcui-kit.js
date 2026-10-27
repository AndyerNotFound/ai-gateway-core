'use strict';
/* gcui 页面构件 Kit (2026-10-08, DEVLOG 2.70)
 * 「按 App 能力双模式展开」的内核公共构件 —— App 能力分支不进插件。
 * 插件只声明「筛什么」: 维度 = { key: state键, url: URL参数名, field: 行机器字段, op: 算子, cur: 现值 }。
 * App 上报 cond 能力 → 生成 setState/selectedIf/where(本机模式, 零 round-trip);
 * 否则 → 生成 open/selected(URL 模式, 跳转语义由插件 urlJump 保留)。
 * 三原则: ①App 不与插件死绑(插件不写 caps 探测) ②为未知插件服务(任何插件一行声明
 * 获得本机筛选) ③测试便利 —— 纯函数模块, 插件作者可 require 本模块 stub ctx.gcui。 */
module.exports = {
  /** 筛选维度集 → 双模式构件工厂。
   *  urlJump(over): URL 模式的跳转构造(插件提供, 保留自家 mkUrl 语义)。 */
  filters(caps, dims, urlJump) {
    const can = !!(caps && caps.hasComponent && caps.hasComponent('cond'));
    const S = (k) => '{{state.' + k + '}}';
    const st = {}; for (const d of dims) st[d.key] = d.cur;
    const urlClear = () => { const o = {}; for (const d of dims) o[d.url] = ''; return urlJump(o); };
    return {
      can,
      /** state 初值(cond 模式 return 用; 键序 = dims 声明序) */
      state: st,
      /** list.where 条件数组(cond 模式); URL 模式 undefined */
      where() {
        if (!can) return undefined;
        return dims.map(d => ({ left: '{{item.' + d.field + '}}', op: d.op || 'eq', right: S(d.key) }));
      },
      /** 维度取值 chip: 点了把 value 写进该维度 */
      chip(dim, label, value) {
        if (can) return { type: 'chip', text: label, selected: false,
          action: { type: 'setState', patch: { [dim.key]: value } },
          selectedIf: { left: S(dim.key), op: 'eq', right: value } };
        return { type: 'chip', text: label, selected: dim.cur === value,
          action: urlJump({ [dim.url]: value }) };
      },
      /** 维度「全部」chip: 清该维度 */
      all(dim, label) {
        if (can) return { type: 'chip', text: label || '全部', selected: false,
          action: { type: 'setState', patch: { [dim.key]: '' } },
          selectedIf: { left: S(dim.key), op: 'isEmpty' } };
        return { type: 'chip', text: label || '全部', selected: !dim.cur,
          action: urlJump({ [dim.url]: '' }) };
      },
      /** 顶层「全部」chip: 清全部维度(+extraPatch 如 limit 复位); URL 模式 selected=!filtered */
      clearAll(label, filtered, extraPatch) {
        if (can) {
          const patch = {}; for (const d of dims) patch[d.key] = '';
          Object.assign(patch, extraPatch || {});
          return { type: 'chip', text: label, selected: false,
            action: { type: 'setState', patch },
            selectedIf: { all: dims.map(d => ({ left: S(d.key), op: 'isEmpty' })) } };
        }
        return { type: 'chip', text: label, selected: !filtered, action: urlClear() };
      },
      /** 「重置筛选」chip: 清全部维度; 选中态 = 任一维度非空 */
      reset(label) {
        if (can) {
          const patch = {}; for (const d of dims) patch[d.key] = '';
          return { type: 'chip', text: label, selected: false,
            action: { type: 'setState', patch },
            selectedIf: { any: dims.map(d => ({ left: S(d.key), op: 'notEmpty' })) } };
        }
        return { type: 'chip', text: label, selected: false, action: urlClear() };
      },
      /** 搜索输入双模式: key=输入框键, patchKey=要写的 state 键(两者常不同, 如 kw→fKw) */
      input(key, patchKey, cur, label, icon, urlSubmit) {
        const base = { type: 'input', key: key, label: label, value: cur };
        if (icon) base.leadingIcon = icon;
        base.submit = can
          ? { type: 'setState', patch: { [patchKey]: '{{input.' + key + '}}' } }
          : urlSubmit;
        return base;
      },
      /** 视图参数 chip(不进 where/不被清除): cond 选中态走 selectedIf */
      viewChip(dim, label, value) {
        if (can) return { type: 'chip', text: label,
          selectedIf: { left: S(dim.key), op: 'eq', right: value },
          action: { type: 'setState', patch: { [dim.key]: value } } };
        return { type: 'chip', text: label, selected: dim.cur === value,
          action: urlJump({ [dim.url]: value }) };
      },
      /** 分页条(cond 模式): 三 chip 全渲染, 显隐由 App 按 limit/total 数值比较推导;
       *  URL 模式返回 null(插件走自家 moreUrl 分支) */
      pager(o) {
        if (!can) return null;
        return { type: 'hscroll', gap: 6, visible: { any: [
            { left: S(o.limitKey), op: 'lt', right: S(o.totalKey) },
            { left: S(o.limitKey), op: 'gt', right: String(o.pageLimit) },
          ] }, children: [
          { type: 'chip', text: '显示更多 +' + o.step, selected: false,
            action: { type: 'setState', patch: { [o.limitKey]: '+' + o.step } } },
          { type: 'chip', text: '全部显示（' + o.total + ' 个）', selected: false,
            action: { type: 'setState', patch: { [o.limitKey]: String(o.max) } } },
          { type: 'chip', text: '只看前 ' + o.pageLimit + ' 个（更快）', selected: false,
            action: { type: 'setState', patch: { [o.limitKey]: String(o.pageLimit) } } },
        ] };
      },
    };
  },

  /** 筛选组版式: caption 标题 + 横滑 chips(与能力无关, 纯版式) */
  filterRow(label, chips) {
    return { type: 'column', gap: 6, children: [
      { type: 'text', text: label, style: 'caption', color: '$onSurfaceVariant' },
      { type: 'hscroll', gap: 6, children: chips },
    ] };
  },
};
