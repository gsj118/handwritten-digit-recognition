"use strict";

const canvas = document.getElementById("drawing-canvas");
const context = canvas.getContext("2d", { willReadFrequently: true });
const recognizeButton = document.getElementById("recognize-button");
const clearButton = document.getElementById("clear-button");
const message = document.getElementById("status-message");
const hint = document.getElementById("canvas-hint");
const resultsPanel = document.querySelector(".results-panel");
const resultBadge = document.getElementById("result-badge");
const modelReady = document.body.dataset.modelReady === "true";
const initialMessage = message.textContent;
const stateLabels = {
  empty: "입력 대기", drawing: "입력 중", ready: "인식 준비",
  processing: "분석 중", complete: "분석 완료", error: "다시 시도", unavailable: "모델 준비 필요",
};
let activePointer = null;
let hasInk = false;
let revision = 0;
let requestController = null;

function syncControls() {
  recognizeButton.disabled = !modelReady || !hasInk || activePointer !== null || requestController !== null;
  if (resultsPanel.dataset.state === "processing") {
    recognizeButton.textContent = "분석 중…";
  } else {
    recognizeButton.innerHTML = '숫자 인식 <span aria-hidden="true">↗</span>';
  }
}

function setState(state, text) {
  resultsPanel.dataset.state = state;
  resultsPanel.setAttribute("aria-busy", String(state === "processing"));
  resultBadge.textContent = stateLabels[state];
  message.textContent = text;
  message.classList.toggle("error", state === "error" || state === "unavailable");
  syncControls();
}

function resetResults() {
  document.getElementById("predicted-digit").textContent = "—";
  document.getElementById("confidence").replaceChildren(document.createTextNode("—"), Object.assign(document.createElement("span"), { textContent: "%" }));
  document.getElementById("confidence-fill").style.width = "0%";
  document.getElementById("confidence-caption").textContent = "인식 후 예측 확률이 표시됩니다.";
  document.getElementById("top-three").classList.remove("has-result");
  document.querySelectorAll(".rank-card").forEach(card => {
    card.querySelector("strong").textContent = "—";
    card.querySelector("small").textContent = "—";
  });
  document.querySelectorAll(".probability-row").forEach(row => {
    row.classList.remove("winner");
    row.querySelector(".probability-fill").style.width = "0%";
    row.querySelector(".probability-value").textContent = "—";
  });
  const preview = document.getElementById("processed-preview");
  preview.hidden = true;
  preview.removeAttribute("src");
  document.getElementById("preview-placeholder").hidden = false;
}

function cancelPendingPrediction() {
  revision += 1;
  if (requestController) requestController.abort();
  requestController = null;
}

function clearCanvas(announce = true) {
  const wasProcessing = requestController !== null;
  cancelPendingPrediction();
  const pointerToRelease = activePointer;
  activePointer = null;
  if (pointerToRelease !== null && canvas.hasPointerCapture(pointerToRelease)) canvas.releasePointerCapture(pointerToRelease);
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = "#171717";
  context.fillStyle = "#171717";
  context.lineWidth = 19;
  context.lineCap = "round";
  context.lineJoin = "round";
  hasInk = false;
  hint.hidden = false;
  resetResults();
  const clearMessage = wasProcessing
    ? "분석을 취소하고 그림과 결과를 지웠습니다. 새 숫자를 그려주세요."
    : "그림과 결과를 지웠습니다. 새 숫자를 그리면 인식할 수 있습니다.";
  setState(modelReady ? "empty" : "unavailable", modelReady && announce ? clearMessage : initialMessage);
}

function pointFromEvent(event) {
  const bounds = canvas.getBoundingClientRect();
  return { x: (event.clientX - bounds.left) * canvas.width / bounds.width, y: (event.clientY - bounds.top) * canvas.height / bounds.height };
}

canvas.addEventListener("pointerdown", event => {
  if (activePointer !== null || (event.pointerType === "mouse" && event.button !== 0)) return;
  event.preventDefault();
  cancelPendingPrediction();
  resetResults();
  activePointer = event.pointerId;
  canvas.setPointerCapture(activePointer);
  const point = pointFromEvent(event);
  context.beginPath();
  context.arc(point.x, point.y, context.lineWidth / 2, 0, 2 * Math.PI);
  context.fill();
  context.beginPath();
  context.moveTo(point.x, point.y);
  hasInk = true;
  hint.hidden = true;
  setState(modelReady ? "drawing" : "unavailable", modelReady ? "입력 중입니다. 획을 마치면 숫자를 인식할 수 있습니다." : initialMessage);
});

canvas.addEventListener("pointermove", event => {
  if (event.pointerId !== activePointer) return;
  event.preventDefault();
  const samples = event.getCoalescedEvents ? event.getCoalescedEvents() : [event];
  for (const sample of samples.length ? samples : [event]) {
    const point = pointFromEvent(sample);
    context.lineTo(point.x, point.y);
    context.stroke();
    context.beginPath();
    context.moveTo(point.x, point.y);
  }
});

function finishStroke(event) {
  if (event.pointerId !== activePointer) return;
  const pointerToRelease = activePointer;
  activePointer = null;
  if (canvas.hasPointerCapture(pointerToRelease)) canvas.releasePointerCapture(pointerToRelease);
  context.beginPath();
  setState(modelReady ? "ready" : "unavailable", modelReady ? "입력 준비 완료. ‘숫자 인식’을 누르거나 획을 더 그려주세요." : initialMessage);
}
canvas.addEventListener("pointerup", finishStroke);
canvas.addEventListener("pointercancel", finishStroke);
canvas.addEventListener("lostpointercapture", finishStroke);
clearButton.addEventListener("click", () => clearCanvas());

function renderPrediction(result) {
  document.getElementById("predicted-digit").textContent = result.prediction;
  const percent = (result.confidence * 100).toFixed(1);
  document.getElementById("confidence").replaceChildren(document.createTextNode(percent), Object.assign(document.createElement("span"), { textContent: "%" }));
  document.getElementById("confidence-fill").style.width = `${percent}%`;
  document.getElementById("confidence-caption").textContent = "후보 간 상대 확률이며, 높아도 틀릴 수 있습니다.";
  document.getElementById("top-three").classList.add("has-result");
  document.querySelectorAll(".rank-card").forEach((card, index) => {
    card.querySelector("strong").textContent = result.top3[index].digit;
    card.querySelector("small").textContent = `${(result.top3[index].probability * 100).toFixed(1)}%`;
  });
  document.querySelectorAll(".probability-row").forEach((row, digit) => {
    const probability = result.probabilities[digit] * 100;
    row.classList.toggle("winner", digit === result.prediction);
    row.querySelector(".probability-fill").style.width = `${probability}%`;
    row.querySelector(".probability-value").textContent = `${probability.toFixed(1)}%`;
  });
  const preview = document.getElementById("processed-preview");
  preview.src = result.processed_image;
  preview.hidden = false;
  document.getElementById("preview-placeholder").hidden = true;
  setState("complete", `예측 숫자는 ${result.prediction}, 예측 확률은 ${percent}%입니다. 새 숫자를 그리려면 ‘지우기’를 눌러주세요.`);
}

function responseErrorMessage(status) {
  if (status === 400) return "숫자 입력을 읽지 못했습니다. ‘지우기’를 누르고 숫자를 다시 그려주세요.";
  if (status === 413) return "입력 이미지가 너무 큽니다. ‘지우기’를 누르고 한 자리 숫자를 다시 그려주세요.";
  if (status === 503) return "모델이 준비되지 않았습니다. 앱 실행 상태를 확인한 뒤 새로고침해주세요.";
  return "분석을 완료하지 못했습니다. 그림은 유지되어 있으니 ‘숫자 인식’을 눌러 다시 시도해주세요.";
}

recognizeButton.addEventListener("click", async () => {
  if (!modelReady || !hasInk || activePointer !== null || requestController !== null) return;
  const submittedRevision = revision;
  const controller = new AbortController();
  requestController = controller;
  resetResults();
  setState("processing", "손글씨를 분석하고 있습니다. ‘지우기’를 누르면 취소할 수 있습니다.");
  const timeout = setTimeout(() => controller.abort(), 15000);
  let recoveryMessage = "서버에 연결하지 못했습니다. 앱 실행 상태를 확인한 뒤 ‘숫자 인식’을 눌러 다시 시도해주세요.";
  try {
    const response = await fetch("/predict", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: canvas.toDataURL("image/png") }),
      signal: controller.signal,
    });
    if (submittedRevision !== revision) return;
    if (!response.ok) {
      recoveryMessage = responseErrorMessage(response.status);
      throw new Error("Prediction request failed");
    }
    recoveryMessage = "분석 결과를 읽지 못했습니다. 페이지를 새로고침한 뒤 숫자를 다시 그려주세요.";
    const result = await response.json();
    if (submittedRevision !== revision) return;
    renderPrediction(result);
  } catch (error) {
    if (submittedRevision === revision) {
      resetResults();
      setState("error", error.name === "AbortError"
        ? "응답 시간이 초과되었습니다. 그림은 유지되어 있으니 ‘숫자 인식’을 눌러 다시 시도해주세요."
        : recoveryMessage);
    }
  } finally {
    clearTimeout(timeout);
    if (submittedRevision === revision) {
      requestController = null;
      syncControls();
    }
  }
});

clearCanvas(false);
