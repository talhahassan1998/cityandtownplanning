# GDAL + its Python bindings come from the official OSGeo image; the API adds FastAPI on top.
FROM ghcr.io/osgeo/gdal:ubuntu-small-3.10.3
RUN apt-get update && apt-get install -y --no-install-recommends python3-pip && rm -rf /var/lib/apt/lists/*
WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir --break-system-packages -r requirements.txt
COPY app app
COPY tests tests
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
