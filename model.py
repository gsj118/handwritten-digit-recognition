"""Shared CNN architecture and safe checkpoint loading."""

from pathlib import Path

import torch
from torch import nn

PROJECT_ROOT = Path(__file__).resolve().parent
DEFAULT_CHECKPOINT = PROJECT_ROOT / "model" / "mnist_cnn.pt"
MNIST_MEAN = 0.1307
MNIST_STD = 0.3081


class DigitCNN(nn.Module):
    """Extract local stroke features and classify one 28 by 28 digit."""

    def __init__(self) -> None:
        super().__init__()
        self.features = nn.Sequential(
            nn.Conv2d(1, 32, kernel_size=3, padding=1),
            nn.ReLU(),
            nn.MaxPool2d(2),
            nn.Conv2d(32, 64, kernel_size=3, padding=1),
            nn.ReLU(),
            nn.MaxPool2d(2),
        )
        self.classifier = nn.Sequential(
            nn.Flatten(),
            nn.Linear(64 * 7 * 7, 128),
            nn.ReLU(),
            nn.Dropout(0.3),
            nn.Linear(128, 10),
        )

    def forward(self, images: torch.Tensor) -> torch.Tensor:
        return self.classifier(self.features(images))


def load_model(checkpoint_path: Path = DEFAULT_CHECKPOINT) -> DigitCNN:
    """Load weights onto CPU; importing this module never starts training."""
    checkpoint = torch.load(checkpoint_path, map_location="cpu", weights_only=True)
    if checkpoint.get("architecture") != "DigitCNN-v1":
        raise ValueError("Unsupported checkpoint architecture. Run python train.py.")
    model = DigitCNN()
    model.load_state_dict(checkpoint["model_state_dict"])
    model.eval()
    return model
