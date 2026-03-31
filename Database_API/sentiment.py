from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer


_ANALYZER = SentimentIntensityAnalyzer()


def analyze_feedback(feedback):
    text = str(feedback or "").strip()
    if not text:
        return None

    scores = _ANALYZER.polarity_scores(text)
    compound_score = round(float(scores.get("compound", 0.0)), 4)

    if compound_score >= 0.05:
        sentiment_label = "Positive"
    elif compound_score <= -0.05:
        sentiment_label = "Negative"
    else:
        sentiment_label = "Neutral"

    return {
        "feedback": text,
        "sentiment_label": sentiment_label,
        "sentiment_score": compound_score,
        "sentiment_breakdown": {
            "positive": round(float(scores.get("pos", 0.0)), 4),
            "neutral": round(float(scores.get("neu", 0.0)), 4),
            "negative": round(float(scores.get("neg", 0.0)), 4),
        },
    }


def build_sentiment_report(vote_audit_collection, candidates_collection):
    candidate_names = {}
    for row in candidates_collection.find({}, {"_id": 0, "candidate_id": 1, "name": 1}):
        candidate_names[int(row.get("candidate_id", 0) or 0)] = row.get("name") or f"Candidate {row.get('candidate_id')}"

    items_by_candidate = {}
    rows = vote_audit_collection.find(
        {},
        {
            "_id": 0,
            "candidate_id": 1,
            "candidate_name": 1,
            "feedback": 1,
            "sentiment_label": 1,
            "sentiment_score": 1,
        },
    )

    for row in rows:
        feedback = str(row.get("feedback") or "").strip()
        if not feedback:
            continue

        candidate_id = int(row.get("candidate_id", 0) or 0)
        if candidate_id not in items_by_candidate:
            items_by_candidate[candidate_id] = {
                "candidate_id": candidate_id,
                "candidate_name": row.get("candidate_name") or candidate_names.get(candidate_id) or f"Candidate {candidate_id}",
                "total_feedback": 0,
                "positive_count": 0,
                "neutral_count": 0,
                "negative_count": 0,
                "average_sentiment_score": 0.0,
            }

        sentiment_label = row.get("sentiment_label")
        sentiment_score = row.get("sentiment_score")
        if sentiment_label is None or sentiment_score is None:
            analyzed = analyze_feedback(feedback)
            sentiment_label = analyzed["sentiment_label"]
            sentiment_score = analyzed["sentiment_score"]

        item = items_by_candidate[candidate_id]
        item["total_feedback"] += 1
        if sentiment_label == "Positive":
            item["positive_count"] += 1
        elif sentiment_label == "Negative":
            item["negative_count"] += 1
        else:
            item["neutral_count"] += 1
        item["average_sentiment_score"] += float(sentiment_score or 0.0)

    items = []
    for item in items_by_candidate.values():
        total_feedback = int(item["total_feedback"] or 0)
        item["average_sentiment_score"] = round(item["average_sentiment_score"] / total_feedback, 4) if total_feedback else 0.0
        items.append(item)

    items.sort(key=lambda row: (-row["total_feedback"], row["candidate_id"]))
    return {
        "items": items,
        "candidates_with_feedback": len(items),
        "total_candidates": max(len(candidate_names), len(items)),
    }
