import numpy as np
from sklearn.linear_model import LinearRegression


def _safe_int(value, default=0):
    try:
        return int(value)
    except Exception:
        return default


def _predict_final_votes(turnout_points, cumulative_votes, current_vote_count, prediction_target):
    current_vote_count = _safe_int(current_vote_count, 0)
    prediction_target = max(_safe_int(prediction_target, 0), len(turnout_points), current_vote_count)

    if prediction_target == 0 or not turnout_points:
        return {
            "predicted_final_vote_count": current_vote_count,
            "trend_slope": 0.0,
            "model_fit": 0.0,
            "used_regression": False,
        }

    if len(turnout_points) == 1:
        point = max(float(turnout_points[0]), 1.0)
        single_point_projection = round((current_vote_count / point) * prediction_target)
        return {
            "predicted_final_vote_count": max(current_vote_count, min(prediction_target, int(single_point_projection))),
            "trend_slope": round(current_vote_count / point, 4),
            "model_fit": 0.0,
            "used_regression": False,
        }

    features = np.array(turnout_points, dtype=float).reshape(-1, 1)
    targets = np.array(cumulative_votes, dtype=float)
    model = LinearRegression()
    model.fit(features, targets)

    predicted = float(model.predict(np.array([[float(prediction_target)]], dtype=float))[0])
    predicted = round(max(float(current_vote_count), min(float(prediction_target), predicted)))
    model_fit = model.score(features, targets)
    slope = float(model.coef_[0]) if getattr(model, "coef_", None) is not None else 0.0

    return {
        "predicted_final_vote_count": int(predicted),
        "trend_slope": round(slope, 4),
        "model_fit": round(max(0.0, min(1.0, float(model_fit))), 4),
        "used_regression": True,
    }


def generate_vote_prediction_report(voters_collection, candidates_collection, vote_report_collection, vote_audit_collection):
    total_registered_voters = voters_collection.count_documents({"role": "user", "is_active": {"$ne": False}})
    audit_rows = list(
        vote_audit_collection.find({}, {"_id": 0, "candidate_id": 1, "candidate_name": 1, "party": 1, "voted_at": 1}).sort("voted_at", 1)
    )

    if not audit_rows:
        return {
            "items": [],
            "votes_cast_so_far": 0,
            "turnout_progress_percent": 0.0,
            "confidence_percentage": 0.0,
            "predicted_winner": None,
        }

    candidates_by_id = {}
    for row in candidates_collection.find({}, {"_id": 0, "candidate_id": 1, "name": 1, "party": 1}):
        candidate_id = _safe_int(row.get("candidate_id"), 0)
        candidates_by_id[candidate_id] = {
            "candidate_name": row.get("name") or f"Candidate {candidate_id}",
            "party": row.get("party") or "",
        }

    votes_cast_so_far = len(audit_rows)
    prediction_target = max(int(total_registered_voters), votes_cast_so_far)
    cumulative_by_candidate = {}
    current_counts = {}
    names_from_audit = {}

    for index, row in enumerate(audit_rows, start=1):
        candidate_id = _safe_int(row.get("candidate_id"), 0)
        if candidate_id not in cumulative_by_candidate:
            cumulative_by_candidate[candidate_id] = {"turnout_points": [], "cumulative_votes": [], "running_total": 0}
        cumulative_by_candidate[candidate_id]["running_total"] += 1
        cumulative_by_candidate[candidate_id]["turnout_points"].append(index)
        cumulative_by_candidate[candidate_id]["cumulative_votes"].append(cumulative_by_candidate[candidate_id]["running_total"])
        current_counts[candidate_id] = current_counts.get(candidate_id, 0) + 1
        if candidate_id not in names_from_audit:
            names_from_audit[candidate_id] = {
                "candidate_name": row.get("candidate_name") or f"Candidate {candidate_id}",
                "party": row.get("party") or "",
            }

    items = []
    regression_scores = []

    candidate_ids = sorted(set(candidates_by_id.keys()) | set(current_counts.keys()))
    for candidate_id in candidate_ids:
        fallback_meta = candidates_by_id.get(candidate_id, names_from_audit.get(candidate_id, {}))
        current_vote_count = _safe_int(current_counts.get(candidate_id), 0)
        history = cumulative_by_candidate.get(candidate_id, {"turnout_points": [], "cumulative_votes": []})
        prediction = _predict_final_votes(
            turnout_points=history.get("turnout_points", []),
            cumulative_votes=history.get("cumulative_votes", []),
            current_vote_count=current_vote_count,
            prediction_target=prediction_target,
        )
        if prediction["used_regression"]:
            regression_scores.append(prediction["model_fit"])

        predicted_final_vote_count = prediction["predicted_final_vote_count"]
        items.append(
            {
                "candidate_id": candidate_id,
                "candidate_name": fallback_meta.get("candidate_name") or f"Candidate {candidate_id}",
                "party": fallback_meta.get("party") or "",
                "current_vote_count": current_vote_count,
                "predicted_final_vote_count": predicted_final_vote_count,
                "predicted_vote_share_percent": round((predicted_final_vote_count / prediction_target) * 100, 2) if prediction_target else 0.0,
                "trend_slope_per_vote": prediction["trend_slope"],
                "model_fit_score": prediction["model_fit"],
            }
        )

    items.sort(key=lambda row: (-row["predicted_final_vote_count"], -row["current_vote_count"], row["candidate_id"]))
    predicted_winner = items[0] if items else None

    confidence_percentage = round((sum(regression_scores) / len(regression_scores)) * 100, 2) if regression_scores else 0.0
    turnout_progress_percent = round((votes_cast_so_far / prediction_target) * 100, 2) if prediction_target else 0.0

    return {
        "items": items,
        "votes_cast_so_far": votes_cast_so_far,
        "turnout_progress_percent": turnout_progress_percent,
        "confidence_percentage": confidence_percentage,
        "predicted_winner": predicted_winner,
    }
