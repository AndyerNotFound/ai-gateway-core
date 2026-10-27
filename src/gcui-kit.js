'use strict';
/** gcui page building-block Kit (2026-10-08, DEVLOG 2.70)
 * Core building blocks for the "dual-mode expand by App capability" design -- App capability branches stay out of plugins.
   * plugins declare only "what to filter": a dimension = { key: state key, url: URL param name, field: row machine field, op: operator, cur: current value }.
   * the App reporting the cond capability -> generate setState/selectedIf/where (local mode, zero round-trips);
   * otherwise -> generate open/selected (URL mode; the plugin's urlJump keeps its own link semantics).
   * three principles: (1) no hard binding between App and plugins (plugins write no caps probing) (2) serve unknown plugins (any plugin, one line, gains local filtering)
* get local filtering) (3) test convenience -- pure-function module, plugin authors can require it and stub ctx.gcui. */
module.exports = {
/** Filter dimension set -> dual-mode component factory.
   *  urlJump(over): URL-mode link construction (plugin-provided; preserves its own mkUrl semantics). */
  filters(caps, dims, urlJump) {
    const can = !!(caps && caps.hasComponent && caps.hasComponent('cond'));
    const S = (k) => '{{state.' + k + '}}';
    const st = {}; for (const d of dims) st[d.key] = d.cur;
    const urlClear = () => { const o = {}; for (const d of dims) o[d.url] = ''; return urlJump(o); };
    return {
      can,
      /** initial state (used by cond-mode returns; key order = declaration order of dims) */
      state: st,
      /** list.where condition array (cond mode); undefined in URL mode */
      where() {
        if (!can) return undefined;
        return dims.map(d => ({ left: '{{item.' + d.field + '}}', op: d.op || 'eq', right: S(d.key) }));
      },
      /** dimension value chip: tapping writes value into that dimension */
      chip(dim, label, value) {
        if (can) return { type: 'chip', text: label, selected: false,
          action: { type: 'setState', patch: { [dim.key]: value } },
          selectedIf: { left: S(dim.key), op: 'eq', right: value } };
        return { type: 'chip', text: label, selected: dim.cur === value,
          action: urlJump({ [dim.url]: value }) };
      },
      /** dimension "all" chip: clears that dimension */
      all(dim, label) {
        if (can) return { type: 'chip', text: label || '全部', selected: false,
          action: { type: 'setState', patch: { [dim.key]: '' } },
          selectedIf: { left: S(dim.key), op: 'isEmpty' } };
        return { type: 'chip', text: label || '全部', selected: !dim.cur,
          action: urlJump({ [dim.url]: '' }) };
      },
      /** top-level "all" chip: clears every dimension (+extraPatch such as resetting limit); URL mode selected=!filtered */
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
      /** "reset filters" chip: clears every dimension; active when any dimension is non-empty */
      reset(label) {
        if (can) {
          const patch = {}; for (const d of dims) patch[d.key] = '';
          return { type: 'chip', text: label, selected: false,
            action: { type: 'setState', patch },
            selectedIf: { any: dims.map(d => ({ left: S(d.key), op: 'notEmpty' })) } };
        }
        return { type: 'chip', text: label, selected: false, action: urlClear() };
      },
      /** search input, dual mode: key = the input's key, patchKey = the state key to write (often different, e.g. kw -> fKw) */
      input(key, patchKey, cur, label, icon, urlSubmit) {
        const base = { type: 'input', key: key, label: label, value: cur };
        if (icon) base.leadingIcon = icon;
        base.submit = can
          ? { type: 'setState', patch: { [patchKey]: '{{input.' + key + '}}' } }
          : urlSubmit;
        return base;
      },
      /** view-param chip (never enters where / never cleared): cond-mode active state uses selectedIf */
      viewChip(dim, label, value) {
        if (can) return { type: 'chip', text: label,
          selectedIf: { left: S(dim.key), op: 'eq', right: value },
          action: { type: 'setState', patch: { [dim.key]: value } } };
        return { type: 'chip', text: label, selected: dim.cur === value,
          action: urlJump({ [dim.url]: value }) };
      },
      /** pagination row (cond mode): all three chips render; the App derives visibility by comparing limit/total;
       *  URL mode returns null (plugins use their own moreUrl branch) */
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

/** Filter-group layout: caption title + horizontally scrollable chips (capability-independent, pure layout) */
  filterRow(label, chips) {
    return { type: 'column', gap: 6, children: [
      { type: 'text', text: label, style: 'caption', color: '$onSurfaceVariant' },
      { type: 'hscroll', gap: 6, children: chips },
    ] };
  },
};
