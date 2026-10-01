# Finish service — grommets + pole pockets (run-to-completion, no HTTP).
FROM python:3.13-slim
WORKDIR /app
COPY finish/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY _common/ .
COPY finish/ .
CMD ["python", "main.py"]
