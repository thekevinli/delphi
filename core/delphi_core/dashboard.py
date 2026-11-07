"""Deterministic dashboard artifacts: no model calls and no load-time writes."""

import asyncio
import contextlib
import re
import tempfile
import logging
import os
import base64
import io
import shutil
import subprocess
import signal
import resource
import threading
import time
import urllib.parse
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from bs4 import BeautifulSoup
from fastapi import HTTPException
from PIL import Image, ImageDraw

from .browser_host import BrowserHost, configured as browser_host
from .browser_render import (
    _asset_hosts,
    _browser_errors,
    _chrome_executable,
    _inherited_signal_state,
    _pinned_public_address,
    _public_only_proxy,
    base_chrome_flags,
    kill_group,
    render_width_of,
    screenshot_with_host,
    spawn_clean,
)
from .config import Settings
from .pdf_figures import encode_thumbnail
from .storage import ALL_CONVERSATIONS, ObjectStore, Storage, paper_key, utc_now
from .web_extract import static_document
from .web_fetch import PDF_TYPES, fetch_resource
from .web_revision import inert_document, read_revision

SPACE = re.compile(r"\s+")
logger = logging.getLogger("uvicorn.error")
# Renderer versions invalidate only the corresponding thumbnail.
# 10: Adapt source-origin stylesheet CORS before photographing frozen DOMs.
WEB_THUMBNAIL_VERSION = 10
PDF_THUMBNAIL_VERSION = 1
# A failed preview is retried inside the Reader open that asked for it, not
# across the document's lifetime. Three attempts, a minute apart; another open
# starts the count over. The escalating cooldown this replaced (2 minutes, then
# 20, then 3 hours, then a day) was how a starved first capture — the one made
# during the document's own creation request — froze the card for every later
# open that fell inside the pause.
THUMBNAIL_RETRY_AFTER = timedelta(minutes=1)
THUMBNAIL_ATTEMPTS_PER_ENGAGEMENT = 3
#: In-flight retry chains, keyed by (username, project_id, paper_id). A newer
#: open cancels the previous chain so two engagements cannot pile attempts.
_THUMBNAIL_RETRY_TASKS: dict[tuple[str, str, str], asyncio.Task] = {}
_THUMBNAIL_ENGAGEMENT_GEN: dict[tuple[str, str, str], int] = {}
VIMEO_POSTER = re.compile(r'https://i\.vimeocdn\.com/video/[^"\\]+')


def required_thumbnail_version(paper: dict[str, Any]) -> int:
    return (
        WEB_THUMBNAIL_VERSION if paper.get("kind") == "web"
        else PDF_THUMBNAIL_VERSION
    )


def thumbnail_is_due(paper: dict[str, Any], *, now: datetime | None = None) -> bool:
    """Whether a preview is worth generating right now. One test, two callers.

    The engagement touch and `delphi_core.backfill.thumbnails` both ask this, so the
    dry-run's count and the live decision cannot drift — the backfill used to
    carry its own copy of the version comparison.

    Three questions, deliberately not collapsed. A paper behind the renderer is
    due immediately: that is the entire point of bumping a version. A paper at
    the current version with bytes is never due. A paper whose capture *failed*
    is due one minute later, until this engagement has spent its three
    attempts. A new Reader open resets the count (see
    `capture_document_thumbnail_for_engagement`) rather than waiting out a
    pause the reader already came back inside of.
    """
    if int(paper.get("thumbnailVersion") or 0) < required_thumbnail_version(paper):
        return True
    if paper.get("thumbnailAvailable"):
        return False
    if int(paper.get("thumbnailAttempts") or 0) >= THUMBNAIL_ATTEMPTS_PER_ENGAGEMENT:
        return False
    attempted = paper.get("thumbnailAttemptedAt")
    if not attempted:
        return True
    try:
        last = datetime.fromisoformat(str(attempted))
    except ValueError:
        return True
    if last.tzinfo is None:
        last = last.replace(tzinfo=timezone.utc)
    waited = (now or datetime.now(timezone.utc)) - last
    return waited >= THUMBNAIL_RETRY_AFTER


def thumbnail_fields(
    paper: dict[str, Any], *, generated: bool, version: int | None = None
) -> dict[str, Any]:
    """What every writer of a capture stores about it. One place, five callers.

    Creation, the refresh, storing a linked PDF, an upload and the lazy path all
    used to spell this out themselves, which is how four of them came to record
    the attempt and none of them the count. `thumbnailAvailable` is set only on
    success and never cleared: a failed re-capture at a *new* version must not
    take away the older preview that is still on the card and still serves.
    """
    required = version if version is not None else required_thumbnail_version(paper)
    # Failures count only against the version that saw them: a version bump is
    # a new renderer and deserves a fresh engagement budget, not the three
    # attempts the previous one had already spent.
    previous = (
        int(paper.get("thumbnailAttempts") or 0)
        if int(paper.get("thumbnailVersion") or 0) == required
        else 0
    )
    fields: dict[str, Any] = {
        "thumbnailVersion": required,
        "thumbnailAttemptedAt": utc_now(),
        "thumbnailAttempts": 0 if generated else previous + 1,
    }
    if generated:
        fields["thumbnailAvailable"] = True
    return fields


def _trim_blank_margins(
    image: Image.Image, *, minimum_fraction: float = 0.35
) -> Image.Image:
    """Crop the empty page around an article so a 4:3 card is the article.

    A Notion page is a ~900px column in a 1512px window. Photographed whole,
    then `object-fit: cover` into 104×78, the card is the topbar and a field
    of white — which is how "Continue reading" came to show a logo on a blank
    tile. Near-white margins are the empty window, not the page.
    """
    gray = image.convert("L")
    mask = gray.point(lambda pixel: 255 if pixel < 248 else 0)
    box = mask.getbbox()
    if box is None:
        return image
    pad = 12
    left, top, right, bottom = box
    cropped = image.crop((
        max(0, left - pad),
        max(0, top - pad),
        min(image.width, right + pad),
        min(image.height, bottom + pad),
    ))
    if (
        cropped.width < image.width * minimum_fraction
        or cropped.height < image.height * minimum_fraction
    ):
        return image
    return cropped


def _save_thumbnail(image: Image.Image, objects: ObjectStore, key: str) -> bool:
    return _store_thumbnail(encode_thumbnail(image), objects, key)


def _store_thumbnail(webp: bytes, objects: ObjectStore, key: str) -> bool:
    with tempfile.NamedTemporaryFile(suffix=".webp", delete=False) as handle:
        handle.write(webp)
        path = Path(handle.name)
    try:
        objects.put_file(key, path, "image/webp")
        return True
    finally:
        path.unlink(missing_ok=True)


# 640×380 cream card after `_save_thumbnail`'s 360×460 fit. A real page
# photograph from the 960-wide viewport is 360×270; a PDF first-page is
# taller still. This size is how a fallback card is recognised without a
# second stored flag — papers stamped `thumbnailAvailable` when the
# placeholder still counted as success would otherwise never recapture.
_FALLBACK_THUMB_SIZE = (360, 214)


def _is_fallback_web_thumbnail(objects: ObjectStore, key: str) -> bool:
    """The cream 'WEB DOCUMENT' card, not a photograph of the page."""
    try:
        payload = b"".join(objects.open_range(key))
        with Image.open(io.BytesIO(payload)) as image:
            return image.size == _FALLBACK_THUMB_SIZE
    except Exception:
        return False


def _has_current_screenshot(
    paper: dict[str, Any], objects: ObjectStore, thumb_key: str
) -> bool:
    if int(paper.get("thumbnailVersion") or 0) < required_thumbnail_version(paper):
        return False
    if not paper.get("thumbnailAvailable") or not objects.exists(thumb_key):
        return False
    return not _is_fallback_web_thumbnail(objects, thumb_key)


#: A first page renders in well under a second. An upload waits on this, so
#: it bounds a stuck child rather than budgeting for a slow one.
PDF_THUMBNAIL_TIMEOUT_SECONDS = 30.0


def make_pdf_thumbnail(
    pdf_path: Path, objects: ObjectStore, username: str, project_id: str, paper_id: str
) -> bool:
    """Store the first page as the card, rendered in `pdf_worker` (core/CLAUDE.md §8).

    False for any failure of the child, which `run_isolated` has already
    logged: the caller still records the attempt (`thumbnail_fields`), and an
    upload succeeds without a preview rather than taking the server with it.
    """
    from .pdf_figures import run_isolated

    webp = run_isolated(
        "pdf_thumbnail", {"path": str(pdf_path)}, timeout=PDF_THUMBNAIL_TIMEOUT_SECONDS
    )
    if not isinstance(webp, bytes) or not webp:
        return False
    return _store_thumbnail(
        webp, objects, paper_key(username, project_id, paper_id, "thumb")
    )


async def make_web_thumbnail(
    title: str,
    source_url: str,
    favicon_url: str | None,
    objects: ObjectStore,
    settings: Settings,
    username: str,
    project_id: str,
    paper_id: str,
    budget_seconds: float | None = None,
) -> bool:
    """Photograph a web document for its card: its page copy if it has one.

    A capture that finishes after a newer copy has replaced the one it
    photographed is discarded, so an older picture never lands on top of the
    newer copy's — two annotations a moment apart store two copies, and their
    captures can finish in either order.
    """
    revision = read_revision(objects, username, project_id, paper_id)
    screenshot, capture_kind = await _capture_webpage_safely(
        revision.get("savedPageUrl") or source_url,
        settings,
        budget_seconds,
        # One copy, two uses: the panel's cached view shows it and the card is
        # a picture of it, so they cannot disagree. This is not a second live
        # navigation of Notion — that is what left 1×1 placeholders in the
        # card — and not a second fetch of a site that refuses one.
        revision.get("savedDom"),
    )
    if read_revision(objects, username, project_id, paper_id).get(
        "savedPageHash"
    ) != revision.get("savedPageHash"):
        if screenshot is not None:
            screenshot.unlink(missing_ok=True)
        logger.info("web thumbnail: %s changed during its capture, keeping the newer preview", source_url)
        return False
    if screenshot is not None:
        try:
            if capture_kind == "pdf":
                import anyio

                return await anyio.to_thread.run_sync(
                    make_pdf_thumbnail,
                    screenshot,
                    objects,
                    username,
                    project_id,
                    paper_id,
                )
            with Image.open(screenshot) as page:
                # A valid PNG can still be an empty app shell. Accepting it
                # stamps success and prevents engagement retries indefinitely.
                if any(high - low > 2 for low, high in page.convert("RGB").getextrema()):
                    return _save_thumbnail(
                        _trim_blank_margins(page),
                        objects,
                        paper_key(username, project_id, paper_id, "thumb"),
                    )
                logger.warning("web thumbnail: blank capture of %s, keeping the prior preview", source_url)
        finally:
            screenshot.unlink(missing_ok=True)

    # Browser capture is derived and best-effort. This remains a recognizable
    # web-document fallback for hosts that refuse automation or depend entirely
    # on cross-host assets, never a substitute presented as a screenshot.
    card = Image.new("RGB", (640, 380), "#fffaf4")
    draw = ImageDraw.Draw(card)
    draw.rounded_rectangle((1, 1, 638, 378), radius=24, outline="#e7d9c8", width=3)
    draw.ellipse((54, 76, 150, 172), fill="#f9e5d3", outline="#c1703c", width=4)
    draw.arc((76, 96, 128, 152), 0, 360, fill="#c1703c", width=4)
    draw.line((56, 124, 148, 124), fill="#c1703c", width=4)
    if favicon_url:
        try:
            resource = await fetch_resource(favicon_url, settings, include_images=True)
            if resource.content_type.startswith("image/") and resource.content_type != "image/svg+xml":
                import io
                icon = Image.open(io.BytesIO(resource.body)).convert("RGBA")
                icon.thumbnail((72, 72), Image.Resampling.LANCZOS)
                card.paste(icon, (66 + (72 - icon.width) // 2, 88 + (72 - icon.height) // 2), icon)
        except Exception:
            pass
    label = SPACE.sub(" ", title).strip()[:52]
    draw.text((54, 226), label, fill="#2e1b0d", stroke_width=0)
    draw.text((54, 276), "WEB DOCUMENT", fill="#9a8674")
    key = paper_key(username, project_id, paper_id, "thumb")
    # A failed recapture must not overwrite a real screenshot with this
    # card: `thumbnailAvailable` is never cleared, so the overwritten bytes
    # would keep being served as if they were the older preview.
    if not objects.exists(key) or _is_fallback_web_thumbnail(objects, key):
        _save_thumbnail(card, objects, key)
    # A placeholder is useful bytes, but it is not a successful screenshot.
    # Reporting success here made a transient network failure permanent because
    # the paper was stamped with the current renderer version and never retried.
    return False


#: Reported once per process, on the first capture. A fix that works leaves no
#: failure line to attach this to, and "it stopped happening" is not the same
#: as knowing why — so the first capture says what it was handed either way.
_SIGNAL_STATE_REPORTED = False


def _capture_webpage(
    source_url: str,
    asset_hosts: tuple[str, ...] = (),
    prepared_html: str | None = None,
    budget_seconds: float = 30.0,
    viewport_width: int = 960,
    viewport_height: int | None = None,
) -> Path | None:
    """Capture one public host without giving page markup an internal-network client.

    Every failure here is logged with the reason that produced it. It used to
    return None for a missing browser, a refused host, a crashed Chromium and a
    blown deadline alike, with the browser's own stderr sent to DEVNULL — so a
    deployment where captures had quietly stopped working looked exactly like
    one where nothing had been captured yet, and the only evidence anywhere was
    a flat card on the Dashboard.
    """
    host = browser_host()
    browser = None if host else _chrome_executable()
    if not host and not browser:
        logger.warning("web thumbnail: no chromium on PATH, %s not captured", source_url)
        return None
    parsed = urllib.parse.urlparse(source_url)
    hostname = parsed.hostname
    if not hostname:
        logger.warning("web thumbnail: no hostname in %s", source_url)
        return None
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    try:
        if not _pinned_public_address(hostname, port):
            logger.warning("web thumbnail: %s has no public address to pin", hostname)
            return None
    except Exception:
        logger.warning("web thumbnail: %s could not be resolved", hostname)
        return None
    with tempfile.TemporaryDirectory(prefix="delphi-web-thumb-") as directory, (
        _public_only_proxy()
    ) as proxy:
        root = Path(directory)
        (root / "crashes").mkdir()
        screenshot = root / "page.png"
        profile = root / "profile"
        target = source_url
        if prepared_html is not None:
            page = root / "page.html"
            # Opened from file://, where a page may read any other file: it
            # is photographed with nothing in it that runs.
            page.write_text(inert_document(prepared_html), encoding="utf-8")
            target = page.as_uri()
        if host:
            return _capture_with_host(
                host, source_url, target, screenshot, proxy, budget_seconds,
                viewport_width, viewport_height or round(viewport_width * 0.75),
            )
        command = [
            browser,
            *base_chrome_flags(
                profile,
                root / "crashes",
                # Per-request validation, as the render uses: a stored image
                # URL can redirect anywhere. Notion's `/image/…` is same-host
                # and 302s to S3, which a pinned host list refused — Figure 1
                # came back a broken-image glyph.
                [f"--proxy-server={proxy}", "--proxy-bypass-list=<-loopback>"],
            ),
            (
                f"--window-size={viewport_width},"
                f"{viewport_height or round(viewport_width * 0.75)}"
            ),
            "--force-device-scale-factor=1",
            "--virtual-time-budget=5000",
            f"--screenshot={screenshot}",
            target,
        ]
        global _SIGNAL_STATE_REPORTED
        if not _SIGNAL_STATE_REPORTED:
            _SIGNAL_STATE_REPORTED = True
            # Once per process, because the failure this exists for was
            # ambient rather than in the code: under Cloud Run's gen1 gVisor
            # kernel every capture died in Chromium's crashpad handler, while
            # the same image captured fine as a job. If previews ever stop
            # again, this line says which kernel and which limits were in
            # force when they did.
            logger.info(
                "web thumbnail: first capture in this process, HOME=%r"
                " rlimit_nofile=%s threads=%d%s",
                os.environ.get("HOME"),
                resource.getrlimit(resource.RLIMIT_NOFILE),
                threading.active_count(),
                _inherited_signal_state(),
            )
        # Chromium's stderr is kept rather than discarded, and reported only
        # when the capture fails: it is noisy on every run (dbus, GCM, nssdb —
        # none of which matter headlessly), and it is also the only place a
        # crash ever says what it hit.
        errors = tempfile.TemporaryFile()
        started = time.monotonic()
        process = spawn_clean(command, stdout=subprocess.DEVNULL, stderr=errors)
        deadline = started + budget_seconds
        finished = False
        capture_ready = False
        last_signature: tuple[int, int] | None = None
        stable_since: float | None = None
        try:
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    finished = True
                    break
                if screenshot.is_file():
                    stat = screenshot.stat()
                    signature = (stat.st_size, stat.st_mtime_ns)
                    if stat.st_size >= 1000 and signature == last_signature:
                        stable_since = stable_since or time.monotonic()
                        if time.monotonic() - stable_since >= 1.0:
                            capture_ready = True
                            break
                    else:
                        last_signature = signature
                        stable_since = time.monotonic()
                time.sleep(0.08)
        finally:
            if process.poll() is None:
                kill_group(process, signal.SIGTERM)
                try:
                    process.wait(timeout=1)
                except subprocess.TimeoutExpired:
                    kill_group(process, signal.SIGKILL)
                    process.wait(timeout=1)
        # Some pages keep media frames alive after Chrome has completed its PNG.
        # Requiring the browser process to exit made those pages fall back forever.
        # Conversely, accepting the first file appearance produced half-written
        # cards. A full second with unchanged size and mtime is the useful middle:
        # the screenshot writer is done even if an unrelated Vimeo frame is not.
        elapsed = round(time.monotonic() - started, 1)
        written = screenshot.stat().st_size if screenshot.is_file() else 0
        if (
            not (capture_ready or (finished and process.returncode == 0))
            or written < 1000
        ):
            # Which of these it is decides what to do about it, so say which.
            # A timeout is a container that needs a longer ceiling or less
            # contention; a negative return code is Chromium taking a signal,
            # which on a small instance is usually memory.
            if not finished:
                reason = f"still running at the {budget_seconds:g}s ceiling"
            elif process.returncode and process.returncode < 0:
                reason = f"killed by signal {-process.returncode}"
            elif process.returncode:
                reason = f"exited {process.returncode}"
            else:
                reason = f"wrote {written} bytes"
            logger.warning(
                "web thumbnail: capture of %s failed after %ss — chromium %s%s%s",
                source_url, elapsed, reason, _browser_errors(errors),
                # Only on a signal death, and only because this is the one
                # thing about a failed capture that cannot be reproduced by
                # running the same image anywhere else.
                _inherited_signal_state() if (process.returncode or 0) < 0 else "",
            )
            return None
        errors.close()
        handle, output_name = tempfile.mkstemp(suffix=".png")
        os.close(handle)
        output = Path(output_name)
        shutil.copyfile(screenshot, output)
        logger.info(
            "web thumbnail: captured %s in %ss (%d bytes)", source_url, elapsed, written
        )
        return output


async def _html_with_static_video_posters(
    html: str, base_url: str, settings: Settings
) -> str | None:
    """Freeze public Vimeo embeds without mutating or scripting the live page."""
    soup = BeautifulSoup(html, "html.parser")
    changed = False
    for frame in soup.find_all("iframe"):
        value = frame.get("src")
        if not value:
            continue
        frame_url = urllib.parse.urljoin(base_url, str(value))
        if urllib.parse.urlparse(frame_url).hostname != "player.vimeo.com":
            continue
        try:
            player = await fetch_resource(frame_url, settings)
            player_html = player.body.decode(player.encoding, errors="replace")
            matches = VIMEO_POSTER.findall(player_html)
            if not matches:
                continue
            raw_url = next((item for item in reversed(matches) if "?f=webp" in item), matches[-1])
            poster_url = raw_url.replace(r"\u0026", "&")
            separator = "&" if "?" in poster_url else "?"
            poster = await fetch_resource(
                f"{poster_url}{separator}mw=1920&q=85",
                settings,
                include_images=True,
            )
            if not poster.content_type.startswith("image/"):
                continue
            with Image.open(io.BytesIO(poster.body)) as source:
                source.thumbnail((1280, 720), Image.Resampling.LANCZOS)
                compact = io.BytesIO()
                source.convert("RGB").save(compact, "WEBP", quality=82, method=4)
            encoded = base64.b64encode(compact.getvalue()).decode("ascii")
            frame["srcdoc"] = (
                '<style>html,body{width:100%;height:100%;margin:0;overflow:hidden}'
                'img{width:100%;height:100%;object-fit:cover}</style>'
                f'<img src="data:image/webp;base64,{encoded}" alt="">'
            )
            del frame["src"]
            changed = True
            # Only the first embed can appear in the fixed 960x720 capture.
            break
        except Exception:
            continue
    if not changed:
        return None
    # The fetched HTML already contains the server-rendered article. Hydrating it
    # from a temporary file gives Next.js the wrong route and replaces that useful
    # shell with its client-error page, so the thumbnail document remains static.
    for script in soup.find_all("script"):
        script.decompose()
    if soup.head is not None and soup.head.find("base") is None:
        base = soup.new_tag("base", href=base_url)
        soup.head.insert(0, base)
    return str(soup)


#: One browser at a time, per process. Chromium is by a wide margin the most
#: expensive thing this process starts, and the deployed instance is one vCPU
#: and one GiB shared with the request that asked for the capture — two at once
#: is how both of them end up over the ceiling, or dead. Created lazily because
#: an asyncio primitive built at import time binds the loop that imported it.
_CAPTURE_SLOT: asyncio.Semaphore | None = None


def _capture_with_host(
    host: BrowserHost, source_url: str, target: str, screenshot: Path, proxy: str,
    budget_seconds: float, width: int, height: int,
) -> Path | None:
    """`_capture_webpage` in the product's browser, logged the same way."""
    started = time.monotonic()
    try:
        reason = screenshot_with_host(
            host, target, screenshot, proxy=proxy, width=width, height=height,
            budget_seconds=budget_seconds,
        )
    except Exception as exc:
        reason = f"{type(exc).__name__}: {exc}"
    elapsed = round(time.monotonic() - started, 1)
    written = screenshot.stat().st_size if screenshot.is_file() else 0
    if reason or written < 1000:
        logger.warning(
            "web thumbnail: capture of %s failed after %ss in the browser host — %s",
            source_url, elapsed, reason or f"wrote {written} bytes",
        )
        return None
    handle, output_name = tempfile.mkstemp(suffix=".png")
    os.close(handle)
    output = Path(output_name)
    shutil.copyfile(screenshot, output)
    logger.info(
        "web thumbnail: captured %s in %ss in the browser host (%d bytes)",
        source_url, elapsed, written,
    )
    return output


@contextlib.asynccontextmanager
async def _capture_slot(
    settings: Settings, source_url: str, *, wait_seconds: float | None = None
):
    """Hold the single browser slot within the caller's waiting budget.

    Dashboard previews use the short configured default because the next
    engagement retry brings them round again. Durable captures pass their own
    bounded wait because temporary contention must not become permanently
    missing source material.
    """
    global _CAPTURE_SLOT
    if _CAPTURE_SLOT is None:
        _CAPTURE_SLOT = asyncio.Semaphore(1)
    try:
        wait = (
            settings.web_thumbnail_queue_seconds
            if wait_seconds is None
            else wait_seconds
        )
        await asyncio.wait_for(_CAPTURE_SLOT.acquire(), wait)
    except (asyncio.TimeoutError, TimeoutError):
        logger.warning(
            "web capture: another capture held the slot for %ss, skipping %s",
            wait, source_url,
        )
        yield False
        return
    try:
        yield True
    finally:
        _CAPTURE_SLOT.release()


async def capture_static_html(
    source_url: str,
    prepared_html: str,
    settings: Settings,
    *,
    viewport_width: int,
    viewport_height: int,
    budget_seconds: float | None = None,
) -> Path | None:
    """Photograph frozen public-page markup through the one browser slot."""
    import anyio

    budget = (
        budget_seconds
        if budget_seconds is not None
        else settings.web_thumbnail_capture_seconds
    )
    # Unlike a Dashboard preview, this is durable source capture: contention
    # must not permanently turn a figure into an uncaptured link. It may wait
    # for the same bounded interval the subsequent browser run is allowed.
    async with _capture_slot(settings, source_url, wait_seconds=budget) as granted:
        if not granted:
            return None
        return await anyio.to_thread.run_sync(
            _capture_webpage,
            source_url,
            (),
            prepared_html,
            budget,
            viewport_width,
            viewport_height,
        )


def trim_blank_margins(
    image: Image.Image, *, minimum_fraction: float = 0.35
) -> Image.Image:
    """Expose the shared screenshot crop for other guarded renderers."""
    return _trim_blank_margins(image, minimum_fraction=minimum_fraction)


async def _capture_webpage_safely(
    source_url: str,
    settings: Settings,
    budget_seconds: float | None = None,
    saved_copy: str | None = None,
) -> tuple[Path | None, str | None]:
    try:
        import anyio

        # A document with a saved copy is photographed from it, never from a
        # second live fetch. The import has just fetched the page, and sites
        # that rate-limit readers (pi.website) refuse the thumbnail's request
        # seconds later — which left the card a placeholder on every retry.
        # A page that assembles itself in the browser has already been built
        # once, and its live shell is a loading skeleton — so the stored DOM
        # is both the better picture and the only one there is.
        if saved_copy:
            html, page_url = saved_copy, source_url
        else:
            resource = await fetch_resource(source_url, settings, include_pdf=True)
            if resource.content_type in PDF_TYPES:
                handle, output_name = tempfile.mkstemp(suffix=".pdf")
                try:
                    with os.fdopen(handle, "wb") as output:
                        output.write(resource.body)
                except Exception:
                    Path(output_name).unlink(missing_ok=True)
                    raise
                return Path(output_name), "pdf"
            if not (
                resource.content_type.startswith("text/")
                or "html" in resource.content_type
            ):
                return None, None
            html = resource.body.decode(resource.encoding, errors="replace")
            page_url = resource.url
        hosts = _asset_hosts(html, page_url)
        # Captured from static markup, never by driving the live page. Scripts
        # broke this both ways: a page that keeps working never holds still long
        # enough to look finished (kexue.fm re-typesets its equations and burned
        # the whole 30s ceiling), and a hydrating app discards the markup being
        # photographed. No ceiling fixes either. Posters run first because only
        # that pass can recover a video's frame.
        posted = await _html_with_static_video_posters(
            html, page_url, settings
        )
        prepared_html = await anyio.to_thread.run_sync(
            static_document, posted or html, page_url
        )
        # A prepared document is rendered from a file:// URL and reloads its
        # own assets, so it has always been given longer than a live page.
        budget = (
            budget_seconds
            if budget_seconds is not None
            else settings.web_thumbnail_capture_seconds
        ) * 1.5
        async with _capture_slot(settings, source_url) as granted:
            if not granted:
                return None, None
            return (
                await anyio.to_thread.run_sync(
                    _capture_webpage,
                    page_url,
                    hosts,
                    prepared_html,
                    budget,
                    # A copy a browser built — the renderer's, or the reader's
                    # frame's — only lays out correctly at the width it
                    # carries. Everything else reflows, and keeps the card's
                    # 4:3 shot.
                    render_width_of(saved_copy, 960) if saved_copy else 960,
                ),
                "web",
            )
    except HTTPException as refusal:
        # A host that 404s, refuses an automated reader, or resolves somewhere
        # the fetcher may not go is an ordinary outcome, not a fault: one line,
        # no traceback.
        logger.warning(
            "web thumbnail: %s could not be captured — %s",
            source_url, refusal.detail,
        )
        return None, None
    except Exception:
        logger.warning(
            "web thumbnail: capture of %s failed before the browser started",
            source_url, exc_info=True,
        )
        return None, None


async def make_web_thumbnail_safely(*args: Any, **kwargs: Any) -> bool:
    try:
        return await make_web_thumbnail(*args, **kwargs)
    except Exception:
        return False


async def ensure_document_thumbnail(
    storage: Storage,
    objects: ObjectStore,
    settings: Settings,
    username: str,
    project_id: str,
    paper: dict[str, Any],
    force: bool = False,
) -> bool:
    """Materialise a document's derived preview when one is due."""
    paper_id = paper["id"]
    thumb_key = paper_key(username, project_id, paper_id, "thumb")
    required_version = required_thumbnail_version(paper)
    if not force and _has_current_screenshot(paper, objects, thumb_key):
        return True
    lying_placeholder = (
        bool(paper.get("thumbnailAvailable"))
        and objects.exists(thumb_key)
        and _is_fallback_web_thumbnail(objects, thumb_key)
    )
    if (
        not force
        and not thumbnail_is_due(paper)
        and objects.exists(thumb_key)
        and not lying_placeholder
    ):
        # The bytes are the one thing `thumbnail_is_due` cannot see from the
        # record, so they are checked here and nowhere else. A failed capture
        # still inside its one-minute gap returns here. A fallback card that
        # an older writer stamped available is not a screenshot, and falls
        # through so this open can photograph the page.
        return bool(paper.get("thumbnailAvailable"))
    generated = False
    if paper.get("kind") == "web":
        generated = await make_web_thumbnail_safely(
            paper.get("title") or "Web document",
            paper.get("url") or "",
            paper.get("favicon"),
            objects,
            settings,
            username,
            project_id,
            paper_id,
        )
    else:
        pdf_key = paper_key(username, project_id, paper_id, "pdf")
        if objects.exists(pdf_key):
            source = objects.fetch_to_tempfile(pdf_key)
            try:
                import anyio

                generated = await anyio.to_thread.run_sync(
                    make_pdf_thumbnail,
                    source,
                    objects,
                    username,
                    project_id,
                    paper_id,
                )
            finally:
                source.unlink(missing_ok=True)
    # Stamped whether or not it worked. Recording only successes is what made a
    # failure permanent *and* free to repeat: the paper stayed behind the
    # renderer, so the next Reader open ran the whole capture again, and the
    # one after that. The attempt is the thing worth remembering — and how many
    # of them this engagement has spent, which is what decides when the next
    # one is due.
    storage.update_paper_snapshot(
        username, project_id, paper_id,
        thumbnail_fields(paper, generated=generated, version=required_version),
    )
    return generated


async def ensure_document_thumbnail_safely(*args: Any, **kwargs: Any) -> bool:
    try:
        return await ensure_document_thumbnail(*args, **kwargs)
    except Exception:
        logger.exception("document thumbnail generation failed")
        return False


def _thumbnail_retry_key(
    username: str, project_id: str, paper_id: str
) -> tuple[str, str, str]:
    return (username, project_id, paper_id)


async def _begin_thumbnail_engagement(key: tuple[str, str, str]) -> int:
    """Cancel any in-flight retry chain and mint a generation for this open."""
    seq = _THUMBNAIL_ENGAGEMENT_GEN.get(key, 0) + 1
    _THUMBNAIL_ENGAGEMENT_GEN[key] = seq
    existing = _THUMBNAIL_RETRY_TASKS.pop(key, None)
    if existing is not None:
        existing.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await existing
    return seq


def _remember_thumbnail_retry(
    key: tuple[str, str, str], task: asyncio.Task
) -> None:
    _THUMBNAIL_RETRY_TASKS[key] = task

    def _clear(done: asyncio.Task) -> None:
        if _THUMBNAIL_RETRY_TASKS.get(key) is done:
            del _THUMBNAIL_RETRY_TASKS[key]

    task.add_done_callback(_clear)


async def capture_document_thumbnail_for_engagement(
    storage: Storage,
    objects: ObjectStore,
    settings: Settings,
    username: str,
    project_id: str,
    paper: dict[str, Any],
) -> bool:
    """Try a preview for this Reader open, then retry it twice a minute apart.

    A new open is a new engagement: the count starts at zero even if the last
    open's attempts had been spent, and even if that was thirty seconds ago.
    Closing the page and returning is a new open. The scheduled follow-ups
    belong to this one and are cancelled when the next one starts.
    """
    paper_id = paper["id"]
    key = _thumbnail_retry_key(username, project_id, paper_id)
    seq = await _begin_thumbnail_engagement(key)
    thumb_key = paper_key(username, project_id, paper_id, "thumb")
    if _has_current_screenshot(paper, objects, thumb_key):
        return True
    session = {
        **paper,
        "thumbnailAttempts": 0,
        "thumbnailAttemptedAt": None,
        # A fallback card may still be stamped available from when the
        # placeholder counted as success. This open has to be allowed to
        # photograph the page.
        "thumbnailAvailable": False,
    }
    if not thumbnail_is_due(session):
        return bool(paper.get("thumbnailAvailable"))
    made = await ensure_document_thumbnail_safely(
        storage, objects, settings, username, project_id, session,
    )
    if made or _THUMBNAIL_ENGAGEMENT_GEN.get(key) != seq:
        return made
    _remember_thumbnail_retry(
        key,
        asyncio.create_task(
            _retry_document_thumbnail_for_engagement(
                storage, objects, settings, username, project_id, paper_id, seq,
            )
        ),
    )
    return made


async def _retry_document_thumbnail_for_engagement(
    storage: Storage,
    objects: ObjectStore,
    settings: Settings,
    username: str,
    project_id: str,
    paper_id: str,
    seq: int,
) -> None:
    key = _thumbnail_retry_key(username, project_id, paper_id)
    try:
        remaining = THUMBNAIL_ATTEMPTS_PER_ENGAGEMENT - 1
        for _ in range(remaining):
            await asyncio.sleep(THUMBNAIL_RETRY_AFTER.total_seconds())
            if _THUMBNAIL_ENGAGEMENT_GEN.get(key) != seq:
                return
            try:
                paper = storage.get_paper(username, project_id, paper_id)
            except HTTPException:
                return
            # The sleep above *is* the one-minute gap. Clearing the timestamp
            # on this copy lets `thumbnail_is_due` see the remaining budget
            # without depending on `asyncio.sleep` returning at the exact
            # wall-clock second the last stamp plus one minute would require.
            due = {**paper, "thumbnailAttemptedAt": None}
            if not thumbnail_is_due(due):
                return
            made = await ensure_document_thumbnail_safely(
                storage, objects, settings, username, project_id, due,
            )
            if made:
                return
    except asyncio.CancelledError:
        raise
    except Exception:
        logger.exception("scheduled thumbnail retry failed for %s", paper_id)


def public_conversations(
    projects_by_id: dict[str, dict[str, Any]], records: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Storage conversation records, plus the names the client draws them with.

    A conversation stores ids; every surface that lists one shows names, so the
    join happens here rather than in two clients. `paperTitle` is what the
    settings sheet's Chats pane reads — the paper object was already in hand for
    its slug, so naming it costs nothing and saves that pane a second read of
    every project.
    """
    listed = []
    for item in records:
        project = projects_by_id.get(item.get("projectId"))
        paper = None
        if project and item.get("paperId"):
            paper = next(
                (p for p in project.get("papers", []) if p["id"] == item["paperId"]),
                None,
            )
        listed.append({
            **item,
            "projectName": project.get("name") if project else None,
            "projectSlug": project.get("slug") if project else None,
            "paperSlug": paper.get("slug") if paper else None,
            "paperTitle": paper.get("title") if paper else None,
        })
    return listed


def dashboard_payload(storage: Any, username: str) -> dict[str, Any]:
    """One bounded read: records only, and not a single object read.

    It takes no `ObjectStore` because it has nothing to ask one for. That was
    the last derived-on-read field, and losing the parameter is the point — a
    read that cannot reach the object store cannot regress into paying for it.
    """
    projects = storage.list_projects_with_papers(username)
    all_documents: list[tuple[dict[str, Any], dict[str, Any]]] = []
    for project in projects:
        for paper in project.get("papers", []):
            all_documents.append((project, paper))
    total = len(all_documents)
    completed = sum(bool(paper.get("doneAt")) for _, paper in all_documents)
    recent_conversations = storage.list_recent_conversations(username, limit=5)
    projects_by_id = {project["id"]: project for project in projects}

    def public_document(
        project: dict[str, Any], paper: dict[str, Any]
    ) -> dict[str, Any]:
        return {
            **paper,
            "projectId": project["id"], "projectName": project["name"],
            "projectSlug": project["slug"],
        }

    conversations = public_conversations(projects_by_id, recent_conversations)
    project_rows = []
    # `accentIndex` is the project's position in `list_projects_with_papers`
    # order — createdAt descending — and it is stamped here, *before* the rows
    # are reordered for display. The carousel sorts by recency, so its array
    # position is no longer a stable name for a project; the library rail's
    # `projectAccent` still counts from the unsorted order, and a project that
    # changed colour between the Dashboard and the rail would read as two
    # projects. Separating the two is what lets the order move without the
    # palette moving with it.
    for accent_index, project in enumerate(projects):
        papers = sorted(project.get("papers", []), key=lambda p: (p.get("lastEngagedAt") or p.get("createdAt") or "", p["id"]), reverse=True)
        project_rows.append({
            "id": project["id"], "name": project["name"], "slug": project["slug"],
            "accentIndex": accent_index,
            "totalCount": len(papers), "activeCount": sum(not p.get("doneAt") for p in papers),
            "documents": [public_document(project, p) for p in papers],
            "lastEngagedAt": max(
                (p.get("lastEngagedAt") or p.get("createdAt") or "" for p in papers),
                default="",
            ),
        })
    # The newest engagement puts a project first without changing its accent.
    project_rows.sort(key=lambda row: (row["lastEngagedAt"], row["id"]), reverse=True)
    return {
        "stats": {"projects": len(projects), "documents": total, "completed": completed,
                  "completedPercent": round(completed * 100 / total) if total else 0},
        "conversations": conversations,
        "projects": project_rows,
    }


def conversations_payload(storage: Any, username: str) -> list[dict[str, Any]]:
    """Every conversation the account has actually said something in.

    Unbounded where the Dashboard is bounded, and deliberately so: the Dashboard
    is the critical path after login and shows five as a hint, while this answers
    a sheet the reader opened to find one particular thread. What is *not*
    unbounded is the cost of a row — the same enrichment, no object reads at all.

    On the filesystem backend `list_recent_conversations` is the heavy read —
    one JSON file per conversation — so this payload is deferred to the sheet
    that asks for it rather than the Dashboard that does not.
    """
    projects = storage.list_projects_with_papers(username)
    return public_conversations(
        {project["id"]: project for project in projects},
        storage.list_recent_conversations(username, limit=ALL_CONVERSATIONS),
    )
