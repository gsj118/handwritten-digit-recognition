"use strict";

const canvas = document.getElementById("drawing-canvas");
const context = canvas.getContext("2d", { willReadFrequently: true });
const recognizeButton = document.getElementById("recognize-button");
const clearButton = document.getElementById("clear-button");
const message = document.getElementById("status-message");
const hint = document.getElementById("canvas-hint");
const modelReady = document.body.dataset.modelReady === "true";
const initialMessage = message.textContent;
let activePointer = null;
let hasInk = false;
let revision = 0;
let requestController = null;

function showMessage(text, isError = false) {
  message.textContent = text;
  message.classList.toggle("error", isError);
}

function resetResults() {
  document.getElementById("predicted-digit").textContent = "—";
  document.getElementById("confidence").replaceChildren(document.createTextNode("—"), Object.assign(document.createElement("span"), { textContent: "%" }));
  document.getElementById("confidence-fill").style.width = "0%";
  document.getElementById("confidence-caption").textContent = "입력 후 예측 확률이 표시됩니다.";
  document.getElementById("result-badge").textContent = "Awaiting input";
  document.getElementById("result-badge").classList.remove("complete");
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
  recognizeButton.disabled = !modelReady;
  recognizeButton.innerHTML = 'Recognize <span aria-hidden="true">↗</span>';
  document.querySelector(".results-panel").setAttribute("aria-busy", "false");
}

function clearCanvas() {
  cancelPendingPrediction();
  if (activePointer !== null && canvas.hasPointerCapture(activePointer)) canvas.releasePointerCapture(activePointer);
  activePointer = null;
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
  showMessage(initialMessage);
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
  showMessage(modelReady ? "준비되면 Recognize를 눌러주세요." : initialMessage);
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
  if (canvas.hasPointerCapture(activePointer)) canvas.releasePointerCapture(activePointer);
  activePointer = null;
  context.beginPath();
}
canvas.addEventListener("pointerup", finishStroke);
canvas.addEventListener("pointercancel", finishStroke);
canvas.addEventListener("lostpointercapture", finishStroke);
clearButton.addEventListener("click", clearCanvas);

function renderPrediction(result) {
  document.getElementById("predicted-digit").textContent = result.prediction;
  const percent = (result.confidence * 100).toFixed(1);
  document.getElementById("confidence").replaceChildren(document.createTextNode(percent), Object.assign(document.createElement("span"), { textContent: "%" }));
  document.getElementById("confidence-fill").style.width = `${percent}%`;
  document.getElementById("confidence-caption").textContent = "Softmax probability · 정답 보장 아님";
  document.getElementById("result-badge").textContent = "Analysis complete";
  document.getElementById("result-badge").classList.add("complete");
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
  showMessage(`인식 완료: ${result.prediction} · 다른 숫자를 그리려면 Clear를 눌러주세요.`);
}

recognizeButton.addEventListener("click", async () => {
  if (!hasInk) {
    showMessage("먼저 캔버스에 숫자를 그려주세요.", true);
    return;
  }
  const submittedRevision = revision;
  const controller = new AbortController();
  requestController = controller;
  recognizeButton.disabled = true;
  recognizeButton.textContent = "Recognizing…";
  document.querySelector(".results-panel").setAttribute("aria-busy", "true");
  showMessage("손글씨를 분석하고 있습니다…");
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch("/predict", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: canvas.toDataURL("image/png") }),
      signal: controller.signal,
    });
    const result = await response.json();
    if (submittedRevision !== revision) return;
    if (!response.ok) throw new Error(result.error || "Prediction failed. Please try again.");
    renderPrediction(result);
  } catch (error) {
    if (submittedRevision === revision) showMessage(error.name === "AbortError" ? "응답 시간이 초과되었습니다. 다시 시도해주세요." : error.message, true);
  } finally {
    clearTimeout(timeout);
    if (submittedRevision === revision) {
      requestController = null;
      recognizeButton.disabled = !modelReady;
      recognizeButton.innerHTML = 'Recognize <span aria-hidden="true">↗</span>';
      document.querySelector(".results-panel").setAttribute("aria-busy", "false");
    }
  }
});

clearCanvas();
