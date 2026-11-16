// ============================================================================
// dsh-duo-model — Host 半边
// ----------------------------------------------------------------------------
// 双模型分工的"真正生效"部分：
//   1) 注册 `duo` Remote 服务(TypertRemoteService)，浏览器里的两个格子通过
//      connection.rpc.call('/api','duo/save'|'duo/get') 直接读写分工设置；
//   2) 用 @deepseek-ai/dsh-tool-subagent 的同一套公开辅助函数装一个
//      `subagent` 工具(modelSelectionSettings 语义)：思考者(本会话模型)委派
//      工作者(用户选的便宜模型)时，参数里会带上 provider/model；
//   3) 把结果写进会话投影 `subagentModelSelectionPolicy`，与内核
//      tool-subagent 的投影 key/事件完全一致（同 key 同 schema，语义兼容）。
// ============================================================================

import { z } from 'zod';
import { Service } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createDuoRoute, ROUTE_PREFIX } from './route.js';
import {
  parentAgentOptionsForDelegation,
  delegationDepthOf,
  assertSubagentMaxDepth,
} from '@deepseek-ai/dsh-subagent';
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm';

export const name = 'dsh-duo-model';

/** 服务键 / Remote namespace。 */
const SERVICE_KEY = 'duo';

/** 与内核 tool-subagent 完全一致的投影 key 与事件名。 */
const POLICY_KEY = 'subagentModelSelectionPolicy';
const POLICY_EVENT = 'subagent/model-selection-policy';

const RouteSchema = z
  .object({ provider: z.string().min(1), model: z.string().min(1) })
  .strict();

/** 会话投影：思考者/工作者白名单。schema 与内核定义逐字对齐。 */
export const duoPolicyProjection = {
  key: POLICY_KEY,
  stateVersion: 1,
  stateSchema: z.array(RouteSchema).min(1).nullable(),
  init: () => null,
  apply: (policy, event) => {
    if (policy !== null || event.type !== POLICY_EVENT) return policy;
    const allowedModels = event.data?.allowedModels ?? event.payload?.allowedModels;
    if (!Array.isArray(allowedModels) || allowedModels.length === 0) return null;
    const next = [];
    const seen = new Set();
    for (const candidate of allowedModels) {
      const provider = candidate?.provider;
      const model = candidate?.model;
      if (typeof provider !== 'string' || provider.length === 0) continue;
      if (typeof model !== 'string' || model.length === 0) continue;
      const key = `${provider}\u0000${model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      next.push({ provider, model });
    }
    return next.length === 0 ? null : next;
  },
};

/** 读会话投影里的白名单。 */
const readPolicy = (projections, session) => {
  try {
    const state = projections.stateOf(session, POLICY_KEY);
    if (!Array.isArray(state) || state.length === 0) return null;
    return state.map((route) => ({ provider: route.provider, model: route.model }));
  } catch (error) {
    return null;
  }
};

/** 把白名单落到会话（一次性：投影落地后不再重写）。 */
const recordPolicy = (projections, session, routes) => {
  if (session === undefined || session === null) return false;
  const current = readPolicy(projections, session);
  if (Array.isArray(current)) return true;
  try {
    session.append(POLICY_EVENT, {
      allowedModels: routes.map((route) => ({ provider: route.provider, model: route.model })),
    });
    return true;
  } catch (error) {
    return false;
  }
};

/** 归一化一条前端传来的路由。 */
const normalizeRoute = (value) => {
  if (value === undefined || value === null || typeof value !== 'object') return undefined;
  const provider = typeof value.provider === 'string' ? value.provider.trim() : '';
  const model = typeof value.model === 'string' ? value.model.trim() : '';
  const effort = typeof value.reasoningEffort === 'string' ? value.reasoningEffort.trim() : '';
  if (provider.length === 0 || model.length === 0) return undefined;
  const route = { provider, model };
  if (effort.length > 0) route.reasoningEffort = effort;
  return route;
};

const routeKeyOf = (route) => (route === undefined ? '' : `${route.provider}\u0000${route.model}`);

/**
 * 双模型分工服务：保存/读取设置，并把白名单写到当前会话。
 * 通过 `ctx.provide('duo', …)` 暴露给路由层与委派工具。
 */
class DuoService extends Service {
  #contexts = new WeakMap();
  #global = { enabled: false, planner: undefined, worker: undefined };

  constructor(ctx) {
    super(ctx, SERVICE_KEY);
  }

  /** 之后新开的会话默认套用的分工（Host 内存态）。 */
  defaults() {
    return {
      enabled: this.#global.enabled,
      planner: this.#global.planner === undefined ? null : { ...this.#global.planner },
      worker: this.#global.worker === undefined ? null : { ...this.#global.worker },
    };
  }

  #fingerprint(ctx) {
    if (ctx === undefined || ctx === null) return undefined;
    try {
      return ctx.get('id') ?? ctx.id ?? String(Object.prototype.toString.call(ctx));
    } catch (error) {
      return undefined;
    }
  }

  #stateFor(agent) {
    const ctx = agent?.ctx ?? agent;
    const key = this.#fingerprint(ctx);
    if (key === undefined) return { enabled: false, planner: undefined, worker: undefined };
    const cached = this.#contexts.get(ctx);
    if (cached !== undefined) return cached;
    const fresh = { enabled: false, planner: undefined, worker: undefined };
    this.#contexts.set(ctx, fresh);
    return fresh;
  }

  /**
   * 委派工具调用前解析工作者的准确路由。
   * @param agent - 发起委派的 Agent。
   * @param session - 该 Agent 的会话。
   * @returns 工作者路由，或 undefined（不分派）。
   */
  routeFor(agent, session) {
    const state = this.#stateFor(agent);
    const persisted = readPolicy(this.#sessionProjections(), session);
    const enabled = state.enabled === true || Array.isArray(persisted);
    if (!enabled) return undefined;
    if (state.worker !== undefined) return { ...state.worker };
    if (Array.isArray(persisted)) {
      const parentOptions = safeParentOptions(agent);
      const plannerKey = routeKeyOf(parentOptions);
      const other = persisted.find((route) => routeKeyOf(route) !== plannerKey) ?? persisted[0];
      return other === undefined ? undefined : { ...other };
    }
    return this.#global.worker === undefined ? undefined : { ...this.#global.worker };
  }

  /** 会话已存在的白名单（给系统提示词用）。 */
  policyFor(session) {
    return readPolicy(this.#sessionProjections(), session);
  }

  #sessionProjections() {
    return this.ctx.get('sessionProjections');
  }

  /**
   * 读取当前分工：默认值 + 本会话已落地的白名单。
   * @param request - `{ sessionId? }`
   */
  async get(request) {
    const sessionId = typeof request?.sessionId === 'string' ? request.sessionId : undefined;
    const sessions = this.ctx.get('sessions');
    const session = sessionId === undefined ? undefined : sessions?.get(sessionId);
    const persisted = readPolicy(this.#sessionProjections(), session);
    let planner = this.#global.planner === undefined ? undefined : { ...this.#global.planner };
    let worker = this.#global.worker === undefined ? undefined : { ...this.#global.worker };
    if (Array.isArray(persisted)) {
      const plannerKey = routeKeyOf(planner);
      const other = persisted.find((route) => routeKeyOf(route) !== plannerKey) ?? persisted[1];
      if (planner === undefined && plannerKey === '') planner = { ...persisted[0] };
      if (other !== undefined) worker = { ...other };
    }
    return {
      ok: true,
      enabled: this.#global.enabled === true || Array.isArray(persisted),
      planner: planner ?? null,
      worker: worker ?? null,
      policy: persisted === null ? null : persisted.map((route) => ({ ...route })),
      sessionPolicy: Array.isArray(persisted),
      routeCount: Array.isArray(persisted) ? persisted.length : this.#global.enabled ? 2 : 0,
    };
  }

  /**
   * 保存分工：更新默认值，并把白名单写进当前会话投影。
   * @param request - `{ sessionId?, enabled?, planner?, worker? }`
   */
  async save(request) {
    const planner = normalizeRoute(request?.planner);
    const worker = normalizeRoute(request?.worker);
    const enabled = request?.enabled !== false;
    if (enabled && (planner === undefined || worker === undefined)) {
      throw new Error('duo: enabled requires both a thinker route and a worker route');
    }
    if (enabled && routeKeyOf(planner) === routeKeyOf(worker)) {
      throw new Error('duo: the thinker and the worker must be different models');
    }
    this.#global = {
      enabled,
      planner: planner === undefined ? this.#global.planner : planner,
      worker: worker === undefined ? this.#global.worker : worker,
    };

    const routes = [];
    const seen = new Set();
    for (const route of [this.#global.planner, this.#global.worker]) {
      if (route === undefined) continue;
      const key = routeKeyOf(route);
      if (seen.has(key)) continue;
      seen.add(key);
      routes.push({ ...route });
    }

    const sessionId = typeof request?.sessionId === 'string' ? request.sessionId : undefined;
    const sessions = this.ctx.get('sessions');
    const session = sessionId === undefined ? undefined : sessions?.get(sessionId);
    let recorded = false;
    if (enabled && routes.length >= 2) recorded = recordPolicy(this.#sessionProjections(), session, routes);

    return {
      ok: true,
      enabled,
      planner: this.#global.planner === undefined ? null : { ...this.#global.planner },
      worker: this.#global.worker === undefined ? null : { ...this.#global.worker },
      recorded,
      sessionPolicy: Array.isArray(readPolicy(this.#sessionProjections(), session)),
    };
  }

  /** 清空分工（客户端"关闭分工"）。 */
  async reset() {
    this.#global = { enabled: false, planner: this.#global.planner, worker: this.#global.worker };
    return { ok: true, enabled: false };
  }
}

/** 父 Agent 当前路由，读不到就给空对象。 */
function safeParentOptions(agent) {
  try {
    return parentAgentOptionsForDelegation(agent) ?? {};
  } catch (error) {
    return {};
  }
}

const ROUTE_PARAMS = {
  provider: {
    type: 'string',
    description: 'Child LLM provider id, exactly as advertised by list_subagent_models.',
  },
  model: {
    type: 'string',
    description: 'Child LLM model id for that provider.',
  },
  reasoning_effort: {
    type: 'string',
    description: 'Optional reasoning effort id for the child route.',
  },
};

/**
 * 装一个自带双模型分工的委派工具。
 * @param ctx - Host 插件上下文。
 * @param duo - 分工服务。
 * @param config - `{ provider, toolName, maxDepth }`
 */
function installDelegation(ctx, duo, config) {
  const providerName = config.provider;
  const toolName = config.toolName;
  const maxDepth = config.maxDepth;

  let disposeTool;
  const install = (runtimeCtx) => {
    const definition = defineTool({
      name: toolName,
      description:
        'Delegate a self-contained task to a subagent (a separate agent that works in its own context) so it does not consume this conversation\'s context. ' +
        'This tool routes the child to the Worker model that the user assigned in the two-seat model bar: when a division of labor is active, `provider`/`model` default to the Worker route, so omit them. ' +
        'The subagent returns its result, not its intermediate steps. This tool starts an independently managed subagent and immediately returns its id; the runtime notifies you when it finishes.',
      parameters: {
        cwd: {
          type: 'string',
          description: 'Initial child working directory. Relative paths use your current directory; omitted inherits it.',
        },
        description: {
          type: 'string',
          required: true,
          description: 'A short (3-5 word) description of the delegated task, for display.',
        },
        prompt: {
          type: 'string',
          required: true,
          description: 'The complete, self-contained task for the subagent. It does not share this conversation\'s context, so include everything it needs.',
        },
        ...ROUTE_PARAMS,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            subagentId: { type: 'string', required: true },
          },
          additionalProperties: false,
        },
        render: (_args, value) => [{ type: 'text', text: `started subagent ${value.subagentId}` }],
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const parent = exec.agent;
        if (!parent) throw new Error('subagent tool requires a calling agent (exec.agent was undefined)');
        if (!exec.signal.aborted) {
          if (maxDepth !== 'provider-managed') assertSubagentMaxDepth(maxDepth);
        }
        const parentOptions = safeParentOptions(parent);
        const worker = duo.routeFor(parent, exec.parentSession ?? parent.session);
        const plannerKey = routeKeyOf(parentOptions);
        const requestedProvider = args.provider;
        const requestedModel = args.model;
        const requestedEffort = args.reasoning_effort;

        let provider = requestedProvider;
        let model = requestedModel;
        let reasoningEffort = requestedEffort;
        if ((provider === undefined) !== (model === undefined)) {
          throw new Error('child LLM `provider` and `model` must be supplied together');
        }
        if (provider === undefined && worker !== undefined) {
          provider = worker.provider;
          model = worker.model;
          reasoningEffort = reasoningEffort ?? worker.reasoningEffort;
        }
        if (provider !== undefined && routeKeyOf({ provider, model }) === plannerKey) {
          throw new Error(
            `duo: "${provider}/${model}" is the thinker model of this session — delegate to the worker model instead (or let this tool pick it)`,
          );
        }

        const agentOptions = {};
        if (provider !== undefined) {
          agentOptions.provider = provider;
          agentOptions.model = model;
        }
        if (reasoningEffort !== undefined) agentOptions.reasoningEffort = ReasoningEffortId(reasoningEffort);

        const llm = runtimeCtx.get('llm');
        if (provider !== undefined && llm !== undefined) {
          await llm.resolveCallConfig(
            {
              provider,
              model,
              ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
            },
            exec.signal,
          );
        }
        exec.signal.throwIfAborted();

        const depthCap = runtimeCtx.subagents.resolveMaxDepth(maxDepth);
        const limit = depthCap === undefined ? maxDepth : Math.min(depthCap, maxDepth);
        void delegationDepthOf;
        const request = {
          ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
          prompt: [{ type: 'text', text: args.prompt }],
          parent,
          ...(Object.keys(agentOptions).length === 0 ? {} : { agentOptions }),
          ...(typeof limit === 'number' ? { maxDepth: limit } : {}),
        };
        const started = await runtimeCtx.subagents.startActivation({
          provider: providerName,
          label: args.description,
          request,
          signal: exec.signal,
          delivery: 'parent',
        });
        return { kind: 'activation', subagentId: started.childId };
      },
    });
    const unregister = runtimeCtx.tools.register(definition);
    return () => unregister();
  };

  const runtime = ctx.get('subagents');
  const mount = (subagentProvider) => {
    if (subagentProvider.name !== providerName) return;
    const capabilities = subagentProvider.capabilities ?? {};
    if (!capabilities.agentOptions) return;
    disposeTool?.();
    disposeTool = install(ctx);
    ctx.logger.info(`dsh-duo-model: "${toolName}" mounted over subagent provider "${providerName}"`);
  };

  if (runtime !== undefined && runtime.getProvider(providerName) !== undefined) {
    mount(runtime.getProvider(providerName));
  }
  ctx.on('subagent/provider-added', mount);
  ctx.on('subagent/provider-removed', (removed) => {
    if (removed !== providerName) return;
    disposeTool?.();
    disposeTool = undefined;
  });

  ctx.systemPrompt?.context?.({
    name: 'duo:model-seats',
    order: 30,
    text: (context) => {
      const session = context?.session;
      const agent = context?.agent;
      if (session === undefined || agent === undefined) return '';
      const worker = duo.routeFor(agent, session);
      if (worker === undefined) return '';
      const planner = routeKeyOf(safeParentOptions(agent));
      const plannerText = planner === '' ? 'this session model' : planner.replace('\u0000', '/');
      return (
        `Two-model division of labor is active: \`${plannerText}\` (thinker) plans and reviews; ` +
        `\`${worker.provider}/${worker.model}\` (worker) does the hands-on work. ` +
        `Use \`${toolName}\` for implementation, file edits, searches, and any long mechanical work so the thinker stays cheap and focused; ` +
        `keep planning and the final answer here.`
      );
    },
  });
}

export const Config = z
  .object({
    provider: z.string().default('in-process'),
    toolName: z.string().default('subagent'),
    maxDepth: z.union([z.number().int().min(1), z.literal('provider-managed')]).default(10),
    route: z.string().default(ROUTE_PREFIX),
  })
  .default({});

export const inject = ['tools', 'subagents', 'systemPrompt', 'sessionProjections', 'sessions'];

/**
 * 插件入口。
 * @param ctx - Host 上下文。
 * @param config - 插件配置。
 */
export function apply(ctx, config) {
  const resolved = {
    provider: config?.provider ?? 'in-process',
    toolName: config?.toolName ?? 'subagent',
    maxDepth: config?.maxDepth ?? 10,
  };
  const duo = new DuoService(ctx);
  // 内核 tool-subagent 在同 key 上已经注册过同名投影；重复注册会抛错，
  // 因此自己的投影只在没有他人注册时补位（白名单事件由我们 append）。
  try {
    const dispose = ctx.effect(() => {
      let registered;
      try {
        registered = ctx.sessionProjections.register(duoPolicyProjection);
      } catch (error) {
        return () => {};
      }
      return () => registered?.();
    }, 'dsh-duo-model: policy projection');
    void dispose;
  } catch (error) {
    // projection registry unavailable: the delegation tool still works without it
  }
  installDelegation(ctx, duo, resolved);
  installRoute(ctx, duo, resolved);
}

/**
 * 把分工设置挂到稳定的 HTTP 前缀上。
 *
 * `webServer` **刻意不写进 `inject`**：它是可选能力，写进去会让没有它的部署连插件
 * 都起不来，委派工具也跟着一起消失。改为 `ctx.inject` 按需拿，并且必须在这个回调里
 * 注册——它可能比本插件晚挂载，apply 时读一次会永远拿到 undefined。
 */
function installRoute(ctx, duo, config) {
  const prefix = typeof config.route === 'string' && config.route.length > 1 ? config.route : ROUTE_PREFIX;
  const readConnection = (scoped) => {
    try {
      return scoped.get('connection');
    } catch (error) {
      return undefined;
    }
  };
  try {
    if (typeof ctx.inject !== 'function') {
      ctx.logger.info('dsh-duo-model: host has no ctx.inject, skipping the model-bar routes');
      return;
    }
    const handle = createDuoRoute({ logger: ctx.logger, service: duo });
    ctx.inject(['webServer'], (scoped) => {
      scoped.effect(
        () =>
          scoped.webServer.register({
            kind: 'prefix',
            path: prefix,
            handler: (req, res) => handle(req, res, readConnection(scoped)),
          }),
        'dsh-duo-model: model-bar routes',
      );
    });
  } catch (error) {
    ctx.logger.warn(`dsh-duo-model: model-bar routes were not installed: ${error?.message ?? error}`);
  }
}
