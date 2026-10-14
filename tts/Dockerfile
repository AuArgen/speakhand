# Кыргызча TTS (facebook/mms-tts-kir, CPU). Кошумча кызмат: docker compose --profile tts up -d
FROM python:3.12-slim
WORKDIR /app
ENV PIP_NO_CACHE_DIR=1 \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/opt/hf

# CPU үчүн torch (GPU версиясынан бир топ кичине), анан transformers.
RUN pip install --index-url https://download.pytorch.org/whl/cpu torch==2.14.1 \
 && pip install transformers==5.19.0 numpy==2.5.3

# Моделди сүрөткө салып коёбуз — иштөө убагында интернет керек эмес.
RUN python -c "from transformers import AutoTokenizer, VitsModel; m='facebook/mms-tts-kir'; AutoTokenizer.from_pretrained(m); VitsModel.from_pretrained(m)"

COPY server.py ./
RUN useradd --system --uid 10001 tts && chown -R tts /opt/hf
USER tts
ENV HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1 \
    TTS_HOST=0.0.0.0 \
    TTS_PORT=8790

EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8790/health', timeout=4).status == 200 else 1)"
CMD ["python", "server.py", "--preload"]
