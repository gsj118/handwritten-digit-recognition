"""Convert a browser PNG into a centered MNIST-style input tensor."""

import base64
import binascii
from io import BytesIO

import numpy as np
from PIL import Image, UnidentifiedImageError
import torch

from model import MNIST_MEAN, MNIST_STD

MAX_IMAGE_BYTES = 1_000_000
MAX_IMAGE_SIDE = 1024
FOREGROUND_THRESHOLD = 20


class InputError(ValueError):
    """An image cannot be interpreted as a single handwritten digit."""


def decode_canvas(data_url: str) -> Image.Image:
    """Decode only bounded PNG data URLs, without accepting remote paths."""
    prefix = "data:image/png;base64,"
    if not isinstance(data_url, str) or not data_url.startswith(prefix):
        raise InputError("Send a PNG image from the drawing canvas.")
    encoded = data_url[len(prefix):]
    if len(encoded) > (MAX_IMAGE_BYTES * 4 // 3 + 4):
        raise InputError("The image is too large. Use the drawing canvas.")
    try:
        raw = base64.b64decode(encoded, validate=True)
        if len(raw) > MAX_IMAGE_BYTES:
            raise InputError("The image is too large.")
        image = Image.open(BytesIO(raw))
        if image.format != "PNG":
            raise InputError("Only PNG images are supported.")
        if not (28 <= image.width <= MAX_IMAGE_SIDE and 28 <= image.height <= MAX_IMAGE_SIDE):
            raise InputError("Image dimensions must be between 28 and 1024 pixels.")
        image.load()
        return image
    except (binascii.Error, UnidentifiedImageError, OSError, Image.DecompressionBombError) as error:
        raise InputError("The image could not be read. Clear the canvas and try again.") from error


def preprocess_image(image: Image.Image) -> tuple[torch.Tensor, Image.Image]:
    """Crop, fit inside 20x20, pad and center by intensity-weighted mass.

    Opaque inputs may use either polarity. Transparent pixels are composited
    onto white, matching the web canvas's black-ink convention.
    """
    rgba = image.convert("RGBA")
    background = Image.new("RGBA", rgba.size, "white")
    grayscale = np.asarray(Image.alpha_composite(background, rgba).convert("L"), dtype=np.float32)
    border = np.concatenate((grayscale[0], grayscale[-1], grayscale[:, 0], grayscale[:, -1]))
    foreground = 255.0 - grayscale if np.median(border) > 127 else grayscale
    mask = foreground > FOREGROUND_THRESHOLD
    if np.count_nonzero(mask) < 8:
        raise InputError("Draw a digit first, then select Recognize.")

    rows, columns = np.where(mask)
    cropped = Image.fromarray(foreground[rows.min():rows.max() + 1, columns.min():columns.max() + 1].astype(np.uint8))
    scale = 20.0 / max(cropped.size)
    fitted = cropped.resize(
        (max(1, round(cropped.width * scale)), max(1, round(cropped.height * scale))),
        Image.Resampling.LANCZOS,
    )
    centered = Image.new("L", (28, 28), 0)
    centered.paste(fitted, ((28 - fitted.width) // 2, (28 - fitted.height) // 2))

    pixels = np.asarray(centered, dtype=np.float32)
    y_grid, x_grid = np.indices(pixels.shape)
    total_mass = pixels.sum()
    shift_x = round(13.5 - float((x_grid * pixels).sum() / total_mass))
    shift_y = round(13.5 - float((y_grid * pixels).sum() / total_mass))
    # Clamp the translation so no foreground is clipped or wrapped around.
    ink_y, ink_x = np.where(pixels > 0)
    shift_x = int(np.clip(shift_x, -ink_x.min(), 27 - ink_x.max()))
    shift_y = int(np.clip(shift_y, -ink_y.min(), 27 - ink_y.max()))
    shifted = Image.new("L", (28, 28), 0)
    shifted.paste(centered, (shift_x, shift_y))
    normalized = (np.asarray(shifted, dtype=np.float32) / 255.0 - MNIST_MEAN) / MNIST_STD
    tensor = torch.from_numpy(normalized.copy()).unsqueeze(0).unsqueeze(0)
    return tensor, shifted


def image_data_url(image: Image.Image) -> str:
    """Encode the actual 28x28 model input for display in the interface."""
    buffer = BytesIO()
    image.save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")
