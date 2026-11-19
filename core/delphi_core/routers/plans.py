"""Authenticated plan catalog/export and the read-only Streamable HTTP MCP surface.

Browser cookies administer grants; MCP accepts only explicitly issued bearer
credentials. A grant captures its exact plan set and never expands implicitly.
"""
import base64
import hashlib
import hmac
import tempfile
from pathlib import Path
import json
import secrets
import time
import zipfile
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import HTMLResponse, FileResponse
from starlette.background import BackgroundTask
from fastapi.routing import APIRoute
from pydantic import Field
from typing import Annotated

from .. import plans
from ..plan_page import Strict, render_plan
from ..deps import get_current_user, get_object_store, get_storage
from ..storage import ObjectStore, Storage
from ..storage.base import safe_id, utc_now

class PrivatePlanRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()
        async def private(request):
            response = await handler(request)
            response.headers.update(HEADERS)
            return response
        return private

router = APIRouter(prefix="/api/plans", tags=["plans"], route_class=PrivatePlanRoute)
CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
HEADERS = {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer"}

class Selection(Strict):
    id: str = Field(min_length=1, max_length=64)
    revision: int = Field(ge=1)
class Archive(Strict):
    selected: list[Selection] = Field(min_length=1, max_length=3)
class Grant(Strict):
    planIds: list[Annotated[str, Field(min_length=1, max_length=64)]] = Field(min_length=1, max_length=20)
    expiresInDays: int = Field(default=30, ge=1, le=90)

@router.get("")
def catalog(username: str = Depends(get_current_user), storage: Storage = Depends(get_storage)):
    return plans.list_plans(storage, username)

@router.get("/capacity")
def capacity(username: str = Depends(get_current_user), storage: Storage = Depends(get_storage)):
    return plans.capacity(storage, username)

@router.post("/archive")
def archive(body: Archive, username: str = Depends(get_current_user), storage: Storage = Depends(get_storage)):
    if len({p.id for p in body.selected}) != len(body.selected):
        raise HTTPException(400, "Choose each plan only once")
    def apply(state):
        for selected in body.selected:
            record = state["plans"].get(selected.id)
            if not record or record["archived"] or record["revision"] != selected.revision:
                raise HTTPException(409, {"message": "The plan list changed; review your selection", **plans.capacity_state(state)})
        for selected in body.selected:
            record = state["plans"][selected.id]
            record.update(archived=True, revision=record["revision"] + 1)
        return plans.capacity_state(state)
    return storage.plan_transaction(username, apply)


def grant_public(row):
    return {k: row[k] for k in ("id", "planIds", "createdAt", "expiresAt", "revokedAt")}

@router.get("/grants")
def grants(username: str = Depends(get_current_user), storage: Storage = Depends(get_storage)):
    return storage.plan_transaction(username, lambda s: {"grants": [grant_public(r) for r in s["grants"].values()]})

@router.post("/grants", status_code=201)
def issue_grant(body: Grant, username: str = Depends(get_current_user), storage: Storage = Depends(get_storage)):
    grant_id, secret = secrets.token_hex(16), secrets.token_urlsafe(32)
    token = f"dpg.{username}.{grant_id}.{secret}"
    expiry = time.time() + body.expiresInDays * 86400
    record = {"id": grant_id, "planIds": list(dict.fromkeys(body.planIds)), "createdAt": utc_now(),
              "expiresAt": datetime.fromtimestamp(expiry, UTC).isoformat(), "expires": expiry,
              "revokedAt": None, "hash": hashlib.sha256(token.encode()).hexdigest(), "window": 0, "calls": 0}
    def issue(state):
        if any(i not in state["plans"] for i in record["planIds"]):
            raise HTTPException(404, "Plan not found")
        if sum(not g["revokedAt"] and g["expires"] > time.time() for g in state["grants"].values()) >= 20:
            raise HTTPException(409, "Revoke an existing connection before adding another")
        state["grants"][grant_id] = record
        return {"grant": grant_public(record), "token": token, "mcpUrl": "/api/plans/mcp"}
    return storage.plan_transaction(username, issue)

@router.delete("/grants/{grant_id}", status_code=204)
def revoke(grant_id: str, username: str = Depends(get_current_user), storage: Storage = Depends(get_storage)):
    def apply(state):
        record = state["grants"].get(grant_id)
        if not record:
            raise HTTPException(404, "Connection not found")
        record["revokedAt"] = record["revokedAt"] or utc_now()
    storage.plan_transaction(username, apply)
    return Response(status_code=204)

TOOLS = [
    {"name": "get_plan", "description": "Read a deliberately shared research plan and captured source index. Conversation is opt-in.",
     "inputSchema": {"type": "object", "additionalProperties": False, "required": ["plan_id"], "properties": {
         "plan_id": {"type": "string"}, "include_conversation": {"type": "boolean", "default": False}}}},
    {"name": "read_plan_source", "description": "Read captured source text in 20,000-character chunks, or a captured PDF page image.",
     "inputSchema": {"type": "object", "additionalProperties": False, "required": ["plan_id", "index"], "properties": {
         "plan_id": {"type": "string"}, "index": {"type": "integer", "minimum": 0, "maximum": 19},
         "offset": {"type": "integer", "minimum": 0, "default": 0}, "page": {"type": "integer", "minimum": 1}}}},
]


def authorized_grant(storage, token):
    try:
        prefix, username, grant_id, secret = token.split(".")
        if prefix != "dpg" or len(secret) < 32:
            raise ValueError()
        safe_id(username)
        safe_id(grant_id)
    except (ValueError, HTTPException):
        raise HTTPException(401, "A valid Plan access token is required", headers={"WWW-Authenticate": "Bearer"})
    def check(state):
        grant = state["grants"].get(grant_id)
        if not grant or grant["revokedAt"] or grant["expires"] <= time.time() or not hmac.compare_digest(
            grant["hash"], hashlib.sha256(token.encode()).hexdigest()):
            raise HTTPException(401, "Plan access token expired or revoked", headers={"WWW-Authenticate": "Bearer"})
        window = int(time.time() // 60)
        grant["calls"] = grant["calls"] + 1 if grant["window"] == window else 1
        grant["window"] = window
        if grant["calls"] > 60:
            raise HTTPException(429, "Too many plan reads", headers={"Retry-After": "60"})
        return list(grant["planIds"])
    try:
        return username, storage.plan_transaction(username, check)
    except HTTPException as exc:
        if exc.status_code == 404:
            raise HTTPException(401, "Plan access token unavailable")
        raise


def read_tool(name, args, record, objects):
    if not isinstance(args, dict):
        raise ValueError("Arguments must be an object")
    if name == "get_plan":
        if set(args) - {"plan_id", "include_conversation"} or not isinstance(args.get("include_conversation", False), bool):
            raise ValueError("Invalid get_plan arguments")
        value = {"id": record["id"], "plan": record["plan"], "contentHash": record["contentHash"],
                 "sources": [{k: v for k, v in d.items() if not k.endswith("Key")} for d in record["documents"]],
                 "images": [{k: v for k, v in i.items() if k != "key"} for i in record["referenceImages"]]}
        if args.get("include_conversation"):
            value["conversation"] = json.loads(objects.get_text(record["conversationKey"]))
            value["conversationTruncated"] = record.get("conversationTruncated", False)
        return [{"type": "text", "text": json.dumps(value, ensure_ascii=False)}]
    if name != "read_plan_source" or set(args) - {"plan_id", "index", "offset", "page"}:
        raise ValueError("Unknown tool or arguments")
    index, offset, page = args.get("index"), args.get("offset", 0), args.get("page")
    if type(index) is not int or not 0 <= index < len(record["documents"]) or type(offset) is not int or offset < 0:
        raise ValueError("Source index or offset is out of bounds")
    document = record["documents"][index]
    if page is not None:
        if type(page) is not int or page < 1:
            raise ValueError("Page must be a positive integer")
        image = next((i for i in record["referenceImages"] if i["sourceId"] == document["id"] and i["page"] == page), None)
        if not image:
            raise ValueError("This page image was not captured; use captured text")
        raw = b"".join(objects.open_range(image["key"]))
        return [{"type": "image", "mimeType": "image/png", "data": base64.b64encode(raw).decode()}]
    if not document.get("textKey"):
        raise ValueError(document.get("error", "Source text unavailable"))
    text = objects.get_text(document["textKey"])
    if offset > len(text):
        raise ValueError("Offset is past the end of this captured source")
    return [{"type": "text", "text": json.dumps({"sourceId": document["id"], "text": text[offset:offset+20000],
             "offset": offset, "nextOffset": offset+20000 if offset+20000 < len(text) else None, "totalCharacters": len(text)}, ensure_ascii=False)}]

@router.get("/mcp")
def mcp_events():
    return Response(status_code=405, headers={"Allow": "POST", **HEADERS})


@router.post("/mcp")
async def mcp(request: Request, storage: Storage = Depends(get_storage), objects: ObjectStore = Depends(get_object_store)):
    # Bearer credentials are never inferred from a browser session. Reject browser
    # cross-origin use; native remote MCP clients send no Origin.
    if request.headers.get("origin"):
        raise HTTPException(403, "Use the external MCP connection with its access token")
    auth = request.headers.get("authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(401, "A Plan access token is required", headers={"WWW-Authenticate": "Bearer"})
    from starlette.concurrency import run_in_threadpool
    username, allowed = await run_in_threadpool(authorized_grant, storage, auth[7:])
    version = request.headers.get("mcp-protocol-version")
    supported = {"2025-03-26", "2025-06-18", "2025-11-25"}
    if version is not None and version not in supported:
        raise HTTPException(400, "Unsupported MCP protocol version")
    raw = bytearray()
    async for chunk in request.stream():
        raw.extend(chunk)
        if len(raw) > 16384:
            raise HTTPException(413, "MCP request is too large")
    try:
        body = json.loads(raw)
        if not isinstance(body, dict) or body.get("jsonrpc") != "2.0":
            raise ValueError("Expected JSON-RPC 2.0")
    except (ValueError, TypeError):
        return {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Invalid JSON-RPC request"}}
    method, params, call_id = body.get("method"), body.get("params", {}), body.get("id")
    if not isinstance(method, str) or type(call_id) not in {str, int, type(None)} or not isinstance(params, dict):
        return {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Invalid JSON-RPC request"}}
    if "id" not in body:
        # Notifications have no response body, including extensions we ignore.
        return Response(status_code=202)
    try:
        if not isinstance(params, dict):
            raise ValueError("Parameters must be an object")
        if method == "initialize":
            result = {"protocolVersion": params.get("protocolVersion") if params.get("protocolVersion") in supported else "2025-11-25", "capabilities": {"tools": {}},
                      "serverInfo": {"name": "Delphi Plans", "version": "1.0"}}
        elif method == "ping":
            result = {}
        elif method == "tools/list":
            result = {"tools": TOOLS}
        elif method == "tools/call":
            args = params.get("arguments") or {}
            if not isinstance(args, dict) or args.get("plan_id") not in allowed:
                raise ValueError("Plan is not shared with this connection")
            record = await run_in_threadpool(plans.get_plan, storage, username, args["plan_id"])
            try:
                content = await run_in_threadpool(read_tool, params.get("name"), args, record, objects)
                result = {"content": content, "isError": False}
            except (ValueError, HTTPException):
                result = {"content": [{"type": "text", "text": "Requested captured evidence is unavailable or arguments are invalid"}], "isError": True}
        else:
            return {"jsonrpc": "2.0", "id": call_id, "error": {"code": -32601, "message": "Method not found"}}
        return {"jsonrpc": "2.0", "id": call_id, "result": result}
    except (ValueError, AttributeError, HTTPException):
        return {"jsonrpc": "2.0", "id": call_id, "error": {"code": -32602, "message": "Invalid or unauthorized parameters"}}

@router.get("/{plan_id}")
def detail(plan_id: str, username: str = Depends(get_current_user), storage: Storage = Depends(get_storage)):
    record = plans.get_plan(storage, username, plan_id)
    return {**record, **plans.summary(record)}

@router.get("/{plan_id}/view", response_class=HTMLResponse)
def view(plan_id: str, username: str = Depends(get_current_user), storage: Storage = Depends(get_storage), objects: ObjectStore = Depends(get_object_store)):
    record = plans.get_plan(storage, username, plan_id)
    images = [{**i, "data": base64.b64encode(b"".join(objects.open_range(i["key"]))).decode()} for i in record.get("referenceImages", [])]
    return HTMLResponse(render_plan(record, images, json.loads(objects.get_text(record["conversationKey"]))), headers={**HEADERS, "Content-Security-Policy": CSP})

@router.get("/{plan_id}/export")
def export(plan_id: str, username: str = Depends(get_current_user), storage: Storage = Depends(get_storage), objects: ObjectStore = Depends(get_object_store)):
    record = plans.get_plan(storage, username, plan_id)
    # Stream object chunks into a temporary ZIP: twenty bounded PDFs must not
    # become a 400 MB per-request allocation in a Cloud Run worker.
    temporary = tempfile.NamedTemporaryFile(suffix=".zip", delete=False)
    path = Path(temporary.name)
    temporary.close()
    try:
        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("plan.json", json.dumps(record, ensure_ascii=False))
            archive.writestr("plan.html", render_plan(record, [{**i, "src": f'images/{i["sourceId"]}-{i["page"]}.png'} for i in record["referenceImages"]], json.loads(objects.get_text(record["conversationKey"]))))
            archive.writestr("conversation.json", objects.get_text(record["conversationKey"]))
            def copy(key, name):
                with archive.open(name, "w") as target:
                    for chunk in objects.open_range(key):
                        target.write(chunk)
            for document in record["documents"]:
                for field, extension in (("textKey", "txt"), ("pdfKey", "pdf")):
                    if document.get(field):
                        copy(document[field], f'sources/{document["index"]}.{extension}')
            for image in record["referenceImages"]:
                copy(image["key"], f'images/{image["sourceId"]}-{image["page"]}.png')
        return FileResponse(path, media_type="application/zip", filename=f"delphi-plan-{safe_id(plan_id)}.zip",
                            headers=HEADERS, background=BackgroundTask(path.unlink, missing_ok=True))
    except BaseException:
        path.unlink(missing_ok=True)
        raise
