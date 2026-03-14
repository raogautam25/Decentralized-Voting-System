from __future__ import annotations

from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer


_ANALYZER = SentimentIntensityAnalyzer()
_POSITIVE_THRESHOLD = 0.05
_NEGATIVE_THRESHOLD = -0.05


def _safe_int(value, default=0):
    try:
        return int(value)
    except Exception:
        return default


def analyze_feedback(feedback):
    normalized_feedback = " ".join(str(feedback or "").split()).strip()
    if not normalized_feedback:
        return None

    scores = _ANALYZER.polarity_scores(normalized_feedback)
    compound_score = round(float(scores.get("compound", 0.0)), 4)

    if compound_score >= _POSITIVE_THRESHOLD:
        sentiment_label = "Positive"
    elif compound_score <= _NEGATIVE_THRESHOLD:
        sentiment_label = "Negative"
    else:
        sentiment_label = "Neutral"

    return {
        "feedback": normalized_feedback,
        "sentiment_label": sentiment_label,
        "sentiment_score": compound_score,
        "sentiment_breakdown": {
            "positive": round(float(scores.get("pos", 0.0)), 4),
            "neutral": round(float(scores.get("neu", 0.0)), 4),
            "negative": round(float(scores.get("neg", 0.0)), 4),
        },
    }


def build_sentiment_report(vote_audit_collection, candidates_collection):
    summaries = {}

    for row in candidates_collection.find({}, {"_id": 0, "candidate_id": 1, "name": 1, "party": 1}).sort("candidate_id", 1):
        candidate_id = _safe_int(row.get("candidate_id"), None)
        if candidate_id is None:
            continue
        summaries[candidate_id] = {
            "candidate_id": candidate_id,
            "candidate_name": row.get("name") or f"Candidate {candidate_id}",
            "party": row.get("party"),
            "total_feedback": 0,
            "positive_count": 0,
            "neutral_count": 0,
            "negative_count": 0,
            "average_sentiment_score": 0.0,
        }

    cursor = vote_audit_collection.find(
        {"feedback": {"$exists": True, "$nin": [None, ""]}},
        {
            "_id": 0,
            "candidate_id": 1,
            "candidate_name": 1,
            "party": 1,
            "feedback": 1,
            "sentiment_label": 1,
            "sentiment_score": 1,
        },
    ).sort("candidate_id", 1)

    score_totals = {}
    for row in cursor:
        candidate_id = _safe_int(row.get("candidate_id"), None)
        if candidate_id is None:
            continue

        summary = summaries.setdefault(
            candidate_id,
            {
                "candidate_id": candidate_id,
                "candidate_name": row.get("candidate_name") or f"Candidate {candidate_id}",
                "party": row.get("party"),
                "total_feedback": 0,
                "positive_count": 0,
                "neutral_count": 0,
                "negative_count": 0,
                "average_sentiment_score": 0.0,
            },
        )
        if not summary.get("candidate_name"):
            summary["candidate_name"] = row.get("candidate_name") or f"Candidate {candidate_id}"
        if not summary.get("party"):
            summary["party"] = row.get("party")

        sentiment_label = row.get("sentiment_label")
        sentiment_score = row.get("sentiment_score")
        if sentiment_label is None or sentiment_score is None:
            analyzed = analyze_feedback(row.get("feedback"))
            if analyzed:
                sentiment_label = analyzed["sentiment_label"]
                sentiment_score = analyzed["sentiment_score"]

        summary["total_feedback"] += 1
        if sentiment_label == "Positive":
            summary["positive_count"] += 1
        elif sentiment_label == "Negative":
            summary["negative_count"] += 1
        else:
            summary["neutral_count"] += 1

        score_totals[candidate_id] = round(float(score_totals.get(candidate_id, 0.0)) + float(sentiment_score or 0.0), 4)

    items = []
    for candidate_id in sorted(summaries):
        summary = summaries[candidate_id]
        total_feedback = summary["total_feedback"]
        average_sentiment_score = round(score_totals.get(candidate_id, 0.0) / total_feedback, 4) if total_feedback else 0.0
        summary["average_sentiment_score"] = average_sentiment_score
        items.append(summary)

    return {
        "total_candidates": len(items),
        "candidates_with_feedback": sum(1 for item in items if item["total_feedback"] > 0),
        "items": items,
    }
