import os

import cv2
import numpy as np


FRONTAL_FACE_CASCADE = cv2.CascadeClassifier(
    os.path.join(cv2.data.haarcascades, "haarcascade_frontalface_default.xml")
)
PROFILE_FACE_CASCADE = cv2.CascadeClassifier(
    os.path.join(cv2.data.haarcascades, "haarcascade_profileface.xml")
)
FACE_MATCH_THRESHOLD = float(os.environ.get("FACE_MATCH_THRESHOLD", "0.89"))
FACE_IMAGE_SIZE = (64, 64)
CLAHE = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
HOG_DESCRIPTOR = cv2.HOGDescriptor(FACE_IMAGE_SIZE, (16, 16), (8, 8), (8, 8), 9)
ORB_DESCRIPTOR = cv2.ORB_create(nfeatures=256, scaleFactor=1.15, edgeThreshold=8, fastThreshold=10)


def _load_grayscale_image_from_bytes(image_bytes):
    if not image_bytes:
        return None
    arr = np.frombuffer(image_bytes, dtype=np.uint8)
    return cv2.imdecode(arr, cv2.IMREAD_GRAYSCALE)


def _load_grayscale_image_from_path(path):
    if not path or not os.path.exists(path):
        return None
    return cv2.imread(path, cv2.IMREAD_GRAYSCALE)


def _detect_with_cascade(cascade, image):
    if image is None or cascade.empty():
        return []
    faces = cascade.detectMultiScale(
        image,
        scaleFactor=1.1,
        minNeighbors=5,
        minSize=(48, 48),
    )
    return [tuple(int(value) for value in face) for face in faces]


def _intersection_over_union(left, right):
    lx, ly, lw, lh = left
    rx, ry, rw, rh = right

    left_x2 = lx + lw
    left_y2 = ly + lh
    right_x2 = rx + rw
    right_y2 = ry + rh

    inter_x1 = max(lx, rx)
    inter_y1 = max(ly, ry)
    inter_x2 = min(left_x2, right_x2)
    inter_y2 = min(left_y2, right_y2)

    inter_width = max(0, inter_x2 - inter_x1)
    inter_height = max(0, inter_y2 - inter_y1)
    intersection = inter_width * inter_height
    if intersection == 0:
        return 0.0

    left_area = lw * lh
    right_area = rw * rh
    union = left_area + right_area - intersection
    if union <= 0:
        return 0.0
    return float(intersection / union)


def _merge_face_detections(detections, overlap_threshold=0.35):
    merged = []
    for face in sorted(detections, key=lambda item: item[2] * item[3], reverse=True):
        if any(_intersection_over_union(face, existing) >= overlap_threshold for existing in merged):
            continue
        merged.append(face)
    return merged


def _detect_frontal_faces(image):
    return _detect_with_cascade(FRONTAL_FACE_CASCADE, image)


def _detect_profile_faces(image):
    direct = _detect_with_cascade(PROFILE_FACE_CASCADE, image)
    if image is None:
        return direct

    flipped = cv2.flip(image, 1)
    mirrored = []
    for x, y, w, h in _detect_with_cascade(PROFILE_FACE_CASCADE, flipped):
        mirrored.append((image.shape[1] - x - w, y, w, h))
    return direct + mirrored


def _detect_faces(image):
    detections = []
    detections.extend(_detect_frontal_faces(image))
    detections.extend(_detect_profile_faces(image))
    return _merge_face_detections(detections)


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
    pad_x = int(w * 0.28)
    pad_y = int(h * 0.28)
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


def _compute_average_hash(image):
    small = cv2.resize(image, (16, 16), interpolation=cv2.INTER_AREA)
    average = float(small.mean())
    return (small > average).astype(np.uint8)


def _compute_intensity_histogram(image):
    histogram = cv2.calcHist([image], [0], None, [32], [0, 256])
    return cv2.normalize(histogram, histogram).flatten()


def _compute_edge_histogram(image):
    edges = cv2.Canny(image, 60, 160)
    histogram = cv2.calcHist([edges], [0], None, [16], [0, 256])
    return cv2.normalize(histogram, histogram).flatten()


def _compute_orb_descriptors(image):
    keypoints, descriptors = ORB_DESCRIPTOR.detectAndCompute(image, None)
    if not keypoints or descriptors is None or len(descriptors) == 0:
        return None
    return descriptors


def _orb_similarity(left, right):
    if left is None or right is None:
        return None
    matcher = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=False)
    matches = matcher.knnMatch(left, right, k=2)
    good_matches = 0
    comparable = 0
    for pair in matches:
        if len(pair) < 2:
            continue
        comparable += 1
        first, second = pair
        if first.distance < 0.78 * second.distance:
            good_matches += 1
    if comparable == 0:
        return None
    baseline = float(max(12, min(len(left), len(right))))
    return _clamp_unit(good_matches / baseline)


def _feature_bundle(image):
    if image is None:
        return None
    return {
        "average_hash": _compute_average_hash(image),
        "histogram": _compute_intensity_histogram(image),
        "lbp_histogram": _compute_lbp_histogram(image),
        "hog_descriptor": HOG_DESCRIPTOR.compute(image).reshape(-1),
        "edge_histogram": _compute_edge_histogram(image),
        "orb_descriptor": _compute_orb_descriptors(image),
    }


def _compare_feature_bundles(left, right):
    if not left or not right:
        return 0.0

    hash_distance = np.count_nonzero(left["average_hash"] != right["average_hash"])
    hash_similarity = 1.0 - (hash_distance / float(left["average_hash"].size))
    hist_similarity = _clamp_unit(
        (cv2.compareHist(left["histogram"], right["histogram"], cv2.HISTCMP_CORREL) + 1.0) / 2.0
    )
    lbp_similarity = _clamp_unit(
        cv2.compareHist(left["lbp_histogram"], right["lbp_histogram"], cv2.HISTCMP_INTERSECT)
    )
    hog_similarity = _clamp_unit(
        _cosine_similarity(left["hog_descriptor"], right["hog_descriptor"])
    )
    edge_similarity = _clamp_unit(
        cv2.compareHist(left["edge_histogram"], right["edge_histogram"], cv2.HISTCMP_INTERSECT)
    )
    orb_similarity = _orb_similarity(left["orb_descriptor"], right["orb_descriptor"])

    metrics = [
        (hash_similarity, 0.12),
        (hist_similarity, 0.10),
        (lbp_similarity, 0.22),
        (hog_similarity, 0.28),
        (edge_similarity, 0.12),
    ]
    if orb_similarity is not None:
        metrics.append((orb_similarity, 0.16))

    total_weight = sum(weight for _value, weight in metrics)
    if total_weight <= 0:
        return 0.0
    return float(sum(value * weight for value, weight in metrics) / total_weight)


def analyze_image_bytes(image_bytes):
    image = _load_grayscale_image_from_bytes(image_bytes)
    if image is None:
        return {
            "face_count": 0,
            "has_face": False,
            "frontal_face_count": 0,
            "profile_face_count": 0,
        }

    frontal_faces = _detect_frontal_faces(image)
    profile_faces = _detect_profile_faces(image)
    all_faces = _merge_face_detections(frontal_faces + profile_faces)
    face_count = len(all_faces)
    return {
        "face_count": int(face_count),
        "has_face": face_count > 0,
        "frontal_face_count": int(len(frontal_faces)),
        "profile_face_count": int(len(profile_faces)),
    }


def _image_signature(image):
    faces = _detect_faces(image)
    face_crop, face_count = _extract_primary_face(image, faces)
    normalized = _prepare_image(face_crop if face_crop is not None else image)
    if normalized is None:
        return None

    return {
        "features": _feature_bundle(normalized),
        "mirrored_features": _feature_bundle(cv2.flip(normalized, 1)),
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

    direct_similarity = _compare_feature_bundles(source_sig["features"], target_sig["features"])
    mirrored_similarity = _compare_feature_bundles(source_sig["features"], target_sig["mirrored_features"])
    face_bonus = 0.05 if source_sig["has_face"] and target_sig["has_face"] else 0.0

    return float(min(1.0, max(direct_similarity, mirrored_similarity) + face_bonus))


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
