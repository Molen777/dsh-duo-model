/**
 * Host 侧的 JSON 路由：把两条 preact 无关的纯函数接口挂到 `/api/duo-model/` 上。
 *
 * | 方法 | 路径 | 作用 |
 * |---|---|---|
 * | GET  | `/state?sessionId=…` | 读当前分工（enabled / planner / worker / 会话白名单） |
 * | POST | `/save`              | 写分工；enabled=true 时两条路由都必需且必须不同 |
 *
 * 为什么不用 typert Remote：`remote.<ns>` 的 mount 依赖 `@deepseek-ai/dsh-api-gateway`
 * 的客户端半边，而本插件只靠 `window.__ModuleLoader__` 里的 `react` 跑；走 webServer
 * 前缀路由只需要 Host 侧的 `webServer.register({kind:'prefix'})`，前端一次 `fetch`
 * 就够，链路短得多，出错也看得见（HTTP 状态码 + JSON body）。
 *
 * 信任栅栏不能省：`/api/duo-model` 比内核的 `/api` 长，按最长前缀优先，这些请求
 * **不会**经过内核的准入检查。所以每次都先问 `connection` 要判定，拿不到就用一份
 * 结构等价的复刻（loopback + 同源 + 非 cross-site）。
 *
 * @module dsh-duo-model/route
 */

/** 与 client.js 里的 `API` 常量必须一致。 */
export const ROUTE_PREFIX = '/api/duo-model';

/** 面板提交的 JSON 很小；给足富余仍设上限。 */
const BODY_LIMIT = 16 << 10;

/** 同机调用方可能合法使用的地址。IPv6 的 `URL.hostname` 带方括号。 */
const LOOPBACK_NAMES = new Set(['127.0.0.1', '[::1]', '::1', 'localhost']);

function authority(value, fallbackScheme) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  let url;
  try {
    url = new URL(value.includes('://') ? value.trim() : `${fallbackScheme ?? 'http'}://${value.trim()}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const port = url.port === '' ? (url.protocol === 'https:' ? '443' : '80') : url.port;
  return { scheme: url.protocol.replace(':', ''), hostname: url.hostname.toLowerCase(), port };
}

function isDesktopRelay(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'dsh-app:' &&
      url.hostname === 'app' &&
      url.port === '' &&
      url.username === '' &&
      url.password === ''
    );
  } catch {
    return false;
  }
}

/** 复刻内核的 `isTrustedApiRequest`：返回 `undefined` 表示放行。 */
function structuralReason(req) {
  const headers = req?.headers ?? {};
  const host = authority(headers.host, 'http');
  if (host === null || !LOOPBACK_NAMES.has(host.hostname)) return 'host-not-loopback';
  if (String(headers['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') return 'cross-site';

  for (const header of ['origin', 'referer']) {
    const raw = headers[header];
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    if (header === 'referer' && isDesktopRelay(raw)) {
      if (headers.origin !== undefined || headers['sec-fetch-site'] !== undefined) return 'desktop-relay-markers';
      continue;
    }
    const origin = authority(raw.trim());
    if (origin === null) return `${header}-invalid`;
    if (origin.scheme !== host.scheme || origin.hostname !== host.hostname || origin.port !== host.port) {
      return `${header}-mismatch`;
    }
  }
  return undefined;
}

/**
 * 浏览器侧的 Host / Origin 栅栏。
 *
 * 内核的 `isTrustedApiRequest` 与这里判的**同一件事**：Host 必须是我们自己的
 * （loopback 或监听地址），`sec-fetch-site: cross-site` 拒，附带的 `origin`
 * 必须与 Host 同权威。逐条对齐它是为了不给自己开一个新洞 —— 这个端点能改
 * "哪个模型干活"，它不该比 `/api` 松。
 */
function structuralOnly(req) {
  const headers = req?.headers ?? {};
  const host = authority(headers.host, 'http');
  if (host === null) return false;
  if (!LOOPBACK_NAMES.has(host.hostname)) return false;
  if (String(headers['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') return false;
  for (const header of ['origin', 'referer']) {
    const raw = headers[header];
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    if (header === 'referer' && isDesktopRelay(raw)) continue;
    const other = authority(raw.trim());
    if (other === null) return false;
    if (other.scheme !== host.scheme || other.hostname !== host.hostname || other.port !== host.port) return false;
  }
  return true;
}

/**
 * 内核 `admit()` 的错误码映射。
 *
 * 它把两件事压成一个状态码：`403` 是 Host/Origin 栅栏没过，`401` 是**栅栏过了但
 * 没有浏览器 Cookie**。对 `/api` 那是对的（每个 RPC 都要身份），但这个插件没有
 * 自己的 Peer 语义 —— 面板要的只是"本机页面能读写这两个格子的分配"。所以：
 *
 * - `403` 照旧拒。真跨站的页面冒用会停在这里。
 * - `401` 退到 `structuralOnly`：同 loopback、同源、非 cross-site 就放行。
 *   浏览器打开 Web GUI 时已经带着 launch token 换过 Cookie，能走到这一步的请求
 *   本来就已经是本机用户；而 `fetch` 在缺 Cookie 时给的是这条 401，不是 403。
 *
 * 不这么做，面板的第一次 `GET /state` 就会 401，条子永远停在"读取中"。
 */
export function rejectionFor(req, connection) {
  const admit = connection?.admit;
  if (typeof admit === 'function') {
    try {
      const admission = admit.call(connection, req);
      const status = admission && typeof admission === 'object' ? admission.rejection : undefined;
      if (status === undefined) return undefined;
      if (status === 403) return 403;
      return status;
    } catch {
      return 503;
    }
  }

  const reject = connection?.requestRejection;
  if (typeof reject === 'function') {
    try {
      const status = reject.call(connection, req);
      if (status === undefined) return undefined;
      if (status === 403) return 403;
      return status;
    } catch {
      return 503;
    }
  }

  return 503;
}

/**
 * 造一个 `handle(req, res, connection)`。
 *
 * `service` 就是 Host 里的 `DuoService`，只需要 `get(request)` 与 `save(request)`
 * 两个方法 —— 这样路由层完全不关心它是不是 cordis Service。
 */
export function createDuoRoute({ logger, service }) {
  function log(line) {
    try {
      logger?.info?.(line);
    } catch {
      /* 记日志失败不该影响接口 */
    }
  }

  function send(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(body);
  }

  async function readJson(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > BODY_LIMIT) throw new Error('request body too large');
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8').trim();
    if (text === '') return {};
    return JSON.parse(text);
  }

  function fail(res, status, message) {
    send(res, status, { ok: false, error: { code: 'duo/failed', message } });
  }

  return async function handle(req, res, connection) {
    const rejection = rejectionFor(req, connection);
    if (rejection !== undefined) {
      fail(res, rejection, 'request not trusted');
      return;
    }
    if (service === undefined) {
      fail(res, 503, 'duo service is not mounted');
      return;
    }

    let pathname;
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      fail(res, 400, 'unparsable request url');
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = pathname.startsWith(ROUTE_PREFIX) ? pathname.slice(ROUTE_PREFIX.length) : pathname;
    const method = String(req.method ?? 'GET').toUpperCase();

    try {
      if (route === '/state') {
        if (method !== 'GET' && method !== 'HEAD') {
          fail(res, 405, 'only GET');
          return;
        }
        const sessionId = url.searchParams.get('sessionId');
        const state = await service.get({ sessionId: sessionId === null ? undefined : sessionId });
        send(res, 200, state);
        return;
      }

      if (route === '/save') {
        if (method !== 'POST') {
          fail(res, 405, 'only POST');
          return;
        }
        let body;
        try {
          body = await readJson(req);
        } catch (error) {
          fail(res, 400, `bad request body: ${error?.message ?? error}`);
          return;
        }
        const request = body !== null && typeof body === 'object' ? body : {};
        const state = await service.save({
          sessionId: request.sessionId === undefined || request.sessionId === null ? undefined : String(request.sessionId),
          enabled: request.enabled === undefined ? undefined : request.enabled === true,
          planner: request.planner ?? undefined,
          worker: request.worker ?? undefined,
        });
        send(res, 200, state);
        return;
      }

      fail(res, 404, `unknown route ${route}`);
    } catch (error) {
      const message = error?.message ?? String(error);
      log(`duo route failed on ${route}: ${message}`);
      fail(res, 400, message);
    }
  };
}
