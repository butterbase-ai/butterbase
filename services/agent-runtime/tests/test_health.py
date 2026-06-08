from fastapi import FastAPI
from fastapi.testclient import TestClient

from agent_runtime.routes.health import router


def test_health_returns_ok():
    app = FastAPI()
    app.include_router(router)
    client = TestClient(app)
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
