"""
Generate drive-image-ids.json
==============================
Run this script ONCE (locally, by the developer) to create a mapping of
image filenames → Google Drive file IDs for a public Drive folder.

After running, commit the output file to the repository.
The deployed GitHub Pages site will then load images directly from Drive
with no API key required at runtime.

Usage:
    pip install requests
    python generate_drive_image_ids.py --api-key YOUR_API_KEY [--folder-id FOLDER_ID]

Or set the GOOGLE_API_KEY environment variable instead of --api-key.
"""

import argparse
import json
import os
import sys
import urllib.parse
import urllib.request

DRIVE_API_BASE = "https://www.googleapis.com/drive/v3"
DEFAULT_FOLDER_ID = "1POm8kAP0868XFKxa1F4be5fNfr_3L5IV"
OUTPUT_PATH = os.path.join(os.path.dirname(__file__), "Keter-Image_And_Alto", "drive-image-ids.json")
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".tif", ".tiff"}


def list_all_files(folder_id: str, api_key: str) -> dict[str, str]:
    """Return {filename: file_id} for every image file in the folder tree."""
    result: dict[str, str] = {}
    folder_queue = [folder_id]
    seen_folders: set[str] = set()

    while folder_queue:
        current = folder_queue.pop(0)
        if current in seen_folders:
            continue
        seen_folders.add(current)
        page_token = ""
        while True:
            q = f"'{current}' in parents and trashed = false"
            params = {
                "q": q,
                "fields": "nextPageToken,files(id,name,mimeType)",
                "pageSize": "1000",
                "supportsAllDrives": "true",
                "includeItemsFromAllDrives": "true",
                "key": api_key,
            }
            if page_token:
                params["pageToken"] = page_token
            url = f"{DRIVE_API_BASE}/files?" + urllib.parse.urlencode(params)
            with urllib.request.urlopen(url) as resp:
                data = json.loads(resp.read().decode())
            for item in data.get("files", []):
                if item["mimeType"] == "application/vnd.google-apps.folder":
                    folder_queue.append(item["id"])
                else:
                    ext = os.path.splitext(item["name"])[1].lower()
                    if ext in IMAGE_EXTENSIONS:
                        result[item["name"]] = item["id"]
            page_token = data.get("nextPageToken", "")
            if not page_token:
                break
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate drive-image-ids.json for the Keter viewer")
    parser.add_argument("--api-key", default=os.environ.get("GOOGLE_API_KEY", ""), help="Google API key")
    parser.add_argument("--folder-id", default=DEFAULT_FOLDER_ID, help="Drive folder ID or sharing URL")
    args = parser.parse_args()

    api_key = args.api_key.strip()
    if not api_key:
        sys.exit("ERROR: provide --api-key or set GOOGLE_API_KEY environment variable")

    # Accept full sharing URL or bare ID
    folder_id = args.folder_id.strip()
    import re
    m = re.search(r"/folders/([a-zA-Z0-9_-]+)", folder_id)
    if m:
        folder_id = m.group(1)

    print(f"Listing files in Drive folder: {folder_id} ...")
    image_ids = list_all_files(folder_id, api_key)
    print(f"Found {len(image_ids)} image file(s)")

    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(image_ids, f, ensure_ascii=False, indent=2, sort_keys=True)
    print(f"Written to: {OUTPUT_PATH}")
    print("Commit this file to your repository — no API key needed at runtime.")


if __name__ == "__main__":
    main()
