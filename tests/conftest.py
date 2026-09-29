"""Small deterministic fixtures; tests never download MNIST or train a model."""

import pytest
from PIL import Image, ImageDraw
import torch

from app import create_app
from model import DigitCNN


@pytest.fixture
def digit_image():
    image = Image.new("RGB", (336, 336), "white")
    ImageDraw.Draw(image).line([(95, 75), (240, 75), (145, 270)], fill="black", width=20)
    return image


@pytest.fixture
def checkpoint(tmp_path):
    torch.manual_seed(42)
    path = tmp_path / "test_model.pt"
    torch.save({"architecture": "DigitCNN-v1", "model_state_dict": DigitCNN().state_dict()}, path)
    return path


@pytest.fixture
def client(checkpoint):
    app = create_app(checkpoint)
    app.config["TESTING"] = True
    return app.test_client()
