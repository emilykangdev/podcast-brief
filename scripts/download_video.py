#!/usr/bin/env python3
"""
Download a single YouTube video using the yt-dlp Python API.

Usage:
  python download_video.py <video_url> [--output-dir ./downloads]

Examples:
  python download_video.py https://www.youtube.com/watch?v=dQw4w9WgXcQ
  python download_video.py https://youtu.be/dQw4w9WgXcQ --output-dir ./yt_downloads --subs-only

Notes:
- Requires `yt-dlp`. Install with: pip install yt-dlp
"""

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from typing import Any, Dict, List

try:
    import yt_dlp as ytdlp  # type: ignore
except Exception:
    print("ERROR: yt-dlp is not installed. Install it with: pip install yt-dlp", file=sys.stderr)
    raise


def make_progress_hook(manifest_path: str):
    os.makedirs(os.path.dirname(manifest_path) or ".", exist_ok=True)
    seen_ids: set[str] = set()

    def _hook(d: Dict[str, Any]) -> None:
        status = d.get("status")
        if status == "downloading":
            total = d.get("_total_bytes_str") or d.get("_total_bytes_estimate_str") or "?"
            downloaded = d.get("_downloaded_bytes_str") or d.get("downloaded_bytes") or "?"
            speed = d.get("_speed_str") or "?"
            eta = d.get("_eta_str") or "?"
            print(f"[downloading] {downloaded}/{total} at {speed} ETA {eta}", flush=True)
        elif status == "finished":
            filename = d.get("filename") or "<file>"
            info = d.get("info_dict") or {}
            vid = info.get("id")
            if vid and vid in seen_ids:
                return
            if vid:
                seen_ids.add(vid)
            subs = info.get("requested_subtitles") or {}
            sub_files = []
            base, _ = os.path.splitext(filename)
            for lang, meta in subs.items():
                ext = (meta or {}).get("ext") or "srt"
                fpath = (meta or {}).get("filepath") or f"{base}.{lang}.{ext}"
                if os.path.exists(fpath):
                    sub_files.append(fpath)
            record = {
                "id": info.get("id"),
                "title": info.get("title"),
                "uploader": info.get("uploader"),
                "upload_date": info.get("upload_date"),
                "duration": info.get("duration"),
                "webpage_url": info.get("webpage_url"),
                "ext": info.get("ext"),
                "filepath": filename,
                "subtitle_files": sub_files,
                "saved_at": datetime.now(timezone.utc).isoformat(),
            }
            try:
                with open(manifest_path, "a", encoding="utf-8") as f:
                    f.write(json.dumps(record, ensure_ascii=False) + "\n")
            except Exception as e:
                print(f"[warn] Failed to write manifest: {e}")
            print(f"[post] Finished downloading: {filename}", flush=True)

    return _hook


def make_ydl_opts(
    output_dir: str,
    sub_langs: str = "en,en-*",
    sub_format: str = "srt",
    write_auto_sub: bool = True,
    write_subs: bool = True,
    subs_only: bool = False,
) -> Dict[str, Any]:
    opts: Dict[str, Any] = {
        "outtmpl": os.path.join(output_dir, "%(uploader)s", "%(upload_date)s_%(title)s_%(id)s.%(ext)s"),
        "restrictfilenames": True,
        "continuedl": True,
        "concurrent_fragment_downloads": 4,
        "writesubtitles": bool(write_subs),
        "writeautomaticsub": bool(write_auto_sub),
        "subtitleslangs": [s.strip() for s in str(sub_langs).split(",") if s.strip()],
        "subtitlesformat": str(sub_format),
        "format": "bv*+ba/b",
        "merge_output_format": "mp4",
        "writeinfojson": True,
        "clean_infojson": True,
        # Critical: only this video, even if URL has a playlist param
        "noplaylist": True,
        "quiet": False,
        "no_warnings": False,
    }

    if subs_only:
        opts["skip_download"] = True
        if not (opts.get("writesubtitles") or opts.get("writeautomaticsub")):
            opts["writeautomaticsub"] = True

    return opts


def download_video(
    video_url: str,
    output_dir: str,
    manifest_file: str | None = None,
    sub_langs: str = "en,en-*",
    sub_format: str = "srt",
    write_auto_sub: bool = True,
    write_subs: bool = True,
    subs_only: bool = False,
) -> None:
    os.makedirs(output_dir, exist_ok=True)
    if not manifest_file:
        manifest_file = os.path.join(output_dir, "manifest.jsonl")

    ydl_opts = make_ydl_opts(
        output_dir,
        sub_langs=sub_langs,
        sub_format=sub_format,
        write_auto_sub=write_auto_sub,
        write_subs=write_subs,
        subs_only=subs_only,
    )
    ydl_opts["progress_hooks"] = [make_progress_hook(manifest_file)]

    with ytdlp.YoutubeDL(ydl_opts) as ydl:
        try:
            info = ydl.extract_info(video_url, download=False)
            title = info.get("title") if isinstance(info, dict) else None
            if title:
                print(f"[info] Resolved: {title}")
        except Exception as e:
            print(f"[warn] Could not pre-extract info: {e}")

        print(f"[start] Downloading video: {video_url}")
        retcode = ydl.download([video_url])
        if retcode == 0:
            print("[done] Video processed.")
        else:
            print(f"[done] Completed with {retcode} error(s). See logs above.")


def parse_args(argv: List[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Download a single YouTube video using yt-dlp")
    p.add_argument("video_url", help="YouTube video URL (e.g., https://www.youtube.com/watch?v=...)")
    p.add_argument("--output-dir", default="../data", help="Root output directory (default: ../data)")
    p.add_argument("--manifest-file", default=None, help="Append per-video JSON record here (default: <output-dir>/manifest.jsonl)")
    p.add_argument("--subs-langs", default="en,en-*", help="Comma-separated subtitle languages to fetch (default: en,en-*)")
    p.add_argument("--subs-format", default="srt", choices=["srt", "vtt"], help="Subtitle format (default: srt)")
    p.add_argument("--no-auto-sub", action="store_true", help="Disable auto-generated subtitles")
    p.add_argument("--no-subs", action="store_true", help="Disable provided subtitles")
    p.add_argument("--subs-only", action="store_true", help="Download subtitles/transcripts only (skip video download)")
    return p.parse_args(argv)


def main(argv: List[str] | None = None) -> None:
    if argv is None:
        argv = sys.argv[1:]
    args = parse_args(argv)
    download_video(
        args.video_url,
        args.output_dir,
        manifest_file=args.manifest_file,
        sub_langs=args.subs_langs,
        sub_format=args.subs_format,
        write_auto_sub=(not args.no_auto_sub),
        write_subs=(not args.no_subs),
        subs_only=args.subs_only,
    )


if __name__ == "__main__":
    main()
