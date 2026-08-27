"""Google Drive upload (CA facility) — ported from legacy stpWorker/driveHelper.py.

Same google-api-python-client flow: service-account credentials, create the
order folder under CA_DRIVE_ID, upload every file concurrently (4 workers).
The service-account JSON now comes from SSM instead of a checked-in file.
"""

import mimetypes
import os
from concurrent.futures import ThreadPoolExecutor, as_completed

from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload

SCOPES = ["https://www.googleapis.com/auth/drive"]


def get_drive(service_account_file):
    creds = service_account.Credentials.from_service_account_file(
        service_account_file, scopes=SCOPES)
    return build("drive", "v3", credentials=creds)


def create_drive_folder(drive, name, parent_folder_id):
    meta = {"name": name, "mimeType": "application/vnd.google-apps.folder"}
    if parent_folder_id:
        meta["parents"] = [parent_folder_id]
    # supportsAllDrives is required for Shared Drive IDs (CA_DRIVE_ID is one).
    folder = drive.files().create(body=meta, fields="id", supportsAllDrives=True).execute()
    return folder.get("id")


def _upload_single_file(drive, local_path, file_name, drive_root_id):
    try:
        mime_type = mimetypes.guess_type(local_path)[0] or "application/octet-stream"
        media = MediaFileUpload(local_path, mimetype=mime_type, resumable=True)
        f = drive.files().create(
            body={"name": file_name, "parents": [drive_root_id]},
            media_body=media, fields="id", supportsAllDrives=True).execute()
        return {"success": True, "file": file_name, "id": f.get("id")}
    except Exception as e:  # per-file failure recorded, not fatal (legacy behaviour)
        return {"success": False, "file": file_name, "error": str(e)}


def upload_print_folder(drive, local_path, parent_folder_id, max_workers=4):
    """Sync port of the legacy async uploader (run-to-completion container)."""
    local_folder = os.path.abspath(local_path)
    if not os.path.isdir(local_folder):
        raise ValueError(f"{local_folder} not found")

    root_name = os.path.basename(local_folder.rstrip("/\\"))
    drive_root_id = create_drive_folder(drive, root_name, parent_folder_id)

    files = [f for f in os.listdir(local_folder)
             if os.path.isfile(os.path.join(local_folder, f)) and not f.startswith(".")]

    results = []
    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures = [pool.submit(_upload_single_file, drive,
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
