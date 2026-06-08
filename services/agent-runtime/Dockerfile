FROM python:3.12-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml ./
COPY src ./src

RUN pip install --no-cache-dir .

ENV PYTHONUNBUFFERED=1
EXPOSE 7140

CMD ["uvicorn", "agent_runtime.app:app", "--host", "0.0.0.0", "--port", "7140"]
