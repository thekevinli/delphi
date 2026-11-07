"""The application factory: how a product builds Delphi's HTTP API.

    app = create_app(load_settings(MySettings), stores=Stores.local())

Core owns every route under `/api/`. A product adds routers under its own
prefix, middleware and lifespan hooks, and overrides `get_current_user`; it
never removes or reshapes a core route. `delphi_core.main:app` is the reference
app built this way.

`get_settings`, `get_storage` and `get_object_store` are here so a product's
routes can depend on what core's routes do: the app's settings and stores.
"""
from collections.abc import AsyncIterator, Callable, Sequence
from contextlib import AbstractAsyncContextManager, AsyncExitStack, asynccontextmanager
from importlib.metadata import version
import logging

from fastapi import APIRouter, Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware import Middleware

from .config import Settings, get_settings
from .deps import get_current_user, get_object_store, get_storage
from .model_tasks import describe_model_tasks
from .routers import (
    auth,
    captures,
    chat,
    dashboard,
    evidence,
    export,
    onboarding,
    digests,
    memory,
    library,
    search,
    personas,
    projects,
    plans,
    reader,
)
from .storage import Storage
from .stores import Stores
from .web_fetch import create_web_client, set_shared_web_client

__all__ = [
    "create_app",
    "Stores",
    "Lifespan",
    "get_current_user",
    "get_settings",
    "get_storage",
    "get_object_store",
]

#: A product's startup and shutdown, given the app. Entered before core's own
#: and left after it, so whatever core's shutdown writes through still works.
Lifespan = Callable[[FastAPI], AbstractAsyncContextManager[None]]

#: Core's routers, in the order their routes are matched and published.
CORE_ROUTERS = (
    auth.router,
    dashboard.router,
    onboarding.router,
    reader.router,
    projects.router,
    captures.router,
    personas.router,
    digests.router,
    library.router,
    search.router,
    memory.router,
    evidence.router,
    chat.router,
    plans.router,
    export.router,
)


def create_app(
    settings: Settings,
    *,
    stores: Stores,
    routers: Sequence[APIRouter] = (),
    middleware: Sequence[Middleware] = (),
    lifespan: Sequence[Lifespan] = (),
) -> FastAPI:
    """Delphi's API over `settings` and `stores`, with a product's additions.

    - `routers` are included after core's, each under the product's own prefix.
    - `middleware` is listed outermost first, as Starlette's own list is; CORS
      wraps all of it, so a product's responses carry the same headers.
    - `lifespan` hooks are entered in order before core starts, and left in
      reverse after core stops.
    """
    # Nothing configured logging, so the root logger stayed at its WARNING default
    # and every INFO line this application writes was discarded — in the deployed
    # container as much as locally. That is only invisible until it matters: a
    # thumbnail capture that *failed* was in the log and one that succeeded was
    # not, so "no line about it" meant two opposite things and neither could be
    # told from a capture that was never attempted. Uvicorn installs its own
    # configuration in development, so `force=False` leaves that alone and this
    # only takes effect where nothing else has claimed the root logger — which is
    # exactly the Hypercorn container.
    logging.basicConfig(
        level=getattr(logging, settings.log_level.upper(), logging.INFO),
        format="%(levelname)s %(name)s %(message)s",
    )

    @asynccontextmanager
    async def core_lifespan(app: FastAPI) -> AsyncIterator[None]:
        # What this instance will actually ask of a model, said once at startup.
        # Model configuration reaches the deployed service through `MODEL_TASKS`
        # defaults and never through the environment — `deploy.sh --set-env-vars`
        # ships none — so "which model is production using" was a question only
        # answerable by guessing which commit was live.
        logging.getLogger(__name__).info("model tasks: %s", describe_model_tasks(settings))
        web_client = create_web_client(settings)
        set_shared_web_client(web_client)
        try:
            yield
        finally:
            # Filing that was still running goes back to the queue unspent rather
            # than waiting out its lease: a desktop switching connections and a
            # Cloud Run instance being replaced both stop the server mid-drain.
            # It writes through the stores, so a product hook that closes them
            # (a database pool) is left after this.
            from .routers.memory import release_held_claims

            if released := release_held_claims():
                logging.getLogger(__name__).info("released %d Memory claim(s) on shutdown", released)
            set_shared_web_client(None)
            await web_client.aclose()

    @asynccontextmanager
    async def app_lifespan(app: FastAPI) -> AsyncIterator[None]:
        async with AsyncExitStack() as stack:
            for hook in lifespan:
                await stack.enter_async_context(hook(app))
            await stack.enter_async_context(core_lifespan(app))
            yield

    app = FastAPI(title="Delphi API", version=version("delphi-core"), lifespan=app_lifespan)
    app.state.settings = settings
    app.state.stores = stores
    # Each add wraps the ones before it, so the reversed product list leaves its
    # first entry outermost of the product's, and CORS, added last, outside all.
    for layer in reversed(middleware):
        app.add_middleware(layer.cls, *layer.args, **layer.kwargs)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    for router in CORE_ROUTERS:
        app.include_router(router)

    @app.get("/", include_in_schema=False)
    def root():
        """
        This service is the API only — the reader UI is served from a different
        origin, which forwards /api/* here. Hitting the root would otherwise be a
        bare 404 that looks like a broken deployment rather than a wrong address.
        """
        return {
            "service": "Delphi API",
            "status": "ok",
            "docs": "/docs",
            "health": "/api/health",
            "note": "The Delphi web app is served separately; this host answers /api/* only.",
        }

    @app.get("/api/health")
    def health(storage: Storage = Depends(get_storage)):
        return {
            "status": "ok",
            "storage": storage.kind,
            "app": settings.app_name,
        }

    for router in routers:
        app.include_router(router)
    return app
