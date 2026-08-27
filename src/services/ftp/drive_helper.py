"""Google Drive upload (CA facility) — ported from legacy stpWorker/driveHelper.py.

Same google-api-python-client flow: service-account credentials, create the
order folder under CA_DRIVE_ID, upload every file concurrently.

Two cloud-specific hardenings over the legacy office setup:
  * The googleapiclient service (and its underlying httplib2 http) is NOT
    thread-safe. The legacy uploader was async with a connection per request;
    this port fans out over threads, so each worker builds its OWN service —
    sharing one across threads corrupts the TLS stream ("[SSL] record layer
    failure"). A per-thread service is the documented pattern.
  * The Fargate task's egress is less reliable than the office network, so each
    file upload gets a socket timeout and a few retries with backoff to ride out
    transient SSL drops / read timeouts.

The service-account JSON comes from SSM instead of a checked-in file.
"""

import mimetypes
import os
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload

SCOPES = ["https://www.googleapis.com/auth/drive"]
MAX_ATTEMPTS = 4


def _build_service(service_account_file):
    """Build a fresh Drive service (own http/socket) — safe for one thread."""
    creds = service_account.Credentials.from_service_account_file(
        service_account_file, scopes=SCOPES)
    # cache_discovery=False avoids a shared on-disk cache across threads.
    return build("drive", "v3", credentials=creds, cache_discovery=False)


# Back-compat: callers that only need a service (e.g. folder create) can still
# get one directly.
def get_drive(service_account_file):
    return _build_service(service_account_file)


def create_drive_folder(drive, name, parent_folder_id):
    meta = {"name": name, "mimeType": "application/vnd.google-apps.folder"}
    if parent_folder_id:
        meta["parents"] = [parent_folder_id]
    # supportsAllDrives is required for Shared Drive IDs (CA_DRIVE_ID is one).
    folder = drive.files().create(body=meta, fields="id", supportsAllDrives=True).execute()
    return folder.get("id")


def _upload_single_file(service_account_file, local_path, file_name, drive_root_id):
    """Upload one file with its own Drive service, retrying transient failures."""
    mime_type = mimetypes.guess_type(local_path)[0] or "application/octet-stream"
    last_error = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            drive = _build_service(service_account_file)
            # Simple (non-resumable) upload: one multipart request, same request
            # style as the folder-create call that succeeds.
            media = MediaFileUpload(local_path, mimetype=mime_type, resumable=False)
            f = drive.files().create(
                body={"name": file_name, "parents": [drive_root_id]},
                media_body=media, fields="id",
                supportsAllDrives=True,
            ).execute(num_retries=2)
            return {"success": True, "file": file_name, "id": f.get("id")}
        except Exception as e:  # transient TLS drop / read timeout -> retry
            last_error = str(e)
            if attempt < MAX_ATTEMPTS:
                time.sleep(2 ** attempt)  # 2s, 4s, 8s
    return {"success": False, "file": file_name, "error": last_error}


def upload_print_folder(service_account_file, local_path, parent_folder_id, max_workers=4):
    """Create the order folder and upload every file (own service per worker)."""
    local_folder = os.path.abspath(local_path)
    if not os.path.isdir(local_folder):
        raise ValueError(f"{local_folder} not found")

    root_name = os.path.basename(local_folder.rstrip("/\\"))
    # Folder create on the main thread with its own service.
    drive_root_id = create_drive_folder(
        _build_service(service_account_file), root_name, parent_folder_id)

    files = [f for f in os.listdir(local_folder)
             if os.path.isfile(os.path.join(local_folder, f)) and not f.startswith(".")]

    results = []
    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures = [pool.submit(_upload_single_file, service_account_file,
                               os.path.join(local_folder, name), name, drive_root_id)
                   for name in files]
        for fut in as_completed(futures):
            results.append(fut.result())

    return {
        "folder_id": drive_root_id,
        "total_files": len(files),
        "successful": sum(1 for r in results if r["success"]),
        "failed": sum(1 for r in results if not r["success"]),
        "results": results,
    }
