from sqlalchemy import create_engine


class Database:
    def open(self):
        return create_engine("sqlite://")
