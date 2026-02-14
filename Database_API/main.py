  # Import required modules
import base64
import csv
import datetime
import dotenv
import io
import os
import glob
import uuid
import traceback
import mysql.connector
from fastapi import FastAPI, HTTPException, status, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from mysql.connector import errorcode
import jwt

# Loading the environment variables
dotenv.load_dotenv()

# Initialize the todoapi app
app = FastAPI()

# Define the allowed origins for CORS
origins = [
    "http://localhost:8080",
    "http://127.0.0.1:8080",
]

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
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


def ensure_schema():
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS voters (
            voter_id VARCHAR(64) PRIMARY KEY,
            password VARCHAR(255) NOT NULL,
            role VARCHAR(16) NOT NULL DEFAULT 'user',
            full_name VARCHAR(120),
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
            votes INT NOT NULL DEFAULT 0
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
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
        """
    )

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS candidate_nominations (
            id INT AUTO_INCREMENT PRIMARY KEY,
            election_name VARCHAR(160) NULL,
            position VARCHAR(160) NULL,
            full_name VARCHAR(160) NOT NULL,
            date_of_birth DATE NOT NULL,
            address TEXT NULL,
            contact_number VARCHAR(32) NULL,
            id_number VARCHAR(64) NOT NULL,
            party_name VARCHAR(120) NULL,
            party_symbol VARCHAR(64) NULL,
            is_independent TINYINT NOT NULL DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uq_candidate_fullname_dob (full_name, date_of_birth),
            UNIQUE KEY uq_candidate_party_name (party_name),
            UNIQUE KEY uq_candidate_id_number (id_number)
        )
        """
    )

    # Single-row config
    cursor.execute("INSERT IGNORE INTO election_config (id, start_ts, end_ts) VALUES (1, 0, 0)")
    # Existing deployments may have an older voters schema (name/email only).
    # Add required columns incrementally so /admin/voters works without manual DB reset.
    cursor.execute("SHOW COLUMNS FROM voters")
    existing_cols = {row[0] for row in cursor.fetchall()}

    if "full_name" not in existing_cols:
        cursor.execute("ALTER TABLE voters ADD COLUMN full_name VARCHAR(120) NULL")
        if "name" in existing_cols:
            cursor.execute("UPDATE voters SET full_name = name WHERE full_name IS NULL")

    if "photo_path" not in existing_cols:
        cursor.execute("ALTER TABLE voters ADD COLUMN photo_path VARCHAR(255) NULL")

    if "qr_token" not in existing_cols:
        cursor.execute("ALTER TABLE voters ADD COLUMN qr_token VARCHAR(128) NULL")
        cursor.execute("CREATE UNIQUE INDEX idx_voters_qr_token ON voters (qr_token)")

    if "is_active" not in existing_cols:
        cursor.execute("ALTER TABLE voters ADD COLUMN is_active TINYINT DEFAULT 1")
        cursor.execute("UPDATE voters SET is_active = 1 WHERE is_active IS NULL")

    # Add missing vote_audit blob columns for older deployments.
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
    if "," not in data_url:
        raise HTTPException(status_code=400, detail="Invalid image payload")
    header, encoded = data_url.split(",", 1)
    ext = "jpg"
    if "png" in header:
        ext = "png"
    filename = f"{prefix}_{uuid.uuid4().hex}.{ext}"
    rel_path = os.path.join("media", filename)
    abs_path = os.path.join(os.path.dirname(__file__), rel_path)
    with open(abs_path, "wb") as f:
        f.write(base64.b64decode(encoded))
    return rel_path.replace("\\", "/")


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
    voter_id = (payload.get("voter_id") or "").strip()
    password = (payload.get("password") or "").strip()
    full_name = (payload.get("full_name") or "").strip()
    role = (payload.get("role") or "user").strip().lower()
    photo_data = payload.get("photo_data")

    if not voter_id or not password or not full_name:
        raise HTTPException(status_code=400, detail="voter_id, password, full_name are required")
    if role not in ("user", "admin"):
        role = "user"

    qr_token = f"VOTER::{voter_id}::{uuid.uuid4().hex[:10]}"
    photo_path = save_image_from_data_url(photo_data, f"voter_{voter_id}") if photo_data else None

    try:
        cursor.execute(
            """
            INSERT INTO voters (voter_id, password, role, full_name, photo_path, qr_token, is_active)
            VALUES (%s, %s, %s, %s, %s, %s, 1)
            ON DUPLICATE KEY UPDATE
                password = VALUES(password),
                role = VALUES(role),
                full_name = VALUES(full_name),
                photo_path = VALUES(photo_path),
                qr_token = VALUES(qr_token),
                is_active = 1
            """,
            (voter_id, password, role, full_name, photo_path, qr_token),
        )
        cnx.commit()
    except mysql.connector.Error as err:
        print(err)
        raise HTTPException(status_code=500, detail="Failed to save voter")

    return {
        "message": "Voter saved",
        "voter_id": voter_id,
        "full_name": full_name,
        "role": role,
        "qr_token": qr_token,
        "photo_path": photo_path,
    }


@app.get("/voter/by-qr")
async def get_voter_by_qr(qr_token: str):
    cursor.execute(
        """
        SELECT voter_id, full_name, role, photo_path, qr_token
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
        "qr_token": row[4],
    }


@app.get("/candidates")
async def list_candidates():
    cursor.execute(
        """
        SELECT c.candidate_id, c.name, c.party, COALESCE(r.vote_count, 0) AS vote_count
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
                "vote_count": int(row[3]),
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

    if not candidate_id or not name or not party:
        raise HTTPException(status_code=400, detail="candidate_id, name, party are required")
    try:
        candidate_id = int(candidate_id)
    except Exception:
        raise HTTPException(status_code=400, detail="candidate_id must be an integer")

    try:
        cursor.execute(
            """
            INSERT INTO candidates (candidate_id, name, party, symbol, votes)
            VALUES (%s, %s, %s, %s, 0)
            ON DUPLICATE KEY UPDATE
                name = VALUES(name),
                party = VALUES(party),
                symbol = VALUES(symbol)
            """,
            (candidate_id, name, party, symbol),
        )
        cnx.commit()
    except mysql.connector.Error as err:
        print(err)
        raise HTTPException(status_code=500, detail="Failed to save candidate")

    return {"message": "Candidate saved", "candidate_id": candidate_id, "name": name, "party": party}


@app.get("/admin/candidate-nominations/keys")
async def list_candidate_nomination_keys():
    # Minimal fields for fast, client-side duplicate prechecks.
    cursor.execute(
        """
        SELECT full_name, date_of_birth, party_name
        FROM candidate_nominations
        ORDER BY id DESC
        """
    )
    items = []
    for row in cursor.fetchall():
        items.append(
            {
                "full_name": row[0],
                "date_of_birth": str(row[1]),
                "party_name": row[2],
            }
        )
    return {"items": items}


@app.post("/admin/candidate-nominations/check")
async def check_candidate_nomination(request: Request):
    payload = await request.json()
    full_name = (payload.get("full_name") or "").strip()
    dob_raw = (payload.get("date_of_birth") or "").strip()
    id_number = (payload.get("id_number") or "").strip()
    party_name = (payload.get("party_name") or "").strip()
    is_independent = bool(payload.get("is_independent"))

    if not full_name or not dob_raw or not id_number:
        raise HTTPException(status_code=400, detail="full_name, date_of_birth, id_number are required")

    try:
        dob = datetime.date.fromisoformat(dob_raw)
    except Exception:
        raise HTTPException(status_code=400, detail="date_of_birth must be YYYY-MM-DD")

    if dob >= datetime.date.today():
        raise HTTPException(status_code=400, detail="date_of_birth must be in the past")

    if is_independent:
        party_name = ""
    else:
        if not party_name:
            raise HTTPException(status_code=400, detail="party_name is required unless is_independent is true")

    cursor.execute(
        "SELECT id FROM candidate_nominations WHERE full_name = %s AND date_of_birth = %s LIMIT 1",
        (full_name, dob),
    )
    if cursor.fetchone():
        raise HTTPException(status_code=409, detail="Duplicate detected: Full Name + Date of Birth already exists")

    if party_name:
        cursor.execute("SELECT id FROM candidate_nominations WHERE party_name = %s LIMIT 1", (party_name,))
        if cursor.fetchone():
            raise HTTPException(status_code=409, detail="Duplicate detected: Party Name already exists")

    cursor.execute("SELECT id FROM candidate_nominations WHERE id_number = %s LIMIT 1", (id_number,))
    if cursor.fetchone():
        raise HTTPException(status_code=409, detail="Duplicate detected: ID Number already exists")

    return {"ok": True}


@app.post("/admin/candidate-nominations")
async def create_candidate_nomination(request: Request):
    payload = await request.json()

    election_name = (payload.get("election_name") or "").strip()
    position = (payload.get("position") or "").strip()
    full_name = (payload.get("full_name") or "").strip()
    dob_raw = (payload.get("date_of_birth") or "").strip()
    address = (payload.get("address") or "").strip()
    contact_number = (payload.get("contact_number") or "").strip()
    id_number = (payload.get("id_number") or "").strip()
    party_name = (payload.get("party_name") or "").strip()
    party_symbol = (payload.get("party_symbol") or "").strip()
    is_independent = bool(payload.get("is_independent"))

    if not full_name or not dob_raw or not id_number:
        raise HTTPException(status_code=400, detail="full_name, date_of_birth, id_number are required")

    try:
        dob = datetime.date.fromisoformat(dob_raw)
    except Exception:
        raise HTTPException(status_code=400, detail="date_of_birth must be YYYY-MM-DD")

    if dob >= datetime.date.today():
        raise HTTPException(status_code=400, detail="date_of_birth must be in the past")

    if contact_number and not contact_number.isdigit():
        raise HTTPException(status_code=400, detail="contact_number must be numeric")

    if is_independent:
        party_name = None
        party_symbol = None
    else:
        if not party_name:
            raise HTTPException(status_code=400, detail="party_name is required unless is_independent is true")
        if party_symbol == "":
            party_symbol = None

    # Friendly duplicate checks (DB unique constraints still enforce truth).
    cursor.execute(
        "SELECT id FROM candidate_nominations WHERE full_name = %s AND date_of_birth = %s LIMIT 1",
        (full_name, dob),
    )
    if cursor.fetchone():
        raise HTTPException(status_code=409, detail="Duplicate detected: Full Name + Date of Birth already exists")

    if party_name:
        cursor.execute("SELECT id FROM candidate_nominations WHERE party_name = %s LIMIT 1", (party_name,))
        if cursor.fetchone():
            raise HTTPException(status_code=409, detail="Duplicate detected: Party Name already exists")

    cursor.execute("SELECT id FROM candidate_nominations WHERE id_number = %s LIMIT 1", (id_number,))
    if cursor.fetchone():
        raise HTTPException(status_code=409, detail="Duplicate detected: ID Number already exists")

    try:
        cursor.execute(
            """
            INSERT INTO candidate_nominations (
                election_name, position, full_name, date_of_birth, address, contact_number,
                id_number, party_name, party_symbol, is_independent
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                election_name or None,
                position or None,
                full_name,
                dob,
                address or None,
                contact_number or None,
                id_number,
                party_name,
                party_symbol or None,
                1 if is_independent else 0,
            ),
        )
        cnx.commit()
    except mysql.connector.Error as err:
        # 1062: duplicate key
        if getattr(err, "errno", None) == 1062:
            raise HTTPException(status_code=409, detail="Duplicate detected: nomination already exists")
        print(err)
        raise HTTPException(status_code=500, detail="Failed to save candidate nomination")

    return {"message": "Candidate nomination created"}


@app.get("/election/dates")
async def get_election_dates():
    cursor.execute("SELECT start_ts, end_ts, updated_at FROM election_config WHERE id = 1")
    row = cursor.fetchone()
    if not row:
        return {"start_ts": 0, "end_ts": 0}
    return {"start_ts": int(row[0] or 0), "end_ts": int(row[1] or 0), "updated_at": str(row[2])}


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

    cursor.execute("UPDATE election_config SET start_ts = %s, end_ts = %s WHERE id = 1", (start_ts, end_ts))
    cnx.commit()
    return {"message": "Election dates saved", "start_ts": start_ts, "end_ts": end_ts}

@app.post("/voter/confirm-scan")
async def confirm_scan(request: Request):
    payload = await request.json()
    qr_token = (payload.get("qr_token") or "").strip()
    image_data = payload.get("image_data")
    if not qr_token or not image_data:
        raise HTTPException(status_code=400, detail="qr_token and image_data are required")

    cursor.execute(
        "SELECT voter_id, full_name, role, photo_path FROM voters WHERE qr_token = %s AND is_active = 1",
        (qr_token,),
    )
    row = cursor.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Voter not found for this QR")

    voter_id, full_name, role, photo_path = row
    on_vote_day_path = save_image_from_data_url(image_data, f"scan_{voter_id}")

    return {
        "message": "Scan confirmed",
        "voter_id": voter_id,
        "full_name": full_name,
        "role": role,
        "photo_path": photo_path,
        "on_vote_day_image_path": on_vote_day_path,
        "confirmed_at": datetime.datetime.utcnow().isoformat() + "Z",
    }


@app.post("/vote/audit")
async def save_vote_audit(request: Request):
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
