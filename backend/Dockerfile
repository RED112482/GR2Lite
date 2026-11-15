FROM python:3.12-slim
WORKDIR /app
COPY pyproject.toml /app/
COPY gr2lite /app/gr2lite
RUN pip install --no-cache-dir .
ENV PORT=8000
EXPOSE 8000
CMD ["uvicorn", "gr2lite.api:app", "--host", "0.0.0.0", "--port", "8000"]
