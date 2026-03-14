from __future__ import annotations

import datetime

import numpy as np
from sklearn.linear_model import LinearRegression


def _utc_iso(value):
    if value is None:
        return None
    if isinstance(value, datetime.datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=datetime.timezone.utc)
        return value.astimezone(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
    return str(value)


def _safe_int(value, default=0):
    try:
        return int(value)
    except Exception:
        return default


def _build_candidate_map(candidates_collection, vote_report_collection, vote_audit_rows):
    candidates_by_id = {}

    for row in candidates_collection.find({}, {"_id": 0, "candidate_id": 1, "name": 1, "party": 1}):
        candidate_id = _safe_int(row.get("candidate_id"), None)
        if candidate_id is None:
            continue
        candidates_by_id[candidate_id] = {
            "candidate_id": candidate_id,
            "candidate_name": row.get("name"),
            "party": row.get("party"),
            "current_vote_count": 0,
        }

    for row in vote_report_collection.find({}, {"_id": 0, "candidate_id": 1, "candidate_name": 1, "party": 1, "vote_count": 1}):
        candidate_id = _safe_int(row.get("candidate_id"), None)
        if candidate_id is None:
            continue
        entry = candidates_by_id.setdefault(
            candidate_id,
            {
                "candidate_id": candidate_id,
                "candidate_name": row.get("candidate_name"),
                "party": row.get("party"),
                "current_vote_count": 0,
            },
        )
        if not entry.get("candidate_name"):
            entry["candidate_name"] = row.get("candidate_name")
        if not entry.get("party"):
            entry["party"] = row.get("party")
        entry["current_vote_count"] = _safe_int(row.get("vote_count"), 0)

    for row in vote_audit_rows:
        candidate_id = _safe_int(row.get("candidate_id"), None)
        if candidate_id is None:
            continue
        entry = candidates_by_id.setdefault(
            candidate_id,
            {
                "candidate_id": candidate_id,
                "candidate_name": row.get("candidate_name"),
                "party": row.get("party"),
                "current_vote_count": 0,
            },
        )
        if not entry.get("candidate_name"):
            entry["candidate_name"] = row.get("candidate_name")
        if not entry.get("party"):
            entry["party"] = row.get("party")

    return candidates_by_id


def _build_cumulative_history(candidate_ids, vote_audit_rows):
    turnout_points = []
    series = {candidate_id: [] for candidate_id in candidate_ids}
    running_counts = {candidate_id: 0 for candidate_id in candidate_ids}

    for index, row in enumerate(vote_audit_rows, start=1):
        candidate_id = _safe_int(row.get("candidate_id"), None)
        if candidate_id is None:
            continue
        if candidate_id not in series:
            series[candidate_id] = [0] * (index - 1)
            running_counts[candidate_id] = 0
            candidate_ids.append(candidate_id)

        running_counts[candidate_id] += 1
        turnout_points.append(index)

        for tracked_candidate_id in candidate_ids:
            series.setdefault(tracked_candidate_id, [])
            running_counts.setdefault(tracked_candidate_id, 0)
            series[tracked_candidate_id].append(running_counts[tracked_candidate_id])

    return turnout_points, series


def _predict_final_votes(turnout_points, cumulative_votes, current_vote_count, prediction_target):
    current_vote_count = _safe_int(current_vote_count, 0)
    prediction_target = max(_safe_int(prediction_target, 0), len(turnout_points))

    if prediction_target == 0 or not turnout_points:
        return {
            "predicted_final_vote_count": current_vote_count,
            "trend_slope": 0.0,
            "model_fit": 0.0,
            "used_regression": False,
        }

    if len(turnout_points) == 1:
        single_point_projection = round((current_vote_count / turnout_points[0]) * prediction_target)
        return {
            "predicted_final_vote_count": max(current_vote_count, min(prediction_target, single_point_projection)),
            "trend_slope": float(current_vote_count),
            "model_fit": 0.0,
            "used_regression": False,
        }

    x = np.array(turnout_points, dtype=float).reshape(-1, 1)
    y = np.array(cumulative_votes, dtype=float)
    model = LinearRegression()
    model.fit(x, y)

    predicted = float(model.predict(np.array([[float(prediction_target)]], dtype=float))[0])
    predicted = round(max(float(current_vote_count), min(float(prediction_target), predicted)))

    try:
        model_fit = float(model.score(x, y))
    except Exception:
        model_fit = 0.0

    return {
        "predicted_final_vote_count": int(predicted),
        "trend_slope": round(float(model.coef_[0]), 6),
        "model_fit": round(max(0.0, min(1.0, model_fit)), 4),
        "used_regression": True,
    }


def generate_vote_prediction_report(voters_collection, candidates_collection, vote_report_collection, vote_audit_collection):
    total_registered_voters = voters_collection.count_documents({"is_active": True, "role": {"$ne": "admin"}})
    vote_audit_rows = list(
        vote_audit_collection.find(
            {},
            {"_id": 0, "candidate_id": 1, "candidate_name": 1, "party": 1, "voted_at": 1, "audit_id": 1},
        ).sort([("voted_at", 1), ("audit_id", 1)])
    )

    candidates_by_id = _build_candidate_map(candidates_collection, vote_report_collection, vote_audit_rows)
    if not candidates_by_id:
        return {
            "total_registered_voters": int(total_registered_voters),
            "votes_cast_so_far": len(vote_audit_rows),
            "turnout_progress_percent": 0.0,
            "predicted_winner": None,
            "confidence_percentage": 0.0,
            "generated_at": _utc_iso(datetime.datetime.now(datetime.timezone.utc)),
            "items": [],
        }

    candidate_ids = sorted(candidates_by_id)
    turnout_points, cumulative_history = _build_cumulative_history(candidate_ids, vote_audit_rows)
    votes_cast_so_far = len(vote_audit_rows)
    prediction_target = max(int(total_registered_voters), votes_cast_so_far)

    if votes_cast_so_far == 0:
        items = [
            {
                "candidate_id": candidate_id,
                "candidate_name": candidates_by_id[candidate_id].get("candidate_name") or f"Candidate {candidate_id}",
                "party": candidates_by_id[candidate_id].get("party"),
                "current_vote_count": 0,
                "predicted_final_vote_count": 0,
                "current_vote_share_percent": 0.0,
                "predicted_vote_share_percent": 0.0,
                "trend_slope_per_vote": 0.0,
                "model_fit_score": 0.0,
            }
            for candidate_id in sorted(candidates_by_id)
        ]
        return {
            "total_registered_voters": int(total_registered_voters),
            "votes_cast_so_far": 0,
            "turnout_progress_percent": 0.0,
            "predicted_winner": None,
            "confidence_percentage": 0.0,
            "generated_at": _utc_iso(datetime.datetime.now(datetime.timezone.utc)),
            "items": items,
        }

    items = []
    regression_scores = []

    for candidate_id in sorted(candidates_by_id):
        entry = candidates_by_id[candidate_id]
        current_vote_count = _safe_int(entry.get("current_vote_count"), 0)
        if votes_cast_so_far > 0 and current_vote_count == 0:
            current_vote_count = _safe_int(cumulative_history.get(candidate_id, [0])[-1], 0)

        prediction = _predict_final_votes(
            turnout_points=turnout_points,
            cumulative_votes=cumulative_history.get(candidate_id, []),
            current_vote_count=current_vote_count,
            prediction_target=prediction_target,
        )

        if prediction["used_regression"]:
            regression_scores.append(prediction["model_fit"])

        predicted_final_vote_count = prediction["predicted_final_vote_count"]
        items.append(
            {
                "candidate_id": candidate_id,
                "candidate_name": entry.get("candidate_name") or f"Candidate {candidate_id}",
                "party": entry.get("party"),
                "current_vote_count": current_vote_count,
                "predicted_final_vote_count": predicted_final_vote_count,
                "current_vote_share_percent": round((current_vote_count / votes_cast_so_far) * 100, 2) if votes_cast_so_far else 0.0,
                "predicted_vote_share_percent": round((predicted_final_vote_count / prediction_target) * 100, 2) if prediction_target else 0.0,
                "trend_slope_per_vote": prediction["trend_slope"],
                "model_fit_score": prediction["model_fit"],
            }
        )

    items.sort(key=lambda row: (-row["predicted_final_vote_count"], -row["current_vote_count"], row["candidate_id"]))
    predicted_winner = items[0] if items else None
    runner_up_votes = items[1]["predicted_final_vote_count"] if len(items) > 1 else 0

    turnout_ratio = min(1.0, (votes_cast_so_far / prediction_target)) if prediction_target else 0.0
    lead_margin_ratio = 0.0
    if predicted_winner and predicted_winner["predicted_final_vote_count"] > 0:
        lead_margin_ratio = max(
            0.0,
            (predicted_winner["predicted_final_vote_count"] - runner_up_votes) / predicted_winner["predicted_final_vote_count"],
        )

    average_model_fit = sum(regression_scores) / len(regression_scores) if regression_scores else 0.0
    confidence_percentage = 0.0
    if predicted_winner:
        confidence_percentage = round(
            max(5.0, min(99.0, 30.0 + (40.0 * turnout_ratio) + (20.0 * lead_margin_ratio) + (10.0 * average_model_fit))),
            2,
        )

    turnout_progress_percent = round((votes_cast_so_far / prediction_target) * 100, 2) if prediction_target else 0.0
    return {
        "total_registered_voters": int(total_registered_voters),
        "votes_cast_so_far": votes_cast_so_far,
        "turnout_progress_percent": turnout_progress_percent,
        "predicted_winner": {
            "candidate_id": predicted_winner["candidate_id"],
            "candidate_name": predicted_winner["candidate_name"],
            "party": predicted_winner["party"],
            "predicted_final_vote_count": predicted_winner["predicted_final_vote_count"],
        }
        if predicted_winner
        else None,
        "confidence_percentage": confidence_percentage,
        "generated_at": _utc_iso(datetime.datetime.now(datetime.timezone.utc)),
        "items": items,
    }
