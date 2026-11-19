"""
The app factory: what a product builds Delphi's API with.

Three properties a product leans on and no route test would notice breaking:
the API does not depend on which settings and stores an app is made with (a
dependency that leaked `Stores` into a signature would publish it as a query
parameter); the settings an app is made with are the ones its routes read, with
no quiet fallback to the environment; and a product's lifespan hooks wrap
core's, so core's shutdown still writes through stores the product then closes.
"""
from fastapi import APIRouter, Depends, FastAPI
from fastapi.responses import PlainTextResponse
from fastapi.testclient import TestClient
import pytest
from starlette.middleware import Middleware

import delphi_core.app as factory
import delphi_core.config as config
from delphi_core.app import Stores, create_app, get_current_user, get_object_store, get_settings, get_storage
from delphi_core.config import Settings
from delphi_core.main import app as reference
from delphi_core.storage import LocalObjectStore, ObjectStore, Storage


def local_app(tmp_path, **kwargs):
    return create_app(Settings(_env_file=None, data_dir=tmp_path, session_secret="factory-secret"),
                      stores=Stores.local(), **kwargs)


def test_the_factory_builds_the_reference_apps_api_whatever_it_is_given(tmp_path):
    """The reference app runs on the environment's settings; this one on a temp directory."""
    assert local_app(tmp_path).openapi() == reference.openapi()
    unusual = Stores(storage=lambda settings: None, objects=lambda settings: None)
    assert create_app(Settings(_env_file=None, data_dir=tmp_path, max_upload_mb=1), stores=unusual).openapi() == \
        reference.openapi()


def test_a_product_route_on_the_shared_dependencies_publishes_only_the_session_cookie(tmp_path):
    """`get_storage` and `get_object_store` reach the app's stores without becoming part of the API."""
    product = APIRouter(prefix="/api/desktop")

    @product.get("/probe")
    def probe(
        username: str = Depends(get_current_user),
        settings: Settings = Depends(get_settings),
        storage: Storage = Depends(get_storage),
        objects: ObjectStore = Depends(get_object_store),
    ):
        return {"user": username, "app": settings.app_name, "storage": storage.kind,
                "objects": type(objects).__name__}

    app = local_app(tmp_path, routers=(product,))
    published = app.openapi()
    assert [(parameter["in"], parameter["name"]) for parameter in published["paths"]["/api/desktop/probe"]["get"]["parameters"]] == \
        [("cookie", "delphi_session")]
    core = reference.openapi()
    # Added after core's own routes, and nothing of core's changed.
    assert list(published["paths"]) == [*core["paths"], "/api/desktop/probe"]
    assert {path: item for path, item in published["paths"].items() if path != "/api/desktop/probe"} == core["paths"]

    with TestClient(app) as client:
        assert client.post("/api/auth/register", json={"username": "reader", "password": "factory-password"}).status_code == 200
        assert client.get("/api/desktop/probe").json() == \
            {"user": "reader", "app": "Delphi", "storage": "local", "objects": "LocalObjectStore"}


def test_the_settings_given_to_the_factory_reach_its_routes_and_the_environment_never_does(tmp_path, monkeypatch):
    elsewhere = tmp_path / "from-the-environment"
    monkeypatch.setenv("DATA_DIR", str(elsewhere))
    monkeypatch.setenv("MAX_UPLOAD_MB", "99")

    def environment(*_args):
        raise AssertionError("a route read the environment's settings")

    monkeypatch.setattr(config, "load_settings", environment)
    monkeypatch.setattr(config, "_loaded", environment)
    given = tmp_path / "given"
    app = create_app(Settings(_env_file=None, data_dir=given, max_upload_mb=7), stores=Stores.local())

    with TestClient(app) as client:
        assert client.get("/api/config").json()["maxUploadMb"] == 7
        assert client.post("/api/auth/register", json={"username": "reader", "password": "factory-password"}).status_code == 200
        assert client.get("/api/health").json()["storage"] == "local"
    assert (given / "users" / "reader" / "account.json").exists()
    assert not elsewhere.exists()

    # An app the factory did not make has no settings to fall back to.
    bare = FastAPI()

    @bare.get("/settings")
    def read(settings: Settings = Depends(get_settings)):
        return settings.app_name

    with pytest.raises(AttributeError):
        TestClient(bare).get("/settings")


def test_a_products_lifespan_hooks_wrap_cores_so_claims_are_released_before_they_close(tmp_path, monkeypatch):
    seen = []

    def hook(name):
        from contextlib import asynccontextmanager

        @asynccontextmanager
        async def lifespan(app):
            assert app.state.settings.data_dir == tmp_path
            seen.append(f"{name} starts")
            try:
                yield
            finally:
                seen.append(f"{name} stops")

        return lifespan

    def shared_client(client):
        seen.append("core starts" if client is not None else "core stops")

    def release_held_claims():
        seen.append("core releases claims")
        return 0

    monkeypatch.setattr(factory, "set_shared_web_client", shared_client)
    monkeypatch.setattr("delphi_core.routers.memory.release_held_claims", release_held_claims)
    with TestClient(local_app(tmp_path, lifespan=(hook("first"), hook("second")))):
        assert seen == ["first starts", "second starts", "core starts"]
    assert seen == ["first starts", "second starts", "core starts",
                    "core releases claims", "core stops", "second stops", "first stops"]


def test_cors_wraps_a_products_middleware_and_the_first_listed_is_outermost(tmp_path):
    seen = []

    class Recording:
        def __init__(self, app, name):
            self.app, self.name = app, name

        async def __call__(self, scope, receive, send):
            if scope["type"] == "http":
                seen.append(self.name)
            await self.app(scope, receive, send)

    class Refusing:
        def __init__(self, app):
            self.app = app

        async def __call__(self, scope, receive, send):
            if scope["type"] == "http" and scope["path"] == "/api/desktop/refused":
                await PlainTextResponse("refused", status_code=403)(scope, receive, send)
                return
            await self.app(scope, receive, send)

    app = local_app(tmp_path, middleware=(Middleware(Recording, "outer"), Middleware(Recording, "inner"),
                                          Middleware(Refusing)))
    origin = {"Origin": "http://localhost:3000"}
    with TestClient(app) as client:
        refused = client.get("/api/desktop/refused", headers=origin)
        assert refused.status_code == 403
        # A response the product's middleware made itself still carries CORS headers.
        assert refused.headers["access-control-allow-origin"] == "http://localhost:3000"
        assert client.get("/api/health", headers=origin).headers["access-control-allow-origin"] == "http://localhost:3000"
    assert seen == ["outer", "inner", "outer", "inner"]


def test_the_local_stores_open_under_the_requests_data_directory(tmp_path, monkeypatch):
    swept = []
    monkeypatch.setattr(LocalObjectStore, "_sweep_chat_images", lambda store, days: swept.append(days))
    stores = Stores.local()
    settings = Settings(_env_file=None, data_dir=tmp_path, chat_image_retention_days=3)
    assert stores.is_local
    assert stores.storage(settings).root == tmp_path
    assert stores.objects(settings).root == tmp_path
    # The object store keeps chat images for as long as the request's settings say.
    assert swept == [3]
