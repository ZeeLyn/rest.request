# @zeelyn/http

轻量 Axios HTTP 封装，支持异步请求前钩子、独立客户端和统一错误通知。使用 ESM，返回完整 AxiosResponse。

## 安装与请求

```sh
npm install @zeelyn/http
```

```js
import http, { createHttpClient } from "@zeelyn/http";

http.defaults(config => {
  config.baseURL = "https://api.example.com";
  config.timeout = 15000;
  config.$on_before_request = async request => {
    // 在这里等待宿主提供的异步认证逻辑，然后修改 request.headers。
  };
});

const response = await http.post("/messages", {
  data: { content: "你好" },
});
console.log(response.data);

const other = createHttpClient({ baseURL: "https://other.example.com" });
const child = http.create({ timeout: 30000 });
```

保留 get、post、put、patch、delete、head、options 和 _request。
所有快捷方法均采用 (url, options)，正文放 options.data，查询参数放 options.params。
快捷方法固定使用其名称对应的 HTTP 方法；需要动态方法时使用 request。
request 支持 (url, options) 或 ({ url, method, ...options })。

defaults(callback) 的回调必须同步，更新从下一次请求生效。
单次请求配置优先于默认配置，create(config) 继承当前默认配置快照。
客户端不修改全局 axios.defaults。默认超时为 5000 毫秒。

## 钩子与错误

| 配置项 | 参数与含义 |
| --- | --- |
| $on_before_request | config：支持 async，直接修改配置，忽略返回值 |
| $401、$403 等 | error：HTTP 失败状态码通知 |
| $cancel | error：主动取消 |
| $timeout | error：请求超时 |
| $error_network | error：网络失败 |
| $error_request | error：配置或请求前置处理失败 |
| $error | (error, kind)：全部失败，kind 为 http / cancel / timeout / network / request |
| $finally | responseOrError：每次请求结束调用一次 |

请求前钩子失败会阻止发送，错误代码为 ERR_BEFORE_REQUEST，原始异常位于 error.cause。
通知回调按“分类回调 → $error → $finally”执行并等待完成；回调抛错会记录简短消息，不覆盖请求结果。
失败请求始终拒绝，不自动重试。validateStatus 决定哪些 HTTP 状态视为成功。
单次请求可覆盖钩子，设为 null 可禁用继承的钩子。
通知回调应及时结束，否则请求 Promise 会继续等待。

```js
const controller = new AbortController();
const pending = http.get("/report", { signal: controller.signal });
controller.abort();
try {
  await pending;
} catch (error) {
  if (!http.isCancel(error)) throw error;
}
```

等待异步前置钩子期间取消，会在钩子结束后阻止发送；不会强行终止宿主的异步钩子。
Axios 的 timeout 作用于传输阶段，不包括前置钩子耗时。
上传 FormData 时不必指定 Content-Type，由 Axios/运行环境生成 multipart boundary。

## 兼容性说明

- 继续使用 post(url, { data })，不是 Axios 的三参数形式。
- 超时和取消现在分别进入 $timeout / $cancel，不再进入 $error_network。
- 不再强制 POST/PUT 为 JSON；普通对象仍由 Axios 自动序列化。
- 不再默认打印完整网络异常，按需配置错误通知。
- 不包含业务 Token 刷新、ChatEngine 或其他外部传输适配。

## 测试

使用支持全局 FormData、Blob 的现代 Node.js 执行 npm test。
测试通过本地 HTTP 服务验证请求，不依赖公网或代理凭据。

## 准备请求配置

prepareRequest 支持 (url, options) 和 (config)，可用于自定义传输、原生 Fetch
或其他 HTTP 客户端复用地址、参数和认证头，不依赖任何业务框架。

```js
const prepared = await http.prepareRequest("/files", {
  method: "POST",
  params: { category: "image" },
  data: formData,
});
// prepared.url：包含 baseURL 和查询参数的地址（无 baseURL 时可以是相对地址）
// prepared.headers：合并 common、当前方法、单次请求头后的普通对象
// prepared.data：未序列化的正文
```

此方法合并配置、等待一次 $on_before_request，并检查取消状态，不发送网络请求。
baseURL 和 params 已合入 url，返回时清空，避免外部传输重复拼接。
请求准备失败直接拒绝 Promise，不触发 $error、状态码回调或 $finally。

返回值仍是 Axios 风格配置，不是 Fetch RequestInit：data 不会变成 body，
也不会执行 transformRequest、适配器级 XSRF、Basic Auth 或传输超时。
使用其他传输时，应按其 API 显式映射正文、认证、超时及 credentials 等选项。
如果把结果再交给 http.request，会再次合并默认配置并执行前置钩子；
正常发送请直接调用 request，无需先调用 prepareRequest。
