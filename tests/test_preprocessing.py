import numpy as np
from PIL import Image, ImageDraw, ImageOps
import pytest
import torch

from model import MNIST_MEAN, MNIST_STD
from preprocessing import InputError, decode_canvas, image_data_url, preprocess_image


def test_output_shape_and_normalization(digit_image):
    tensor, preview = preprocess_image(digit_image)
    assert tensor.shape == (1, 1, 28, 28)
    assert tensor.dtype == torch.float32
    assert torch.isfinite(tensor).all()
    assert tensor.min().item() == pytest.approx(-MNIST_MEAN / MNIST_STD)
    assert tensor.max().item() <= (1 - MNIST_MEAN) / MNIST_STD + 1e-6
    reconstructed = (tensor[0, 0].numpy() * MNIST_STD + MNIST_MEAN) * 255
    np.testing.assert_allclose(reconstructed, np.asarray(preview), atol=3e-5)


def test_polarity_invariance(digit_image):
    black_on_white, _ = preprocess_image(digit_image)
    white_on_black, _ = preprocess_image(ImageOps.invert(digit_image))
    assert torch.equal(black_on_white, white_on_black)


def test_position_invariance_and_mass_center():
    tensors = []
    for x, y in [(5, 8), (210, 190)]:
        image = Image.new("L", (336, 336), 255)
        ImageDraw.Draw(image).line([(x, y), (x + 75, y), (x + 25, y + 115)], fill=0, width=10)
        tensor, preview = preprocess_image(image)
        tensors.append(tensor)
        pixels = np.asarray(preview, dtype=float)
        grid_y, grid_x = np.indices((28, 28))
        assert abs((pixels * grid_x).sum() / pixels.sum() - 13.5) <= 0.6
        assert abs((pixels * grid_y).sum() / pixels.sum() - 13.5) <= 0.6
    assert torch.equal(*tensors)


def test_aspect_ratio_is_preserved():
    image = Image.new("L", (336, 336), 255)
    ImageDraw.Draw(image).rectangle((140, 40, 160, 250), fill=0)
    _, preview = preprocess_image(image)
    rows, columns = np.where(np.asarray(preview) > 20)
    assert rows.max() - rows.min() + 1 == 20
    assert columns.max() - columns.min() + 1 <= 3


@pytest.mark.parametrize("color", ["white", "black"])
def test_blank_image_rejected(color):
    with pytest.raises(InputError, match="Draw a digit"):
        preprocess_image(Image.new("RGB", (336, 336), color))


def test_transparent_canvas_and_black_ink():
    image = Image.new("RGBA", (336, 336), (0, 0, 0, 0))
    with pytest.raises(InputError):
        preprocess_image(image)
    ImageDraw.Draw(image).line((100, 70, 200, 270), fill="black", width=20)
    tensor, _ = preprocess_image(image)
    assert tensor.max() > 0


def test_png_roundtrip(digit_image):
    decoded = decode_canvas(image_data_url(digit_image))
    assert decoded.size == digit_image.size
    np.testing.assert_array_equal(np.asarray(decoded), np.asarray(digit_image))


@pytest.mark.parametrize("payload", ["", "https://example.com/image.png", "data:image/png;base64,!!!", "data:image/png;base64,aGVsbG8="])
def test_invalid_data_url(payload):
    with pytest.raises(InputError):
        decode_canvas(payload)


def test_oversized_dimensions_rejected():
    with pytest.raises(InputError, match="dimensions"):
        decode_canvas(image_data_url(Image.new("L", (1025, 28))))
