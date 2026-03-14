from __future__ import annotations

import datetime
import math

import jwt
import numpy as np
from fastapi import HTTPException, status
from sklearn.ensemble import IsolationForest


def _utc_datetime(value):
    if isinstance(value, datetime.datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=datetime.timezone.utc)
        return value.astimezone(datetime.timezone.utc)
    if isinstance(value, str):
        normalized = value.strip().replace("Z", "+00:00")
        try:
            parsed = datetime.datetime.fromisoformat(normalized)
            if parsed.tzinfo is None:
                return parsed.replace(tzinfo=datetime.timezone.utc)
            return parsed.astimezone(datetime.timezone.utc)
        except Exception:
            return None
    return None


def _utc_iso(value):
    if value is None:
        return None
    return value.astimezone(datetime.timezone.utc).isoformat().replace("+00:00", "Z")


def require_admin_role(request, secret_key):
    authorization = (request.headers.get("authorization") or "").strip()
    if not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Admin token is required")

    token = authorization.split(" ", 1)[1].strip()
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Admin token is required")

    try:
        payload = jwt.decode(token, secret_key, algorithms=["HS256"])
    except jwt.PyJWTError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")

    if str(payload.get("role") or "").strip().lower() != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin access required")

    return payload


def _build_rolling_windows(timestamps, window_minutes):
    window_seconds = max(60, int(window_minutes) * 60)
    windows = []

    for index, start_at in enumerate(timestamps):
        end_at = start_at + datetime.timedelta(seconds=window_seconds)
        bucket = []
        probe = index
        while probe < len(timestamps) and timestamps[probe] < end_at:
            bucket.append(timestamps[probe])
            probe += 1

        vote_count = len(bucket)
        if vote_count <= 0:
            continue

        span_seconds = (bucket[-1] - bucket[0]).total_seconds() if vote_count > 1 else 0.0
        average_gap_seconds = span_seconds / (vote_count - 1) if vote_count > 1 else float(window_seconds)

        windows.append(
            {
                "window_start_dt": start_at,
                "window_end_dt": end_at,
                "vote_count": vote_count,
                "rate_per_minute": round(vote_count / max(float(window_minutes), 1.0), 4),
                "average_gap_seconds": round(float(average_gap_seconds), 2),
            }
        )

    return windows


def _merge_windows(windows):
    if not windows:
        return []

    windows = sorted(windows, key=lambda item: item["window_start_dt"])
    merged = [windows[0].copy()]

    for window in windows[1:]:
        current = merged[-1]
        if window["window_start_dt"] <= current["window_end_dt"]:
            current["window_end_dt"] = max(current["window_end_dt"], window["window_end_dt"])
            current["vote_count"] = max(current["vote_count"], window["vote_count"])
            current["rate_per_minute"] = max(current["rate_per_minute"], window["rate_per_minute"])
            current["average_gap_seconds"] = min(current["average_gap_seconds"], window["average_gap_seconds"])
            current["anomaly_score"] = min(current["anomaly_score"], window["anomaly_score"])
            continue
        merged.append(window.copy())

    return merged


def generate_anomaly_report(vote_audit_collection, window_minutes=5):
    rows = list(
        vote_audit_collection.find({}, {"_id": 0, "voted_at": 1, "audit_id": 1}).sort([("voted_at", 1), ("audit_id", 1)])
    )
    timestamps = [parsed for parsed in (_utc_datetime(row.get("voted_at")) for row in rows) if parsed is not None]

    if len(timestamps) < 6:
        return {
            "analysis_window_minutes": int(window_minutes),
            "votes_analyzed": len(timestamps),
            "suspicious_window_count": 0,
            "items": [],
            "note": "At least 6 votes are required before anomaly detection becomes meaningful.",
        }

    windows = _build_rolling_windows(timestamps, window_minutes)
    if len(windows) < 4:
        return {
            "analysis_window_minutes": int(window_minutes),
            "votes_analyzed": len(timestamps),
            "suspicious_window_count": 0,
            "items": [],
            "note": "Not enough time windows were produced for anomaly detection.",
        }

    vote_counts = [window["vote_count"] for window in windows]
    gap_values = [window["average_gap_seconds"] for window in windows]
    median_vote_count = float(np.median(vote_counts))
    median_gap_seconds = float(np.median(gap_values))

    feature_rows = []
    for window in windows:
        inverse_gap = 1.0 / max(window["average_gap_seconds"], 1.0)
        feature_rows.append([float(window["vote_count"]), float(window["rate_per_minute"]), inverse_gap])

    if len({tuple(row) for row in feature_rows}) <= 1:
        return {
            "analysis_window_minutes": int(window_minutes),
            "votes_analyzed": len(timestamps),
            "suspicious_window_count": 0,
            "items": [],
            "note": "Voting activity is too uniform to isolate suspicious spikes.",
        }

    contamination = min(0.25, max(0.1, 2.0 / len(feature_rows)))
    model = IsolationForest(contamination=contamination, n_estimators=150, random_state=42)
    predictions = model.fit_predict(feature_rows)
    anomaly_scores = model.score_samples(feature_rows)

    suspicious_windows = []
    minimum_spike_votes = max(2, int(math.ceil(median_vote_count)))
    for window, prediction, score in zip(windows, predictions, anomaly_scores):
        faster_than_baseline = window["vote_count"] >= minimum_spike_votes or window["average_gap_seconds"] < median_gap_seconds
        if prediction != -1 or not faster_than_baseline:
            continue

        suspicious_windows.append(
            {
                **window,
                "anomaly_score": round(float(score), 6),
            }
        )

    merged_windows = _merge_windows(suspicious_windows)
    items = [
        {
            "window_start": _utc_iso(window["window_start_dt"]),
            "window_end": _utc_iso(window["window_end_dt"]),
            "vote_count": int(window["vote_count"]),
            "rate_per_minute": round(float(window["rate_per_minute"]), 4),
            "average_gap_seconds": round(float(window["average_gap_seconds"]), 2),
            "anomaly_score": round(float(window["anomaly_score"]), 6),
        }
        for window in merged_windows
    ]

    return {
        "analysis_window_minutes": int(window_minutes),
        "votes_analyzed": len(timestamps),
        "suspicious_window_count": len(items),
        "items": items,
    }
