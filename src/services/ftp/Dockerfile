# Transfer service — FTP (GA/NJ/TX/NV) + Google Drive (CA).
FROM python:3.13-slim
WORKDIR /app
COPY ftp/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY _common/ .
COPY ftp/ .
CMD ["python", "main.py"]
