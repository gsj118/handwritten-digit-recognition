"use strict";

// Exercise the shipped browser script with controlled requests and minimal DOM doubles.
// This tests state transitions and races; real layout and pointer input need a browser.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const script = readFileSync(path.join(__dirname, "../static/js/app.js"), "utf8");

function element() {
  const classes = new Set();
  return {
    textContent: "", innerHTML: "", hidden: false, disabled: false, style: {}, dataset: {},
    attributes: {}, listeners: {}, children: {},
    classList: {
      add: name => classes.add(name), remove: name => classes.delete(name),
      toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name),
    },
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this[name]; },
    addEventListener(name, handler) { this.listeners[name] = handler; },
    querySelector(selector) { return this.children[selector] ??= element(); },
    replaceChildren(...children) { this.textContent = children.map(child => child.textContent).join(""); },
  };
}

function harness(modelReady = true) {
  const nodes = new Map();
  const get = name => {
    if (!nodes.has(name)) nodes.set(name, element());
    return nodes.get(name);
  };
  const canvas = get("drawing-canvas");
  const captures = new Set();
  const cards = Array.from({ length: 3 }, element);
  const rows = Array.from({ length: 10 }, element);
  const requests = [];
  const timers = new Map();
  let timerId = 0;
  Object.assign(canvas, {
    width: 336, height: 336,
    getContext: () => new Proxy({}, { get: (target, key) => target[key] ?? (() => {}) }),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 336, height: 336 }),
    setPointerCapture: id => captures.add(id), hasPointerCapture: id => captures.has(id),
    releasePointerCapture: id => captures.delete(id),
    toDataURL: () => "data:image/png;base64,dGVzdA==",
  });
  get("status-message").textContent = modelReady ? "먼저 숫자를 그리면 인식 버튼이 활성화됩니다." : "모델을 준비한 뒤 앱을 다시 실행해주세요.";
  const document = {
    body: { dataset: { modelReady: String(modelReady) } },
    getElementById: get, querySelector: get,
    querySelectorAll: selector => selector === ".rank-card" ? cards : rows,
    createElement: element, createTextNode: textContent => ({ textContent }),
  };
  vm.runInNewContext(script, {
    document, AbortController, console,
    setTimeout: handler => { timers.set(++timerId, handler); return timerId; },
    clearTimeout: id => timers.delete(id),
    fetch: (_url, options) => new Promise((resolve, reject) => requests.push({ resolve, reject, options })),
  });
  const pointer = (type, overrides = {}) => canvas.listeners[type]({
    pointerId: 1, pointerType: "mouse", button: 0, clientX: 80, clientY: 80,
    preventDefault() {}, ...overrides,
  });
  const draw = () => { pointer("pointerdown"); pointer("pointermove"); pointer("pointerup"); };
  return {
    get, pointer, draw, requests, timers, cards, rows,
    submit: () => get("recognize-button").listeners.click(),
    clear: () => get("clear-button").listeners.click(),
    state: () => get(".results-panel").dataset.state,
  };
}

const result = {
  prediction: 7, confidence: 0.8,
  probabilities: [0.01, 0.01, 0.01, 0.1, 0.01, 0.01, 0.01, 0.8, 0.01, 0.03],
  top3: [{ digit: 7, probability: 0.8 }, { digit: 3, probability: 0.1 }, { digit: 9, probability: 0.03 }],
  processed_image: "data:image/png;base64,cHJldmlldw==",
};
const success = () => ({ ok: true, json: async () => result });

test("empty input and unfinished strokes cannot submit; a completed stroke can", async () => {
  const ui = harness();
  assert.equal(ui.state(), "empty");
  assert.equal(ui.get("recognize-button").disabled, true);
  await ui.submit();
  ui.pointer("pointerdown");
  assert.equal(ui.state(), "drawing");
  await ui.submit();
  assert.equal(ui.requests.length, 0);
  ui.pointer("pointerup");
  assert.equal(ui.state(), "ready");
  assert.equal(ui.get("recognize-button").disabled, false);
});

test("one request renders all results; a repeat request clears stale values", async () => {
  const ui = harness();
  ui.draw();
  const pending = ui.submit();
  await ui.submit();
  assert.equal(ui.requests.length, 1);
  assert.equal(ui.state(), "processing");
  assert.equal(ui.get(".results-panel").attributes["aria-busy"], "true");
  assert.equal(ui.get("recognize-button").disabled, true);
  ui.requests[0].resolve(success());
  await pending;
  assert.equal(ui.state(), "complete");
  assert.equal(ui.get("predicted-digit").textContent, 7);
  assert.equal(ui.get("confidence").textContent, "80.0%");
  assert.equal(ui.cards[0].querySelector("strong").textContent, 7);
  assert.equal(ui.rows[7].querySelector(".probability-value").textContent, "80.0%");
  assert.equal(ui.get("processed-preview").src, result.processed_image);
  assert.match(ui.get("status-message").textContent, /7.*80.0%/);
  const repeat = ui.submit();
  assert.equal(ui.get("predicted-digit").textContent, "—");
  assert.equal(ui.get("processed-preview").hidden, true);
  ui.requests[1].resolve(success());
  await repeat;
  ui.clear();
  assert.equal(ui.state(), "empty");
  assert.match(ui.get("status-message").textContent, /그림과 결과를 지웠습니다/);
});

test("Clear during JSON decoding prevents a late response from restoring old results", async () => {
  const ui = harness();
  ui.draw();
  const pending = ui.submit();
  let finishJson;
  let markJsonStarted;
  const jsonStarted = new Promise(resolve => { markJsonStarted = resolve; });
  ui.requests[0].resolve({ ok: true, json: () => new Promise(resolve => { finishJson = resolve; markJsonStarted(); }) });
  await jsonStarted;
  assert.equal(typeof finishJson, "function");
  ui.clear();
  assert.equal(ui.requests[0].options.signal.aborted, true);
  finishJson(result);
  await pending;
  assert.equal(ui.state(), "empty");
  assert.equal(ui.get("predicted-digit").textContent, "—");
  assert.equal(ui.get("recognize-button").disabled, true);
  assert.match(ui.get("status-message").textContent, /분석을 취소/);
});

test("drawing cancels a request, and its late completion cannot unlock a newer request", async () => {
  const ui = harness();
  ui.draw();
  const oldRequest = ui.submit();
  ui.draw();
  assert.equal(ui.requests[0].options.signal.aborted, true);
  const newRequest = ui.submit();
  ui.requests[0].resolve(success());
  await oldRequest;
  assert.equal(ui.state(), "processing");
  assert.equal(ui.get("recognize-button").disabled, true);
  ui.requests[1].resolve(success());
  await newRequest;
  assert.equal(ui.state(), "complete");
  assert.equal(ui.get("recognize-button").disabled, false);
});

test("timeout keeps the drawing and permits retry", async () => {
  const ui = harness();
  ui.draw();
  const pending = ui.submit();
  ui.timers.values().next().value();
  assert.equal(ui.requests[0].options.signal.aborted, true);
  ui.requests[0].reject({ name: "AbortError" });
  await pending;
  assert.equal(ui.state(), "error");
  assert.match(ui.get("status-message").textContent, /시간이 초과.*그림은 유지/);
  assert.equal(ui.get("recognize-button").disabled, false);
  const retry = ui.submit();
  ui.requests[1].resolve(success());
  await retry;
  assert.equal(ui.state(), "complete");
});

test("HTTP errors give Korean recovery instructions without displaying the server body", async () => {
  for (const status of [400, 413, 500, 503]) {
    const ui = harness();
    ui.draw();
    const pending = ui.submit();
    ui.requests[0].resolve({ ok: false, status, json: () => { throw new Error("Internal server details"); } });
    await pending;
    assert.equal(ui.state(), "error");
    assert.match(ui.get("status-message").textContent, /다시|새로고침/);
    assert.doesNotMatch(ui.get("status-message").textContent, /Internal/);
    assert.equal(ui.get("recognize-button").disabled, false);
  }
});

test("connection failures and non-JSON responses never expose technical exceptions", async () => {
  const ui = harness();
  ui.draw();
  const offline = ui.submit();
  ui.requests[0].reject(new TypeError("Failed to fetch"));
  await offline;
  assert.match(ui.get("status-message").textContent, /서버에 연결하지 못했습니다/);
  const malformed = ui.submit();
  ui.requests[1].resolve({ ok: true, json: async () => { throw new SyntaxError("Unexpected token <"); } });
  await malformed;
  assert.match(ui.get("status-message").textContent, /새로고침/);
  assert.doesNotMatch(ui.get("status-message").textContent, /SyntaxError|Unexpected/);
});

test("a missing model remains unavailable through drawing and Clear", async () => {
  const ui = harness(false);
  ui.draw();
  await ui.submit();
  ui.clear();
  assert.equal(ui.requests.length, 0);
  assert.equal(ui.state(), "unavailable");
  assert.equal(ui.get("recognize-button").disabled, true);
  assert.match(ui.get("status-message").textContent, /모델/);
});
