import pytest
import torch

from model import DEFAULT_CHECKPOINT, DigitCNN, load_model


def test_forward_produces_ten_finite_logits():
    model = DigitCNN().eval()
    with torch.no_grad():
        output = model(torch.zeros(4, 1, 28, 28))
    assert output.shape == (4, 10)
    assert torch.isfinite(output).all()


def test_checkpoint_loaded_in_eval_mode_on_cpu(checkpoint):
    model = load_model(checkpoint)
    assert not model.training
    assert next(model.parameters()).device.type == "cpu"
    sample = torch.randn(1, 1, 28, 28)
    with torch.no_grad():
        assert torch.equal(model(sample), model(sample))


def test_missing_checkpoint_has_clear_exception(tmp_path):
    with pytest.raises(FileNotFoundError):
        load_model(tmp_path / "missing.pt")


def test_bundled_checkpoint_is_loadable():
    assert DEFAULT_CHECKPOINT.is_file(), "Train and include model/mnist_cnn.pt before submission."
    model = load_model()
    with torch.no_grad():
        assert model(torch.zeros(1, 1, 28, 28)).shape == (1, 10)
