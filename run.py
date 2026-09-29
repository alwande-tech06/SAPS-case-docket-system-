import os

from app import create_app, scheduler

app = create_app(os.getenv('FLASK_CONFIG', 'development'))

if __name__ == '__main__':
    scheduler.start(app)
    app.run(host=os.getenv('HOST', '127.0.0.1'), port=int(os.getenv('PORT', '5000')), debug=app.config.get('DEBUG', False))
