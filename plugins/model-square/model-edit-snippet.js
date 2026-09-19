








  ctx.registerAdminUi({
    id: 'model-edit',
    title: '编辑模型',
    icon: 'edit',
    menu: false,
    render: (gw, c, q) => {
      const inst = String((q && q.get) ? q.get('instance') : '') || myInstName();
      const chName = String((q && q.get) ? q.get('channel') : '');
      const modelName = String((q && q.get) ? q.get('model') : '');
      const meta = metaOf(inst, chName, modelName) || { group: DEFAULT_GROUP };
      const groups = cfg.groups.map(g => g.name);
      const price = meta.price || {};
      const rules = Array.isArray(meta.rules) ? meta.rules : [];
      const sym = curSym();
      const call = (body) => ({ type: 'adminApi', method: 'POST', path: '/admin/api/plugin-call', body: { plugin: 'model-square', path: '/admin/groups', method: 'POST', body: body } });

      const kids = [
        txt(meta.alias || modelName, 'title3'),
        txt(inst + ' · ' + chName + '  /  ' + modelName, 'caption', '$onSurfaceVariant'),
        gap(8),
        {
          type: 'form', submitText: '保存', submitShape: 'large',
          fields: [
            { type: 'input', key: 'alias', label: '对外名称（留空 = 用原名）', value: meta.alias || '' },
            { type: 'input', key: 'group', label: '分组（可选: ' + groups.join(', ') + '）', value: meta.group || DEFAULT_GROUP },
            { type: 'input', key: 'perCall', label: '按次价格（' + sym + '/次，留空 = 按量计费）', inputType: 'number', value: meta.perCall != null ? String(meta.perCall) : '' },
            { type: 'input', key: 'priceIn', label: '输入（' + sym + ' / 1M tokens）', inputType: 'number', value: String(price['in'] || 0) },
            { type: 'input', key: 'priceOut', label: '输出（' + sym + ' / 1M tokens）', inputType: 'number', value: String(price.out || 0) },
            { type: 'input', key: 'priceCW', label: '缓存写入（' + sym + ' / 1M tokens）', inputType: 'number', value: String(price.cacheWrite || 0) },
            { type: 'input', key: 'priceCR', label: '缓存读取（' + sym + ' / 1M tokens）', inputType: 'number', value: String(price.cacheRead || 0) },
          ],
          submit: call({
            action: 'setModel', instance: inst, channel: chName, model: modelName,
            group: '{{form.group}}', alias: '{{form.alias}}', perCall: '{{form.perCall}}',
            price: { in: '{{form.priceIn}}', out: '{{form.priceOut}}', cacheWrite: '{{form.priceCW}}', cacheRead: '{{form.priceCR}}' },
          }),
        },
        txt('两种计费方式二选一：填了「按次价格」就按次收，否则按 token 单价；都填 0 = 免费。', 'caption', '$onSurfaceVariant'),
        gap(12),
        txt('计费规则（该模型专属，会覆盖全局规则）', 'title3'),
      ];

      if (!rules.length) {
        kids.push(txt('没有模型级规则。上面的价格字段已经决定基础扣费。要加规则可以用 billing 插件的网页端编辑器。', 'caption', '$onSurfaceVariant'));
      } else {
        for (let i = 0; i < rules.length; i++) {
          const r = rules[i];
          const wTxt = (r.when || []).map(c => c.k + ' ' + (c.op || 'eq') + ' ' + (Array.isArray(c.v) ? c.v.join(',') : c.v)).join(' 且 ') || '无条件';
          const tTxt = (r.then || []).map(e => e.k + (e.k === 'price' ? '(' + (e.field || 'all') + ',' + (e.mode || 'set') + '):' + e.v : ':' + e.v)).join('，');
          kids.push({
            type: 'card', variant: 'outlined', gap: 6, children: [
              txt((r.note || ('规则 ' + (i + 1))) + (r.on === false ? '（已停用）' : ''), 'body'),
              txt('触发: ' + wTxt, 'caption', '$onSurfaceVariant'),
              txt('效果: ' + tTxt, 'caption', '$onSurfaceVariant'),
              btn('删除规则', 'text', call({ action: 'setModel', instance: inst, channel: chName, model: modelName, rules: rules.filter((_, j) => j !== i) })),
            ],
          });
        }
      }

      kids.push(gap(8));
      kids.push(btn('关闭', 'text', { type: 'close' }));

      return { title: '编辑模型', state: {}, root: { type: 'column', gap: 10, children: kids } };
    },
  });
