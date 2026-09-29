"""Independently evaluate a saved checkpoint on the 10,000 MNIST test images."""

import argparse
import os
from pathlib import Path

import torch
from torch.utils.data import DataLoader
from torchvision import datasets, transforms

from model import DEFAULT_CHECKPOINT, MNIST_MEAN, MNIST_STD, PROJECT_ROOT, load_model


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", type=Path, default=DEFAULT_CHECKPOINT)
    parser.add_argument("--data-dir", type=Path, default=PROJECT_ROOT / "data")
    args = parser.parse_args()
    if not args.checkpoint.is_file():
        parser.error("Checkpoint missing. Run python train.py first.")
    torch.set_num_threads(min(4, os.cpu_count() or 1))
    model = load_model(args.checkpoint)
    transform = transforms.Compose([transforms.ToTensor(), transforms.Normalize((MNIST_MEAN,), (MNIST_STD,))])
    dataset = datasets.MNIST(args.data_dir, train=False, download=True, transform=transform)
    correct = 0
    with torch.no_grad():
        for images, labels in DataLoader(dataset, batch_size=256):
            correct += (model(images).argmax(dim=1) == labels).sum().item()
    print(f"MNIST test accuracy: {correct / len(dataset):.2%} ({correct}/{len(dataset)})")


if __name__ == "__main__":
    main()
