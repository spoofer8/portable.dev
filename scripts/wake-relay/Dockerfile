FROM python:3.12-alpine@sha256:c4634f578a412db396771b61b064c6e546c9d6414c7fb5b1b05d5871f1885f7b

WORKDIR /app
COPY wake_relay.py /app/wake_relay.py

USER 65534:65534
ENTRYPOINT ["python3", "/app/wake_relay.py"]
