"""Train on MNIST, select by validation accuracy, and evaluate held-out test data."""

import argparse
import copy
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import platform
import random
import time

import numpy as np
import torch
from torch import nn
from torch.utils.data import DataLoader, TensorDataset
from torchvision.datasets import MNIST

from model import DEFAULT_CHECKPOINT, MNIST_MEAN, MNIST_STD, PROJECT_ROOT, DigitCNN


def set_seed(seed: int) -> None:
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    torch.use_deterministic_algorithms(True)


def make_dataset(dataset: MNIST, indices: torch.Tensor | None = None) -> TensorDataset:
    images, labels = dataset.data, dataset.targets
    if indices is not None:
        images, labels = images[indices], labels[indices]
    images = (images.unsqueeze(1).float() / 255.0 - MNIST_MEAN) / MNIST_STD
    return TensorDataset(images, labels)


@torch.no_grad()
def evaluate(model: DigitCNN, loader: DataLoader) -> tuple[float, list[list[int]]]:
    model.eval()
    correct = 0
    confusion = torch.zeros((10, 10), dtype=torch.int64)
    for images, labels in loader:
        predictions = model(images).argmax(dim=1)
        correct += (predictions == labels).sum().item()
        confusion += torch.bincount(labels * 10 + predictions, minlength=100).reshape(10, 10)
    return correct / len(loader.dataset), confusion.tolist()


def train(args: argparse.Namespace) -> None:
    set_seed(args.seed)
    torch.set_num_threads(args.threads)
    started = time.perf_counter()
    print("Loading MNIST (the first run downloads the dataset)...", flush=True)
    source = MNIST(root=args.data_dir, train=True, download=True)
    test_source = MNIST(root=args.data_dir, train=False, download=True)
    generator = torch.Generator().manual_seed(args.seed)
    indices = torch.randperm(len(source), generator=generator)
    train_data = make_dataset(source, indices[5000:])
    validation_data = make_dataset(source, indices[:5000])
    test_data = make_dataset(test_source)
    train_loader = DataLoader(train_data, batch_size=args.batch_size, shuffle=True, generator=generator)
    validation_loader = DataLoader(validation_data, batch_size=256)
    test_loader = DataLoader(test_data, batch_size=256)
    model = DigitCNN()
    optimizer = torch.optim.Adam(model.parameters(), lr=args.learning_rate)
    criterion = nn.CrossEntropyLoss()
    history = []
    best_accuracy = -1.0
    best_state = None
    best_epoch = 0
    for epoch in range(1, args.epochs + 1):
        epoch_started = time.perf_counter()
        model.train()
        loss_sum, correct = 0.0, 0
        for images, labels in train_loader:
            optimizer.zero_grad(set_to_none=True)
            logits = model(images)
            loss = criterion(logits, labels)
            loss.backward()
            optimizer.step()
            loss_sum += loss.item() * labels.size(0)
            correct += (logits.argmax(dim=1) == labels).sum().item()
        validation_accuracy, _ = evaluate(model, validation_loader)
        row = {
            "epoch": epoch,
            "training_loss": loss_sum / len(train_data),
            "training_accuracy": correct / len(train_data),
            "validation_accuracy": validation_accuracy,
            "seconds": round(time.perf_counter() - epoch_started, 2),
        }
        history.append(row)
        print(
            f"Epoch {epoch}/{args.epochs} | loss {row['training_loss']:.4f} | "
            f"train {row['training_accuracy']:.2%} | validation {validation_accuracy:.2%} | "
            f"{row['seconds']:.1f}s", flush=True,
        )
        if validation_accuracy > best_accuracy:
            best_accuracy = validation_accuracy
            best_epoch = epoch
            best_state = copy.deepcopy(model.state_dict())

    model.load_state_dict(best_state)
    test_accuracy, confusion = evaluate(model, test_loader)
    metadata = {
        "architecture": "DigitCNN-v1",
        "seed": args.seed,
        "epochs": args.epochs,
        "selected_epoch": best_epoch,
        "batch_size": args.batch_size,
        "learning_rate": args.learning_rate,
        "train_samples": len(train_data),
        "validation_samples": len(validation_data),
        "test_samples": len(test_data),
        "validation_accuracy": best_accuracy,
        "test_accuracy": test_accuracy,
        "confusion_matrix": confusion,
        "history": history,
        "device": "cpu",
        "threads": args.threads,
        "python_version": platform.python_version(),
        "torch_version": str(torch.__version__),
        "platform": platform.system(),
        "elapsed_seconds": round(time.perf_counter() - started, 2),
        "trained_at_utc": datetime.now(timezone.utc).isoformat(),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = args.output.with_suffix(".tmp")
    torch.save({"architecture": "DigitCNN-v1", "model_state_dict": best_state, "metadata": metadata}, temporary_path)
    temporary_path.replace(args.output)
    metrics_path = args.output.with_suffix(".json")
    metrics_path.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    print(f"Selected epoch: {best_epoch} | held-out test accuracy: {test_accuracy:.2%}", flush=True)
    print(f"Checkpoint: {args.output}\nMetrics: {metrics_path}", flush=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--epochs", type=int, default=5)
    parser.add_argument("--batch-size", type=int, default=128)
    parser.add_argument("--learning-rate", type=float, default=0.001)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--threads", type=int, default=min(4, os.cpu_count() or 1))
    parser.add_argument("--data-dir", type=Path, default=PROJECT_ROOT / "data")
    parser.add_argument("--output", type=Path, default=DEFAULT_CHECKPOINT)
    args = parser.parse_args()
    if args.epochs < 1 or args.batch_size < 1 or args.threads < 1 or args.learning_rate <= 0:
        parser.error("epochs, batch-size, threads, and learning-rate must be positive")
    return args


if __name__ == "__main__":
    train(parse_args())
