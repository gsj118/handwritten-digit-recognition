"""Local Flask application for CPU handwritten digit inference."""

import os
from pathlib import Path

from flask import Flask, jsonify, render_template, request
import torch
from werkzeug.exceptions import RequestEntityTooLarge

from model import DEFAULT_CHECKPOINT, load_model
from preprocessing import InputError, decode_canvas, image_data_url, preprocess_image


def create_app(checkpoint_path: Path | None = None) -> Flask:
    app = Flask(__name__)
    app.config["MAX_CONTENT_LENGTH"] = 1_500_000
    torch.set_num_threads(min(4, os.cpu_count() or 1))
    path = Path(checkpoint_path) if checkpoint_path is not None else DEFAULT_CHECKPOINT
    network = None
    model_message = "Model ready · CPU inference"
    try:
        network = load_model(path)
    except FileNotFoundError:
        model_message = "Model missing. Run python train.py, then restart the app."
    except Exception:
        app.logger.exception("Could not load the model checkpoint")
        model_message = "Model could not be loaded. Run python train.py, then restart the app."
    app.extensions["digit_model"] = network

    @app.get("/")
    def index():
        return render_template("index.html", model_ready=network is not None, model_message=model_message)

    @app.get("/health")
    def health():
        return jsonify(model_ready=network is not None, device="cpu", message=model_message), 200 if network is not None else 503

    @app.errorhandler(RequestEntityTooLarge)
    def too_large(_error):
        return jsonify(error="The image is too large. Use the drawing canvas."), 413

    @app.post("/predict")
    def predict():
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict) or not isinstance(payload.get("image"), str):
            return jsonify(error="Send a JSON object containing an image data URL."), 400
        try:
            tensor, preview = preprocess_image(decode_canvas(payload["image"]))
        except InputError as error:
            return jsonify(error=str(error)), 400
        if network is None:
            return jsonify(error=model_message), 503
        with torch.no_grad():
            probabilities = torch.softmax(network(tensor), dim=1)[0]
        values, indices = probabilities.topk(3)
        return jsonify(
            prediction=int(indices[0]),
            confidence=float(values[0]),
            probabilities=probabilities.tolist(),
            top3=[{"digit": int(digit), "probability": float(value)} for digit, value in zip(indices, values)],
            processed_image=image_data_url(preview),
        )

    return app


if __name__ == "__main__":
    application = create_app()
    print("Open http://127.0.0.1:5000 in your browser.", flush=True)
    if application.extensions["digit_model"] is None:
        print("Model unavailable: run python train.py, then restart the app.", flush=True)
    application.run(host="127.0.0.1", port=5000, debug=False)
