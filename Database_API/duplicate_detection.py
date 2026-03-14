import os

import cv2
import numpy as np


FACE_CASCADE = cv2.CascadeClassifier(
    os.path.join(cv2.data.haarcascades, "haarcascade_frontalface_default.xml")
)
FACE_MATCH_THRESHOLD = 0.88
FACE_IMAGE_SIZE = (64, 64)
CLAHE = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
HOG_DESCRIPTOR = cv2.HOGDescriptor(FACE_IMAGE_SIZE, (16, 16), (8, 8), (8, 8), 9)


def _load_grayscale_image_from_bytes(image_bytes):
    if not image_bytes:
        return None
    arr = np.frombuffer(image_bytes, dtype=np.uint8)
    return cv2.imdecode(arr, cv2.IMREAD_GRAYSCALE)


def _load_grayscale_image_from_path(path):
    if not path or not os.path.exists(path):
        return None
    return cv2.imread(path, cv2.IMREAD_GRAYSCALE)


def _detect_faces(image):
    if image is None or FACE_CASCADE.empty():
        return []
    faces = FACE_CASCADE.detectMultiScale(
        image,
        scaleFactor=1.1,
        minNeighbors=5,
        minSize=(48, 48),
    )
    return sorted(faces, key=lambda face: face[2] * face[3], reverse=True)


def _prepare_image(image):
    if image is None:
        return None
    normalized = cv2.resize(image, FACE_IMAGE_SIZE, interpolation=cv2.INTER_AREA)
    normalized = CLAHE.apply(normalized)
    return cv2.GaussianBlur(normalized, (3, 3), 0)


def _extract_primary_face(image, faces=None):
    if image is None:
        return None, 0
    faces = faces if faces is not None else _detect_faces(image)
    if len(faces) == 0:
        return None, 0

    x, y, w, h = max(faces, key=lambda face: face[2] * face[3])
    pad_x = int(w * 0.18)
    pad_y = int(h * 0.22)
    x1 = max(x - pad_x, 0)
    y1 = max(y - pad_y, 0)
    x2 = min(x + w + pad_x, image.shape[1])
    y2 = min(y + h + pad_y, image.shape[0])
    return image[y1:y2, x1:x2], len(faces)


def _compute_lbp_histogram(image):
    if image is None or image.shape[0] < 3 or image.shape[1] < 3:
        return None

    center = image[1:-1, 1:-1]
    lbp = np.zeros_like(center, dtype=np.uint8)
    offsets = [
        (-1, -1),
        (-1, 0),
        (-1, 1),
        (0, 1),
        (1, 1),
        (1, 0),
        (1, -1),
        (0, -1),
    ]
    for bit_index, (dy, dx) in enumerate(offsets):
        neighborhood = image[1 + dy : image.shape[0] - 1 + dy, 1 + dx : image.shape[1] - 1 + dx]
        lbp |= ((neighborhood >= center).astype(np.uint8) << bit_index)

    histogram = cv2.calcHist([lbp], [0], None, [32], [0, 256])
    return cv2.normalize(histogram, histogram).flatten()


def _cosine_similarity(left, right):
    if left is None or right is None:
        return 0.0
    denominator = float(np.linalg.norm(left) * np.linalg.norm(right))
    if denominator == 0:
        return 0.0
    return float(np.dot(left, right) / denominator)


def _clamp_unit(value):
    return max(0.0, min(1.0, float(value)))


def analyze_image_bytes(image_bytes):
    image = _load_grayscale_image_from_bytes(image_bytes)
    if image is None:
        return {"face_count": 0, "has_face": False}
    face_count = len(_detect_faces(image))
    return {"face_count": int(face_count), "has_face": face_count > 0}


def _image_signature(image):
    faces = _detect_faces(image)
    face_crop, face_count = _extract_primary_face(image, faces)
    normalized = _prepare_image(face_crop if face_crop is not None else image)
    if normalized is None:
        return None

    small = cv2.resize(normalized, (16, 16), interpolation=cv2.INTER_AREA)
    average = float(small.mean())
    average_hash = (small > average).astype(np.uint8)

    histogram = cv2.calcHist([normalized], [0], None, [32], [0, 256])
    histogram = cv2.normalize(histogram, histogram).flatten()
    lbp_histogram = _compute_lbp_histogram(normalized)
    hog_descriptor = HOG_DESCRIPTOR.compute(normalized)

    return {
        "average_hash": average_hash,
        "histogram": histogram,
        "lbp_histogram": lbp_histogram,
        "hog_descriptor": hog_descriptor.reshape(-1) if hog_descriptor is not None else None,
        "has_face": face_crop is not None,
        "face_count": face_count,
    }


def compute_similarity_score(source_bytes, existing_image_path, base_dir):
    source_image = _load_grayscale_image_from_bytes(source_bytes)
    if source_image is None:
        return 0.0

    target_path = existing_image_path
    if not os.path.isabs(target_path):
        target_path = os.path.join(base_dir, existing_image_path)
    target_image = _load_grayscale_image_from_path(target_path)
    if target_image is None:
        return 0.0

    source_sig = _image_signature(source_image)
    target_sig = _image_signature(target_image)
    if not source_sig or not target_sig:
        return 0.0

    hash_distance = np.count_nonzero(source_sig["average_hash"] != target_sig["average_hash"])
    hash_similarity = 1.0 - (hash_distance / float(source_sig["average_hash"].size))
    hist_similarity = _clamp_unit(
        (cv2.compareHist(source_sig["histogram"], target_sig["histogram"], cv2.HISTCMP_CORREL) + 1.0) / 2.0
    )
    lbp_similarity = _clamp_unit(
        cv2.compareHist(source_sig["lbp_histogram"], target_sig["lbp_histogram"], cv2.HISTCMP_INTERSECT)
    )
    hog_similarity = _clamp_unit(
        _cosine_similarity(source_sig["hog_descriptor"], target_sig["hog_descriptor"])
    )
    face_bonus = 0.05 if source_sig["has_face"] and target_sig["has_face"] else 0.0

    return float(
        min(
        1.0,
        (hog_similarity * 0.45)
        + (lbp_similarity * 0.25)
        + (hash_similarity * 0.15)
        + (hist_similarity * 0.10)
        + face_bonus,
        )
    )


def find_similar_image(source_bytes, existing_image_paths, base_dir, threshold=FACE_MATCH_THRESHOLD):
    best_match = None
    best_score = 0.0

    for item in existing_image_paths:
        image_path = item.get("path") if isinstance(item, dict) else item
        score = compute_similarity_score(source_bytes, image_path, base_dir)
        if score > best_score:
            best_match = item
            best_score = score

    if best_score >= threshold:
        rounded_score = float(round(best_score, 4))
        if isinstance(best_match, dict):
            result = dict(best_match)
            result["score"] = rounded_score
            return result
        return {"path": best_match, "score": rounded_score}
    return None
