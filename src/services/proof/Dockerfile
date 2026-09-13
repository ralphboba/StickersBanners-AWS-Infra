# Proof service — DZI deep-zoom tiling (pyvips needs libvips).
FROM python:3.13-slim
RUN apt-get update && \
    apt-get install -y --no-install-recommends libvips && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY proof/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY _common/ .
COPY proof/ .
CMD ["python", "main.py"]
