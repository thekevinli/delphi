"""The suite sees no provider key unless a test names one, as in CI.

CI runs with OPENAI_API_KEY empty (`.github/workflows/backend-wheel.yml`), but
`Settings` also reads the developer's `../.env`. Without this, every test that
names no key runs with a configured provider locally: it passes here, fails in
CI, and calls the real provider on the way. Set before any test module imports
the reference app (`delphi_core.main`), whose settings are loaded once, at
import, and cached.

`DATABASE_URL` and `GCS_BUCKET` are emptied too. They name a product's cloud
stores, and a product's `.env` may still set them; core's `Settings` ignores
both. Emptied here, they stay out of anything the suite starts in a child as
well, a release before this one included, which still read them.
"""
import os

os.environ["OPENAI_API_KEY"] = ""
os.environ["DATABASE_URL"] = ""
os.environ["GCS_BUCKET"] = ""
# The research pass before a digest is the same kind of thing: a second model
# call, with web search, that a test of digests did not ask for. Off unless a
# test builds its own `Settings` that turns it on.
os.environ["DIGEST_RESEARCH_ENABLED"] = "false"


# --- the stores the kit's store tests run on ------------------------------------
#
# The store tests are the kit's (`delphi_core_testkit.conformance`), and
# `store_harness` gives them the one store core holds, the local one. A product
# runs the same tests on its own. Below the environment above, which has to be
# set before anything here imports the app.

from contextlib import contextmanager

import pytest

# Before anything imports the kit: its asserts are rewritten only if pytest
# knows them for its own first, or a failing one loses its detail.
pytest.register_assert_rewrite("delphi_core_testkit")

from delphi_core_testkit.conformance import StoreHarness, require_conformance


def pytest_configure(config):
    # A5: the gates run with DELPHI_REQUIRE_CONFORMANCE=local, and the run then
    # fails unless it collected every kit store test on the local store and skipped none.
    require_conformance(config)


class LocalHarness:
    """The filesystem store, whose account lock is the process's re-entrant `PERSONA_LOCK`."""

    id = "local"

    def make(self, tmp_path):
        from delphi_core.config import Settings
        from delphi_core.storage import LocalStorage

        return LocalStorage(Settings(data_dir=tmp_path))

    @contextmanager
    def hold_account_lock(self, storage, username):
        from delphi_core.storage.local import PERSONA_LOCK

        with PERSONA_LOCK:
            yield lambda: storage.settle_onboarding(username, require_filing=True)

    def hold_job_kinds(self, monkeypatch, kinds):
        """Nothing of its own: the local store claims through `storage.base.job_is_due`, which reads core's rule."""


HARNESSES = [pytest.param(LocalHarness(), id=LocalHarness.id)]


@pytest.fixture(params=HARNESSES)
def store_harness(request) -> StoreHarness:
    return request.param
