from io import BytesIO
import base64

from PIL import Image
import pytest

from app import create_app
from preprocessing import image_data_url


def test_home_and_health(client):
    response = client.get("/")
    assert response.status_code == 200
    assert b"drawing-canvas" in response.data
    assert client.get("/health").json["model_ready"] is True


def test_predict_response_contract(client, digit_image):
    response = client.post("/predict", json={"image": image_data_url(digit_image)})
    assert response.status_code == 200
    result = response.json
    assert 0 <= result["prediction"] <= 9
    probabilities = result["probabilities"]
    assert len(probabilities) == 10
    assert sum(probabilities) == pytest.approx(1, abs=1e-6)
    assert all(0 <= value <= 1 for value in probabilities)
    assert result["confidence"] == max(probabilities)
    assert result["prediction"] == probabilities.index(max(probabilities))
    assert len(result["top3"]) == 3
    assert len({item["digit"] for item in result["top3"]}) == 3
    assert [item["probability"] for item in result["top3"]] == sorted(probabilities, reverse=True)[:3]
    assert all(item["probability"] == probabilities[item["digit"]] for item in result["top3"])
    image = Image.open(BytesIO(base64.b64decode(result["processed_image"].split(",")[1])))
    assert image.size == (28, 28)


@pytest.mark.parametrize("payload", [None, [], 7, {}, {"image": None}, {"image": 23}, {"image": "bad"}, {"image": "data:image/png;base64,!!!"}])
def test_invalid_requests_return_json_error(client, payload):
    response = client.post("/predict", json=payload)
    assert response.status_code == 400
    assert response.json["error"]


def test_malformed_json(client):
    response = client.post("/predict", data="{", content_type="application/json")
    assert response.status_code == 400
    assert "error" in response.json


def test_blank_canvas(client):
    response = client.post("/predict", json={"image": image_data_url(Image.new("RGB", (336, 336), "white"))})
    assert response.status_code == 400
    assert "Draw a digit" in response.json["error"]


def test_request_size_limit(client):
    response = client.post("/predict", data="x" * 1_500_001, content_type="application/json")
    assert response.status_code == 413
    assert response.is_json


def test_missing_model_keeps_page_available(tmp_path, digit_image):
    client = create_app(tmp_path / "missing.pt").test_client()
    assert client.get("/").status_code == 200
    assert client.get("/health").status_code == 503
    response = client.post("/predict", json={"image": image_data_url(digit_image)})
    assert response.status_code == 503
    assert "python train.py" in response.json["error"]


def test_corrupt_model_keeps_page_available(tmp_path):
    path = tmp_path / "corrupt.pt"
    path.write_bytes(b"invalid checkpoint")
    client = create_app(path).test_client()
    assert client.get("/").status_code == 200
    assert client.get("/health").status_code == 503
