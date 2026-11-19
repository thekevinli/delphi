"""
The web rig's scripted model provider, served on a port of its own.

    python -I serve_provider.py <provider.py> <port>

The Memory journey points the bundled backend's OpenAI base URL at
`http://127.0.0.1:<port>/__fixtures/provider/v1`, so this is the only model the
backend can reach. The provider is loaded by path, as the web rig loads it, and
its own routes are served unchanged: the Responses and Files endpoints, the
requests it recorded, what it refused to play, and its holds.

It exits when stdin reaches end-of-file. The test holds the other end, so a
test that dies takes its provider with it.
"""
import importlib.util
import os
import sys
import threading
from pathlib import Path

source, port = Path(sys.argv[1]).resolve(), int(sys.argv[2])
# The provider names the origin of its own fixture pages from this.
os.environ["DELPHI_E2E_API_PORT"] = str(port)
spec = importlib.util.spec_from_file_location("memory_journey_provider", source)
provider = importlib.util.module_from_spec(spec)
spec.loader.exec_module(provider)

import uvicorn  # noqa: E402  (after the provider, which needs the port first)
from fastapi import FastAPI  # noqa: E402

app = FastAPI()
app.include_router(provider.fixture_router)


def orphaned():
    sys.stdin.buffer.read()
    os._exit(0)


threading.Thread(target=orphaned, name="parent-watch", daemon=True).start()
uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
