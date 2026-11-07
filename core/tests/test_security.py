from delphi_core.security import (
    hash_password,
    make_session,
    make_staged_upload_token,
    read_session,
    read_staged_upload_token,
    verify_password,
)


def test_password_round_trip():
    salt, digest = hash_password("a very good password")
    assert verify_password("a very good password", salt, digest)
    assert not verify_password("wrong password", salt, digest)


def test_session_round_trip():
    token = make_session("ada", "secret", 1)
    assert read_session(token, "secret") == "ada"
    assert read_session(token, "wrong") is None



def test_staged_upload_token_round_trip():
    paper = {"id": "abc123", "title": "Scaling laws", "bytes": 12_345}
    token = make_staged_upload_token("ada", "prj1", paper, "secret", 60)

    assert read_staged_upload_token(token, "ada", "prj1", "secret") == paper
    # A reader cannot spend another reader's token, or move one between their
    # own projects, and cannot mint one without the secret.
    assert read_staged_upload_token(token, "bob", "prj1", "secret") is None
    assert read_staged_upload_token(token, "ada", "prj2", "secret") is None
    assert read_staged_upload_token(token, "ada", "prj1", "wrong") is None


def test_an_expired_staged_upload_token_is_refused():
    paper = {"id": "abc123", "title": "Scaling laws", "bytes": 12_345}
    token = make_staged_upload_token("ada", "prj1", paper, "secret", -1)
    assert read_staged_upload_token(token, "ada", "prj1", "secret") is None
