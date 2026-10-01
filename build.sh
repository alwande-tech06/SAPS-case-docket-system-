#!/usr/bin/env bash
# Render build command. Runs on every deploy.
set -o errexit

pip install --upgrade pip
pip install -r requirements.txt
flask db upgrade      # bring the database schema up to date
flask bootstrap       # reference data; on an empty database, the first admin or the demo data
