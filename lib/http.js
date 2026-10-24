import axios from "axios";

// 使用空默认配置构建 URL，避免重新合并客户端或全局的可变默认值。
const uriBuilder = new axios.Axios({});

function isCanceled(error) {
  return axios.isCancel(error) || error?.name === "AbortError";
}

function throwIfCanceled(config) {
  config.cancelToken?.throwIfRequested();
  if (config.signal?.aborted) {
    throw new axios.CanceledError("请求已取消。", config);
  }
}

/** 请求前钩子可以修改 config；保持旧接口，不使用钩子的返回值替换配置。 */
async function beforeRequest(config) {
  throwIfCanceled(config);
  try {
    await config.$on_before_request?.(config);
  } catch (cause) {
    if (isCanceled(cause)) throw cause;

    // 保留原始异常，同时让调用者能区分“准备失败”和“服务器请求失败”。
    const error = new axios.AxiosError(
      "请求前置处理失败，未发送本次请求。",
      "ERR_BEFORE_REQUEST",
      config,
    );
    error.cause = cause;
    throw error;
  }
  throwIfCanceled(config);
  return config;
}

/** 通知类回调不改变请求结果；自身失败不能掩盖响应或原始请求异常。 */
async function notify(config, name, ...args) {
  try {
    const callback = config?.[name];
    if (typeof callback === "function") await callback(...args);
  } catch {
    // 不打印整个异常，避免把请求中的认证信息写入控制台。
    console.error(`[http] ${name} 回调执行失败，请求结果保持不变。`);
  }
}

function errorKind(error) {
  if (isCanceled(error)) return "cancel";
  if (error?.code === "ERR_BEFORE_REQUEST") return "request";
  if (error?.response) return "http";
  if (["ECONNABORTED", "ETIMEDOUT"].includes(error?.code)) return "timeout";
  if (error?.request || error?.code === "ERR_NETWORK") return "network";
  return "request";
}

/**
 * 创建独立客户端；不修改 axios.defaults，不与其他客户端共享可变配置。
 * 普通请求返回完整 AxiosResponse；失败保留 Axios 异常及其 config/response。
 * 支持 $状态码、$cancel、$timeout、$error_network、$error_request 回调。
 * $error(error, kind) 接收全部失败，$finally(responseOrError) 接收本次结果。
 */
export function createHttpClient(initialConfig = {}) {
  const instance = axios.create({ timeout: 5000, ...initialConfig });
  instance.interceptors.request.use(beforeRequest);

  /**
   * 兼容 request(url, options) 和 request(config)。
   * 不自动重试，避免 POST、发邮件、工具调用等操作被重复执行。
   */
  async function request(urlOrConfig, options) {
    const input = typeof urlOrConfig === "string"
      ? { ...options, url: urlOrConfig }
      : urlOrConfig ?? {};

    // 保存本次调用的配置；即使异常没有 config，仍能运行错误和 finally 回调。
    let config = instance.defaults;
    let outcome;
    try {
      config = axios.mergeConfig(instance.defaults, input);
      outcome = await instance.request(config);
      config = outcome.config;
      return outcome;
    } catch (error) {
      outcome = error;
      config = error?.config ?? config;
      const kind = errorKind(error);
      const handler = kind === "http"
        ? `$${error.response.status}`
        : {
            cancel: "$cancel",
            timeout: "$timeout",
            network: "$error_network",
            request: "$error_request",
          }[kind];

      await notify(config, handler, error);
      await notify(config, "$error", error, kind);
      throw error;
    } finally {
      // 成功时传入 response，失败时传入 error；每次请求只调用一次。
      await notify(config, "$finally", outcome);
    }
  }

  /** 合并配置并执行前置钩子，供其他传输复用；不发送请求或运行响应通知。 */
  async function prepareRequest(urlOrConfig, options) {
    const input = typeof urlOrConfig === "string"
      ? { ...options, url: urlOrConfig }
      : urlOrConfig ?? {};
    const config = axios.mergeConfig(instance.defaults, input);
    config.method = (config.method || instance.defaults.method || "get").toLowerCase();
    const source = config.headers ?? {};
    const headers = axios.AxiosHeaders.concat(source.common, source[config.method]);
    const groups = new Set(["common", "get", "post", "put", "patch", "delete", "head", "options"]);
    for (const [name, value] of Object.entries(source)) {
      if (!groups.has(name.toLowerCase())) headers.set(name, value);
    }
    config.headers = headers;
    await beforeRequest(config);

    return {
      ...config,
      url: uriBuilder.getUri(config),
      headers: axios.AxiosHeaders.from(config.headers).toJSON(true),
      baseURL: undefined,
      params: undefined,
    };
  }

  const client = {
    /**
     * 配置回调必须同步；修改直接作用于当前实例，从下一次请求开始生效。
     * 已经开始的请求使用自己的配置快照，不被后续 defaults 修改影响。
     */
    defaults(configure) {
      if (configure !== undefined) {
        if (typeof configure !== "function") {
          throw new TypeError("defaults 参数必须是配置函数。");
        }
        configure(instance.defaults);
      }
      return client;
    },

    /** 继承当前默认配置的快照，创建配置相互隔离的客户端。 */
    create(config = {}) {
      return createHttpClient(axios.mergeConfig(instance.defaults, config));
    },

    request,
    prepareRequest,
    _request: request,
    isCancel: isCanceled,

    get(url, options) {
      return request(url, { ...options, method: "get" });
    },
    delete(url, options) {
      return request(url, { ...options, method: "delete" });
    },
    head(url, options) {
      return request(url, { ...options, method: "head" });
    },
    options(url, options) {
      return request(url, { ...options, method: "options" });
    },
    // 保持旧接口：post(url, { data, headers, ... })，不是 Axios 的三参数形式。
    post(url, options) {
      return request(url, { ...options, method: "post" });
    },
    put(url, options) {
      return request(url, { ...options, method: "put" });
    },
    patch(url, options) {
      return request(url, { ...options, method: "patch" });
    },
  };

  return client;
}

export default createHttpClient();
