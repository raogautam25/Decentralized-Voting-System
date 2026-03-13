import os

import cv2
import numpy as np


FACE_CASCADE = cv2.CascadeClassifier(
    os.path.join(cv2.data.haarcascades, "haarcascade_frontalface_default.xml")
)


def _load_grayscale_image_from_bytes(image_bytes):
    if not image_bytes:
        return None
    arr = np.frombuffer(image_bytes, dtype=np.uint8)
    return cv2.imdecode(arr, cv2.IMREAD_GRAYSCALE)


def _load_grayscale_image_from_path(path):
    if not path or not os.path.exists(path):
        return None
    return cv2.imread(path, cv2.IMREAD_GRAYSCALE)


def _normalize_image(image):
    if image is None:
        return None
    normalized = cv2.resize(image, (64, 64), interpolation=cv2.INTER_AREA)
    return cv2.GaussianBlur(normalized, (3, 3), 0)


def _extract_primary_face(image):
    if image is None or FACE_CASCADE.empty():
        return None

    faces = FACE_CASCADE.detectMultiScale(
        image,
        scaleFactor=1.1,
        minNeighbors=5,
        minSize=(48, 48),
    )
    if len(faces) == 0:
        return None

    x, y, w, h = max(faces, key=lambda face: face[2] * face[3])
    pad_x = int(w * 0.18)
    pad_y = int(h * 0.22)
    x1 = max(x - pad_x, 0)
    y1 = max(y - pad_y, 0)
    x2 = min(x + w + pad_x, image.shape[1])
    y2 = min(y + h + pad_y, image.shape[0])
    return image[y1:y2, x1:x2]


def _image_signature(image):
    face_crop = _extract_primary_face(image)
    normalized = _normalize_image(face_crop if face_crop is not None else image)
    if normalized is None:
        return None

    small = cv2.resize(normalized, (16, 16), interpolation=cv2.INTER_AREA)
    average = float(small.mean())
    average_hash = (small > average).astype(np.uint8)

    histogram = cv2.calcHist([normalized], [0], None, [32], [0, 256])
    histogram = cv2.normalize(histogram, histogram).flatten()

    return average_hash, histogram, face_crop is not None


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

    source_hash, source_hist, source_has_face = source_sig
    target_hash, target_hist, target_has_face = target_sig

    hash_distance = np.count_nonzero(source_hash != target_hash)
    hash_similarity = 1.0 - (hash_distance / float(source_hash.size))
    hist_similarity = float(cv2.compareHist(source_hist, target_hist, cv2.HISTCMP_CORREL))
    face_bonus = 0.08 if source_has_face and target_has_face else 0.0

    return min(1.0, (hash_similarity * 0.65) + (hist_similarity * 0.27) + face_bonus)


def find_similar_image(source_bytes, existing_image_paths, base_dir, threshold=0.90):
    best_match = None
    best_score = 0.0

    for item in existing_image_paths:
        image_path = item.get("path") if isinstance(item, dict) else item
        score = compute_similarity_score(source_bytes, image_path, base_dir)
        if score > best_score:
            best_match = item
            best_score = score

    if best_score >= threshold:
        if isinstance(best_match, dict):
          result = dict(best_match)
          result["score"] = round(best_score, 4)
          return result
        return {"path": best_match, "score": round(best_score, 4)}
    return None
