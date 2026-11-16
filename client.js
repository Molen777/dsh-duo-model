// ============================================================================
// dsh-duo-model — Client 半边（composer 双格模型分配条）
// ----------------------------------------------------------------------------
// 两个格子：思考者（= 本会话模型）、工作者（便宜的干活模型）。
//   选中「思考者」会真的切换本会话的模型；
//   选中「工作者」把两条路由交给 Host，由 Host 写进会话投影
//   subagentModelSelectionPolicy，并装一个默认带 worker 路由的 `subagent` 委派工具。
//
// 通信只走一条路：`fetch('/api/duo-model/state|save')`。
// 不用 typert Remote，也不 require `react-dom` —— 这个包里只有 `react` 是保证能
// 拿到的（`react-dom` / primitives 在宿主 bundle 里由内核自己拥有，第三方包里
// require 它们会让整个 factory throw，而 slot 注册早就成功了，于是屏幕上是
// "什么都不显示"而不是"报错"）。
//
// 组件外面再包一层错误边界：真出异常时画一条"读取失败"的窄条，而不是静默消失。
// ============================================================================
window.__ModuleLoader__.load({
  id: 'dsh-duo-model',
  factory(require) {
    const React = require('react');
    const { useState, useRef, useEffect, useMemo, useCallback, useSyncExternalStore, Component } = React;
    const h = React.createElement;

    const NS = 'duo-model';
    const PLUGIN = 'dsh-duo-model';
    const SLOT = 'conversation.composer.dock';
    const SLOT_ID = 'duo-model-router';
    const MENU_WIDTH = 340;
    /** 与 Host 侧 route.js 的 ROUTE_PREFIX 必须一致。 */
    const API = '/api/duo-model';

    /** 内置文案；locale 服务注册后由它覆盖。 */
    const TEXT = {
      title: { zh: '双模型', en: 'Duo' },
      planner: { zh: '思考者', en: 'Thinker' },
      worker: { zh: '工作者', en: 'Worker' },
      plannerHint: { zh: '理解需求、拆方案、做决策、写最终答复', en: 'Understands the task, plans, decides, writes the final answer' },
      workerHint: { zh: '由思考者委派，负责实际执行', en: 'Delegated by the thinker, does the hands-on work' },
      swap: { zh: '互换角色', en: 'Swap roles' },
      toggleOn: { zh: '点一下启用分工', en: 'Click to enable the duo' },
      toggleOff: { zh: '点一下关闭分工', en: 'Click to disable the duo' },
      on: { zh: '分工已启用', en: 'Duo on' },
      off: { zh: '分工未启用', en: 'Duo off' },
      empty: { zh: '未选择', en: 'Not set' },
      noModels: { zh: '没有匹配的模型', en: 'No matching model' },
      search: { zh: '搜索模型…', en: 'Search models…' },
      saveFailed: { zh: '保存失败', en: 'Save failed' },
      savedHint: {
        zh: '分工已保存：{planner} 思考，{worker} 执行',
        en: 'Saved: {planner} thinks, {worker} works',
      },
      sessionPending: {
        zh: '这个会话已经开始了，白名单从下一个新会话起生效。',
        en: 'This session already started; the allowlist applies from the next new session.',
      },
      needBoth: { zh: '先把两个格子都选上，且不能是同一个模型', en: 'Pick both seats first, and they must differ' },
      enterHint: { zh: '↑↓ 选择 · Enter 确认 · Esc 关闭', en: '↑↓ to move · Enter to pick · Esc to close' },
      unavailable: { zh: '宿主接口还没就绪', en: 'Host endpoint not ready' },
      busy: { zh: '处理中…', en: 'Working…' },
      loading: { zh: '读取中…', en: 'Loading…' },
      crash: { zh: '双模型条渲染出错', en: 'The duo bar failed to render' },
    };

    const CSS = [
      '.duo-root{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:4px 2px 2px;font-size:12px;line-height:1.4}',
      '.duo-title{font-weight:600;color:var(--dsw-alias-label-tertiary,#888);letter-spacing:.02em;margin-right:2px}',
      '.duo-cell{display:inline-flex;align-items:center;gap:6px;min-height:26px;padding:2px 8px;border-radius:7px;',
      'border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28));background:var(--dsw-alias-bg-layer-1,transparent);',
      'color:var(--dsw-alias-label-primary,#e6e6e6);cursor:pointer;font:inherit;max-width:230px}',
      '.duo-cell:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}',
      '.duo-cell:disabled{opacity:.55;cursor:default}',
      '.duo-cell[data-empty="true"] .duo-name{color:var(--dsw-alias-label-tertiary,#888)}',
      '.duo-tag{font-size:10.5px;font-weight:700;padding:1px 5px;border-radius:4px;color:#fff;flex:none}',
      '.duo-cell[data-role="planner"] .duo-tag{background:#7b5cff}',
      '.duo-cell[data-role="worker"] .duo-tag{background:#1f9e77}',
      '.duo-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:130px}',
      '.duo-prov{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#888);flex:none}',
      '.duo-chev{font-size:10px;opacity:.7;flex:none}',
      '.duo-iconbtn{appearance:none;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary,#999);',
      'border-radius:6px;width:24px;height:24px;cursor:pointer;font:inherit;flex:none}',
      '.duo-iconbtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}',
      '.duo-iconbtn:disabled{opacity:.4;cursor:default}',
      '.duo-state{display:inline-flex;align-items:center;gap:5px;border-radius:999px;padding:2px 9px;font:inherit;cursor:pointer;',
      'border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28));background:transparent;color:var(--dsw-alias-label-secondary,#999)}',
      '.duo-state[data-on="true"]{border-color:#1f9e77;color:#1f9e77;background:rgba(31,158,119,.1)}',
      '.duo-state:disabled{opacity:.55;cursor:default}',
      '.duo-dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}',
      '.duo-menu{position:fixed;z-index:2147483000;display:flex;flex-direction:column;border-radius:10px;overflow:hidden;',
      'border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));background:var(--dsw-alias-bg-layer-1,#1c1c1f);',
      'box-shadow:0 12px 32px rgba(0,0,0,.32);color:var(--dsw-alias-label-primary,#e6e6e6)}',
      '.duo-menuHead{padding:7px 8px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2))}',
      '.duo-input{width:100%;box-sizing:border-box;border-radius:6px;padding:5px 8px;font:inherit;',
      'border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08));',
      'color:inherit;outline:none}',
      '.duo-input:focus{border-color:#7b5cff}',
      '.duo-menuBody{overflow:auto;padding:4px 0;max-height:inherit}',
      '.duo-group{padding:5px 10px 3px;font-size:10.5px;font-weight:700;letter-spacing:.04em;',
      'color:var(--dsw-alias-label-tertiary,#888);text-transform:uppercase}',
      '.duo-opt{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;padding:5px 10px;border:0;',
      'background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}',
      '.duo-opt[data-active="true"]{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}',
      '.duo-optName{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.duo-optProv{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#888);flex:none}',
      '.duo-optCheck{width:14px;flex:none;color:#1f9e77}',
      '.duo-note{padding:6px 10px;font-size:11px;color:var(--dsw-alias-label-tertiary,#888)}',
      '.duo-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483001;pointer-events:none;',
      'padding:7px 14px;border-radius:8px;font-size:12px;max-width:70vw;text-align:center;',
      'background:var(--dsw-alias-bg-layer-1,#1c1c1f);color:var(--dsw-alias-label-primary,#e6e6e6);',
      'border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));box-shadow:0 8px 24px rgba(0,0,0,.28)}',
      '.duo-toast[data-error="true"]{border-color:#d9534f;color:#d9534f}',
      '.duo-crash{padding:3px 8px;border-radius:7px;font-size:11.5px;',
      'border:1px dashed var(--dsw-alias-border-l1,rgba(127,127,127,.35));color:var(--dsw-alias-label-tertiary,#888)}',
    ].join('\n');

    // ── 小工具 ────────────────────────────────────────────────────────────────
    const ZH = {};
    const EN = {};
    for (const [key, value] of Object.entries(TEXT)) {
      ZH[key] = value.zh;
      EN[key] = value.en;
    }

    /** 带 {占位} 的内置翻译；locale 不可用时也能跑。 */
    function fill(template, params) {
      if (params === undefined || params === null) return template;
      return String(template).replace(/\{(\w+)\}/g, (whole, name) =>
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole,
      );
    }

    function makeTranslator(locale) {
      const pick = (key) => {
        if (locale !== undefined && locale !== null && typeof locale.t === 'function') {
          try {
            const text = locale.t(NS, key);
            if (typeof text === 'string' && text.length > 0 && text !== key) return text;
          } catch (error) {
            /* 落到内置词典 */
          }
        }
        return ZH[key] ?? EN[key] ?? key;
      };
      return (key, params) => fill(pick(key), params);
    }

    const routeOf = (value) => {
      if (value === undefined || value === null || typeof value !== 'object') return undefined;
      const provider = value.provider;
      const model = value.model;
      if (typeof provider !== 'string' || provider.length === 0) return undefined;
      if (typeof model !== 'string' || model.length === 0) return undefined;
      return { provider, model };
    };

    const routeKey = (route) => (route === undefined ? '' : `${route.provider}\u0000${route.model}`);
    const sameRoute = (a, b) => routeKey(a) !== '' && routeKey(a) === routeKey(b);

    function describeFailure(failure) {
      if (failure === undefined || failure === null) return 'unknown error';
      if (typeof failure === 'string') return failure;
      const message = failure.message === undefined || failure.message === null ? undefined : String(failure.message);
      const code = failure.code === undefined || failure.code === null ? undefined : String(failure.code);
      if (message !== undefined && code !== undefined) return `${code}: ${message}`;
      return message ?? code ?? String(failure);
    }

    /** 固定定位弹层放在触发器上方，并夹在视口内。 */
    function measureAbove(trigger) {
      if (trigger === undefined || trigger === null) return undefined;
      if (typeof trigger.getBoundingClientRect !== 'function') return undefined;
      const rect = trigger.getBoundingClientRect();
      const margin = 12;
      const width = Math.min(MENU_WIDTH, window.innerWidth - margin * 2);
      const left = Math.min(Math.max(margin, rect.left), Math.max(margin, window.innerWidth - width - margin));
      const spaceAbove = rect.top - margin;
      return {
        left,
        bottom: Math.max(margin, window.innerHeight - rect.top + 6),
        width,
        maxHeight: Math.max(180, Math.min(440, spaceAbove)),
      };
    }

    // ── 模型选择弹层 ──────────────────────────────────────────────────────────
    function ModelMenu(props) {
      const { trigger, groups, current, t, onPick, onClose } = props;
      const [query, setQuery] = useState('');
      const [cursor, setCursor] = useState(0);
      const menuRef = useRef(null);
      const inputRef = useRef(null);
      const [box, setBox] = useState(() => measureAbove(trigger));

      useEffect(() => {
        setBox(measureAbove(trigger));
        const node = inputRef.current;
        if (node !== null) node.focus();
      }, [trigger]);

      useEffect(() => {
        const onPointerDown = (event) => {
          const node = event.target;
          if (menuRef.current !== null && menuRef.current.contains(node)) return;
          if (trigger !== undefined && trigger !== null && typeof trigger.contains === 'function' && trigger.contains(node)) return;
          onClose();
        };
        const onKeyDown = (event) => {
          if (event.key === 'Escape') onClose();
        };
        document.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('keydown', onKeyDown, true);
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true);
          document.removeEventListener('keydown', onKeyDown, true);
        };
      }, [trigger, onClose]);

      const filtered = useMemo(() => {
        const needle = query.trim().toLowerCase();
        if (needle === '') return groups;
        return groups
          .map((group) => ({
            ...group,
            models: group.models.filter((model) =>
              `${model.name ?? ''} ${model.id}`.toLowerCase().includes(needle),
            ),
          }))
          .filter((group) => group.models.length > 0);
      }, [groups, query]);

      const flat = useMemo(() => {
        const out = [];
        for (const group of filtered) {
          for (const model of group.models) out.push({ provider: group.id, model: String(model.id) });
        }
        return out;
      }, [filtered]);

      const activeIndex = flat.length === 0 ? -1 : Math.min(cursor, flat.length - 1);

      const onKeyDown = (event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          if (flat.length === 0) return;
          event.preventDefault();
          const step = event.key === 'ArrowDown' ? 1 : -1;
          setCursor((value) => (value + step + flat.length) % flat.length);
          return;
        }
        if (event.key !== 'Enter') return;
        const picked = flat[activeIndex < 0 ? 0 : activeIndex];
        if (picked === undefined) return;
        event.preventDefault();
        onPick(picked);
      };

      const rows = [];
      if (groups.length === 0 || filtered.length === 0) {
        rows.push(h('div', { key: 'none', className: 'duo-note' }, t('noModels')));
      }
      let flatIndex = -1;
      for (const group of filtered) {
        rows.push(h('div', { key: `g:${group.id}`, className: 'duo-group' }, group.name));
        for (const model of group.models) {
          flatIndex += 1;
          const route = { provider: group.id, model: String(model.id) };
          const checked = sameRoute(route, current);
          rows.push(
            h(
              'button',
              {
                key: `m:${group.id}|${String(model.id)}`,
                type: 'button',
                role: 'menuitemradio',
                'aria-checked': checked === true,
                className: 'duo-opt',
                'data-active': flatIndex === activeIndex ? 'true' : 'false',
                onMouseEnter: () => setCursor(flatIndex),
                onClick: () => onPick(route),
              },
              h('span', { className: 'duo-optName' }, String(model.name ?? model.id)),
              h('span', { className: 'duo-optProv' }, group.name),
              h('span', { className: 'duo-optCheck' }, checked !== true ? '' : '✓'),
            ),
          );
        }
      }

      const style =
        box === undefined
          ? { visibility: 'hidden', left: -9999, top: 0, width: MENU_WIDTH }
          : { left: box.left, bottom: box.bottom, width: box.width, maxHeight: box.maxHeight };

      return h(
        'div',
        { ref: menuRef, className: 'duo-menu', role: 'menu', style },
        h(
          'div',
          { className: 'duo-menuHead' },
          h('input', {
            ref: inputRef,
            className: 'duo-input',
            type: 'text',
            value: query,
            placeholder: t('search'),
            'aria-label': t('search'),
            onChange: (event) => {
              setQuery(event.target.value);
              setCursor(0);
            },
            onKeyDown,
          }),
        ),
        h('div', { className: 'duo-menuBody' }, rows),
        h('div', { className: 'duo-note' }, t('enterHint')),
      );
    }

    // ── store 与 HTTP 通道 ────────────────────────────────────────────────────
    /** 对任意 `{subscribe,getSnapshot}` 的稳定订阅。 */
    function useStoreSnapshot(store, selector) {
      const subscribe = useCallback(
        (listener) => (store === undefined || store === null ? () => {} : store.subscribe(listener)),
        [store],
      );
      const read = useCallback(
        () => (store === undefined || store === null ? undefined : selector(store.getSnapshot())),
        [store, selector],
      );
      return useSyncExternalStore(subscribe, read, read);
    }

    /** 模型目录 → provider 分组。 */
    function useCatalogGroups(catalog) {
      const groups = useStoreSnapshot(catalog, (snapshot) => snapshot?.groups);
      return useMemo(() => {
        const out = [];
        for (const group of Array.isArray(groups) ? groups : []) {
          if (group === undefined || group === null || group.id === undefined || group.id === null) continue;
          out.push({
            id: String(group.id),
            name: group.name === undefined || group.name === null ? String(group.id) : String(group.name),
            models: Array.isArray(group.models) ? group.models : [],
          });
        }
        return out;
      }, [groups]);
    }

    /** 一个带超时的 JSON 请求；Host 忙时不会让面板永远停在"读取中"。 */
    async function request(path, options) {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 15000);
      try {
        const res = await fetch(API + path, {
          ...options,
          signal: controller.signal,
          credentials: 'same-origin',
        });
        const body = await res.json().catch(() => null);
        if (!res.ok) {
          const why = body?.error?.message ?? `HTTP ${res.status}`;
          throw new Error(why);
        }
        if (body === null) throw new Error('response is not JSON');
        return body;
      } finally {
        window.clearTimeout(timer);
      }
    }

    /**
     * 本地镜像 Host 的分工状态，形状与内核 store 一致，组件用 useSyncExternalStore 读。
     */
    function createDuoStore(sessionId) {
      let state = { status: 'loading', value: undefined, error: undefined };
      const listeners = new Set();
      const emit = () => {
        for (const listener of [...listeners]) listener();
      };
      const set = (next) => {
        state = { ...state, ...next };
        emit();
      };
      let cancelled = false;
      let inFlight;

      const store = {
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        getSnapshot() {
          return state;
        },
        async load() {
          if (inFlight !== undefined) return inFlight;
          set({ status: state.value === undefined ? 'loading' : state.status, error: undefined });
          inFlight = request(`/state?sessionId=${encodeURIComponent(sessionId ?? '')}`, { method: 'GET' })
            .then(
              (result) => {
                if (!cancelled) set({ status: 'ready', value: result, error: undefined });
                return state;
              },
              (failure) => {
                if (!cancelled) {
                  set({ status: state.value === undefined ? 'error' : 'ready', error: describeFailure(failure) });
                }
                return state;
              },
            )
            .then((result) => {
              inFlight = undefined;
              return result;
            });
          return inFlight;
        },
        /** 成功 resolve 服务端结果；失败 reject 一个说得清的错误。 */
        async save(next) {
          set({ status: 'saving', error: undefined });
          try {
            const result = await request('/save', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ ...next, sessionId }),
            });
            if (!cancelled) set({ status: 'ready', value: result, error: undefined });
            return result;
          } catch (failure) {
            if (!cancelled) set({ status: 'ready', error: describeFailure(failure) });
            throw failure;
          }
        },
        dispose() {
          cancelled = true;
          listeners.clear();
        },
      };
      return store;
    }

    // ── 组件 ──────────────────────────────────────────────────────────────────
    /** composer 下面那条双格模型分配条。 */
    function DuoRouter(props) {
      const sessionId = props.sessionId;
      const catalog = props.catalog;
      const router = props.router;
      const locale = props.locale;
      useEffect(() => {
        void router?.store?.load();
        Promise.resolve(props.directory?.load()).catch(() => {});
      }, [router?.store, props.directory]);
      const t = typeof props.t === 'function' ? props.t : makeTranslator(locale);

      const groups = useCatalogGroups(catalog);
      const plannerRoute = useStoreSnapshot(catalog, (snapshot) => snapshot?.current);
      const modelDefault = useStoreSnapshot(catalog, (snapshot) => snapshot?.default);
      const routerSnapshot = useStoreSnapshot(router?.store, (snapshot) => snapshot);

      const routerValue = routerSnapshot === undefined ? undefined : routerSnapshot.value;
      const planner = routeOf(plannerRoute) ?? routeOf(modelDefault);
      const enabled = routerValue?.enabled === true;
      const storedWorker = routerValue?.worker;
      const storedPolicy = routerValue?.policy;
      const worker = useMemo(() => {
        const direct = routeOf(storedWorker);
        if (direct !== undefined) return direct;
        for (const entry of Array.isArray(storedPolicy) ? storedPolicy : []) {
          const route = routeOf(entry);
          if (route === undefined) continue;
          if (sameRoute(route, planner)) continue;
          return route;
        }
        return undefined;
      }, [storedWorker, storedPolicy, routeKey(planner)]);

      const [openRole, setOpenRole] = useState(null);
      const [busy, setBusy] = useState(false);
      const [toast, setToast] = useState(null);
      const plannerRef = useRef(null);
      const workerRef = useRef(null);
      const toastTimer = useRef(undefined);
      const laterTimer = useRef(undefined);

      const notify = useCallback((message, isError) => {
        setToast({ message, isError: isError === true });
        if (toastTimer.current !== undefined) window.clearTimeout(toastTimer.current);
        toastTimer.current = window.setTimeout(() => {
          toastTimer.current = undefined;
          setToast(null);
        }, 3600);
      }, []);

      const notifyLater = useCallback(
        (message, isError) => {
          if (laterTimer.current !== undefined) window.clearTimeout(laterTimer.current);
          laterTimer.current = window.setTimeout(() => {
            laterTimer.current = undefined;
            notify(message, isError);
          }, 3800);
        },
        [notify],
      );

      useEffect(
        () => () => {
          if (toastTimer.current !== undefined) window.clearTimeout(toastTimer.current);
          if (laterTimer.current !== undefined) window.clearTimeout(laterTimer.current);
        },
        [],
      );

      /**
       * 思考者格就是本会话模型，选它等于切会话模型（与 composer 自带选择器同一服务）。
       * @returns 被拒时返回错误文案，否则 undefined。
       */
      const followPlanner = useCallback(
        async (route) => {
          if (sameRoute(route, planner)) return undefined;
          if (!props.directory || typeof props.directory.select !== 'function') return t('unavailable');
          try {
            const outcome = await props.directory.select({ provider: route.provider, model: route.model });
            if (outcome !== undefined && outcome !== null && outcome.ok === false) {
              return outcome.error?.message ?? String(outcome.error?.code ?? '');
            }
            return undefined;
          } catch (failure) {
            return describeFailure(failure);
          }
        },
        [props.directory, routeKey(planner), t],
      );

      const run = useCallback(
        (nextPlanner, nextWorker, nextEnabled) => {
          if (busy) return;
          if (
            nextEnabled === true &&
            (nextPlanner === undefined || nextWorker === undefined || sameRoute(nextPlanner, nextWorker))
          ) {
            notify(t('needBoth'), true);
            return;
          }
          const store = router?.store;
          if (store === undefined) {
            notify(`${t('saveFailed')}: ${t('unavailable')}`, true);
            return;
          }
          setBusy(true);
          const persist = () =>
            Promise.resolve(
              store.save({
                enabled: nextEnabled === true,
                planner: nextPlanner === undefined ? null : { provider: nextPlanner.provider, model: nextPlanner.model },
                worker: nextWorker === undefined ? null : { provider: nextWorker.provider, model: nextWorker.model },
              }),
            ).then(
              (saved) => {
                setBusy(false);
                notify(
                  t('savedHint', {
                    planner: nextPlanner === undefined ? '-' : nextPlanner.model,
                    worker: nextWorker === undefined ? '-' : nextWorker.model,
                  }),
                  false,
                );
                if (nextEnabled === true && saved?.recorded === false) notifyLater(t('sessionPending'), false);
              },
              (failure) => {
                setBusy(false);
                notify(`${t('saveFailed')}: ${describeFailure(failure)}`, true);
              },
            );
          if (nextPlanner !== undefined && nextPlanner !== null && !sameRoute(nextPlanner, planner)) {
            Promise.resolve(followPlanner(nextPlanner)).then(
              (followError) => {
                if (followError !== undefined && followError !== '') {
                  setBusy(false);
                  notify(`${t('saveFailed')}: ${followError}`, true);
                  return;
                }
                void persist();
              },
              (failure) => {
                setBusy(false);
                notify(`${t('saveFailed')}: ${describeFailure(failure)}`, true);
              },
            );
            return;
          }
          void persist();
        },
        [busy, router, notify, notifyLater, t, followPlanner, routeKey(planner)],
      );

      if (sessionId === undefined || sessionId === null) return null;

      const status = routerSnapshot === undefined ? 'loading' : routerSnapshot.status;
      const ready = status === 'ready' || status === 'saving';
      const disabled = ready !== true || busy;
      const stateHint = status === 'loading' ? t('loading') : status === 'error' ? t('unavailable') : null;

      const renderCell = (role, ref, route, isPlanner) => {
        const label = route === undefined ? t('empty') : String(route.model);
        return h(
          'button',
          {
            ref,
            type: 'button',
            className: 'duo-cell',
            'data-role': role,
            'data-empty': route === undefined ? 'true' : 'false',
            'aria-haspopup': 'menu',
            'aria-expanded': openRole === role,
            disabled,
            title: `${t(isPlanner ? 'planner' : 'worker')}：${t(isPlanner ? 'plannerHint' : 'workerHint')}`,
            onClick: () => setOpenRole((current) => (current === role ? null : role)),
          },
          h('span', { className: 'duo-tag' }, t(isPlanner ? 'planner' : 'worker')),
          h('span', { className: 'duo-name' }, label),
          route === undefined ? null : h('span', { className: 'duo-prov' }, route.provider),
          h('span', { className: 'duo-chev', 'data-open': openRole === role, 'aria-hidden': 'true' }, '▾'),
        );
      };

      const activeRoute = openRole === null ? undefined : openRole === 'planner' ? planner : worker;
      const trigger = openRole === null ? undefined : openRole === 'planner' ? plannerRef.current : workerRef.current;

      return h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'duo-root' },
          h('span', { className: 'duo-title' }, t('title')),
          renderCell('planner', plannerRef, planner, true),
          h(
            'button',
            {
              type: 'button',
              className: 'duo-iconbtn',
              title: t('swap'),
              'aria-label': t('swap'),
              disabled: disabled || planner === undefined || worker === undefined,
              onClick: () => run(worker, planner, true),
            },
            '⇄',
          ),
          renderCell('worker', workerRef, worker, false),
          h(
            'button',
            {
              type: 'button',
              className: 'duo-state',
              'data-on': enabled === true ? 'true' : 'false',
              disabled,
              title: t(enabled === true ? 'toggleOff' : 'toggleOn'),
              onClick: () => run(planner, worker, enabled !== true),
            },
            h('span', { className: 'duo-dot' }),
            t(busy ? 'busy' : enabled === true ? 'on' : 'off'),
          ),
          stateHint === null ? null : h('span', { className: 'duo-prov' }, stateHint),
        ),
        openRole === null
          ? null
          : h(ModelMenu, {
              trigger,
              groups,
              current: activeRoute,
              t,
              onPick: (route) => {
                const wasPlanner = openRole === 'planner';
                setOpenRole(null);
                if (wasPlanner) run(route, worker, enabled);
                else run(planner, route, enabled);
              },
              onClose: () => setOpenRole(null),
            }),
        toast === null
          ? null
          : h(
              'div',
              { className: 'duo-toast', role: 'status', 'data-error': toast.isError === true ? 'true' : 'false' },
              toast.message,
            ),
      );
    }

    /** 组件抛错时画一条窄提示，而不是让整条在屏幕上消失。 */
    class DuoBoundary extends Component {
      constructor(props) {
        super(props);
        this.state = { error: undefined };
      }

      static getDerivedStateFromError(error) {
        return { error };
      }

      componentDidCatch(error) {
        try {
          console.error('[dsh-duo-model] bar render failed:', error);
        } catch (ignored) {
          /* logger 也可能坏 */
        }
      }

      render() {
        const error = this.state.error;
        if (error === undefined) return this.props.children;
        const t = this.props.t;
        return h('div', { className: 'duo-crash' }, `${t('crash')}: ${describeFailure(error)}`);
      }
    }

    // ── 接线 ──────────────────────────────────────────────────────────────────
    /** Client 插件本体：样式、词典、以及 composer 下的双格条。 */
    function apply(ctx) {
      ctx.effect(() => {
        if (document.querySelector('style[data-plugin="dsh-duo-model"]') !== null) return () => {};
        const style = document.createElement('style');
        style.setAttribute('data-plugin', 'dsh-duo-model');
        style.textContent = CSS;
        document.head.appendChild(style);
        return () => style.remove();
      }, 'duo-model: styles');

      try {
        const locale = ctx.get('locale');
        if (locale !== undefined && locale !== null && typeof locale.register === 'function') {
          ctx.effect(() => locale.register(NS, { zh: ZH, en: EN }), 'duo-model: dictionaries');
        }
      } catch (error) {
        /* locale 只是锦上添花，内置词典已经够用 */
      }

      ctx.inject(['slots', 'modelDirectories', 'sessions', 'locale'], (scope) => {
        const stores = new Map();
        scope.effect(() => () => { for (const store of stores.values()) store.dispose(); stores.clear(); });
        const locale = scope.get('locale');
        const models = scope.get('modelDirectories');
        const sessions = scope.get('sessions');

        /** 思考者格 = 本会话模型；子代理会话没有自己的选择器。 */
        const directoryOf = (sessionId) => {
          if (sessionId === undefined || sessionId === null) return undefined;
          if (sessions !== undefined && sessions !== null && typeof sessions.subagentAddress === 'function') {
            try {
              if (sessions.subagentAddress(sessionId) !== undefined) return undefined;
            } catch (error) {
              /* 当作普通会话 */
            }
          }
          if (models === undefined || models === null || typeof models.directoryFor !== 'function') return undefined;
          try {
            return models.directoryFor(sessionId);
          } catch (error) {
            return undefined;
          }
        };

        scope.slots.inject(SLOT, () =>
          scope.slots.register(
            {
              name: SLOT,
              id: SLOT_ID,
              order: 30,
              locale: NS,
              inject: (sessionId) => {
                const directory = directoryOf(sessionId);
                if (!stores.has(sessionId)) stores.set(sessionId, createDuoStore(sessionId));
                return {
                  directory,
                  catalog: directory === undefined ? undefined : directory.store,
                  router: { store: stores.get(sessionId) },
                  locale,
                };
              },
            },
            (props) => {
              const t = makeTranslator(props.locale);
              return h(DuoBoundary, { t }, h(DuoRouter, { ...props, t }));
            },
          ),
        );
      });
    }

    return { inject: ['slots'], apply, name: PLUGIN };
  },
});
