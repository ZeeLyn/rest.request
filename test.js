import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import axios from "axios";
import http, { createHttpClient } from "./index.js";

let server;
let baseURL;
let received = 0;
before(async () => {
  server = createServer(async (req, res) => {
    received++;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (req.url === "/slow") {
      await new Promise(resolve => setTimeout(resolve, 120));
      if (res.destroyed) return;
    }
    res.writeHead(req.url === "/unauthorized" ? 401 : 200, {
      "Content-Type": "application/json",
    });
    res.end(JSON.stringify({
      url: req.url,
      method: req.method,
      headers: req.headers,
      body: Buffer.concat(chunks).toString(),
    }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseURL = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});

test("模块不修改全局 axios 默认配置", () => {
  assert.equal(axios.defaults.timeout, 0);
  assert.equal(axios.defaults.headers.post["Content-Type"], undefined);
  assert.equal(typeof http.get, "function");
});

test("等待异步钩子；保留旧 post options.data 接口和完整响应", async () => {
  const client = createHttpClient({ proxy: false, baseURL });
  const calls = [];
  client.defaults(config => {
    config.$on_before_request = async options => {
      await new Promise(resolve => setTimeout(resolve, 5));
      options.headers.set("Authorization", "Bearer example");
      calls.push("before");
    };
    config.$finally = async response => {
      calls.push(["finally", response.status]);
    };
  });
  const response = await client.post("/echo", { data: { message: "你好" } });
  assert.equal(response.status, 200);
  assert.equal(response.data.headers.authorization, "Bearer example");
  assert.deepEqual(JSON.parse(response.data.body), { message: "你好" });
  assert.deepEqual(calls, ["before", ["finally", 200]]);
});

test("首次调用之后更新 defaults 生效，子客户端相互隔离", async () => {
  const client = createHttpClient({ proxy: false, baseURL, headers: { "X-Test": "first" } });
  assert.equal((await client.get("/echo")).data.headers["x-test"], "first");
  const child = client.create({ headers: { "X-Test": "child" } });
  client.defaults(config => {
    config.headers["X-Test"] = "second";
  });
  assert.equal((await client.get("/echo")).data.headers["x-test"], "second");
  assert.equal((await child.get("/echo")).data.headers["x-test"], "child");
});

test("异步钩子失败阻止发送，cause 保留原始错误，finally 只运行一次", async () => {
  const original = new Error("test hook error");
  const count = received;
  const calls = [];
  const client = createHttpClient({
    baseURL,
    $on_before_request: async () => { throw original; },
    $error_request: error => {
      calls.push(["request", error.cause]);
    },
    $error_network: () => calls.push("network"),
    $finally: () => calls.push("finally"),
  });
  await assert.rejects(client.get("/echo"), error => {
    assert.equal(error.code, "ERR_BEFORE_REQUEST");
    assert.equal(error.cause, original);
    return true;
  });
  assert.equal(received, count);
  assert.deepEqual(calls, [["request", original], "finally"]);
});

test("401 和通用错误回调不会吞掉请求异常", async () => {
  const calls = [];
  const client = createHttpClient({
    baseURL,
    $401: async error => { calls.push(["401", error.response.status]); },
    $error: (error, kind) => { calls.push(["error", kind]); },
    $finally: () => calls.push("finally"),
  });
  await assert.rejects(client.get("/unauthorized"), error => error.response.status === 401);
  assert.deepEqual(calls, [["401", 401], ["error", "http"], "finally"]);
});

test("通知回调失败不掩盖成功响应或原始失败", async () => {
  const original = new axios.AxiosError("test network error", "ERR_NETWORK");
  const errors = [];
  const saved = console.error;
  console.error = message => errors.push(message);
  try {
    const client = createHttpClient({
      baseURL,
      $error_network: async () => { throw new Error("observer"); },
      $finally: async () => { throw new Error("finally"); },
    });
    assert.equal((await client.get("/echo")).status, 200);
    await assert.rejects(client.get("/echo", {
      adapter: async () => { throw original; },
    }), error => error === original);
    assert.equal(errors.length, 3);
  } finally {
    console.error = saved;
  }
});

test("FormData 保持 multipart，不被强制转成 JSON", async () => {
  const client = createHttpClient({ proxy: false, baseURL });
  const form = new FormData();
  form.set("file", new Blob(["file-content"]), "example.txt");
  const { data } = await client.post("/echo", { data: form });
  assert.match(data.headers["content-type"], /^multipart\/form-data; boundary=/);
  assert.match(data.body, /filename="example.txt"/);
  assert.match(data.body, /file-content/);
});

test("取消和超时分别回调；不会混成网络错误", async () => {
  const calls = [];
  const client = createHttpClient({
    baseURL,
    $cancel: () => calls.push("cancel"),
    $timeout: () => calls.push("timeout"),
    $error_network: () => calls.push("network"),
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(client.get("/echo", { signal: controller.signal }), client.isCancel);
  await assert.rejects(client.get("/slow", { timeout: 15 }), error => error.code === "ECONNABORTED");
  assert.deepEqual(calls, ["cancel", "timeout"]);
});

test("等待 Token 时取消不会继续发送", async () => {
  const controller = new AbortController();
  const count = received;
  const client = createHttpClient({
    baseURL,
    $on_before_request: async () => {
      controller.abort();
      await Promise.resolve();
    },
  });
  await assert.rejects(client.get("/echo", { signal: controller.signal }), client.isCancel);
  assert.equal(received, count);
});

test("请求发送后可以通过 AbortController 取消", async () => {
  const controller = new AbortController();
  const client = createHttpClient({ proxy: false, baseURL });
  const pending = client.get("/slow", { signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 10);
  try {
    await assert.rejects(pending, client.isCancel);
  } finally {
    clearTimeout(timer);
  }
});

test("请求方法解构后仍可用；每次调用的配置可覆盖默认配置", async () => {
  const { get, _request } = createHttpClient({ proxy: false, baseURL });
  assert.equal((await get("/echo")).data.method, "GET");
  assert.equal((await _request({ url: "/echo", method: "patch", data: "text" })).data.method, "PATCH");
});
test("prepareRequest 合并 URL/参数/头，钩子一次，不发送、不调用 finally", async () => {
  const count = received;
  let hooks = 0;
  let notifications = 0;
  const client = createHttpClient({
    baseURL: `${baseURL}/api`,
    headers: { common: { "X-Common": "common" }, post: { "X-Method": "post" } },
    $on_before_request: async config => {
      hooks++;
      await Promise.resolve();
      config.headers.set("Authorization", "Bearer example");
    },
    $finally: () => notifications++,
  });
  const prepared = await client.prepareRequest({
    method: "POST", url: "/agent", params: { q: "你好" }, data: { messages: [] },
  });
  assert.equal(new URL(prepared.url).pathname, "/api/agent");
  assert.equal(new URL(prepared.url).searchParams.get("q"), "你好");
  assert.equal(prepared.headers.Authorization, "Bearer example");
  assert.equal(prepared.headers["X-Common"], "common");
  assert.equal(prepared.headers["X-Method"], "post");
  assert.deepEqual(prepared.data, { messages: [] });
  assert.equal(prepared.params, undefined);
  assert.equal(hooks, 1);
  assert.equal(notifications, 0);
  assert.equal(received, count);
});

test("prepareRequest 在异步等待时不会混入后续 defaults 变更", async () => {
  const client = createHttpClient({
    $on_before_request: async () => {
      client.defaults(config => {
        config.baseURL = "http://different.invalid";
        config.params = { injected: true };
      });
      await Promise.resolve();
    },
  });
  const prepared = await client.prepareRequest({ url: "/agent" });
  assert.equal(prepared.url, "/agent");
});



test("prepareRequest 支持 URL 参数、序列化、取消和前置失败", async () => {
  const cause = new Error("hook");
  let notifications = 0;
  const client = createHttpClient({
    baseURL,
    $finally: () => notifications++,
    $error: () => notifications++,
  });
  const prepared = await client.prepareRequest("/echo", {
    params: { q: 1 },
    paramsSerializer: { serialize: () => "custom=yes" },
  });
  assert.equal(prepared.url, baseURL + "/echo?custom=yes");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(client.prepareRequest("/echo", {
    signal: controller.signal,
  }), client.isCancel);
  await assert.rejects(client.prepareRequest("/echo", {
    $on_before_request: async () => { throw cause; },
  }), error => error.code === "ERR_BEFORE_REQUEST" && error.cause === cause);
  assert.equal(notifications, 0);
});

test("prepareRequest 继承默认方法和方法头，单次方法仍可覆盖", async () => {
  const client = createHttpClient({
    proxy: false, baseURL, method: "POST",
    headers: { post: { "X-Method": "post" }, get: { "X-Method": "get" } },
  });
  const actual = await client.request("/echo");
  const prepared = await client.prepareRequest("/echo");
  assert.equal(prepared.method, actual.config.method);
  assert.equal(prepared.headers["X-Method"], actual.data.headers["x-method"]);
  const override = await client.prepareRequest({ url: "/echo", method: "GET" });
  assert.equal(override.method, "get");
  assert.equal(override.headers["X-Method"], "get");
});

test("prepareRequest 的已有参数和序列化器不混入后续默认配置", async () => {
  let release;
  let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const client = createHttpClient({
    baseURL,
    params: { original: 1 },
    paramsSerializer: { indexes: null },
    $on_before_request: async () => { entered(); await gate; },
  });
  const pending = client.prepareRequest("/echo");
  await started;
  client.defaults(config => {
    config.baseURL = "http://different.invalid";
    config.params.extra = "later";
    config.paramsSerializer.serialize = () => "injected=yes";
  });
  release();
  assert.equal((await pending).url, baseURL + "/echo?original=1");
  assert.equal((await client.prepareRequest("/echo")).url,
    "http://different.invalid/echo?injected=yes");
});
