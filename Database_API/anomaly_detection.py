import datetime

import jwt
import numpy as np
from fastapi import HTTPException, status
from sklearn.ensemble import IsolationForest


def require_admin_role(request, secret_key):
    auth_header = str(request.headers.get("authorization") or "").strip()
    if not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Admin authorization required")

    token = auth_header.split(" ", 1)[1].strip()
    try:
        payload = jwt.decode(token, secret_key, algorithms=["HS256"])
    except Exception as error:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=f"Invalid admin token: {error}")

    if str(payload.get("role") or "").lower() != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin role required")
    return payload


def _to_utc(value):
    if isinstance(value, datetime.datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=datetime.timezone.utc)
        return value.astimezone(datetime.timezone.utc)
    return None


def _window_to_item(window):
    return {
        "window_start": window["window_start"].isoformat().replace("+00:00", "Z"),
        "window_end": window["window_end"].isoformat().replace("+00:00", "Z"),
        "vote_count": window["vote_count"],
        "rate_per_minute": round(float(window["rate_per_minute"]), 4),
        "anomaly_score": round(float(window["anomaly_score"]), 6),
    }


def generate_anomaly_report(vote_audit_collection, window_minutes=5):
    rows = list(vote_audit_collection.find({}, {"_id": 0, "voted_at": 1}).sort("voted_at", 1))
    vote_times = [_to_utc(row.get("voted_at")) for row in rows]
    vote_times = [item for item in vote_times if item is not None]

    if len(vote_times) < 6:
        return {
            "items": [],
            "suspicious_window_count": 0,
            "analysis_window_minutes": window_minutes,
            "note": "At least 6 votes are required before anomaly detection becomes meaningful.",
        }

    delta = datetime.timedelta(minutes=max(int(window_minutes), 1))
    first_ts = vote_times[0]
    last_ts = vote_times[-1]
    windows = []
    current_start = first_ts
    index = 0

    while current_start <= last_ts:
        current_end = current_start + delta
        vote_count = 0
        while index < len(vote_times) and vote_times[index] < current_end:
            vote_count += 1
            index += 1
        windows.append(
            {
                "window_start": current_start,
                "window_end": current_end,
                "vote_count": vote_count,
                "rate_per_minute": vote_count / max(float(window_minutes), 1.0),
            }
        )
        current_start = current_end

    if len(windows) < 3:
        return {
            "items": [],
            "suspicious_window_count": 0,
            "analysis_window_minutes": window_minutes,
            "note": "Not enough time windows were produced for anomaly detection.",
        }

    feature_rows = np.array(
        [
            [
                float(window["vote_count"]),
                float(window["rate_per_minute"]),
                float((window["window_start"] - first_ts).total_seconds() / 60.0),
            ]
            for window in windows
        ],
        dtype=float,
    )

    contamination = min(0.35, max(0.1, 2.0 / len(windows)))
    model = IsolationForest(random_state=42, contamination=contamination)
    predictions = model.fit_predict(feature_rows)
    anomaly_scores = model.score_samples(feature_rows)
    baseline_rate = float(np.median([window["rate_per_minute"] for window in windows]))

    suspicious = []
    for window, prediction, score in zip(windows, predictions, anomaly_scores):
        window["anomaly_score"] = score
        faster_than_baseline = window["rate_per_minute"] >= baseline_rate
        if prediction == -1 and faster_than_baseline:
            suspicious.append(_window_to_item(window))

    suspicious.sort(key=lambda row: (row["anomaly_score"], -row["rate_per_minute"]))
    return {
        "items": suspicious,
        "suspicious_window_count": len(suspicious),
        "analysis_window_minutes": window_minutes,
        "baseline_rate_per_minute": round(baseline_rate, 4),
        "note": "Windows with unusually fast voting bursts are flagged.",
    }
