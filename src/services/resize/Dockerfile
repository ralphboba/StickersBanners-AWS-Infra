# Resize service — run-to-completion container (no HTTP server).
# Ghostscript replaces the legacy Windows gswin64c.exe for PostScript .ai files.
FROM python:3.13-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends ghostscript && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .

CMD ["python", "main.py"]
