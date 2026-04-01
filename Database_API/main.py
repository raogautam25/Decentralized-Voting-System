import base64
import csv
import datetime
import glob
import io
import json
import os
import re
import secrets
import string
import traceback
import uuid
from urllib import error as urllib_error
from urllib import request as urllib_request
from urllib.parse import urlparse

import dotenv
from bson.binary import Binary
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pymongo import ASCENDING, DESCENDING, MongoClient, ReturnDocument
from pymongo.errors import DuplicateKeyError, PyMongoError

from anomaly_detection import generate_anomaly_report, require_admin_role
from duplicate_detection import analyze_image_bytes, compute_similarity_score, find_similar_image
from sentiment import analyze_feedback, build_sentiment_report
from vote_prediction import generate_vote_prediction_report

BASE_DIR = os.path.dirname(__file__)
ROOT_DIR = os.path.dirname(BASE_DIR)

dotenv.load_dotenv(os.path.join(BASE_DIR, ".env"), override=False)
dotenv.load_dotenv(os.path.join(ROOT_DIR, ".env"), override=False)

app = FastAPI()


def get_allowed_origins():
    allowed = {"http://localhost:8080", "http://127.0.0.1:8080"}
    configured_origins = os.environ.get("CORS_ALLOWED_ORIGINS", "")
    for origin in configured_origins.split(","):
        normalized = origin.strip().rstrip("/")
        if normalized:
            allowed.add(normalized)
    frontend_url = os.environ.get("FRONTEND_URL", "").strip().rstrip("/")
    if frontend_url:
        allowed.add(frontend_url)
    return sorted(allowed)


app.add_middleware(
    CORSMiddleware,
    allow_origins=get_allowed_origins(),
    allow_origin_regex=os.environ.get("CORS_ALLOW_ORIGIN_REGEX", r"https://.*\.vercel\.app"),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

MEDIA_DIR = os.path.join(BASE_DIR, "media")
os.makedirs(MEDIA_DIR, exist_ok=True)
app.mount("/media", StaticFiles(directory=MEDIA_DIR), name="media")

MINIMUM_AGE_YEARS = 18
DEFAULT_ELECTION_ID = "default-election"
VOTER_ID_ALPHABET = string.ascii_uppercase + string.digits
PRIMARY_ELECTION_CONFIG_ID = "primary"
LIVE_FACE_VERIFICATION_THRESHOLD = float(os.environ.get("LIVE_FACE_VERIFICATION_THRESHOLD", "0.90"))
CHAIN_RPC_URL = str(os.environ.get("RPC_URL", "https://ethereum-sepolia-rpc.publicnode.com")).strip()
CHAIN_RPC_FALLBACK_URLS = [
    item.strip()
    for item in str(os.environ.get("RPC_FALLBACK_URLS", "")).split(",")
    if item.strip()
]
CHAIN_CONTRACT_ADDRESS = str(os.environ.get("VOTING_CONTRACT_ADDRESS", "")).strip().lower()
GET_COUNT_CANDIDATES_SELECTOR = "0x0a84a217"
GET_CANDIDATE_SELECTOR = "0x35b8e820"
VOTE_CAST_EVENT_TOPIC = "0xb4cfecf70861b7b150d8337780d34fb4cbc2114b5fb1fe51a5c5fca1849f7274"

mongo_client = None
mongo_db = None
collections = {}


def resolve_chain_rpc_urls():
    candidates = [
        CHAIN_RPC_URL,
        *CHAIN_RPC_FALLBACK_URLS,
        "https://ethereum-sepolia.publicnode.com",
    ]
    urls = []
    for candidate in candidates:
        normalized = str(candidate or "").strip()
        if normalized and normalized not in urls:
            urls.append(normalized)
    return urls


def normalize_mongo_uri(raw_value):
    value = str(raw_value or "").strip()
    if not value:
        return ""
    if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
        value = value[1:-1].strip()
    return re.sub(r"^(?:MONGODB_URI|MONGO_URI)\s*=\s*", "", value, flags=re.IGNORECASE).strip()


def resolve_mongo_uri():
    for key in ("MONGODB_URI", "MONGO_URI"):
        value = normalize_mongo_uri(os.environ.get(key))
        if value:
            return value
    return ""


def resolve_mongo_db_name(uri):
    explicit = (
        os.environ.get("MONGO_DB_NAME")
        or os.environ.get("MONGODB_DB")
        or os.environ.get("MONGO_DATABASE")
        or os.environ.get("DB_NAME")
        or ""
    ).strip()
    if explicit:
        return explicit
    try:
        parsed = urlparse(uri)
        name = parsed.path.lstrip("/").split("/", 1)[0]
        if name:
            return name
    except Exception:
        pass
    return "votingDB"


def utc_now():
    return datetime.datetime.now(datetime.timezone.utc)


def stringify_datetime(value):
    if value is None:
        return None
    if isinstance(value, datetime.datetime):
        return value.astimezone(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
    return str(value)


def normalize_name(value):
    return re.sub(r"\s+", " ", str(value or "").strip()).lower()


def normalize_feedback_text(value):
    text = str(value or "").strip()
    return text or None


def normalize_address(value):
    value = str(value or "").strip().lower()
    if not value:
        return ""
    if not value.startswith("0x"):
        value = f"0x{value}"
    return value


def calculate_age(date_of_birth, today=None):
    today = today or datetime.date.today()
    return today.year - date_of_birth.year - ((today.month, today.day) < (date_of_birth.month, date_of_birth.day))


def ensure_minimum_age(date_of_birth, subject_label):
    if calculate_age(date_of_birth) < MINIMUM_AGE_YEARS:
        raise HTTPException(status_code=400, detail=f"{subject_label} must be at least {MINIMUM_AGE_YEARS} years old")


def parse_iso_date(raw_value, field_name="date_of_birth"):
    try:
        parsed = datetime.date.fromisoformat((raw_value or "").strip())
    except Exception:
        raise HTTPException(status_code=400, detail=f"{field_name} must be YYYY-MM-DD")
    if parsed >= datetime.date.today():
        raise HTTPException(status_code=400, detail=f"{field_name} must be in the past")
    return parsed


def slugify(value):
    normalized = re.sub(r"[^a-zA-Z0-9]+", "-", str(value or "").strip().lower()).strip("-")
    return normalized or DEFAULT_ELECTION_ID


def derive_election_id(payload):
    explicit = (payload.get("election_id") or "").strip()
    return slugify(explicit or payload.get("election_name") or DEFAULT_ELECTION_ID)


def save_image_bytes(image_bytes, mime, prefix):
    if not image_bytes:
        return None
    ext = "jpg"
    if mime == "image/png":
        ext = "png"
    elif mime == "image/webp":
        ext = "webp"
    filename = f"{prefix}_{uuid.uuid4().hex}.{ext}"
    rel_path = os.path.join("media", filename)
    abs_path = os.path.join(os.path.dirname(__file__), rel_path)
    with open(abs_path, "wb") as file_obj:
        file_obj.write(image_bytes)
    return rel_path.replace("\\", "/")


def decode_image_bytes_from_data_url(data_url):
    raw = str(data_url or "").strip()
    if not raw:
        raise HTTPException(status_code=400, detail="Image data is required")
    match = re.match(r"^data:(?P<mime>[\w/+.-]+);base64,(?P<data>.+)$", raw, flags=re.DOTALL)
    mime = match.group("mime") if match else "image/jpeg"
    encoded = match.group("data") if match else raw
    try:
        image_bytes = base64.b64decode(encoded, validate=False)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid image data")
    if not image_bytes:
        raise HTTPException(status_code=400, detail="Image data is empty")
    return image_bytes, mime


def save_image_from_data_url(data_url, prefix):
    image_bytes, mime = decode_image_bytes_from_data_url(data_url)
    return save_image_bytes(image_bytes, mime, prefix)


def rpc_call(method, params):
    rpc_urls = resolve_chain_rpc_urls()
    if not rpc_urls:
        raise HTTPException(
            status_code=503,
            detail="Blockchain live report is unavailable because RPC_URL is not configured on the backend.",
        )

    payload = json.dumps(
        {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
    ).encode("utf-8")
    failures = []

    for rpc_url in rpc_urls:
        http_request = urllib_request.Request(
            rpc_url,
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib_request.urlopen(http_request, timeout=15) as response:
                data = json.loads(response.read().decode("utf-8"))
        except urllib_error.HTTPError as error:
            response_body = ""
            try:
                response_body = error.read().decode("utf-8", errors="ignore").strip()
            except Exception:
                response_body = ""
            detail = f"{rpc_url} -> HTTP {getattr(error, 'code', 'error')}"
            if response_body:
                detail += f" {response_body[:180]}"
            failures.append(detail)
            continue
        except Exception as error:
            failures.append(f"{rpc_url} -> {error}")
            continue

        if data.get("error"):
            rpc_error = data["error"]
            rpc_error_text = str(rpc_error)
            lowered_error_text = rpc_error_text.lower()
            if any(token in lowered_error_text for token in ("forbidden", "denied", "limit", "temporar", "unavailable")):
                failures.append(f"{rpc_url} -> RPC error {rpc_error_text}")
                continue
            raise HTTPException(status_code=502, detail=f"Blockchain RPC error: {rpc_error}")

        return data.get("result")

    failure_summary = " | ".join(failures) if failures else "Unknown RPC transport failure"
    raise HTTPException(status_code=502, detail=f"Blockchain RPC request failed: {failure_summary}")


def hex_to_int(value):
    try:
        return int(str(value or "0x0"), 16)
    except Exception:
        return 0


def decode_abi_string(raw_bytes, offset):
    if offset < 0 or offset + 32 > len(raw_bytes):
        return ""
    length = int.from_bytes(raw_bytes[offset:offset + 32], "big")
    start = offset + 32
    end = start + length
    if start < 0 or end > len(raw_bytes):
        return ""
    try:
        return raw_bytes[start:end].decode("utf-8", errors="ignore")
    except Exception:
        return ""


def eth_call_contract(data):
    if not CHAIN_CONTRACT_ADDRESS:
        raise HTTPException(
            status_code=503,
            detail="Blockchain live report is unavailable because VOTING_CONTRACT_ADDRESS is not configured on the backend.",
        )
    return rpc_call("eth_call", [{"to": CHAIN_CONTRACT_ADDRESS, "data": data}, "latest"])


def get_onchain_candidate_count():
    result = eth_call_contract(GET_COUNT_CANDIDATES_SELECTOR)
    return hex_to_int(result)


def get_onchain_candidate(candidate_id):
    try:
        candidate_id = int(candidate_id)
    except Exception:
        raise HTTPException(status_code=400, detail="candidate_id must be an integer")

    call_data = f"{GET_CANDIDATE_SELECTOR}{candidate_id:064x}"
    raw = str(eth_call_contract(call_data) or "0x")
    encoded = bytes.fromhex(raw[2:] if raw.startswith("0x") else raw)
    if len(encoded) < 128:
        raise HTTPException(status_code=502, detail="Unexpected blockchain candidate response")

    resolved_candidate_id = int.from_bytes(encoded[0:32], "big")
    name_offset = int.from_bytes(encoded[32:64], "big")
    party_offset = int.from_bytes(encoded[64:96], "big")
    vote_count = int.from_bytes(encoded[96:128], "big")

    return {
        "candidate_id": resolved_candidate_id,
        "name": decode_abi_string(encoded, name_offset),
        "party": decode_abi_string(encoded, party_offset),
        "vote_count": vote_count,
    }


def get_onchain_candidate_results():
    count = get_onchain_candidate_count()
    results = []
    for candidate_id in range(1, count + 1):
        candidate = get_onchain_candidate(candidate_id)
        if candidate["candidate_id"]:
            results.append(candidate)
    results.sort(key=lambda row: (-row["vote_count"], row["candidate_id"]))
    return results


def verify_vote_tx_hash(tx_hash, expected_candidate_id):
    clean_hash = str(tx_hash or "").strip()
    if not clean_hash or not clean_hash.startswith("0x"):
        raise HTTPException(status_code=400, detail="tx_hash is required and must start with 0x")
    if not CHAIN_CONTRACT_ADDRESS:
        raise HTTPException(status_code=503, detail="VOTING_CONTRACT_ADDRESS is not configured")

    receipt = rpc_call("eth_getTransactionReceipt", [clean_hash])
    if not receipt:
        raise HTTPException(status_code=409, detail="Transaction receipt not found yet")
    if str(receipt.get("status", "")).lower() not in {"0x1", "1", "true"}:
        raise HTTPException(status_code=409, detail="Vote transaction failed on-chain")

    expected_candidate_id = int(expected_candidate_id)
    contract_address = normalize_address(CHAIN_CONTRACT_ADDRESS)
    logs = receipt.get("logs") or []
    for log in logs:
        if normalize_address(log.get("address")) != contract_address:
            continue
        topics = log.get("topics") or []
        if len(topics) < 3:
            continue
        if str(topics[0]).lower() != VOTE_CAST_EVENT_TOPIC:
            continue
        candidate_from_log = hex_to_int(topics[2])
        if candidate_from_log != expected_candidate_id:
            raise HTTPException(
                status_code=409,
                detail=f"Vote transaction candidate mismatch. On-chain candidate: {candidate_from_log}, provided: {expected_candidate_id}",
            )
        voter_topic = str(topics[1] or "")
        voter_address = f"0x{voter_topic[-40:]}".lower() if len(voter_topic) >= 42 else ""
        timestamp = hex_to_int(log.get("data"))
        return {
            "tx_hash": clean_hash,
            "candidate_id": candidate_from_log,
            "block_number": hex_to_int(receipt.get("blockNumber")),
            "voter_address": voter_address,
            "timestamp": timestamp,
        }

    raise HTTPException(status_code=409, detail="VoteCast event not found for the configured voting contract")


def ensure_schema():
    voters = collections["voters"]
    candidates = collections["candidates"]
    nominations = collections["candidate_nominations"]
    election_config = collections["election_config"]
    vote_audit = collections["vote_audit"]
    vote_report_live = collections["vote_report_live"]

    voters.create_index([("voter_id", ASCENDING)], unique=True, name="uq_voter_id")
    voters.create_index([("qr_token", ASCENDING)], unique=True, sparse=True, name="uq_qr_token")
    voters.create_index(
        [("normalized_full_name", ASCENDING), ("date_of_birth", ASCENDING), ("is_active", ASCENDING)],
        name="idx_voter_duplicate_lookup",
    )

    candidates.create_index([("candidate_id", ASCENDING)], unique=True, name="uq_candidate_id")

    nominations.create_index(
        [("candidate_id", ASCENDING), ("election_id", ASCENDING)],
        unique=True,
        sparse=True,
        name="uq_nomination_candidate_election",
    )
    nominations.create_index(
        [("election_id", ASCENDING), ("normalized_full_name", ASCENDING), ("date_of_birth", ASCENDING), ("id_number", ASCENDING)],
        unique=True,
        name="uq_nomination_person_election",
    )
    nominations.create_index(
        [("normalized_full_name", ASCENDING), ("date_of_birth", ASCENDING), ("contact_number", ASCENDING), ("id_number", ASCENDING)],
        name="idx_nomination_duplicate_lookup",
    )

    vote_audit.create_index([("audit_id", ASCENDING)], unique=True, name="uq_vote_audit_id")
    vote_audit.create_index([("voter_id", ASCENDING)], unique=True, name="uq_vote_audit_voter")
    vote_audit.create_index([("tx_hash", ASCENDING)], unique=True, sparse=True, name="uq_vote_audit_tx_hash")
    vote_report_live.create_index([("candidate_id", ASCENDING)], unique=True, name="uq_vote_report_candidate")

    election_config.update_one(
        {"_id": PRIMARY_ELECTION_CONFIG_ID},
        {
            "$setOnInsert": {
                "start_ts": 0,
                "end_ts": 0,
                "status": "running",
                "updated_at": utc_now(),
                "reconduct_count": 0,
                "stopped_at": None,
            }
        },
        upsert=True,
    )

    admin_username = os.environ.get("ADMIN_USERNAME", "admin001").strip() or "admin001"
    admin_password = os.environ.get("ADMIN_PASSWORD", "admin123")
    admin_full_name = os.environ.get("ADMIN_FULL_NAME", "System Admin").strip() or "System Admin"
    voters.update_one(
        {"voter_id": admin_username},
        {
            "$setOnInsert": {
                "voter_id": admin_username,
                "password": admin_password,
                "role": "admin",
                "full_name": admin_full_name,
                "normalized_full_name": normalize_name(admin_full_name),
                "date_of_birth": None,
                "image_path": None,
                "photo_path": None,
                "qr_token": None,
                "is_active": True,
                "created_at": utc_now(),
            }
        },
        upsert=True,
    )


def init_mongo():
    global mongo_client, mongo_db, collections
    if mongo_db is not None:
        return mongo_db

    mongo_uri = resolve_mongo_uri()
    if not mongo_uri:
        raise RuntimeError("MONGODB_URI or MONGO_URI must be configured for Database_API")

    timeout_ms = int(os.environ.get("MONGO_SERVER_SELECTION_TIMEOUT_MS", "10000"))
    mongo_client = MongoClient(mongo_uri, serverSelectionTimeoutMS=timeout_ms)
    mongo_client.admin.command("ping")
    mongo_db = mongo_client[resolve_mongo_db_name(mongo_uri)]
    collections = {
        "voters": mongo_db["voters"],
        "candidates": mongo_db["candidates"],
        "candidate_nominations": mongo_db["candidate_nominations"],
        "election_config": mongo_db["election_config"],
        "vote_audit": mongo_db["vote_audit"],
        "vote_report_live": mongo_db["vote_report_live"],
        "counters": mongo_db["counters"],
    }
    ensure_schema()
    return mongo_db


def coll(name):
    if mongo_db is None:
        init_mongo()
    return collections[name]


def next_sequence(sequence_name):
    result = coll("counters").find_one_and_update(
        {"_id": sequence_name},
        {"$inc": {"seq": 1}},
        upsert=True,
        return_document=ReturnDocument.AFTER,
    )
    return int(result.get("seq", 1))


def get_election_state():
    doc = coll("election_config").find_one({"_id": PRIMARY_ELECTION_CONFIG_ID}) or {}
    return {
        "start_ts": int(doc.get("start_ts", 0) or 0),
        "end_ts": int(doc.get("end_ts", 0) or 0),
        "status": doc.get("status") or "running",
        "updated_at": stringify_datetime(doc.get("updated_at")),
        "reconduct_count": int(doc.get("reconduct_count", 0) or 0),
        "stopped_at": stringify_datetime(doc.get("stopped_at")),
    }


def ensure_election_running():
    state = get_election_state()
    if state["status"] == "stopped":
        raise HTTPException(status_code=409, detail="Election is currently stopped")
    return state


def generate_unique_voter_id():
    for _ in range(64):
        candidate = "".join(secrets.choice(VOTER_ID_ALPHABET) for _ in range(10))
        if not coll("voters").find_one({"voter_id": candidate}, {"_id": 1}):
            return candidate
    raise HTTPException(status_code=500, detail="Unable to generate a unique voter ID")


def candidate_exists_in_database(full_name, date_of_birth, contact_number, id_number):
    return coll("candidate_nominations").find_one(
        {
            "$or": [
                {"id_number": id_number},
                {
                    "normalized_full_name": normalize_name(full_name),
                    "date_of_birth": date_of_birth.isoformat(),
                    "contact_number": contact_number or "",
                },
            ]
        },
        {"_id": 1},
    ) is not None


def candidate_exists_for_election(election_id, full_name, date_of_birth, id_number, party_name=None):
    return coll("candidate_nominations").find_one(
        {
            "election_id": election_id,
            "$or": [
                {"id_number": id_number},
                {
                    "normalized_full_name": normalize_name(full_name),
                    "date_of_birth": date_of_birth.isoformat(),
                    "party_name": party_name,
                },
            ],
        },
        {"_id": 1},
    ) is not None


def candidate_id_exists_for_election(candidate_id, election_id):
    if candidate_id in (None, ""):
        return False
    return coll("candidate_nominations").find_one(
        {"candidate_id": int(candidate_id), "election_id": election_id},
        {"_id": 1},
    ) is not None


def find_existing_voter_duplicate(full_name, date_of_birth, image_bytes):
    rows = coll("voters").find(
        {"is_active": True},
        {"voter_id": 1, "full_name": 1, "normalized_full_name": 1, "date_of_birth": 1, "image_path": 1, "photo_path": 1},
    )
    normalized_full_name = normalize_name(full_name)
    dob_iso = date_of_birth.isoformat()
    existing_paths = []
    for row in rows:
        if row.get("normalized_full_name") == normalized_full_name and row.get("date_of_birth") == dob_iso:
            return {
                "reason": "identity_match",
                "matched_voter_id": row.get("voter_id"),
                "matched_full_name": row.get("full_name"),
                "matched_date_of_birth": row.get("date_of_birth"),
            }
        rel_path = row.get("image_path") or row.get("photo_path")
        if rel_path:
            existing_paths.append(
                {
                    "path": rel_path,
                    "matched_voter_id": row.get("voter_id"),
                    "matched_full_name": row.get("full_name"),
                    "matched_date_of_birth": row.get("date_of_birth"),
                    "reason": "face_match",
                }
            )
    if not existing_paths:
        return None
    return find_similar_image(image_bytes, existing_paths, os.path.dirname(__file__))


def get_voter_photo_path(voter):
    return voter.get("image_path") or voter.get("photo_path")


def validate_single_face_image(image_bytes, context_label):
    analysis = analyze_image_bytes(image_bytes)
    if analysis["face_count"] == 0:
        raise HTTPException(
            status_code=400,
            detail=f"No clear face detected in the {context_label}. Please use a front-facing photo with good lighting.",
        )
    if analysis["face_count"] > 1:
        raise HTTPException(
            status_code=400,
            detail=f"Multiple faces detected in the {context_label}. Please keep only one voter in frame.",
        )
    if analysis.get("frontal_face_count", 0) == 0:
        raise HTTPException(
            status_code=400,
            detail=f"A straight front-facing face is required in the {context_label}. Please look directly at the camera.",
        )
    return analysis


def verify_live_face_against_voter(voter, image_bytes, context_label="live photo"):
    photo_path = get_voter_photo_path(voter)
    if not photo_path:
        raise HTTPException(status_code=500, detail="Registered voter photo is missing")

    analysis = validate_single_face_image(image_bytes, context_label)
    score = compute_similarity_score(image_bytes, photo_path, os.path.dirname(__file__))
    matched = score >= LIVE_FACE_VERIFICATION_THRESHOLD
    return {
        "matched": matched,
        "score": round(float(score), 4),
        "threshold": LIVE_FACE_VERIFICATION_THRESHOLD,
        "face_count": analysis["face_count"],
        "photo_path": photo_path,
    }


def refresh_vote_rankings():
    rows = list(coll("vote_report_live").find({}, {"_id": 0}).sort([("vote_count", DESCENDING), ("candidate_id", ASCENDING)]))
    updated_at = utc_now()
    for rank, row in enumerate(rows, start=1):
        coll("vote_report_live").update_one(
            {"candidate_id": row["candidate_id"]},
            {"$set": {"rank_position": rank, "updated_at": updated_at}},
        )


@app.on_event("startup")
def startup_event():
    init_mongo()


@app.post("/admin/voters")
async def add_voter(request: Request):
    payload = await request.json()
    full_name = (payload.get("full_name") or "").strip()
    dob_raw = (payload.get("date_of_birth") or "").strip()
    photo_data = payload.get("photo_data")

    if not full_name or not dob_raw:
        raise HTTPException(status_code=400, detail="full_name and date_of_birth are required")
    if not photo_data:
        raise HTTPException(status_code=400, detail="photo_data is required")

    date_of_birth = parse_iso_date(dob_raw)
    ensure_minimum_age(date_of_birth, "Voter")
    photo_bytes, photo_mime = decode_image_bytes_from_data_url(photo_data)
    photo_analysis = validate_single_face_image(photo_bytes, "uploaded image")

    duplicate_match = find_existing_voter_duplicate(full_name, date_of_birth, photo_bytes)
    if duplicate_match:
        if duplicate_match.get("reason") == "identity_match":
            raise HTTPException(
                status_code=409,
                detail=(
                    "Voter already exists in database with the same full name and date of birth. "
                    f"Existing voter ID: {duplicate_match.get('matched_voter_id')}"
                ),
            )
        raise HTTPException(
            status_code=409,
            detail=(
                "Face image closely matches an existing voter record. "
                f"Matched voter ID: {duplicate_match.get('matched_voter_id')}, "
                f"matched name: {duplicate_match.get('matched_full_name')}, "
                f"matched date of birth: {duplicate_match.get('matched_date_of_birth')}, "
                f"similarity score: {duplicate_match.get('score')}"
            ),
        )

    voter_id = generate_unique_voter_id()
    image_path = save_image_bytes(photo_bytes, photo_mime, f"voter_{voter_id}")
    qr_token = f"VOTER::{voter_id}::{uuid.uuid4().hex[:10]}"
    now = utc_now()

    try:
        coll("voters").insert_one(
            {
                "voter_id": voter_id,
                "password": None,
                "role": "user",
                "full_name": full_name,
                "normalized_full_name": normalize_name(full_name),
                "date_of_birth": date_of_birth.isoformat(),
                "image_path": image_path,
                "photo_path": image_path,
                "qr_token": qr_token,
                "is_active": True,
                "face_count": photo_analysis["face_count"],
                "face_match_version": 2,
                "created_at": now,
                "updated_at": now,
            }
        )
    except DuplicateKeyError:
        raise HTTPException(status_code=409, detail="Generated voter ID or QR token already exists")
    except PyMongoError as err:
        print(err)
        raise HTTPException(status_code=500, detail="Failed to save voter")

    return {
        "message": "Voter saved",
        "voter_id": voter_id,
        "full_name": full_name,
        "date_of_birth": date_of_birth.isoformat(),
        "role": "user",
        "qr_token": qr_token,
        "image_path": image_path,
        "photo_path": image_path,
    }


@app.get("/voter/by-qr")
async def get_voter_by_qr(qr_token: str):
    ensure_election_running()
    voter = coll("voters").find_one(
        {"qr_token": qr_token, "is_active": True},
        {"_id": 0, "voter_id": 1, "full_name": 1, "role": 1, "image_path": 1, "photo_path": 1, "qr_token": 1, "date_of_birth": 1},
    )
    if not voter:
        raise HTTPException(status_code=404, detail="Voter not found for this QR")

    image_path = voter.get("image_path") or voter.get("photo_path")
    return {
        "voter_id": voter["voter_id"],
        "full_name": voter.get("full_name"),
        "role": voter.get("role"),
        "photo_path": image_path,
        "image_path": image_path,
        "qr_token": voter.get("qr_token"),
        "date_of_birth": voter.get("date_of_birth"),
    }


@app.get("/candidates")
async def list_candidates():
    items = []
    onchain_votes = {}
    try:
        onchain_votes = {item["candidate_id"]: item["vote_count"] for item in get_onchain_candidate_results()}
    except HTTPException:
        onchain_votes = {}

    for row in coll("candidates").find({}, {"_id": 0}).sort("candidate_id", ASCENDING):
        items.append(
            {
                "candidate_id": int(row["candidate_id"]),
                "name": row.get("name"),
                "party": row.get("party"),
                "symbol": row.get("symbol"),
                "vote_count": int(onchain_votes.get(row["candidate_id"], 0)),
                "party_symbol_image": row.get("party_symbol_image"),
                "date_of_birth": row.get("date_of_birth"),
            }
        )
    return {"items": items}


@app.post("/admin/candidates")
async def upsert_candidate(request: Request):
    payload = await request.json()
    candidate_id = payload.get("candidate_id")
    name = (payload.get("name") or "").strip()
    party = (payload.get("party") or "").strip()
    symbol = (payload.get("symbol") or "").strip()
    dob_raw = (payload.get("date_of_birth") or "").strip()
    party_symbol_image = (payload.get("party_symbol_image") or "").strip()

    if not candidate_id or not name or not party:
        raise HTTPException(status_code=400, detail="candidate_id, name, party are required")
    try:
        candidate_id = int(candidate_id)
    except Exception:
        raise HTTPException(status_code=400, detail="candidate_id must be an integer")

    candidate_dob = parse_iso_date(dob_raw).isoformat() if dob_raw else None
    now = utc_now()

    try:
        coll("candidates").update_one(
            {"candidate_id": candidate_id},
            {
                "$set": {
                    "name": name,
                    "party": party,
                    "symbol": symbol or None,
                    "date_of_birth": candidate_dob,
                    "party_symbol_image": party_symbol_image or None,
                    "updated_at": now,
                },
                "$setOnInsert": {"created_at": now},
            },
            upsert=True,
        )
    except PyMongoError as err:
        print(err)
        raise HTTPException(status_code=500, detail="Failed to save candidate")

    return {
        "message": "Candidate saved",
        "candidate_id": candidate_id,
        "name": name,
        "party": party,
        "symbol": symbol or None,
        "party_symbol_image": party_symbol_image or None,
        "date_of_birth": candidate_dob,
    }


@app.get("/admin/candidate-nominations/keys")
async def list_candidate_nomination_keys():
    items = []
    rows = coll("candidate_nominations").find(
        {},
        {
            "_id": 0,
            "candidate_id": 1,
            "election_id": 1,
            "full_name": 1,
            "date_of_birth": 1,
            "contact_number": 1,
            "id_number": 1,
            "party_name": 1,
            "created_at": 1,
        },
    ).sort("created_at", DESCENDING)
    for row in rows:
        items.append(
            {
                "candidate_id": row.get("candidate_id"),
                "election_id": row.get("election_id"),
                "full_name": row.get("full_name"),
                "date_of_birth": row.get("date_of_birth"),
                "contact_number": row.get("contact_number"),
                "id_number": row.get("id_number"),
                "party_name": row.get("party_name"),
            }
        )
    return {"items": items}


@app.post("/admin/candidate-nominations/check")
async def check_candidate_nomination(request: Request):
    payload = await request.json()
    election_id = derive_election_id(payload)
    full_name = (payload.get("full_name") or "").strip()
    dob_raw = (payload.get("date_of_birth") or "").strip()
    id_number = (payload.get("id_number") or "").strip()
    contact_number = (payload.get("contact_number") or "").strip()
    party_name = (payload.get("party_name") or "").strip()
    is_independent = bool(payload.get("is_independent"))

    if not full_name or not dob_raw or not id_number:
        raise HTTPException(status_code=400, detail="full_name, date_of_birth, id_number are required")

    dob = parse_iso_date(dob_raw)
    ensure_minimum_age(dob, "Candidate")

    if is_independent:
        party_name = ""
    elif not party_name:
        raise HTTPException(status_code=400, detail="party_name is required unless is_independent is true")

    if contact_number and not contact_number.isdigit():
        raise HTTPException(status_code=400, detail="contact_number must be numeric")

    if candidate_exists_in_database(full_name, dob, contact_number, id_number):
        raise HTTPException(status_code=409, detail="Candidate already exists in database with the same identity details")
    if candidate_exists_for_election(election_id, full_name, dob, id_number, None if is_independent else party_name):
        raise HTTPException(status_code=409, detail="Candidate is already registered for this election with the same identity or party details")

    return {"ok": True, "election_id": election_id}


@app.post("/admin/candidate-nominations")
async def create_candidate_nomination(request: Request):
    payload = await request.json()
    candidate_id = payload.get("candidate_id")
    election_id = derive_election_id(payload)
    election_name = (payload.get("election_name") or "").strip()
    position = (payload.get("position") or "").strip()
    full_name = (payload.get("full_name") or "").strip()
    dob_raw = (payload.get("date_of_birth") or "").strip()
    address = (payload.get("address") or "").strip()
    contact_number = (payload.get("contact_number") or "").strip()
    id_number = (payload.get("id_number") or "").strip()
    party_name = (payload.get("party_name") or "").strip()
    party_symbol = (payload.get("party_symbol") or "").strip()
    party_symbol_image_data = payload.get("party_symbol_image_data")
    party_symbol_image_path = (payload.get("party_symbol_image") or "").strip()
    is_independent = bool(payload.get("is_independent"))

    if not full_name or not dob_raw or not id_number:
        raise HTTPException(status_code=400, detail="full_name, date_of_birth, id_number are required")

    dob = parse_iso_date(dob_raw)
    ensure_minimum_age(dob, "Candidate")

    if contact_number and not contact_number.isdigit():
        raise HTTPException(status_code=400, detail="contact_number must be numeric")

    if is_independent:
        party_name = None
        party_symbol = None
        party_symbol_image_path = None
        contact_number = contact_number or ""
    else:
        if not party_name:
            raise HTTPException(status_code=400, detail="party_name is required unless is_independent is true")
        if party_symbol == "":
            party_symbol = None
        if party_symbol_image_data:
            party_symbol_image_path = save_image_from_data_url(
                party_symbol_image_data,
                f"party_symbol_{slugify(party_name)}",
            )

    if candidate_exists_in_database(full_name, dob, contact_number, id_number):
        raise HTTPException(status_code=409, detail="Candidate already exists in database with the same identity details")
    if candidate_exists_for_election(election_id, full_name, dob, id_number, None if is_independent else party_name):
        raise HTTPException(status_code=409, detail="Candidate is already registered for this election with the same identity or party details")
    if candidate_id_exists_for_election(candidate_id, election_id):
        raise HTTPException(status_code=409, detail="Candidate is already registered for this election")

    if candidate_id not in (None, ""):
        try:
            candidate_id = int(candidate_id)
        except Exception:
            raise HTTPException(status_code=400, detail="candidate_id must be an integer")
    else:
        candidate_id = None

    now = utc_now()
    try:
        coll("candidate_nominations").insert_one(
            {
                "candidate_nomination_id": next_sequence("candidate_nominations"),
                "candidate_id": candidate_id,
                "election_id": election_id,
                "election_name": election_name or None,
                "position": position or None,
                "full_name": full_name,
                "normalized_full_name": normalize_name(full_name),
                "date_of_birth": dob.isoformat(),
                "address": address or None,
                "contact_number": contact_number or "",
                "id_number": id_number,
                "party_name": party_name,
                "party_symbol": party_symbol or None,
                "party_symbol_image": party_symbol_image_path or None,
                "is_independent": is_independent,
                "created_at": now,
                "updated_at": now,
            }
        )
    except DuplicateKeyError:
        raise HTTPException(status_code=409, detail="Candidate is already registered for this election")
    except PyMongoError as err:
        print(err)
        raise HTTPException(status_code=500, detail="Failed to save candidate nomination")

    return {
        "message": "Candidate nomination created",
        "candidate_id": candidate_id,
        "election_id": election_id,
        "party_symbol_image": party_symbol_image_path or None,
    }


@app.get("/election/dates")
async def get_election_dates():
    return get_election_state()


@app.post("/admin/election/dates")
async def set_election_dates(request: Request):
    payload = await request.json()
    start_ts = payload.get("start_ts")
    end_ts = payload.get("end_ts")
    try:
        start_ts = int(start_ts)
        end_ts = int(end_ts)
    except Exception:
        raise HTTPException(status_code=400, detail="start_ts and end_ts must be integers (unix seconds)")
    if end_ts <= start_ts:
        raise HTTPException(status_code=400, detail="end_ts must be greater than start_ts")

    coll("election_config").update_one(
        {"_id": PRIMARY_ELECTION_CONFIG_ID},
        {"$set": {"start_ts": start_ts, "end_ts": end_ts, "status": "running", "stopped_at": None, "updated_at": utc_now()}},
        upsert=True,
    )
    return {"message": "Election dates saved", "start_ts": start_ts, "end_ts": end_ts, "status": "running"}


@app.post("/admin/election/stop")
async def emergency_stop_election():
    coll("election_config").update_one(
        {"_id": PRIMARY_ELECTION_CONFIG_ID},
        {"$set": {"status": "stopped", "stopped_at": utc_now(), "updated_at": utc_now()}},
        upsert=True,
    )
    return {"message": "Election stopped successfully", **get_election_state()}


@app.post("/admin/election/restart")
async def restart_election(request: Request):
    payload = await request.json()
    reset_results = bool(payload.get("reset_results"))
    start_ts = payload.get("start_ts")
    end_ts = payload.get("end_ts")

    if reset_results:
        coll("vote_audit").delete_many({})
        coll("vote_report_live").delete_many({})
        coll("counters").delete_one({"_id": "vote_audit"})

    update_fields = {"status": "running", "stopped_at": None, "updated_at": utc_now()}
    if start_ts is not None and end_ts is not None:
        try:
            start_ts = int(start_ts)
            end_ts = int(end_ts)
        except Exception:
            raise HTTPException(status_code=400, detail="start_ts and end_ts must be integers (unix seconds)")
        if end_ts <= start_ts:
            raise HTTPException(status_code=400, detail="end_ts must be greater than start_ts")
        update_fields["start_ts"] = start_ts
        update_fields["end_ts"] = end_ts

    coll("election_config").update_one(
        {"_id": PRIMARY_ELECTION_CONFIG_ID},
        {"$set": update_fields, "$inc": {"reconduct_count": 1}},
        upsert=True,
    )

    return {
        "message": "Election restarted successfully",
        "note": "Blockchain vote state is unchanged. Redeploy the smart contract if you need a fully fresh on-chain election.",
        "reset_results": reset_results,
        **get_election_state(),
    }


@app.post("/voter/confirm-scan")
async def confirm_scan(request: Request):
    ensure_election_running()
    payload = await request.json()
    qr_token = (payload.get("qr_token") or "").strip()
    image_data = payload.get("image_data")
    if not qr_token or not image_data:
        raise HTTPException(status_code=400, detail="qr_token and image_data are required")

    voter = coll("voters").find_one(
        {"qr_token": qr_token, "is_active": True},
        {"_id": 0, "voter_id": 1, "full_name": 1, "role": 1, "image_path": 1, "photo_path": 1, "date_of_birth": 1},
    )
    if not voter:
        raise HTTPException(status_code=404, detail="Voter not found for this QR")

    live_image_bytes, _live_image_mime = decode_image_bytes_from_data_url(image_data)
    verification = verify_live_face_against_voter(voter, live_image_bytes, "live verification image")
    if not verification["matched"]:
        raise HTTPException(
            status_code=409,
            detail=(
                "Live face does not match the voter ID card image. "
                f"Similarity score: {verification['score']}, required: {verification['threshold']}"
            ),
        )

    image_path = voter.get("image_path") or voter.get("photo_path")
    return {
        "message": "Scan confirmed",
        "voter_id": voter["voter_id"],
        "full_name": voter.get("full_name"),
        "role": voter.get("role"),
        "photo_path": image_path,
        "image_path": image_path,
        "date_of_birth": voter.get("date_of_birth"),
        "on_vote_day_image_path": save_image_from_data_url(image_data, f"scan_{voter['voter_id']}"),
        "face_verified": True,
        "face_similarity_score": verification["score"],
        "face_similarity_threshold": verification["threshold"],
        "confirmed_at": stringify_datetime(utc_now()),
    }


@app.post("/voter/ready-check")
async def ready_check(request: Request):
    ensure_election_running()
    payload = await request.json()
    qr_token = (payload.get("qr_token") or "").strip()
    image_data = payload.get("image_data")
    if not qr_token or not image_data:
        raise HTTPException(status_code=400, detail="qr_token and image_data are required")

    voter = coll("voters").find_one(
        {"qr_token": qr_token, "is_active": True},
        {"_id": 0, "voter_id": 1, "full_name": 1, "role": 1, "image_path": 1, "photo_path": 1, "date_of_birth": 1},
    )
    if not voter:
        raise HTTPException(status_code=404, detail="Voter not found for this QR")

    live_image_bytes, _live_image_mime = decode_image_bytes_from_data_url(image_data)
    verification = verify_live_face_against_voter(voter, live_image_bytes, "ready-check live image")
    if not verification["matched"]:
        raise HTTPException(
            status_code=409,
            detail=(
                "Ready check failed because the live face does not match the voter card image. "
                f"Similarity score: {verification['score']}, required: {verification['threshold']}"
            ),
        )

    return {
        "message": "Ready check passed",
        "voter_id": voter["voter_id"],
        "full_name": voter.get("full_name"),
        "face_verified": True,
        "face_similarity_score": verification["score"],
        "face_similarity_threshold": verification["threshold"],
    }


@app.post("/vote/audit")
async def save_vote_audit(request: Request):
    ensure_election_running()
    try:
        payload = await request.json()
    except Exception:
        print("vote/audit: invalid json")
        print(traceback.format_exc())
        raise HTTPException(status_code=400, detail="Invalid JSON body")

    required_fields = ["voter_id", "candidate_id", "candidate_name", "party"]
    for field_name in required_fields:
        if payload.get(field_name) in (None, ""):
            raise HTTPException(status_code=400, detail=f"{field_name} is required")

    voter_id = str(payload["voter_id"]).strip()
    candidate_id = int(payload["candidate_id"])
    candidate_name = payload["candidate_name"]
    party = payload["party"]
    tx_hash = payload.get("tx_hash")
    pre_vote_image = payload.get("pre_vote_image")
    on_vote_day_image = payload.get("on_vote_day_image")
    feedback_text = normalize_feedback_text(payload.get("feedback"))
    feedback_details = analyze_feedback(feedback_text)

    pre_vote_blob, pre_vote_mime = decode_image_bytes_from_data_url(pre_vote_image) if pre_vote_image else (None, None)
    on_vote_day_blob, on_vote_day_mime = decode_image_bytes_from_data_url(on_vote_day_image) if on_vote_day_image else (None, None)
    pre_vote_path = save_image_bytes(pre_vote_blob, pre_vote_mime, f"pre_vote_{voter_id}") if pre_vote_blob else None
    on_vote_day_path = save_image_bytes(on_vote_day_blob, on_vote_day_mime, f"on_vote_{voter_id}") if on_vote_day_blob else None

    try:
        existing_audit = coll("vote_audit").find_one({"voter_id": voter_id}, {"_id": 1, "tx_hash": 1})
        if existing_audit:
            if feedback_details:
                coll("vote_audit").update_one(
                    {"voter_id": voter_id},
                    {
                        "$set": {
                            "feedback": feedback_details["feedback"],
                            "sentiment_label": feedback_details["sentiment_label"],
                            "sentiment_score": feedback_details["sentiment_score"],
                            "sentiment_breakdown": feedback_details["sentiment_breakdown"],
                            "feedback_submitted_at": utc_now(),
                            "tx_hash": tx_hash or existing_audit.get("tx_hash"),
                        }
                    },
                )
                return {"message": "Vote feedback saved"}
            raise HTTPException(status_code=409, detail="Vote audit already exists for this voter")

        chain_vote = verify_vote_tx_hash(tx_hash, candidate_id)

        voted_at = utc_now()
        audit_record = {
            "audit_id": next_sequence("vote_audit"),
            "voter_id": voter_id,
            "candidate_id": candidate_id,
            "candidate_name": candidate_name,
            "party": party,
            "pre_vote_image_path": pre_vote_path,
            "on_vote_day_image_path": on_vote_day_path,
            "pre_vote_image_blob": Binary(pre_vote_blob) if pre_vote_blob else None,
            "on_vote_day_image_blob": Binary(on_vote_day_blob) if on_vote_day_blob else None,
            "pre_vote_image_mime": pre_vote_mime,
            "on_vote_day_image_mime": on_vote_day_mime,
            "tx_hash": tx_hash,
            "voted_at": voted_at,
            "chain_verified": True,
            "chain_candidate_id": chain_vote["candidate_id"],
            "chain_block_number": chain_vote["block_number"],
            "chain_voter_address": chain_vote["voter_address"],
            "chain_timestamp": chain_vote["timestamp"],
        }
        if feedback_details:
            audit_record.update(
                {
                    "feedback": feedback_details["feedback"],
                    "sentiment_label": feedback_details["sentiment_label"],
                    "sentiment_score": feedback_details["sentiment_score"],
                    "sentiment_breakdown": feedback_details["sentiment_breakdown"],
                    "feedback_submitted_at": voted_at,
                }
            )
        coll("vote_audit").insert_one(audit_record)
    except HTTPException:
        raise
    except DuplicateKeyError:
        raise HTTPException(status_code=409, detail="Vote audit or tx_hash already exists")
    except PyMongoError as err:
        print(err)
        raise HTTPException(status_code=500, detail=f"Failed to save vote audit: {err}")
    except Exception as err:
        print("vote/audit: unexpected error")
        print(traceback.format_exc())
        raise HTTPException(status_code=500, detail=str(err))

    return {"message": "Vote audit saved"}


@app.get("/vote/report")
async def get_vote_report():
    rows = get_onchain_candidate_results()
    return {
        "items": [
            {
                "candidate_id": row.get("candidate_id"),
                "candidate_name": row.get("name") or row.get("candidate_name"),
                "party": row.get("party"),
                "vote_count": int(row.get("vote_count", 0)),
                "rank_position": index,
                "updated_at": stringify_datetime(utc_now()),
                "source": "blockchain",
            }
            for index, row in enumerate(rows, start=1)
        ]
    }


@app.get("/vote/prediction")
async def get_vote_prediction():
    return generate_vote_prediction_report(
        voters_collection=coll("voters"),
        candidates_collection=coll("candidates"),
        vote_report_collection=coll("vote_report_live"),
        vote_audit_collection=coll("vote_audit"),
    )


@app.get("/vote/sentiment-report")
async def get_vote_sentiment_report():
    return build_sentiment_report(
        vote_audit_collection=coll("vote_audit"),
        candidates_collection=coll("candidates"),
    )


@app.get("/admin/anomaly-report")
async def get_anomaly_report(request: Request):
    require_admin_role(request, os.environ.get("SECRET_KEY", "your_super_secret_key"))
    return generate_anomaly_report(vote_audit_collection=coll("vote_audit"))

@app.get("/admin/vote-audit/export")
async def export_vote_audit(request: Request):
    voters_by_id = {
        row["voter_id"]: row.get("full_name", "")
        for row in coll("voters").find({}, {"_id": 0, "voter_id": 1, "full_name": 1})
    }
    rows = coll("vote_audit").find({}, {"_id": 0}).sort([("voted_at", ASCENDING), ("audit_id", ASCENDING)])

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["S No", "Voter ID Card Number", "Voter Name", "On Vote Day Image URL", "Voted Candidate", "Party", "Vote Time", "Transaction Hash"])

    base_url = str(request.base_url).rstrip("/")
    serial = 1
    for row in rows:
        image_url = f"{base_url}/admin/vote-audit/image/{row['audit_id']}?kind=on"
        writer.writerow(
            [
                serial,
                row.get("voter_id"),
                voters_by_id.get(row.get("voter_id"), ""),
                image_url,
                row.get("candidate_name"),
                row.get("party"),
                stringify_datetime(row.get("voted_at")),
                row.get("tx_hash") or "",
            ]
        )
        serial += 1

    headers = {"Content-Disposition": "attachment; filename=vote_audit_report.csv", "Cache-Control": "no-store"}
    return StreamingResponse(iter([output.getvalue()]), media_type="text/csv", headers=headers)


@app.get("/admin/vote-audit/image/{audit_id}")
async def get_vote_audit_image(audit_id: int, kind: str = "on"):
    if kind not in ("on", "pre"):
        raise HTTPException(status_code=400, detail="Invalid kind")

    projection = {"on_vote_day_image_blob": 1, "on_vote_day_image_mime": 1} if kind == "on" else {"pre_vote_image_blob": 1, "pre_vote_image_mime": 1}
    row = coll("vote_audit").find_one({"audit_id": audit_id}, projection)
    if not row:
        raise HTTPException(status_code=404, detail="Image not found")

    blob = row.get("on_vote_day_image_blob") if kind == "on" else row.get("pre_vote_image_blob")
    mime = row.get("on_vote_day_image_mime") if kind == "on" else row.get("pre_vote_image_mime")
    if not blob:
        raise HTTPException(status_code=404, detail="Image not found")
    return StreamingResponse(iter([bytes(blob)]), media_type=mime or "application/octet-stream", headers={"Cache-Control": "no-store"})


@app.post("/admin/database/clear")
async def clear_database(request: Request):
    payload = await request.json()
    if (payload.get("confirm_key") or "").strip() != "CLEAR_ALL":
        raise HTTPException(status_code=400, detail="Invalid confirmation key")

    cleared_collections = []
    try:
        for name in ["vote_audit", "vote_report_live", "candidates", "candidate_nominations", "voters", "election_config", "counters"]:
            result = coll(name).delete_many({})
            if result.acknowledged:
                cleared_collections.append(name)
        for file_path in glob.glob(os.path.join(MEDIA_DIR, "*")):
            if os.path.isfile(file_path):
                os.remove(file_path)
        ensure_schema()
    except PyMongoError as err:
        print(err)
        raise HTTPException(status_code=500, detail="Failed to clear database")

    return {
        "message": "Database data cleared successfully",
        "cleared_tables": cleared_collections,
        "admin_user": os.environ.get("ADMIN_USERNAME", "admin001"),
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
