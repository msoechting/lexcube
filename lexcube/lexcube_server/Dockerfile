FROM tiangolo/uvicorn-gunicorn-fastapi:python3.11

COPY ./requirements-core.txt /app/requirements-core.txt
COPY ./requirements-standalone.txt /app/requirements-standalone.txt

RUN pip install --no-cache-dir --upgrade -r /app/requirements-core.txt
RUN pip install --no-cache-dir --upgrade -r /app/requirements-standalone.txt

COPY . /app

# move main python file to /app/app/main.py to make it work with tiangolo/uvicorn-gunicorn-fastapi
RUN mv /app/src/lexcube_standalone.py /app/src/main.py
RUN mv /app/src /app/app

ENV PRODUCTION=1
ENV LEXCUBE_LOG_PATH=/etc/lexcube-logs