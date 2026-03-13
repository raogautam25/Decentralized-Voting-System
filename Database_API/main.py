import base64
import csv
import datetime
import glob
import io
import os
import re
import secrets
import string
import traceback
import uuid

import dotenv
import jwt
import mysql.connector
from fastapi.middleware.cors import CORSMiddleware
from fastapi import FastAPI, HTTPException, Request, status
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from mysql.connector import errorcode

from duplicate_detection import find_similar_image

# Loading the environment variables
dotenv.load_dotenv()

# Initialize the todoapi app
app = FastAPI()

def get_allowed_origins():
    allowed = {
        "http://localhost:8080",
        "http://127.0.0.1:8080",
    }

    configured_origins = os.environ.get("CORS_ALLOWED_ORIGINS", "")
    for origin in configured_origins.split(","):
        normalized = origin.strip().rstrip("/")
        if normalized:
            allowed.add(normalized)

    frontend_url = os.environ.get("FRONTEND_URL", "").strip().rstrip("/")
    if frontend_url:
        allowed.add(frontend_url)

    return sorted(allowed)


# Define the allowed origins for CORS
origins = get_allowed_origins()
origin_regex = os.environ.get("CORS_ALLOW_ORIGIN_REGEX", r"https://.*\.vercel\.app")

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_origin_regex=origin_regex,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Connect to the MySQL database
try:
    cnx = mysql.connector.connect(
        user=os.environ['MYSQL_USER'],
        password=os.environ['MYSQL_PASSWORD'],
        host=os.environ['MYSQL_HOST'],
        database=os.environ['MYSQL_DB'],
    )
    cursor = cnx.cursor()
except mysql.connector.Error as err:
    if err.errno == errorcode.ER_ACCESS_DENIED_ERROR:
        print("Something is wrong with your user name or password")
    elif err.errno == errorcode.ER_BAD_DB_ERROR:
        print("Database does not exist")
    else:
        print(err)

MEDIA_DIR = os.path.join(os.path.dirname(__file__), "media")
os.makedirs(MEDIA_DIR, exist_ok=True)
app.mount("/media", StaticFiles(directory=MEDIA_DIR), name="media")

MINIMUM_AGE_YEARS = 18
DEFAULT_ELECTION_ID = "default-election"
VOTER_ID_ALPHABET = string.ascii_uppercase + string.digits


def calculate_age(date_of_birth, today=None):
    today = today or datetime.date.today()
    return today.year - date_of_birth.year - (
        (today.month, today.day) < (date_of_birth.month, date_of_birth.day)
    )


def ensure_minimum_age(date_of_birth, subject_label):
    if calculate_age(date_of_birth) < MINIMUM_AGE_YEARS:
        raise HTTPException(
            status_code=400,
            detail=f"{subject_label} must be at least {MINIMUM_AGE_YEARS} years old",
        )


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
    if explicit:
        return slugify(explicit)
    return slugify(payload.get("election_name") or DEFAULT_ELECTION_ID)


def normalize_name(value):
    return re.sub(r"\s+", " ", str(value or "").strip()).lower()


def save_image_bytes(image_bytes, mime, prefix):
    if not image_bytes:
        return None
    ext = "jpg"
    if mime == "image/png":
        ext = "png"
    filename = f"{prefix}_{uuid.uuid4().hex}.{ext}"
    rel_path = os.path.join("media", filename)
    abs_path = os.path.join(os.path.dirname(__file__), rel_path)
    with open(abs_path, "wb") as file_obj:
        file_obj.write(image_bytes)
    return rel_path.replace("\\", "/")


def drop_index_if_exists(table_name, index_name):
    cursor.execute(f"SHOW INDEX FROM {table_name}")
    index_names = {row[2] for row in cursor.fetchall()}
    if index_name in index_names:
        cursor.execute(f"ALTER TABLE {table_name} DROP INDEX {index_name}")


def create_index_if_missing(table_name, index_name, ddl):
    cursor.execute(f"SHOW INDEX FROM {table_name}")
    index_names = {row[2] for row in cursor.fetchall()}
    if index_name not in index_names:
        cursor.execute(ddl)


def get_election_state():
    cursor.execute(
        "SELECT start_ts, end_ts, status, updated_at, reconduct_count, stopped_at FROM election_config WHERE id = 1"
    )
    row = cursor.fetchone()
    if not row:
        return {
            "start_ts": 0,
            "end_ts": 0,
            "status": "running",
            "updated_at": None,
            "reconduct_count": 0,
            "stopped_at": None,
        }
    return {
        "start_ts": int(row[0] or 0),
        "end_ts": int(row[1] or 0),
        "status": row[2] or "running",
        "updated_at": str(row[3]) if row[3] else None,
        "reconduct_count": int(row[4] or 0),
        "stopped_at": str(row[5]) if row[5] else None,
    }


def ensure_election_running():
    state = get_election_state()
    if state["status"] == "stopped":
        raise HTTPException(status_code=409, detail="Election is currently stopped")
    return state


def generate_unique_voter_id():
    for _ in range(64):
        candidate = "".join(secrets.choice(VOTER_ID_ALPHABET) for _ in range(10))
        cursor.execute("SELECT voter_id FROM voters WHERE voter_id = %s LIMIT 1", (candidate,))
        if not cursor.fetchone():
            return candidate
    raise HTTPException(status_code=500, detail="Unable to generate a unique voter ID")


def candidate_exists_in_database(full_name, date_of_birth, contact_number, id_number):
    cursor.execute(
        """
        SELECT id
        FROM candidate_nominations
        WHERE LOWER(TRIM(full_name)) = %s
          AND date_of_birth = %s
          AND COALESCE(contact_number, '') = %s
          AND id_number = %s
        LIMIT 1
        """,
        (normalize_name(full_name), date_of_birth, contact_number or "", id_number),
    )
    return cursor.fetchone() is not None


def candidate_exists_for_election(election_id, full_name, date_of_birth, id_number):
    cursor.execute(
        """
        SELECT id
        FROM candidate_nominations
        WHERE election_id = %s
          AND LOWER(TRIM(full_name)) = %s
          AND date_of_birth = %s
          AND id_number = %s
        LIMIT 1
        """,
        (election_id, normalize_name(full_name), date_of_birth, id_number),
    )
    return cursor.fetchone() is not None


def candidate_id_exists_for_election(candidate_id, election_id):
    if not candidate_id:
        return False
    cursor.execute(
        """
        SELECT id
        FROM candidate_nominations
        WHERE candidate_id = %s AND election_id = %s
        LIMIT 1
        """,
        (candidate_id, election_id),
    )
    return cursor.fetchone() is not None


def find_existing_voter_duplicate(full_name, date_of_birth, image_bytes):
    cursor.execute(
        """
        SELECT COALESCE(image_path, photo_path)
        FROM voters
        WHERE LOWER(TRIM(full_name)) = %s
          AND date_of_birth = %s
          AND is_active = 1
        """,
        (normalize_name(full_name), date_of_birth),
    )
    existing_paths = [row[0] for row in cursor.fetchall() if row[0]]
    if not existing_paths:
        return None
    return find_similar_image(image_bytes, existing_paths, os.path.dirname(__file__))


def ensure_schema():
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS voters (
            voter_id VARCHAR(64) PRIMARY KEY,
            password VARCHAR(255) NULL,
            role VARCHAR(16) NOT NULL DEFAULT 'user',
            full_name VARCHAR(120),
            date_of_birth DATE NULL,
            image_path VARCHAR(255),
            photo_path VARCHAR(255),
            qr_token VARCHAR(128) UNIQUE,
            is_active TINYINT DEFAULT 1,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS candidates (
            candidate_id INT PRIMARY KEY,
            name VARCHAR(120) NOT NULL,
            party VARCHAR(120) NOT NULL,
            symbol VARCHAR(64),
            date_of_birth DATE NULL,
            party_symbol_image VARCHAR(255) NULL,
            votes INT NOT NULL DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS vote_audit (
            id INT AUTO_INCREMENT PRIMARY KEY,
            voter_id VARCHAR(64) NOT NULL,
            candidate_id INT NOT NULL,
            candidate_name VARCHAR(120) NOT NULL,
            party VARCHAR(120) NOT NULL,
            pre_vote_image_path VARCHAR(255),
            on_vote_day_image_path VARCHAR(255),
            pre_vote_image_blob LONGBLOB,
            on_vote_day_image_blob LONGBLOB,
            pre_vote_image_mime VARCHAR(64),
            on_vote_day_image_mime VARCHAR(64),
            tx_hash VARCHAR(120),
            voted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_voter (voter_id),
            INDEX idx_candidate (candidate_id)
        )
        """
    )
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS vote_report_live (
            candidate_id INT PRIMARY KEY,
            candidate_name VARCHAR(120) NOT NULL,
            party VARCHAR(120) NOT NULL,
            vote_count INT NOT NULL DEFAULT 0,
            rank_position INT NOT NULL DEFAULT 0,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
        """
    )
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS election_config (
            id INT PRIMARY KEY,
            start_ts BIGINT NOT NULL DEFAULT 0,
            end_ts BIGINT NOT NULL DEFAULT 0,
            status VARCHAR(20) NOT NULL DEFAULT 'running',
            reconduct_count INT NOT NULL DEFAULT 0,
            stopped_at TIMESTAMP NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
        """
    )
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS candidate_nominations (
            id INT AUTO_INCREMENT PRIMARY KEY,
            candidate_id INT NULL,
            election_id VARCHAR(128) NOT NULL DEFAULT 'default-election',
            election_name VARCHAR(160) NULL,
            position VARCHAR(160) NULL,
            full_name VARCHAR(160) NOT NULL,
            date_of_birth DATE NOT NULL,
            address TEXT NULL,
            contact_number VARCHAR(32) NULL,
            id_number VARCHAR(64) NOT NULL,
            party_name VARCHAR(120) NULL,
            party_symbol VARCHAR(64) NULL,
            party_symbol_image VARCHAR(255) NULL,
            is_independent TINYINT NOT NULL DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """
    )

    cursor.execute(
        """
        INSERT IGNORE INTO election_config (id, start_ts, end_ts)
        VALUES (1, 0, 0)
        """
    )

    cursor.execute("SHOW COLUMNS FROM voters")
    voter_cols = {row[0] for row in cursor.fetchall()}
    if "full_name" not in voter_cols:
        cursor.execute("ALTER TABLE voters ADD COLUMN full_name VARCHAR(120) NULL")
        if "name" in voter_cols:
            cursor.execute("UPDATE voters SET full_name = name WHERE full_name IS NULL")
    if "date_of_birth" not in voter_cols:
        cursor.execute("ALTER TABLE voters ADD COLUMN date_of_birth DATE NULL")
    if "image_path" not in voter_cols:
        cursor.execute("ALTER TABLE voters ADD COLUMN image_path VARCHAR(255) NULL")
    if "photo_path" not in voter_cols:
        cursor.execute("ALTER TABLE voters ADD COLUMN photo_path VARCHAR(255) NULL")
    if "qr_token" not in voter_cols:
        cursor.execute("ALTER TABLE voters ADD COLUMN qr_token VARCHAR(128) NULL")
    if "is_active" not in voter_cols:
        cursor.execute("ALTER TABLE voters ADD COLUMN is_active TINYINT DEFAULT 1")
        cursor.execute("UPDATE voters SET is_active = 1 WHERE is_active IS NULL")
    cursor.execute("ALTER TABLE voters MODIFY COLUMN password VARCHAR(255) NULL")
    cursor.execute("UPDATE voters SET image_path = photo_path WHERE image_path IS NULL AND photo_path IS NOT NULL")
    cursor.execute("UPDATE voters SET photo_path = image_path WHERE photo_path IS NULL AND image_path IS NOT NULL")
    create_index_if_missing("voters", "idx_voters_qr_token", "CREATE UNIQUE INDEX idx_voters_qr_token ON voters (qr_token)")

    cursor.execute("SHOW COLUMNS FROM candidates")
    candidate_cols = {row[0] for row in cursor.fetchall()}
    if "date_of_birth" not in candidate_cols:
        cursor.execute("ALTER TABLE candidates ADD COLUMN date_of_birth DATE NULL")
    if "party_symbol_image" not in candidate_cols:
        cursor.execute("ALTER TABLE candidates ADD COLUMN party_symbol_image VARCHAR(255) NULL")
    if "created_at" not in candidate_cols:
        cursor.execute("ALTER TABLE candidates ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP")

    cursor.execute("SHOW COLUMNS FROM election_config")
    election_cols = {row[0] for row in cursor.fetchall()}
    if "status" not in election_cols:
        cursor.execute("ALTER TABLE election_config ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'running'")
    if "reconduct_count" not in election_cols:
        cursor.execute("ALTER TABLE election_config ADD COLUMN reconduct_count INT NOT NULL DEFAULT 0")
    if "stopped_at" not in election_cols:
        cursor.execute("ALTER TABLE election_config ADD COLUMN stopped_at TIMESTAMP NULL")
    cursor.execute("UPDATE election_config SET status = 'running' WHERE status IS NULL OR status = ''")
    cursor.execute("UPDATE election_config SET reconduct_count = 0 WHERE reconduct_count IS NULL")

    cursor.execute("SHOW COLUMNS FROM candidate_nominations")
    nomination_cols = {row[0] for row in cursor.fetchall()}
    if "candidate_id" not in nomination_cols:
        cursor.execute("ALTER TABLE candidate_nominations ADD COLUMN candidate_id INT NULL AFTER id")
    if "election_id" not in nomination_cols:
        cursor.execute(
            f"ALTER TABLE candidate_nominations ADD COLUMN election_id VARCHAR(128) NOT NULL DEFAULT '{DEFAULT_ELECTION_ID}' AFTER candidate_id"
        )
    if "party_symbol_image" not in nomination_cols:
        cursor.execute("ALTER TABLE candidate_nominations ADD COLUMN party_symbol_image VARCHAR(255) NULL")

    drop_index_if_exists("candidate_nominations", "uq_candidate_fullname_dob")
    drop_index_if_exists("candidate_nominations", "uq_candidate_party_name")
    drop_index_if_exists("candidate_nominations", "uq_candidate_id_number")
    create_index_if_missing(
        "candidate_nominations",
        "uq_candidate_per_election",
        "CREATE UNIQUE INDEX uq_candidate_per_election ON candidate_nominations (candidate_id, election_id)",
    )
    create_index_if_missing(
        "candidate_nominations",
        "idx_candidate_nomination_lookup",
        "CREATE INDEX idx_candidate_nomination_lookup ON candidate_nominations (election_id, full_name, date_of_birth, id_number)",
    )

    cursor.execute("SHOW COLUMNS FROM vote_audit")
    audit_cols = {row[0] for row in cursor.fetchall()}
    if "pre_vote_image_blob" not in audit_cols:
        cursor.execute("ALTER TABLE vote_audit ADD COLUMN pre_vote_image_blob LONGBLOB NULL")
    if "on_vote_day_image_blob" not in audit_cols:
        cursor.execute("ALTER TABLE vote_audit ADD COLUMN on_vote_day_image_blob LONGBLOB NULL")
    if "pre_vote_image_mime" not in audit_cols:
        cursor.execute("ALTER TABLE vote_audit ADD COLUMN pre_vote_image_mime VARCHAR(64) NULL")
    if "on_vote_day_image_mime" not in audit_cols:
        cursor.execute("ALTER TABLE vote_audit ADD COLUMN on_vote_day_image_mime VARCHAR(64) NULL")

    cursor.execute("SELECT COUNT(*) FROM voters WHERE role = 'admin' AND is_active = 1")
    if cursor.fetchone()[0] == 0:
        cursor.execute(
            """
            INSERT INTO voters (voter_id, password, role, full_name, is_active)
            VALUES (%s, %s, %s, %s, %s)
            ON DUPLICATE KEY UPDATE
                password = VALUES(password),
                role = VALUES(role),
                full_name = VALUES(full_name),
                is_active = VALUES(is_active)
            """,
            ("admin001", "admin123", "admin", "System Admin", 1),
        )

    cnx.commit()


def decode_image_bytes_from_data_url(data_url: str):
    if not data_url:
        return None, None
    if "," not in data_url:
        raise HTTPException(status_code=400, detail="Invalid image payload")
    header, encoded = data_url.split(",", 1)
    mime = "image/jpeg"
    if "image/png" in header:
        mime = "image/png"
    try:
        return base64.b64decode(encoded), mime
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid image payload")


def save_image_from_data_url(data_url: str, prefix: str) -> str:
    if not data_url:
        return None
    image_bytes, mime = decode_image_bytes_from_data_url(data_url)
    return save_image_bytes(image_bytes, mime, prefix)


def refresh_vote_rankings():
    cursor.execute(
        "SELECT candidate_id, vote_count FROM vote_report_live ORDER BY vote_count DESC, candidate_id ASC"
    )
    rows = cursor.fetchall()
    rank = 1
    for row in rows:
        candidate_id = row[0]
        cursor.execute(
            "UPDATE vote_report_live SET rank_position = %s WHERE candidate_id = %s",
            (rank, candidate_id),
        )
        rank += 1
    cnx.commit()


ensure_schema()

# Define the authentication middleware
async def authenticate(request: Request):
    try:
        api_key = request.headers.get('authorization').replace("Bearer ", "")
        cursor.execute("SELECT * FROM voters WHERE voter_id = %s", (api_key,))
        if api_key not in [row[0] for row in cursor.fetchall()]:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Forbidden"
            )
    except:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Forbidden"
        )

# Define the GET endpoint for login (No authentication middleware for login)
@app.get("/login")
async def login(voter_id: str, password: str):
    role = await get_role(voter_id, password)

    # Assuming authentication is successful, generate a token
    token = jwt.encode({'password': password, 'voter_id': voter_id, 'role': role}, os.environ['SECRET_KEY'], algorithm='HS256')

    return {'token': token, 'role': role}

# Replace 'admin' with the actual role based on authentication
async def get_role(voter_id, password):
    try:
        cursor.execute("SELECT role FROM voters WHERE voter_id = %s AND password = %s", (voter_id, password,))
        role = cursor.fetchone()
        if role:
            return role[0]
        else:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid voter id or password"
            )
    except mysql.connector.Error as err:
        print(err)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Database error"
        )


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

    duplicate_match = find_existing_voter_duplicate(full_name, date_of_birth, photo_bytes)
    if duplicate_match:
        raise HTTPException(status_code=409, detail="Person already exists in voter database")

    voter_id = generate_unique_voter_id()
    image_path = save_image_bytes(photo_bytes, photo_mime, f"voter_{voter_id}")
    qr_token = f"VOTER::{voter_id}::{uuid.uuid4().hex[:10]}"

    try:
        cursor.execute(
            """
            INSERT INTO voters (
                voter_id, password, role, full_name, date_of_birth,
                image_path, photo_path, qr_token, is_active
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 1)
            """,
            (voter_id, None, "user", full_name, date_of_birth, image_path, image_path, qr_token),
        )
        cnx.commit()
    except mysql.connector.Error as err:
        print(err)
        raise HTTPException(status_code=500, detail="Failed to save voter")

    return {
        "message": "Voter saved",
        "voter_id": voter_id,
        "full_name": full_name,
        "date_of_birth": str(date_of_birth),
        "role": "user",
        "qr_token": qr_token,
        "image_path": image_path,
        "photo_path": image_path,
    }


@app.get("/voter/by-qr")
async def get_voter_by_qr(qr_token: str):
    ensure_election_running()
    cursor.execute(
        """
        SELECT voter_id, full_name, role, COALESCE(image_path, photo_path), qr_token, date_of_birth
        FROM voters
        WHERE qr_token = %s AND is_active = 1
        """,
        (qr_token,),
    )
    row = cursor.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Voter not found for this QR")

    return {
        "voter_id": row[0],
        "full_name": row[1],
        "role": row[2],
        "photo_path": row[3],
        "image_path": row[3],
        "qr_token": row[4],
        "date_of_birth": str(row[5]) if row[5] else None,
    }


@app.get("/candidates")
async def list_candidates():
    cursor.execute(
        """
        SELECT
            c.candidate_id,
            c.name,
            c.party,
            c.symbol,
            COALESCE(r.vote_count, 0) AS vote_count,
            c.party_symbol_image,
            c.date_of_birth
        FROM candidates c
        LEFT JOIN vote_report_live r ON r.candidate_id = c.candidate_id
        ORDER BY c.candidate_id ASC
        """
    )
    items = []
    for row in cursor.fetchall():
        items.append(
            {
                "candidate_id": int(row[0]),
                "name": row[1],
                "party": row[2],
                "symbol": row[3],
                "vote_count": int(row[4]),
                "party_symbol_image": row[5],
                "date_of_birth": str(row[6]) if row[6] else None,
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

    candidate_dob = parse_iso_date(dob_raw) if dob_raw else None

    try:
        cursor.execute(
            """
            INSERT INTO candidates (candidate_id, name, party, symbol, date_of_birth, party_symbol_image, votes)
            VALUES (%s, %s, %s, %s, %s, %s, 0)
            ON DUPLICATE KEY UPDATE
                name = VALUES(name),
                party = VALUES(party),
                symbol = VALUES(symbol),
                date_of_birth = VALUES(date_of_birth),
                party_symbol_image = VALUES(party_symbol_image)
            """,
            (candidate_id, name, party, symbol, candidate_dob, party_symbol_image or None),
        )
        cnx.commit()
    except mysql.connector.Error as err:
        print(err)
        raise HTTPException(status_code=500, detail="Failed to save candidate")

    return {
        "message": "Candidate saved",
        "candidate_id": candidate_id,
        "name": name,
        "party": party,
        "symbol": symbol or None,
        "party_symbol_image": party_symbol_image or None,
        "date_of_birth": str(candidate_dob) if candidate_dob else None,
    }


@app.get("/admin/candidate-nominations/keys")
async def list_candidate_nomination_keys():
    # Minimal fields for fast, client-side duplicate prechecks.
    cursor.execute(
        """
        SELECT candidate_id, election_id, full_name, date_of_birth, contact_number, id_number, party_name
        FROM candidate_nominations
        ORDER BY id DESC
        """
    )
    items = []
    for row in cursor.fetchall():
        items.append(
            {
                "candidate_id": row[0],
                "election_id": row[1],
                "full_name": row[2],
                "date_of_birth": str(row[3]),
                "contact_number": row[4],
                "id_number": row[5],
                "party_name": row[6],
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
    else:
        if not party_name:
            raise HTTPException(status_code=400, detail="party_name is required unless is_independent is true")

    if contact_number and not contact_number.isdigit():
        raise HTTPException(status_code=400, detail="contact_number must be numeric")

    if candidate_exists_in_database(full_name, dob, contact_number, id_number):
        raise HTTPException(status_code=409, detail="Candidate already exists in database")

    if candidate_exists_for_election(election_id, full_name, dob, id_number):
        raise HTTPException(status_code=409, detail="Candidate is already registered for this election")

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
        raise HTTPException(status_code=409, detail="Candidate already exists in database")
    if candidate_exists_for_election(election_id, full_name, dob, id_number):
        raise HTTPException(status_code=409, detail="Candidate is already registered for this election")
    if candidate_id_exists_for_election(candidate_id, election_id):
        raise HTTPException(status_code=409, detail="Candidate is already registered for this election")

    if candidate_id not in (None, ""):
        try:
            candidate_id = int(candidate_id)
        except Exception:
            raise HTTPException(status_code=400, detail="candidate_id must be an integer")
    else:
        candidate_id = None

    try:
        cursor.execute(
            """
            INSERT INTO candidate_nominations (
                candidate_id, election_id, election_name, position, full_name, date_of_birth,
                address, contact_number, id_number, party_name, party_symbol,
                party_symbol_image, is_independent
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                candidate_id,
                election_id,
                election_name or None,
                position or None,
                full_name,
                dob,
                address or None,
                contact_number or None,
                id_number,
                party_name,
                party_symbol or None,
                party_symbol_image_path or None,
                1 if is_independent else 0,
            ),
        )
        cnx.commit()
    except mysql.connector.Error as err:
        # 1062: duplicate key
        if getattr(err, "errno", None) == 1062:
            raise HTTPException(status_code=409, detail="Candidate is already registered for this election")
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

    cursor.execute(
        """
        UPDATE election_config
        SET start_ts = %s, end_ts = %s, status = 'running', stopped_at = NULL
        WHERE id = 1
        """,
        (start_ts, end_ts),
    )
    cnx.commit()
    return {"message": "Election dates saved", "start_ts": start_ts, "end_ts": end_ts, "status": "running"}


@app.post("/admin/election/stop")
async def emergency_stop_election():
    cursor.execute(
        """
        UPDATE election_config
        SET status = 'stopped', stopped_at = CURRENT_TIMESTAMP
        WHERE id = 1
        """
    )
    cnx.commit()
    state = get_election_state()
    return {"message": "Election stopped successfully", **state}


@app.post("/admin/election/restart")
async def restart_election(request: Request):
    payload = await request.json()
    reset_results = bool(payload.get("reset_results"))
    start_ts = payload.get("start_ts")
    end_ts = payload.get("end_ts")

    if reset_results:
        cursor.execute("TRUNCATE TABLE vote_audit")
        cursor.execute("TRUNCATE TABLE vote_report_live")

    if start_ts is not None and end_ts is not None:
        try:
            start_ts = int(start_ts)
            end_ts = int(end_ts)
        except Exception:
            raise HTTPException(status_code=400, detail="start_ts and end_ts must be integers (unix seconds)")
        if end_ts <= start_ts:
            raise HTTPException(status_code=400, detail="end_ts must be greater than start_ts")
        cursor.execute(
            """
            UPDATE election_config
            SET start_ts = %s,
                end_ts = %s,
                status = 'running',
                stopped_at = NULL,
                reconduct_count = reconduct_count + 1
            WHERE id = 1
            """,
            (start_ts, end_ts),
        )
    else:
        cursor.execute(
            """
            UPDATE election_config
            SET status = 'running',
                stopped_at = NULL,
                reconduct_count = reconduct_count + 1
            WHERE id = 1
            """
        )

    cnx.commit()
    state = get_election_state()
    return {
        "message": "Election restarted successfully",
        "note": "Blockchain vote state is unchanged. Redeploy the smart contract if you need a fully fresh on-chain election.",
        "reset_results": reset_results,
        **state,
    }

@app.post("/voter/confirm-scan")
async def confirm_scan(request: Request):
    ensure_election_running()
    payload = await request.json()
    qr_token = (payload.get("qr_token") or "").strip()
    image_data = payload.get("image_data")
    if not qr_token or not image_data:
        raise HTTPException(status_code=400, detail="qr_token and image_data are required")

    cursor.execute(
        """
        SELECT voter_id, full_name, role, COALESCE(image_path, photo_path), date_of_birth
        FROM voters
        WHERE qr_token = %s AND is_active = 1
        """,
        (qr_token,),
    )
    row = cursor.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Voter not found for this QR")

    voter_id, full_name, role, image_path, date_of_birth = row
    on_vote_day_path = save_image_from_data_url(image_data, f"scan_{voter_id}")

    return {
        "message": "Scan confirmed",
        "voter_id": voter_id,
        "full_name": full_name,
        "role": role,
        "photo_path": image_path,
        "image_path": image_path,
        "date_of_birth": str(date_of_birth) if date_of_birth else None,
        "on_vote_day_image_path": on_vote_day_path,
        "confirmed_at": datetime.datetime.utcnow().isoformat() + "Z",
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
    for f in required_fields:
        if payload.get(f) in (None, ""):
            raise HTTPException(status_code=400, detail=f"{f} is required")

    voter_id = payload["voter_id"]
    candidate_id = int(payload["candidate_id"])
    candidate_name = payload["candidate_name"]
    party = payload["party"]
    tx_hash = payload.get("tx_hash")
    pre_vote_image = payload.get("pre_vote_image")
    on_vote_day_image = payload.get("on_vote_day_image")

    # Store audit images directly in DB (BLOB) instead of only file paths.
    pre_vote_blob, pre_vote_mime = decode_image_bytes_from_data_url(pre_vote_image) if pre_vote_image else (None, None)
    on_vote_day_blob, on_vote_day_mime = decode_image_bytes_from_data_url(on_vote_day_image) if on_vote_day_image else (None, None)
    pre_vote_path = None
    on_vote_day_path = None

    try:
        cursor.execute(
            "SELECT id FROM vote_audit WHERE voter_id = %s ORDER BY id DESC LIMIT 1",
            (voter_id,),
        )
        existing = cursor.fetchone()
        if existing:
            raise HTTPException(status_code=409, detail="Vote audit already exists for this voter")

        cursor.execute(
            """
            INSERT INTO vote_audit
                (
                    voter_id,
                    candidate_id,
                    candidate_name,
                    party,
                    pre_vote_image_path,
                    on_vote_day_image_path,
                    pre_vote_image_blob,
                    on_vote_day_image_blob,
                    pre_vote_image_mime,
                    on_vote_day_image_mime,
                    tx_hash
                )
            VALUES
                (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                voter_id,
                candidate_id,
                candidate_name,
                party,
                pre_vote_path,
                on_vote_day_path,
                pre_vote_blob,
                on_vote_day_blob,
                pre_vote_mime,
                on_vote_day_mime,
                tx_hash,
            ),
        )
        cursor.execute(
            """
            INSERT INTO vote_report_live (candidate_id, candidate_name, party, vote_count, rank_position)
            VALUES (%s, %s, %s, 1, 0)
            ON DUPLICATE KEY UPDATE
                candidate_name = VALUES(candidate_name),
                party = VALUES(party),
                vote_count = vote_count + 1
            """,
            (candidate_id, candidate_name, party),
        )
        cnx.commit()
        refresh_vote_rankings()
    except mysql.connector.Error as err:
        print(err)
        raise HTTPException(status_code=500, detail=f"Failed to save vote audit: {err}")
    except HTTPException:
        # Preserve explicit HTTP errors (e.g., duplicate 409).
        raise
    except Exception as err:
        # Surface unexpected exceptions during development instead of a generic "Internal Server Error".
        print("vote/audit: unexpected error")
        print(traceback.format_exc())
        raise HTTPException(status_code=500, detail=str(err))

    return {"message": "Vote audit saved"}


@app.get("/vote/report")
async def get_vote_report():
    cursor.execute(
        """
        SELECT candidate_id, candidate_name, party, vote_count, rank_position, updated_at
        FROM vote_report_live
        ORDER BY rank_position ASC, vote_count DESC, candidate_id ASC
        """
    )
    rows = cursor.fetchall()
    report = []
    for row in rows:
        report.append(
            {
                "candidate_id": row[0],
                "candidate_name": row[1],
                "party": row[2],
                "vote_count": int(row[3]),
                "rank_position": int(row[4]),
                "updated_at": str(row[5]),
            }
        )
    return {"items": report}


@app.get("/admin/vote-audit/export")
async def export_vote_audit(request: Request):
    cursor.execute(
        """
        SELECT
            va.id,
            va.voter_id,
            COALESCE(v.full_name, '') AS voter_name,
            va.on_vote_day_image_path,
            va.candidate_name,
            va.party,
            va.voted_at,
            va.tx_hash
        FROM vote_audit va
        LEFT JOIN voters v ON v.voter_id = va.voter_id
        ORDER BY va.voted_at ASC, va.id ASC
        """
    )
    rows = cursor.fetchall()

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(
        [
            "S No",
            "Voter ID Card Number",
            "Voter Name",
            "On Vote Day Image URL",
            "Voted Candidate",
            "Party",
            "Vote Time",
            "Transaction Hash",
        ]
    )

    base_url = str(request.base_url).rstrip("/")
    serial = 1
    for row in rows:
        audit_id = row[0]
        image_url = f"{base_url}/admin/vote-audit/image/{audit_id}?kind=on"
        vote_time = row[6]
        if isinstance(vote_time, datetime.datetime):
            vote_time = vote_time.isoformat()
        writer.writerow(
            [
                serial,
                row[1],
                row[2],
                image_url,
                row[4],
                row[5],
                vote_time,
                row[7] or "",
            ]
        )
        serial += 1

    csv_data = output.getvalue()
    output.close()
    headers = {
        "Content-Disposition": "attachment; filename=vote_audit_report.csv",
        "Cache-Control": "no-store",
    }
    return StreamingResponse(iter([csv_data]), media_type="text/csv", headers=headers)


@app.get("/admin/vote-audit/image/{audit_id}")
async def get_vote_audit_image(audit_id: int, kind: str = "on"):
    # kind=on (on-vote-day) or kind=pre (pre-vote)
    if kind not in ("on", "pre"):
        raise HTTPException(status_code=400, detail="Invalid kind")

    if kind == "on":
        cursor.execute(
            "SELECT on_vote_day_image_blob, on_vote_day_image_mime FROM vote_audit WHERE id = %s",
            (audit_id,),
        )
    else:
        cursor.execute(
            "SELECT pre_vote_image_blob, pre_vote_image_mime FROM vote_audit WHERE id = %s",
            (audit_id,),
        )

    row = cursor.fetchone()
    if not row or not row[0]:
        raise HTTPException(status_code=404, detail="Image not found")

    blob = row[0]
    mime = row[1] or "application/octet-stream"
    return StreamingResponse(iter([blob]), media_type=mime, headers={"Cache-Control": "no-store"})


@app.post("/admin/database/clear")
async def clear_database(request: Request):
    payload = await request.json()
    confirm_key = (payload.get("confirm_key") or "").strip()
    if confirm_key != "CLEAR_ALL":
        raise HTTPException(status_code=400, detail="Invalid confirmation key")

    cleared_tables = []
    try:
        cursor.execute("SET FOREIGN_KEY_CHECKS = 0")
        for table in ["vote_audit", "vote_report_live", "votes", "candidates", "candidate_nominations", "voters", "election_config"]:
            cursor.execute(
                "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = %s AND table_name = %s",
                (os.environ["MYSQL_DB"], table),
            )
            exists = cursor.fetchone()[0] > 0
            if exists:
                cursor.execute(f"TRUNCATE TABLE {table}")
                cleared_tables.append(table)
        cursor.execute("SET FOREIGN_KEY_CHECKS = 1")

        # Ensure at least one admin account exists after full reset.
        if "voters" in cleared_tables:
            cursor.execute(
                """
                INSERT INTO voters (voter_id, password, role, full_name, is_active)
                VALUES (%s, %s, %s, %s, %s)
                """,
                ("admin001", "admin123", "admin", "System Admin", 1),
            )
        if "election_config" in cleared_tables:
            cursor.execute(
                """
                INSERT INTO election_config (id, start_ts, end_ts, status, reconduct_count, stopped_at)
                VALUES (1, 0, 0, 'running', 0, NULL)
                """
            )

        # Remove captured media files from local storage.
        for file_path in glob.glob(os.path.join(MEDIA_DIR, "*")):
            if os.path.isfile(file_path):
                os.remove(file_path)

        cnx.commit()
    except mysql.connector.Error as err:
        print(err)
        raise HTTPException(status_code=500, detail="Failed to clear database")

    return {
        "message": "Database data cleared successfully",
        "cleared_tables": cleared_tables,
        "admin_user": "admin001",
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
